import type { Metadata } from "next";
import spec from "@/generated/openapi.json";
import { API_BASE, C, Code, DocTitle, P } from "@/components/docs";

export const metadata: Metadata = { title: "API reference" };

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: readonly string[];
  const?: string;
  format?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  allOf?: Schema[];
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
};

type Operation = {
  summary: string;
  description?: string;
  tags: string[];
  "x-required-scope"?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema; description?: string; $ref?: string }>;
  requestBody?: { content: { "application/json": { schema: Schema; example?: unknown } } };
  responses: Record<string, { description?: string; $ref?: string; content?: { "application/json": { schema: Schema } } }>;
};

const schemas = spec.components.schemas as unknown as Record<string, Schema>;
const sharedResponses = spec.components.responses as unknown as Record<string, { description: string }>;
const METHODS = ["get", "post", "patch", "delete"] as const;

function resolve(schema: Schema | undefined): Schema {
  if (!schema) return {};
  if (schema.$ref) return resolve(schemas[schema.$ref.split("/").pop()!]);
  if (schema.allOf) {
    const parts = schema.allOf.map(resolve);
    return {
      type: "object",
      description: schema.description,
      properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
      required: parts.flatMap((p) => p.required ?? []),
    };
  }
  return schema;
}

function typeLabel(schema: Schema): string {
  const s = schema.$ref ? { ...resolve(schema), name: schema.$ref.split("/").pop() } : schema;
  if (schema.$ref) {
    const target = resolve(schema);
    if (target.enum) return target.enum.map((e) => `"${e}"`).join(" | ");
    return schema.$ref.split("/").pop()!;
  }
  if (s.oneOf) return s.oneOf.map(typeLabel).join(" or ");
  if (s.enum) return s.enum.map((e) => `"${e}"`).join(" | ");
  if (s.const) return `"${s.const}"`;
  const type = Array.isArray(s.type) ? s.type.filter((t) => t !== "null").join(" | ") + (s.type.includes("null") ? " | null" : "") : s.type;
  if (type === "array") return `${s.items ? typeLabel(s.items) : "any"}[]`;
  return [type ?? "any", s.format && s.format !== "date-time" ? `(${s.format})` : s.format === "date-time" ? "(ISO 8601)" : ""].filter(Boolean).join(" ");
}

