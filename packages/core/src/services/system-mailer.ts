import { env } from "../config/env.js";
import type { RenderedEmail } from "../mail/templates.js";
import { acceptEmail, getPlatformOrganizationId } from "./email-service.js";

/**
 * Sends TredMail's own account emails (verification, password reset, invitations) through
 * the normal TredMail pipeline, from no-reply@<platform domain> in the platform workspace.
 * Tracking is off: these messages carry security links.
 */
export async function sendSystemEmail(to: string, email: RenderedEmail): Promise<void> {
  const platformId = await getPlatformOrganizationId();
  if (!platformId) {
    throw new Error("Platform workspace is missing. Run the seed before enabling sign-ups.");
  }

  const result = await acceptEmail(platformId, {
    from: `TredMail <no-reply@${env.PRIMARY_DOMAIN}>`,
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    track_opens: false,
    track_clicks: false,
    tags: [{ name: "category", value: "account" }],
  });

  if (!result.ok) {
    throw new Error(`System email to ${to} was not accepted: ${result.error} (${result.message})`);
  }
}
