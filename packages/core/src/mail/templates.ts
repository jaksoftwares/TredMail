/**
 * Branded templates for TredMail's own account emails (verification, password reset,
 * invitations). Colours and type follow the Dovepeak brand guideline: Deep Navy #000027,
 * Vibrant Orange #FF6300 (navy text on orange for contrast), Off-white #F8F8FF, Open Sans.
 * Logos are PNGs from the console's /brand folder (mail clients do not render SVG); every
 * image has alt text so the email still reads correctly when images are blocked.
 */

import { COMPANY } from "../config/company.js";
import { env } from "../config/env.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface LayoutOptions {
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Label/value pairs shown as a table after the paragraphs (invoice details) */
  rows?: Array<[string, string]>;
  cta?: { label: string; url: string };
  footnote?: string;
}

export function layout(options: LayoutOptions) {
  const { preheader, heading, paragraphs, rows, cta, footnote } = options;
  const brandUrl = `${env.CONSOLE_URL.replace(/\/+$/, "")}/brand`;
  const table = rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e4e4ef;border-radius:6px;border-collapse:separate;">${rows
        .map(
          ([label, value], i) =>
            `<tr><td style="padding:9px 12px;font-size:14px;color:#4a4a63;${i ? "border-top:1px solid #e4e4ef;" : ""}">${escapeHtml(label)}</td><td align="right" style="padding:9px 12px;font-size:14px;font-weight:700;color:#000027;${i ? "border-top:1px solid #e4e4ef;" : ""}">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const body =
    paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#000027;">${escapeHtml(p)}</p>`).join("") + table;
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:6px;background:#FF6300;">
         <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#000027;text-decoration:none;border-radius:6px;">${escapeHtml(cta.label)}</a>
       </td></tr></table>
       <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#4a4a63;">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(cta.url)}</span></p>`
    : "";
  const note = footnote
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#4a4a63;">${escapeHtml(footnote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#F8F8FF;font-family:'Open Sans',Arial,Helvetica,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F8FF;padding:24px 12px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e4e4ef;">
    <tr><td style="background:#000027;padding:18px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:12px;vertical-align:middle;"><img src="${brandUrl}/email-brandmark-on-dark.png" width="36" height="38" alt="" style="display:block;border:0;" /></td>
        <td style="vertical-align:middle;">
          <div style="font-size:18px;font-weight:800;line-height:1.2;color:#F8F8FF;letter-spacing:0.2px;">TredMail</div>
          <div style="font-size:12px;line-height:1.4;color:#c9c9e0;">by Dovepeak Technologies</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#000027;font-weight:700;">${escapeHtml(heading)}</h1>
      ${body}${button}${note}
    </td></tr>
  </table>
  <p style="margin:24px 0 8px;font-size:12px;color:#6b6b85;">A product of</p>
  <img src="${brandUrl}/email-dovepeak-logo.png" width="140" height="41" alt="Dovepeak Technologies" style="display:block;border:0;margin:0 auto;" />
  <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#6b6b85;">TredMail by ${COMPANY.name} · Transactional email infrastructure<br>${escapeHtml(COMPANY.postalAddress)}</p>
</td></tr></table>
</body></html>`;
}

export function verifyEmailTemplate(params: { name: string; url: string }): RenderedEmail {
  const heading = "Confirm your email address";
  const intro = `Hi ${params.name}, confirm this address to finish setting up your TredMail account.`;
  return {
    subject: "Confirm your TredMail email address",
    html: layout({
      preheader: "Confirm your email to start sending with TredMail.",
      heading,
      paragraphs: [intro],
      cta: { label: "Confirm email", url: params.url },
      footnote: "This link expires in 24 hours. If you did not create a TredMail account, you can ignore this email.",
    }),
    text: `${heading}\n\n${intro}\n\n${params.url}\n\nThis link expires in 24 hours. If you did not create a TredMail account, ignore this email.`,
  };
}

export function resetPasswordTemplate(params: { name: string; url: string }): RenderedEmail {
  const heading = "Reset your password";
  const intro = `Hi ${params.name}, we received a request to reset your TredMail password.`;
  return {
    subject: "Reset your TredMail password",
    html: layout({
      preheader: "Use this link to choose a new password.",
      heading,
      paragraphs: [intro],
      cta: { label: "Choose a new password", url: params.url },
      footnote: "This link expires in 1 hour. If you did not ask for this, ignore this email; your password stays the same.",
    }),
    text: `${heading}\n\n${intro}\n\n${params.url}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`,
  };
}

export function invitationTemplate(params: { inviterName: string; workspaceName: string; role: string; url: string }): RenderedEmail {
  const heading = `Join ${params.workspaceName} on TredMail`;
  const intro = `${params.inviterName} invited you to the ${params.workspaceName} workspace as ${params.role.toLowerCase()}.`;
  return {
    subject: `${params.inviterName} invited you to ${params.workspaceName} on TredMail`,
    html: layout({
      preheader: intro,
      heading,
      paragraphs: [intro, "TredMail is the Dovepeak Technologies platform for sending transactional email from your applications."],
      cta: { label: "Accept invitation", url: params.url },
      footnote: "This invitation expires in 7 days. Sign in or create an account with this email address to accept it.",
    }),
    text: `${heading}\n\n${intro}\n\nAccept: ${params.url}\n\nThis invitation expires in 7 days.`,
  };
}

export function sandboxWelcomeTemplate(params: { workspaceName: string }): RenderedEmail {
  const heading = "Your first TredMail email";
  const intro = `This test email was sent from the ${params.workspaceName} workspace using the TredMail sandbox.`;
  return {
    subject: "Your first email from TredMail",
    html: layout({
      preheader: "The API works. Next: verify your own domain.",
      heading,
      paragraphs: [
        intro,
        "The sandbox can send only to your workspace members. Verify your own domain to send to anyone, from your own address.",
      ],
    }),
    text: `${heading}\n\n${intro}\n\nThe sandbox can send only to your workspace members. Verify your own domain to send to anyone.`,
  };
}

export function operationsAlertTemplate(params: { title: string; summary: string; details: string[] }): RenderedEmail {
  return {
    subject: `[TredMail alert] ${params.title}`,
    html: layout({
      preheader: params.summary,
      heading: params.title,
      paragraphs: [params.summary, ...params.details],
      footnote: "You receive this because your address is TredMail's operations contact (OPS_EMAIL). Repeat alerts are held back for 6 hours.",
    }),
    text: `${params.title}\n\n${params.summary}\n\n${params.details.join("\n")}`,
  };
}
