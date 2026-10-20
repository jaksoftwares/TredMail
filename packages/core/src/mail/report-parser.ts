/**
 * Reads mail that comes back to TredMail: delivery status notifications (bounces, RFC 3464),
 * abuse feedback reports (spam complaints, RFC 5965 ARF) and the non-standard plain-text
 * bounces some older servers still send.
 */

export interface MimePart {
  headers: Map<string, string[]>;
  /** Lowercase media type without parameters, e.g. "multipart/report". */
  contentType: string;
  params: Record<string, string>;
  /** Decoded body text (empty for multipart containers). */
  body: string;
  parts: MimePart[];
  /** The nested message of a message/rfc822 or text/rfc822-headers part. */
  embedded?: MimePart;
}

export interface DsnRecipient {
  recipient: string;
  /** failed | delayed | delivered | relayed | expanded */
  action: string;
  /** Enhanced status code, e.g. "5.1.1". */
  status?: string;
  diagnostic?: string;
}

export type ParsedReport =
  | { kind: "dsn"; recipients: DsnRecipient[]; originalEmailId?: string }
  | {
      kind: "complaint";
      feedbackType: string;
      originalRecipient?: string;
      originalEmailId?: string;
      originalMessageId?: string;
    }
  | { kind: "unstructured_bounce"; status?: string; diagnostic: string; originalEmailId?: string }
  | { kind: "other"; subject?: string; from?: string; autoReply: boolean };

const MAX_DEPTH = 6;

function splitHeaderBody(raw: string): [string, string] {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return [raw, ""];
  return [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

/** Parses a header block (RFC 5322 field lines, with folded continuations). */
export function parseHeaderBlock(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const lines = block.split(/\r?\n/);
  let current: string | null = null;
  const commit = () => {
    if (current === null) return;
    const colon = current.indexOf(":");
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      const value = current.slice(colon + 1).trim();
      headers.set(name, [...(headers.get(name) ?? []), value]);
    }
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== null) {
      current += " " + line.trim();
    } else {
      commit();
      current = line;
    }
  }
  commit();
  return headers;
}

const first = (headers: Map<string, string[]>, name: string) => headers.get(name.toLowerCase())?.[0];

function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) return { type: "text/plain", params: {} };
  const [type, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const param of rest) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    params[key] = param.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeQuotedPrintable(input: string): string {
  const bytes = input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

function decodeBody(body: string, encoding: string | undefined): string {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}

/** Parses an RFC 5322 message (or MIME part) into a tree of parts. */
export function parseMime(raw: string, depth = 0): MimePart {
  const [headerBlock, rawBody] = splitHeaderBody(raw);
  const headers = parseHeaderBlock(headerBlock);
  const { type, params } = parseContentType(first(headers, "content-type"));
  const part: MimePart = { headers, contentType: type, params, body: "", parts: [] };

  if (depth >= MAX_DEPTH) return part;

  if (type.startsWith("multipart/") && params.boundary) {
    const delimiter = `--${params.boundary}`;
    const sections = rawBody.split(delimiter);
    // sections[0] is the preamble; a section starting with "--" is the closing delimiter
    for (const section of sections.slice(1)) {
      if (section.startsWith("--")) break;
      part.parts.push(parseMime(section.replace(/^\r?\n/, ""), depth + 1));
    }
    return part;
  }

  const body = decodeBody(rawBody, first(headers, "content-transfer-encoding"));
  part.body = body;
  if (type === "message/rfc822" || type === "message/global") {
    part.embedded = parseMime(body, depth + 1);
  } else if (type === "text/rfc822-headers" || type === "message/rfc822-headers") {
    part.embedded = { headers: parseHeaderBlock(body.trim()), contentType: "text/plain", params: {}, body: "", parts: [] };
  }
  return part;
}

function* walk(part: MimePart): Generator<MimePart> {
  yield part;
  for (const child of part.parts) yield* walk(child);
}

const stripAddressType = (value: string) => value.replace(/^[a-z0-9-]+;\s*/i, "").replace(/^<|>$/g, "").trim().toLowerCase();

/** The X-TredMail-ID (or the TredMail Message-ID) of the original message quoted in a report. */
function findOriginalEmailId(root: MimePart): { emailId?: string; messageId?: string } {
  for (const part of walk(root)) {
    if (!part.embedded) continue;
    const id = first(part.embedded.headers, "x-tredmail-id");
    const messageId = first(part.embedded.headers, "message-id");
    if (id) return { emailId: id.trim().toLowerCase(), messageId };
    if (messageId) return { messageId };
  }
  return {};
}

/** Parses the field groups of a message/delivery-status body. */
export function parseDeliveryStatus(body: string): DsnRecipient[] {
  const groups = body.trim().split(/\r?\n\s*\r?\n/).map((g) => parseHeaderBlock(g.trim()));
  const recipients: DsnRecipient[] = [];
  for (const group of groups) {
    const finalRecipient = first(group, "final-recipient") ?? first(group, "original-recipient");
    const action = first(group, "action");
    if (!finalRecipient || !action) continue;
    const status = first(group, "status")?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0];
    const diagnostic = first(group, "diagnostic-code")?.replace(/^smtp;\s*/i, "");
    recipients.push({ recipient: stripAddressType(finalRecipient), action: action.trim().toLowerCase(), status, diagnostic });
  }
  return recipients;
}

const BOUNCE_SENDER = /^(<>|.*\b(mailer-daemon|postmaster|mail delivery (subsystem|system))\b)/i;
const BOUNCE_SUBJECT =
  /(undeliver|delivery (status )?notification|delivery (has )?failed|failure notice|returned mail|could not be delivered|mail delivery failed|non.?delivery)/i;

/** Classifies an inbound message as a bounce report, a complaint, or ordinary mail. */
export function parseInboundReport(raw: string): ParsedReport {
  const root = parseMime(raw);
  const original = findOriginalEmailId(root);

  for (const part of walk(root)) {
    if (part.contentType === "message/delivery-status" || part.contentType === "message/global-delivery-status") {
      return { kind: "dsn", recipients: parseDeliveryStatus(part.body), originalEmailId: original.emailId };
    }
    if (part.contentType === "message/feedback-report") {
      const fields = parseHeaderBlock(part.body.trim());
      const rcpt = first(fields, "original-rcpt-to");
      return {
        kind: "complaint",
        feedbackType: (first(fields, "feedback-type") ?? "abuse").trim().toLowerCase(),
        originalRecipient: rcpt ? stripAddressType(rcpt) : undefined,
        originalEmailId: original.emailId,
        originalMessageId: original.messageId,
      };
    }
  }

  const from = first(root.headers, "from");
  const subject = first(root.headers, "subject");
  const autoSubmitted = (first(root.headers, "auto-submitted") ?? "").toLowerCase();
  const autoReply = autoSubmitted === "auto-replied" || /^(auto|automatic reply|out of (the )?office)/i.test(subject ?? "");

  if (!autoReply && ((from && BOUNCE_SENDER.test(from)) || (subject && BOUNCE_SUBJECT.test(subject)))) {
    const text = [...walk(root)].filter((p) => p.contentType.startsWith("text/") && !p.embedded).map((p) => p.body).join("\n");
    const status = text.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/)?.[1];
    const line = text.split(/\r?\n/).find((l) => /\b[45]\d\d\b/.test(l)) ?? text.trim().split(/\r?\n/)[0] ?? "";
    return { kind: "unstructured_bounce", status, diagnostic: line.trim().slice(0, 500), originalEmailId: original.emailId };
  }

  return { kind: "other", subject, from, autoReply };
}
