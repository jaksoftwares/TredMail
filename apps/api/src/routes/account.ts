import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { env, PLATFORM_ORG_SLUG } from "@tredmail/core/config/env";
import { WORKSPACE_ROLES, canAssignRole, canChangeMember, type WorkspaceRole } from "@tredmail/core/security/roles";
import { recordAudit } from "@tredmail/core/services/audit";
import { acceptEmail } from "@tredmail/core/services/email-service";
import { sendSystemEmail } from "@tredmail/core/services/system-mailer";
import { invitationTemplate, sandboxWelcomeTemplate } from "@tredmail/core/mail/templates";
import {
  auditActor,
  authenticate,
  requireMemberManager,
  requireScope,
  requireUser,
} from "../middleware/auth.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
    if (slug === PLATFORM_ORG_SLUG) continue;
    const taken = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) return slug;
  }
  return `${base}-${crypto.randomBytes(6).toString("hex")}`;
}

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  use_case: z.string().trim().max(500).optional(),
  website: z.string().trim().url().max(200).optional(),
});

const roleSchema = z.enum(WORKSPACE_ROLES);

function badRequest(details: unknown, message = "Invalid request.") {
  return { statusCode: 400, error: "validation_error", message, details };
}

/** Public: what an invitation link is for, so the invite page can show it before sign-in. */
export async function invitationLookupRoute(fastify: FastifyInstance) {
  // GET /v1/invitations/lookup?token=
  fastify.get<{ Querystring: { token?: string } }>("/invitations/lookup", async (request, reply) => {
    const token = request.query.token ?? "";
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: { select: { name: true } }, invitedBy: { select: { name: true } } },
    });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      return reply.status(404).send({ statusCode: 404, error: "invitation_invalid", message: "This invitation is no longer valid." });
    }
    return {
      workspace: invitation.organization.name,
      email: invitation.email,
      role: invitation.role,
      invited_by: invitation.invitedBy?.name ?? null,
    };
  });

}

/** Routes for the signed-in user that do not act in a specific workspace. */
export async function accountRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireUser);

  // GET /v1/me - Profile, workspaces and pending invitations
  fastify.get("/me", async (request) => {
    const user = request.sessionUser!;
    const [profile, memberships, invitations] = await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, name: true, email: true, emailVerified: true, twoFactorEnabled: true, image: true },
      }),
      prisma.organizationMember.findMany({
        where: { userId: user.id, organization: { slug: { not: PLATFORM_ORG_SLUG } } },
        include: { organization: { select: { id: true, name: true, slug: true, planTier: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.invitation.findMany({
        where: { email: user.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { organization: { select: { name: true } } },
      }),
    ]);

    return {
      user: profile,
      workspaces: memberships.map((m) => ({ ...m.organization, role: m.role })),
      pending_invitations: invitations.map((i) => ({ id: i.id, workspace: i.organization.name, role: i.role })),
      sandbox_sender: `onboarding@${env.PRIMARY_DOMAIN}`,
    };
  });

  // POST /v1/workspaces - Create a workspace; the creator becomes its Owner
  fastify.post("/workspaces", async (request, reply) => {
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.errors));

    const user = request.sessionUser!;
    if (!user.emailVerified) {
      return reply.status(403).send({ statusCode: 403, error: "email_not_verified", message: "Verify your email first." });
    }

    const organization = await prisma.organization.create({
      data: {
        name: parsed.data.name,
        slug: await uniqueSlug(parsed.data.name),
        useCase: parsed.data.use_case,
        website: parsed.data.website,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });

    await recordAudit({
      organizationId: organization.id,
      actorType: "user",
      actorId: user.id,
      action: "workspace.created",
      metadata: { name: organization.name },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ id: organization.id, name: organization.name, slug: organization.slug, role: "OWNER" });
  });

  // POST /v1/invitations/accept - Join a workspace with an invitation token
  fastify.post("/invitations/accept", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.errors));

    const user = request.sessionUser!;
    const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(parsed.data.token) } });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      return reply.status(404).send({ statusCode: 404, error: "invitation_invalid", message: "This invitation is no longer valid." });
    }
    if (!user.emailVerified || invitation.email !== user.email) {
      return reply.status(403).send({
        statusCode: 403,
        error: "invitation_email_mismatch",
        message: `This invitation was sent to ${invitation.email}. Sign in with that verified address to accept it.`,
      });
    }

    await prisma.$transaction([
      prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } },
        update: {},
        create: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role },
      }),
      prisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }),
    ]);

    await recordAudit({
      organizationId: invitation.organizationId,
      actorType: "user",
      actorId: user.id,
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { email: user.email, role: invitation.role },
      ipAddress: request.ip,
    });

    return { workspace_id: invitation.organizationId, role: invitation.role };
  });
}

