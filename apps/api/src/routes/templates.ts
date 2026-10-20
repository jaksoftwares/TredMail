import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma, Prisma, type Template } from "@tredmail/db";
import { recordAudit } from "@tredmail/core/services/audit";
import { renderTemplate, templateVariableNames } from "@tredmail/core/mail/template-engine";
import { auditActor, authenticate, requireScope } from "../middleware/auth.js";

const aliasSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "use lowercase letters, digits, - and _ (e.g. password-reset)");

const templateFields = {
  name: z.string().min(1).max(120),
  alias: aliasSchema,
  subject: z.string().min(1).max(998),
  html: z.string().max(1_000_000).nullish(),
  text: z.string().max(500_000).nullish(),
  from: z.string().min(3).max(320).nullish(),
  reply_to: z.string().email().nullish(),
};

const createSchema = z
  .object(templateFields)
  .refine((t) => t.html || t.text, { message: "Provide 'html', 'text' or both.", path: ["html"] });
const updateSchema = z.object(templateFields).partial();
const previewSchema = z.object({ variables: z.record(z.unknown()).default({}) });

const serialize = (t: Template) => ({
  id: t.id,
  name: t.name,
  alias: t.alias,
  subject: t.subject,
  html: t.html,
  text: t.text,
  from: t.from,
  reply_to: t.replyTo,
  variables: templateVariableNames(t.subject, t.html, t.text),
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

const notFound = (reply: FastifyReply, id: string) =>
  reply.status(404).send({ statusCode: 404, error: "not_found", message: `Template '${id}' not found.` });

const aliasTaken = (reply: FastifyReply, alias: string) =>
  reply.status(409).send({ statusCode: 409, error: "alias_taken", message: `Another template already uses the alias '${alias}'.` });

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Templates: reusable subject and body with {{variables}}, sent with `template` on POST /v1/emails. */
export async function templateRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireScope("templates:manage"));

  const find = (organizationId: string, idOrAlias: string) =>
    prisma.template.findFirst({ where: { organizationId, OR: [{ id: idOrAlias }, { alias: idOrAlias.toLowerCase() }] } });

  fastify.get("/", async (request, reply) => {
    const templates = await prisma.template.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { updatedAt: "desc" },
    });
    return reply.send({ data: templates.map(serialize) });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const template = await find(request.organization!.id, request.params.id);
    return template ? reply.send(serialize(template)) : notFound(reply, request.params.id);
  });

  fastify.post("/", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid template.", details: parsed.error.errors });
    }
    const t = parsed.data;
    try {
      const template = await prisma.template.create({
        data: {
          organizationId: request.organization!.id,
          name: t.name,
          alias: t.alias,
          subject: t.subject,
          html: t.html ?? null,
          text: t.text ?? null,
          from: t.from ?? null,
          replyTo: t.reply_to ?? null,
        },
      });
      await recordAudit({
        organizationId: request.organization!.id,
        ...auditActor(request),
        action: "template.created",
        targetType: "template",
        targetId: template.id,
        metadata: { alias: template.alias },
      });
      return reply.status(201).send(serialize(template));
    } catch (err) {
      if (isUniqueViolation(err)) return aliasTaken(reply, t.alias);
      throw err;
    }
  });

  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid template.", details: parsed.error.errors });
    }
    const existing = await find(request.organization!.id, request.params.id);
    if (!existing) return notFound(reply, request.params.id);
    const t = parsed.data;
    const html = t.html === undefined ? existing.html : t.html;
    const text = t.text === undefined ? existing.text : t.text;
    if (!html && !text) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "A template needs 'html', 'text' or both." });
    }
    try {
      const template = await prisma.template.update({
        where: { id: existing.id },
        data: {
          name: t.name,
          alias: t.alias,
          subject: t.subject,
          html,
          text,
          from: t.from === undefined ? undefined : t.from,
          replyTo: t.reply_to === undefined ? undefined : t.reply_to,
        },
      });
      await recordAudit({
        organizationId: request.organization!.id,
        ...auditActor(request),
        action: "template.updated",
        targetType: "template",
        targetId: template.id,
        metadata: { alias: template.alias },
      });
      return reply.send(serialize(template));
    } catch (err) {
      if (isUniqueViolation(err)) return aliasTaken(reply, t.alias ?? "");
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const existing = await find(request.organization!.id, request.params.id);
    if (!existing) return notFound(reply, request.params.id);
    await prisma.template.delete({ where: { id: existing.id } });
    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "template.deleted",
      targetType: "template",
      targetId: existing.id,
      metadata: { alias: existing.alias },
    });
    return reply.send({ id: existing.id, deleted: true });
  });

  // POST /v1/templates/:id/preview - Render with sample variables without sending
  fastify.post<{ Params: { id: string } }>("/:id/preview", async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Send { \"variables\": { ... } }.", details: parsed.error.errors });
    }
    const template = await find(request.organization!.id, request.params.id);
    if (!template) return notFound(reply, request.params.id);
    const rendered = renderTemplate(template, parsed.data.variables);
    return reply.send({ subject: rendered.subject, html: rendered.html ?? null, text: rendered.text ?? null, missing_variables: rendered.missing });
  });
}
