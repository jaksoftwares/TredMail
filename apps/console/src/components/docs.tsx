import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui";

export const API_BASE = "https://api.tredmail.dovepeakdigital.com/v1";
export const SMTP_HOST = "smtp.tredmail.dovepeakdigital.com";

export const DOCS_NAV: Array<{ href: string; label: string }> = [
  { href: "/docs", label: "Quickstart" },
  { href: "/docs/sending", label: "Sending email" },
  { href: "/docs/templates", label: "Templates" },
  { href: "/docs/webhooks", label: "Webhooks" },
  { href: "/docs/smtp", label: "SMTP relay" },
  { href: "/docs/domains", label: "Domains and DNS" },
  { href: "/docs/sdks", label: "SDKs" },
  { href: "/docs/migrate", label: "Moving from Resend, Postmark or SendGrid" },
  { href: "/docs/api", label: "API reference" },
];

export function DocTitle({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="mb-8">
      <h1 className="text-3xl font-extrabold tracking-tight text-navy">{title}</h1>
      {lead && <p className="mt-2 max-w-3xl text-base text-muted">{lead}</p>}
    </header>
  );
}

export function H2({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mb-3 mt-10 scroll-mt-20 text-xl font-bold text-navy">
      {children}
    </h2>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mb-4 max-w-3xl leading-relaxed text-ink">{children}</p>;
}

export function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-navy/5 px-1 py-0.5 font-mono text-[0.85em] text-navy">{children}</code>;
}

export function Code({ code, title }: { code: string; title?: string }) {
  return (
    <div className="mb-5 max-w-3xl overflow-hidden rounded-lg border border-navy-800 bg-navy">
      <div className="flex items-center justify-between border-b border-navy-800 px-3 py-1.5">
        <span className="font-mono text-xs text-navy-200">{title ?? ""}</span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-offwhite">{code}</pre>
    </div>
  );
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" }) {
  return (
    <div
      className={`mb-5 max-w-3xl rounded-md border-l-4 px-4 py-3 text-sm ${
        tone === "warning" ? "border-warning bg-warning-50 text-ink" : "border-navy bg-info-50 text-ink"
      }`}
    >
      {children}
    </div>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mb-5 max-w-3xl list-disc space-y-1.5 pl-5 leading-relaxed">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function DefTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mb-6 max-w-3xl overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-offwhite text-xs uppercase tracking-wide text-subtle">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
