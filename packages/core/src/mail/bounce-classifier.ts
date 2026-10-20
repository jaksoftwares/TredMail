/**
 * Decides what a delivery failure means. Only failures that prove the address itself is
 * bad (unknown user, non-existent domain) suppress the recipient. A spam block or policy
 * rejection says something about *our* reputation or content, so suppressing the
 * recipient would hide the real problem and lose a valid address.
 */

export type FailureCategory =
  | "invalid_recipient"
  | "bad_domain"
  | "mailbox_full"
  | "blocked"
  | "content"
  | "temporary"
  | "unknown";

export interface FailureClassification {
  category: FailureCategory;
  permanent: boolean;
  /** True when the recipient should be added to the suppression list. */
  suppress: boolean;
}

export interface FailureInput {
  /** Enhanced status code, e.g. "5.1.1". */
  status?: string;
  /** Basic SMTP reply code, e.g. 550. */
  smtpCode?: number;
  /** Server's diagnostic text. */
  diagnostic?: string;
  /** KumoMTA's bounce classifier label, when present. */
  mtaClassification?: string;
}

const MTA_CATEGORIES: Record<string, FailureCategory> = {
  InvalidRecipient: "invalid_recipient",
  InactiveMailbox: "invalid_recipient",
  BadDomain: "bad_domain",
  QuotaIssues: "mailbox_full",
  SpamBlock: "blocked",
  SpamContent: "content",
  VirusRelated: "content",
  ContentRelated: "content",
  PolicyRelated: "blocked",
  AuthFailure: "blocked",
  RelayDenied: "blocked",
  InvalidSender: "blocked",
  NoAnswerFromHost: "temporary",
  RoutingErrors: "bad_domain",
  ProtocolErrors: "temporary",
  MessageExpired: "temporary",
  TransientFailure: "temporary",
};

const TEXT_RULES: Array<[RegExp, FailureCategory]> = [
  // Reputation and policy blocks first: their text often also says "mailbox unavailable".
  [/spamhaus|blocklist|blacklist|block ?list|reputation|\bspam\b|listed (at|in|on)|banned sending ip|access denied|not allowed to send|policy (reasons|violation)|dmarc|spf|dkim/i, "blocked"],
  [/quota|mailbox (is )?full|over ?quota|insufficient (system )?storage|exceeded (the )?storage/i, "mailbox_full"],
  [/(domain|host) (name )?(not found|does not exist|unknown)|no (mx|mail exchanger)|unrouteable|unroutable|nxdomain|dns (error|failure)/i, "bad_domain"],
  [/(user|mailbox|recipient|address|account)\b[^.]{0,40}\b(unknown|not found|does ?n[o']t exist|no longer|unavailable|disabled|inactive|deactivated|suspended|invalid|rejected)|no such (user|mailbox|recipient|address)|invalid (recipient|mailbox|address)|unknown (user|recipient|mailbox)|undeliverable address/i, "invalid_recipient"],
  [/message (content|body)|attachment|virus|malware|content (rejected|policy)/i, "content"],
];

function categoryFromStatus(status: string): FailureCategory | null {
  const [, subject, detail] = status.split(".").map(Number);
  switch (subject) {
    case 1: // addressing
      if (detail === 2) return "bad_domain"; // destination system address invalid
      if (detail === 7 || detail === 8) return "blocked"; // bad sender address (our side)
      return "invalid_recipient"; // 5.1.0, 5.1.1, 5.1.3, 5.1.6, 5.1.10, ...
    case 2: // mailbox
      return detail === 2 || detail === 3 ? "mailbox_full" : "invalid_recipient"; // 5.2.1 disabled
    case 4: // network and routing
      return detail === 4 ? "bad_domain" : "temporary";
    case 6: // content
      return "content";
    case 7: // security and policy
      return "blocked";
    default:
      return null;
  }
}

export function classifyFailure(input: FailureInput): FailureClassification {
  const statusClass = input.status?.charAt(0);
  const permanent = statusClass ? statusClass === "5" : (input.smtpCode ?? 0) >= 500;

  let category: FailureCategory | null = null;
  // The text is more specific than generic codes like 5.0.0 or 550 without an enhanced code,
  // and catches policy blocks that are wrongly sent as 5.1.1.
  const textCategory = input.diagnostic ? (TEXT_RULES.find(([re]) => re.test(input.diagnostic!))?.[1] ?? null) : null;
  if (textCategory === "blocked" || textCategory === "content") category = textCategory;

  if (!category && input.mtaClassification && MTA_CATEGORIES[input.mtaClassification]) {
    category = MTA_CATEGORIES[input.mtaClassification];
  }
  if (!category && input.status && !/^\d\.0\.0$/.test(input.status)) category = categoryFromStatus(input.status);
  if (!category) category = textCategory;
  if (!category) category = permanent ? "unknown" : "temporary";

  const suppress = permanent && (category === "invalid_recipient" || category === "bad_domain");
  return { category, permanent, suppress };
}
