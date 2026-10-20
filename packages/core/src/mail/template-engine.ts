/**
 * Template variables, deliberately small (no logic, no helpers, no partials):
 *
 *   {{name}}             value, HTML-escaped in the HTML body
 *   {{{name}}}           value inserted as-is (trusted HTML only)
 *   {{name|fallback}}    fallback text when the variable is missing or empty
 *   {{user.first_name}}  dotted paths into nested objects
 *
 * Unknown variables without a fallback are reported, so a send never goes out with a blank
 * where a name should be.
 */

export type TemplateVariables = Record<string, unknown>;

export interface RenderResult {
  output: string;
  missing: string[];
}

const TAG = /\{\{(\{)?\s*([A-Za-z_][\w.-]*)\s*(?:\|([^}]*))?\}\}(\})?/g;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function lookup(variables: TemplateVariables, path: string): unknown {
  let current: unknown = variables;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function renderTemplateString(source: string, variables: TemplateVariables, mode: "html" | "text"): RenderResult {
  const missing = new Set<string>();
  const output = source.replace(TAG, (match, open: string | undefined, name: string, fallback: string | undefined, close: string | undefined) => {
    const raw = open === "{" && close === "}";
    if ((open === "{") !== (close === "}")) return match; // unbalanced braces: leave untouched
    const value = stringify(lookup(variables, name)) ?? fallback?.trim();
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return mode === "html" && !raw ? escapeHtml(value) : value;
  });
  return { output, missing: [...missing] };
}

/** Variable names a template uses, in order of first appearance. */
export function templateVariableNames(...sources: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(TAG)) names.add(match[2]);
  }
  return [...names];
}

export interface RenderableTemplate {
  subject: string;
  html?: string | null;
  text?: string | null;
}

export function renderTemplate(template: RenderableTemplate, variables: TemplateVariables) {
  const subject = renderTemplateString(template.subject, variables, "text");
  const html = template.html ? renderTemplateString(template.html, variables, "html") : null;
  const text = template.text ? renderTemplateString(template.text, variables, "text") : null;
  const missing = [...new Set([...subject.missing, ...(html?.missing ?? []), ...(text?.missing ?? [])])];
  return {
    subject: subject.output.replace(/[\r\n]+/g, " ").trim(),
    html: html?.output,
    text: text?.output,
    missing,
  };
}