/** Routes that act in the workspace chosen by the x-tredmail-workspace header. */
export async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.principal?.kind !== "user") {
      return reply.status(403).send({
        statusCode: 403,
        error: "session_required",
        message: "Workspace settings are managed from the console, not with API keys.",
      });
    }
  });

  // GET /v1/workspace - Current workspace details
  fastify.get("/workspace", async (request) => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: request.organization!.id },
      select: { id: true, name: true, slug: true, planTier: true, monthlyQuota: true, useCase: true, website: true, createdAt: true },
    });
    const principal = request.principal!;
    return { ...org, role: principal.kind === "user" ? principal.role : null };
  });

  // PATCH /v1/workspace - Rename or update details (Owner/Admin)
  fastify.patch("/workspace", { preHandler: requireMemberManager }, async (request, reply) => {
    const parsed = workspaceSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.errors));
    const org = await prisma.organization.update({
      where: { id: request.organization!.id },
      data: { name: parsed.data.name, useCase: parsed.data.use_case, website: parsed.data.website },
    });
    await recordAudit({
      organizationId: org.id,
      ...auditActor(request),
      action: "workspace.updated",
      metadata: parsed.data,
      ipAddress: request.ip,
    });
    return { id: org.id, name: org.name, slug: org.slug };
  });

  // GET /v1/members
  fastify.get("/members", async (request) => {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: request.organization!.id },
      include: { user: { select: { id: true, name: true, email: true, twoFactorEnabled: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      data: members.map((m) => ({
        id: m.id,
        role: m.role,
        joined_at: m.createdAt.toISOString(),
        user: m.user,
      })),
    };
  });

  // PATCH /v1/members/:id - Change a member's role (Owner/Admin)
  fastify.patch<{ Params: { id: string } }>("/members/:id", { preHandler: requireMemberManager }, async (request, reply) => {
    const parsed = z.object({ role: roleSchema }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.errors));

    const actor = request.principal!;
    const actorRole = actor.kind === "user" ? actor.role : ("VIEWER" as WorkspaceRole);
    const member = await prisma.organizationMember.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
    });
    if (!member) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Member not found." });

    if (!canChangeMember(actorRole, member.role) || !canAssignRole(actorRole, parsed.data.role)) {
      return reply.status(403).send({ statusCode: 403, error: "insufficient_role", message: "You cannot make this change." });
    }
    if (member.role === "OWNER" && parsed.data.role !== "OWNER") {
      const owners = await prisma.organizationMember.count({ where: { organizationId: member.organizationId, role: "OWNER" } });
      if (owners <= 1) {
        return reply.status(409).send({ statusCode: 409, error: "last_owner", message: "A workspace needs at least one Owner." });
      }
    }

    await prisma.organizationMember.update({ where: { id: member.id }, data: { role: parsed.data.role } });
    await recordAudit({
      organizationId: member.organizationId,
      ...auditActor(request),
      action: "member.role_changed",
      targetType: "member",
      targetId: member.id,
      metadata: { from: member.role, to: parsed.data.role },
      ipAddress: request.ip,
    });
    return { id: member.id, role: parsed.data.role };
  });

  // DELETE /v1/members/:id - Remove a member (Owner/Admin), or leave (yourself)
  fastify.delete<{ Params: { id: string } }>("/members/:id", async (request, reply) => {
    const actor = request.principal!;
    if (actor.kind !== "user") return reply.status(403).send();

    const member = await prisma.organizationMember.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
    });
    if (!member) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Member not found." });

    const leavingSelf = member.userId === actor.userId;
    if (!leavingSelf && !canChangeMember(actor.role, member.role)) {
      return reply.status(403).send({ statusCode: 403, error: "insufficient_role", message: "You cannot remove this member." });
    }
    if (member.role === "OWNER") {
      const owners = await prisma.organizationMember.count({ where: { organizationId: member.organizationId, role: "OWNER" } });
      if (owners <= 1) {
        return reply.status(409).send({ statusCode: 409, error: "last_owner", message: "A workspace needs at least one Owner." });
      }
    }

    await prisma.organizationMember.delete({ where: { id: member.id } });
    await recordAudit({
      organizationId: member.organizationId,
      ...auditActor(request),
      action: leavingSelf ? "member.left" : "member.removed",
      targetType: "member",
      targetId: member.id,
      metadata: { userId: member.userId, role: member.role },
      ipAddress: request.ip,
    });
    return { success: true };
  });

  // GET /v1/invitations - Pending invitations
  fastify.get("/invitations", async (request) => {
    const invitations = await prisma.invitation.findMany({
      where: { organizationId: request.organization!.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    return {
      data: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expires_at: i.expiresAt.toISOString(),
        created_at: i.createdAt.toISOString(),
      })),
    };
  });

  // POST /v1/invitations - Invite someone by email (Owner/Admin)
  fastify.post("/invitations", { preHandler: requireMemberManager }, async (request, reply) => {
    const parsed = z
      .object({ email: z.string().trim().toLowerCase().email(), role: roleSchema.default("DEVELOPER") })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.errors));

    const actor = request.principal!;
    if (actor.kind !== "user" || !canAssignRole(actor.role, parsed.data.role)) {
      return reply.status(403).send({ statusCode: 403, error: "insufficient_role", message: "You cannot invite with this role." });
    }

    const organizationId = request.organization!.id;
    const alreadyMember = await prisma.organizationMember.findFirst({
      where: { organizationId, user: { email: parsed.data.email } },
      select: { id: true },
    });
    if (alreadyMember) {
      return reply.status(409).send({ statusCode: 409, error: "already_member", message: "This person is already a member." });
    }

    // One live invitation per address: replace any earlier one.
    await prisma.invitation.updateMany({
      where: { organizationId, email: parsed.data.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString("base64url");
    const invitation = await prisma.invitation.create({
      data: {
        organizationId,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: hashToken(token),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });

    const inviter = request.sessionUser!;
    let emailSent = true;
    try {
      await sendSystemEmail(
        invitation.email,
        invitationTemplate({
          inviterName: inviter.name,
          workspaceName: request.organization!.name,
          role: invitation.role,
          url: `${env.CONSOLE_URL}/invite/${token}`,
        })
      );
    } catch (err) {
      emailSent = false;
      request.log.error({ err }, "invitation email failed");
    }

    await recordAudit({
      organizationId,
      ...auditActor(request),
      action: "invitation.created",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expires_at: invitation.expiresAt.toISOString(),
      email_sent: emailSent,
    });
  });

  // DELETE /v1/invitations/:id - Revoke a pending invitation (Owner/Admin)
  fastify.delete<{ Params: { id: string } }>("/invitations/:id", { preHandler: requireMemberManager }, async (request, reply) => {
    const result = await prisma.invitation.updateMany({
      where: { id: request.params.id, organizationId: request.organization!.id, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Invitation not found." });
    }
    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: request.params.id,
      ipAddress: request.ip,
    });
    return { success: true };
  });

  // GET /v1/audit-logs - Recent workspace changes (Owner/Admin)
  fastify.get<{ Querystring: { limit?: string } }>("/audit-logs", { preHandler: requireMemberManager }, async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const entries = await prisma.auditLog.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return { data: entries };
  });

  // POST /v1/onboarding/test-email - Send the sandbox welcome email to yourself
  fastify.post("/onboarding/test-email", { preHandler: requireScope("emails:send") }, async (request, reply) => {
    const user = request.sessionUser!;
    const template = sandboxWelcomeTemplate({ workspaceName: request.organization!.name });
    const result = await acceptEmail(request.organization!.id, {
      from: `TredMail Sandbox <onboarding@${env.PRIMARY_DOMAIN}>`,
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    if (!result.ok) {
      return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    }
    return { id: result.email.id, to: user.email, status: "queued" };
  });
}