function Fields({ schema }: { schema: Schema }) {
  const resolved = resolve(schema.type === "array" && schema.items ? schema.items : schema);
  const properties = Object.entries(resolved.properties ?? {});
  if (properties.length === 0) return null;
  return (
    <div className="mb-4 overflow-x-auto rounded-md border border-line">
      <table className="w-full text-left text-xs">
        <tbody className="divide-y divide-line">
          {properties.map(([name, prop]) => (
            <tr key={name}>
              <td className="w-44 px-3 py-2 align-top">
                <span className="font-mono font-semibold text-navy">{name}</span>
                {resolved.required?.includes(name) && <span className="ml-1 text-[10px] font-bold uppercase text-orange-600">required</span>}
              </td>
              <td className="w-48 px-3 py-2 align-top font-mono text-muted">{typeLabel(prop)}</td>
              <td className="px-3 py-2 align-top text-ink">{md(prop.description ?? resolve(prop).description)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const methodTone: Record<string, string> = {
  get: "bg-info-50 text-navy",
  post: "bg-green-50 text-green",
  patch: "bg-warning-50 text-warning",
  delete: "bg-danger-50 text-danger",
};

/** Renders the spec's `code` spans (its descriptions use Markdown backticks). */
function md(text: string | undefined) {
  if (!text) return null;
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <C key={i}>{part.slice(1, -1)}</C> : part,
  );
}

const anchor = (method: string, path: string) => `${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}`;

export default function ApiReferencePage() {
  const paths = spec.paths as unknown as Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
  const operations = Object.entries(paths).flatMap(([path, ops]) =>
    METHODS.filter((m) => ops[m]).map((method) => ({ path, method, op: ops[method]! })),
  );
  const tags = spec.tags.map((t) => ({ ...t, operations: operations.filter((o) => o.op.tags.includes(t.name)) }));

  return (
    <>
      <DocTitle title="API reference" lead={md(spec.info.description)} />
      <P>
        Base URL <C>{API_BASE}</C>. Machine-readable description:{" "}
        <a href="/v1/openapi.json" className="font-semibold underline">openapi.json</a> (OpenAPI 3.1), usable with Postman, Insomnia and client generators.
      </P>

      <nav aria-label="Endpoints" className="mb-10 grid gap-x-8 gap-y-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2">
        {tags.map((tag) => (
          <div key={tag.name}>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-subtle">{tag.name}</p>
            <ul className="space-y-0.5">
              {tag.operations.map(({ path, method, op }) => (
                <li key={`${method} ${path}`}>
                  <a href={`#${anchor(method, path)}`} className="text-sm text-navy hover:underline">{op.summary}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {tags.map((tag) => (
        <section key={tag.name} className="mb-12">
          <h2 className="mb-1 text-xl font-bold text-navy">{tag.name}</h2>
          <p className="mb-5 text-sm text-muted">{tag.description}</p>
          <div className="space-y-6">
            {tag.operations.map(({ path, method, op }) => {
              const body = op.requestBody?.content["application/json"];
              const params = (op.parameters ?? []).filter((p) => p.name);
              return (
                <article key={`${method} ${path}`} id={anchor(method, path)} className="scroll-mt-20 rounded-lg border border-line bg-surface p-5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold uppercase ${methodTone[method]}`}>{method}</span>
                    <code className="break-all font-mono text-sm font-semibold text-navy">{path}</code>
                  </div>
                  <h3 className="font-bold text-ink">{op.summary}</h3>
                  {op.description && <p className="mt-1 whitespace-pre-line text-sm text-muted">{md(op.description)}</p>}

                  {params.length > 0 && (
                    <>
                      <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-subtle">Parameters</p>
                      <div className="mb-2 overflow-x-auto rounded-md border border-line">
                        <table className="w-full text-left text-xs">
                          <tbody className="divide-y divide-line">
                            {params.map((p) => (
                              <tr key={`${p.in}-${p.name}`}>
                                <td className="w-44 px-3 py-2 align-top">
                                  <span className="font-mono font-semibold text-navy">{p.name}</span>
                                  {p.required && <span className="ml-1 text-[10px] font-bold uppercase text-orange-600">required</span>}
                                </td>
                                <td className="w-24 px-3 py-2 align-top text-muted">{p.in}</td>
                                <td className="px-3 py-2 align-top">{p.description ? md(p.description) : p.schema ? typeLabel(p.schema) : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {body && (
                    <>
                      <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-subtle">
                        Request body{body.schema.type === "array" ? " (an array of these)" : ""}
                      </p>
                      <Fields schema={body.schema} />
                      {body.example !== undefined && <Code title="Example" code={JSON.stringify(body.example, null, 2)} />}
                    </>
                  )}

                  <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-subtle">Responses</p>
                  <ul className="space-y-1 text-sm">
                    {Object.entries(op.responses).map(([code, response]) => {
                      const description = response.$ref ? sharedResponses[response.$ref.split("/").pop()!]?.description : response.description;
                      return (
                        <li key={code} className="flex gap-3">
                          <span className={`w-10 shrink-0 font-mono font-bold ${code.startsWith("2") ? "text-green" : "text-danger"}`}>{code}</span>
                          <span className="text-muted">{md(description)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      <section className="mb-12">
        <h2 className="mb-1 text-xl font-bold text-navy">Webhook payload</h2>
        <p className="mb-4 text-sm text-muted">{md(spec.webhooks.emailEvent.post.description)}</p>
        <Code title="Example" code={JSON.stringify(spec.webhooks.emailEvent.post.requestBody.content["application/json"].example, null, 2)} />
      </section>
    </>
  );
}
