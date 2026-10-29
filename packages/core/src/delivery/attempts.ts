/**
 * Decisions the delivery worker makes about one attempt to hand an email to the mail server.
 * Kept free of I/O so each rule is unit-tested; apps/worker applies them.
 */

/**
 * Wait before each retry when the hand-off to the mail server fails: quick retries for blips,
 * then every 15 minutes. 30 attempts cover about 6 hours 20 minutes, so a KumoMTA restart or
 * a short outage never fails mail. (KumoMTA itself then retries delivery for 72 hours.)
 */
export const EMAIL_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
export const EMAIL_RETRY_STEADY_MS = 900_000;
export const EMAIL_MAX_ATTEMPTS = 30;

/** Delay before the next attempt after `attemptsMade` failed attempts (1 = after the first). */
export function emailRetryDelay(attemptsMade: number): number {
  return EMAIL_RETRY_DELAYS_MS[attemptsMade - 1] ?? EMAIL_RETRY_STEADY_MS;
}

/** Total time covered by all retries. */
export function emailRetryWindowMs(): number {
  let total = 0;
  for (let attempt = 1; attempt < EMAIL_MAX_ATTEMPTS; attempt++) total += emailRetryDelay(attempt);
  return total;
}

export interface SendErrorLike {
  code?: string;
  responseCode?: number;
  /** The SMTP stage that failed (nodemailer): CONN, EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA... */
  command?: string;
  message?: string;
}

// Stages before the message content is sent: a failure here means the server never had it.
const BEFORE_DATA = new Set(["CONN", "EHLO", "HELO", "LHLO", "STARTTLS", "AUTH PLAIN", "AUTH LOGIN", "AUTH XOAUTH2", "AUTH CRAM-MD5", "MAIL FROM", "RCPT TO"]);

/**
 * How a failed `sendMail` should be treated.
 *  - `permanent`: the server refused the message itself (5xx). Retrying cannot help.
 *  - `not_sent`: a definite failure before the server took the message (a 4xx reply, a
 *     refused connection, DNS, login). Safe to retry from scratch.
 *  - `unknown`: the connection broke or timed out mid-transfer, so the server may have the
 *     message. The retry must first check whether it arrived (see recoveryDecision).
 * Login failures (530, 535) count as `not_sent`, not permanent: they are our configuration,
 * and the retry window gives time to fix it.
 */
export function classifySendError(err: SendErrorLike): "permanent" | "not_sent" | "unknown" {
  const reply = err.responseCode;
  if (reply !== undefined && reply >= 500 && reply !== 530 && reply !== 535) return "permanent";
  if (reply !== undefined) return "not_sent";
  if (err.command && (BEFORE_DATA.has(err.command.toUpperCase()) || err.command.toUpperCase().startsWith("AUTH"))) return "not_sent";
  if (err.code &&["ECONNECTION", "ECONNREFUSED", "EDNS", "EAUTH", "ENOTFOUND", "EHOSTUNREACH", "TLS"].includes(err.code)) {
    return "not_sent";
  }
  return "unknown";
}

/**
 * A readable reason for the email's timeline. Connection failures arrive as an AggregateError
 * with an empty message (one inner error per address tried), so name the codes instead.
 */
export function describeSendError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & SendErrorLike & { errors?: unknown[] };
  const inner = Array.isArray(e.errors)
    ? [...new Set(e.errors.map((x) => (x as { code?: string; message?: string })?.code ?? (x as Error)?.message).filter(Boolean))]
    : [];
  const text = e.message || inner.join(", ") || e.code || e.name;
  const stage = e.command ? ` (during ${e.command})` : "";
  return e.code && !text.includes(e.code) ? `${e.code}: ${text}${stage}` : `${text}${stage}`;
}

/** How long a retry waits for KumoMTA's reception report before deciding a hand-off was lost. */
export const RECEPTION_GRACE_MS = 2 * 60_000;

/** Routes whose mail server reports receptions back to TredMail (KumoMTA). */
export const REPORTING_ROUTES = new Set(["mta", "staging"]);

export interface PreviousAttempt {
  status: string;
  sendAttemptAt: Date | null;
  sendRoute: string | null;
  mtaAcceptedAt: Date | null;
}

/**
 * What to do with an email whose previous attempt may have reached the mail server (status
 * SENDING with an attempt marker): the process died, or the SENT write failed, after sendMail.
 *  - `already_sent`: KumoMTA reported receiving it; record SENT without sending again.
 *  - `wait`: the report may still be on its way; check again at `until`.
 *  - `send`: no evidence it arrived (or the route cannot tell us); send it.
 */
export function recoveryDecision(
  email: PreviousAttempt,
  now = new Date(),
): { action: "send" } | { action: "already_sent" } | { action: "wait"; until: Date } {
  if (email.status !== "SENDING" || !email.sendAttemptAt) return { action: "send" };
  if (email.mtaAcceptedAt) return { action: "already_sent" };
  if (!email.sendRoute || !REPORTING_ROUTES.has(email.sendRoute)) return { action: "send" };
  const until = new Date(email.sendAttemptAt.getTime() + RECEPTION_GRACE_MS);
  return until.getTime() > now.getTime() ? { action: "wait", until } : { action: "send" };
}

/** Domain states mail may be sent from. DEGRADED: a re-check failed recently, still sendable. */
export const SENDABLE_DOMAIN_STATUSES = new Set(["VERIFIED", "DEGRADED"]);

/** How long mail waits for its domain to become verified again before it fails. */
export const DOMAIN_HOLD_MS = 72 * 3600_000;
export const DOMAIN_RECHECK_MS = 30 * 60_000;

/**
 * Mail from a domain that is not currently sendable is held, not failed: DNS problems are
 * often fixed within hours. It fails once it has waited DOMAIN_HOLD_MS since it was queued.
 */
export function domainHoldDecision(domainStatus: string, queuedAt: Date, now = new Date()): "send" | "hold" | "fail" {
  if (SENDABLE_DOMAIN_STATUSES.has(domainStatus)) return "send";
  return now.getTime() - queuedAt.getTime() >= DOMAIN_HOLD_MS ? "fail" : "hold";
}
