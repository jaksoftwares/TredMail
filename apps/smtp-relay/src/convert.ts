import type { AddressObject, ParsedMail } from "mailparser";
import type { SendEmailInput } from "@tredmail/core/services/email-validation";

/**
 * Turns a message submitted over SMTP into one or more API send requests.
 *
 * The SMTP envelope decides who receives the message: header To/Cc addresses that are not
 * envelope recipients are dropped, and envelope recipients missing from To/Cc become Bcc.
 * A message with no To/Cc recipient at all (Bcc only) is split into one email per
 * recipient, so no recipient's address is shown to the others.
 *
 * TredMail options travel as headers, which are removed before sending:
 *   X-TredMail-Tags: category=receipt, plan=pro
 *   X-TredMail-Track-Opens: false        X-TredMail-Track-Clicks: false
 *   X-TredMail-Scheduled-At: 2026-11-01T09:00:00Z
 */

const MAX_CUSTOM_HEADERS = 30;

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
  [field ?? []]
    .flat()
    .flatMap((group) => group.value)
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .map((entry) => entry.address?.trim().toLowerCase())
    .filter((address): address is string => !!address);

const formatAddress = (field: AddressObject | AddressObject[] | undefined): string | undefined => {
  const first = [field ?? []].flat()[0]?.value[0];
  if (!first?.address) return undefined;
  return first.name ? `${first.name.replace(/["<>]/g, "")} <${first.address}>` : first.address;
};

function headerText(parsed: ParsedMail, name: string): string | undefined {
  const value = parsed.headers.get(name);
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String((value as { text?: string }).text ?? value);
}

function parseTags(value: string | undefined): Array<{ name: string; value: string }> | undefined {
  if (!value) return undefined;
  const tags = value
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([name, tagValue]) => name && tagValue)
    .map(([name, tagValue]) => ({ name: name.slice(0, 256), value: tagValue.slice(0, 256) }));
  return tags.length ? tags.slice(0, 50) : undefined;
}

const parseBool = (value: string | undefined) => (value === undefined ? undefined : !/^(false|0|no|off)$/i.test(value.trim()));

/** Custom X- headers the caller set (TredMail's own and reserved ones are left out). */
function customHeaders(parsed: ParsedMail): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of parsed.headerLines) {
    const name = line.line.slice(0, line.line.indexOf(":")).trim();
    if (!/^x-/i.test(name) || /^x-tredmail-/i.test(name) || /^x-(mailer|originating-ip)$/i.test(name)) continue;
    if (Object.keys(headers).length >= MAX_CUSTOM_HEADERS) break;
    headers[name] = line.line.slice(line.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}

export interface Envelope {
  mailFrom: string;
  rcptTo: string[];
}

export function toSendRequests(parsed: ParsedMail, envelope: Envelope): SendEmailInput[] {
  const recipients = [...new Set(envelope.rcptTo.map((r) => r.toLowerCase()))];
  const inEnvelope = new Set(recipients);
  const to = addresses(parsed.to).filter((a) => inEnvelope.has(a));
  const cc = addresses(parsed.cc).filter((a) => inEnvelope.has(a) && !to.includes(a));
  const bcc = recipients.filter((a) => !to.includes(a) && !cc.includes(a));

  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const base: Omit<SendEmailInput, "to"> = {
    from: formatAddress(parsed.from) ?? envelope.mailFrom,
    reply_to: addresses(parsed.replyTo)[0],
    subject: parsed.subject ?? "(no subject)",
    html,
    text: parsed.text?.trim() ? parsed.text : undefined,
    headers: customHeaders(parsed),
    tags: parseTags(headerText(parsed, "x-tredmail-tags")),
    track_opens: parseBool(headerText(parsed, "x-tredmail-track-opens")),
    track_clicks: parseBool(headerText(parsed, "x-tredmail-track-clicks")),
    scheduled_at: headerText(parsed, "x-tredmail-scheduled-at")?.trim() || undefined,
    attachments: parsed.attachments.length
      ? parsed.attachments.map((a) => ({
          filename: a.filename ?? "attachment",
          content: a.content.toString("base64"),
          content_type: a.contentType,
          content_id: a.related || a.contentDisposition === "inline" ? a.cid ?? undefined : undefined,
        }))
      : undefined,
  };

  if (to.length === 0 && cc.length === 0) {
    return bcc.map((recipient) => ({ ...base, to: [recipient] }));
  }
  return [{ ...base, to: to.length ? to : cc, cc: to.length ? cc : undefined, bcc: bcc.length ? bcc : undefined }];
}
