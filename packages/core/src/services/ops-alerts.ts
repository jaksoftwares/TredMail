import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { operationsAlertTemplate } from "../mail/templates.js";
import { sendSystemEmail } from "./system-mailer.js";

/**
 * Operations alerts (delivery health, paused workspaces, unmatched payments...). They must
 * arrive when TredMail's own mail path is the thing that is broken, so they go out through
 * channels that do not depend on KumoMTA:
 *
 *  1. ALERT_WEBHOOK_URL: a chat webhook (Slack, Mattermost, Discord, Google Chat). The JSON body
 *     carries the message as both `text` and `content`, which covers those services.
 *  2. OPS_EMAIL, sent through the fallback SMTP provider (FALLBACK_SMTP_*) when one is set,
 *     otherwise through TredMail itself (which fails exactly when KumoMTA is the problem).
 *
 * Every alert is also logged. Never throws.
 */

export interface OpsAlert {
  title: string;
  summary: string;
  details: string[];
}

/** Which installation an alert comes from (production, staging...), from the API's host name. */
const origin = () => {
  try {
    return new URL(env.API_BASE_URL).host;
  } catch {
    return "tredmail";
  }
};

export function alertChatText(alert: OpsAlert, from = origin()): string {
  return [`*[TredMail alert · ${from}] ${alert.title}*`, alert.summary, ...alert.details.map((d) => `• ${d}`)].join("\n");
}

let directTransport: Transporter | null = null;
function fallbackTransport() {
  if (!env.FALLBACK_SMTP_HOST) return null;
  directTransport ??= nodemailer.createTransport({
    host: env.FALLBACK_SMTP_HOST,
    port: env.FALLBACK_SMTP_PORT,
    secure: env.FALLBACK_SMTP_SECURE,
    auth: env.FALLBACK_SMTP_USER ? { user: env.FALLBACK_SMTP_USER, pass: env.FALLBACK_SMTP_PASS } : undefined,
  });
  return directTransport;
}

/** Channels an alert can reach without KumoMTA. Empty means alerts depend on the mail path they report on. */
export function independentAlertChannels(): string[] {
  return [env.ALERT_WEBHOOK_URL ? "chat webhook" : null, env.OPS_EMAIL && env.FALLBACK_SMTP_HOST ? "email via fallback SMTP" : null].filter(
    (c): c is string => c !== null,
  );
}

async function postToChat(alert: OpsAlert) {
  const text = alertChatText(alert);
  const res = await fetch(env.ALERT_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, content: text.slice(0, 2000) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
}

async function emailOps(alert: OpsAlert) {
  const message = operationsAlertTemplate(alert);
  const transport = fallbackTransport();
  if (transport) {
    await transport.sendMail({
      from: `TredMail alerts <no-reply@${env.PRIMARY_DOMAIN}>`,
      to: env.OPS_EMAIL,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return;
  }
  await sendSystemEmail(env.OPS_EMAIL!, message);
}

export async function sendOpsAlert(alert: OpsAlert): Promise<{ delivered: string[]; failed: string[] }> {
  console.warn(`[alert] ${alert.title}: ${alert.summary}`);
  const attempts: Array<[string, () => Promise<void>]> = [];
  if (env.ALERT_WEBHOOK_URL) attempts.push(["chat webhook", () => postToChat(alert)]);
  if (env.OPS_EMAIL) attempts.push(["email", () => emailOps(alert)]);

  const delivered: string[] = [];
  const failed: string[] = [];
  const results = await Promise.allSettled(attempts.map(([, send]) => send()));
  results.forEach((result, i) => {
    const channel = attempts[i][0];
    if (result.status === "fulfilled") delivered.push(channel);
    else {
      failed.push(channel);
      console.error(`[alert] could not send "${alert.title}" by ${channel}`, result.reason);
    }
  });
  return { delivered, failed };
}
