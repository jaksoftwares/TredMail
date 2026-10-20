/**
 * End-to-end check of console accounts against the local dev stack (API, worker, Mailpit).
 *
 *   npm run test:accounts
 *
 * Walks the Phase 1 gate: a new person signs up, verifies their email, creates a workspace and
 * sends a sandbox email to themselves; then invitations, roles, CSRF and sandbox limits.
 * Uses fresh random addresses each run.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

const API_URL = (process.env.TREDMAIL_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://localhost:8035").replace(/\/+$/, "");
const CONSOLE_ORIGIN = process.env.CONSOLE_ORIGIN ?? "http://localhost:3001";
const PLATFORM_DOMAIN = process.env.PRIMARY_DOMAIN ?? "tredmail.dovepeak.com";

type Json = Record<string, any>;

/** Minimal cookie jar for one browser session. */
class Session {
  private cookies = new Map<string, string>();
  workspaceId?: string;

  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(path: string, init: RequestInit & { origin?: string | null; workspace?: boolean } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Cookie: this.header() };
    if (init.origin !== null) headers.Origin = init.origin ?? CONSOLE_ORIGIN;
    if (init.workspace !== false && this.workspaceId) headers["x-tredmail-workspace"] = this.workspaceId;
    const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, redirect: "manual" });
    this.store(res);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json, res };
  }
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mailTo(address: string, subjectContains: string): Promise<Json> {
  return waitFor(`email '${subjectContains}' to ${address}`, async () => {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const found = ((await res.json()) as Json).messages?.find((m: Json) => m.Subject.includes(subjectContains));
    return found ? ((await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)).json()) as Json) : undefined;
  });
}

function linkIn(message: Json, pattern: RegExp): string {
  const match = (message.Text as string).match(pattern);
  assert.ok(match, `link matching ${pattern} found in email`);
  return match[0];
}

const step = (message: string) => console.log(`- ${message}`);

async function signUpAndVerify(email: string, name: string): Promise<Session> {
  const session = new Session();
  const password = `Pw-${crypto.randomBytes(9).toString("base64url")}`;

  const signUp = await session.request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  assert.equal(signUp.status, 200, `sign-up failed: ${JSON.stringify(signUp.body)}`);

  const early = await new Session().request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assert.equal(early.status, 403, "sign-in is refused until the email is verified");

  const verifyEmail = await mailTo(email, "Confirm your TredMail email");
  const link = linkIn(verifyEmail, /https?:\/\/\S+\/api\/auth\/verify-email\S+/);
  const verifyUrl = new URL(link);
  const verified = await session.request(`${verifyUrl.pathname}${verifyUrl.search}`, { origin: null });
  assert.ok([200, 302].includes(verified.status), `verification failed (${verified.status})`);

  const me = await session.request("/v1/me", { origin: null });
  assert.equal(me.status, 200, "signed in after verification");
  assert.equal(me.body.user.emailVerified, true);
  return session;
}

async function main() {
  const run = crypto.randomBytes(4).toString("hex");
  const ownerEmail = `owner-${run}@example.test`;
  const devEmail = `dev-${run}@example.test`;

  // 1. Sign-up, verification, first workspace
  const owner = await signUpAndVerify(ownerEmail, "Owner Test");
  step("owner signed up; sign-in blocked until verified; verification link signs them in");

  const noOrigin = await owner.request("/v1/workspaces", { method: "POST", origin: null, body: JSON.stringify({ name: "x" }) });
  assert.equal(noOrigin.status, 403, "cookie writes without the console origin are refused (CSRF)");

  const created = await owner.request("/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: `Acme ${run}`, use_case: "Password resets and receipts" }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  owner.workspaceId = created.body.id;
  step(`workspace created (${created.body.slug}); CSRF check holds`);

  // 2. Sandbox: first email without any DNS work
  const test = await owner.request("/v1/onboarding/test-email", { method: "POST", body: "{}" });
  assert.equal(test.status, 200, JSON.stringify(test.body));
  const welcome = await mailTo(ownerEmail, "Your first email from TredMail");
  const headers = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${welcome.ID}/headers`)).json()) as Json;
  assert.ok(headers["Dkim-Signature"]?.[0]?.includes(`d=${PLATFORM_DOMAIN}`), "sandbox email is DKIM-signed");
  step("sandbox test email delivered to the owner, DKIM-signed");

  const stranger = await owner.request("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: `onboarding@${PLATFORM_DOMAIN}`, to: "someone@example.org", subject: "x", text: "x" }),
  });
  assert.equal(stranger.body.error, "sandbox_recipient_not_allowed");
  const spoof = await owner.request("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: `no-reply@${PLATFORM_DOMAIN}`, to: ownerEmail, subject: "x", text: "x" }),
  });
  assert.equal(spoof.body.error, "sandbox_sender_only");
  step("sandbox refuses strangers and other platform addresses");

  // 3. API key created from the console works for the same workspace
  const key = await owner.request("/v1/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: "ci", scopes: ["emails:send"] }),
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const viaKey = await fetch(`${API_URL}/v1/emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.body.token}` },
    body: JSON.stringify({ from: `onboarding@${PLATFORM_DOMAIN}`, to: ownerEmail, subject: "Via API key", text: "ok" }),
  });
  assert.equal(viaKey.status, 200, "API key from the console can send in the sandbox");
  step("console-created API key sends through the API");

  // 4. Invitation, roles and permissions
  const invite = await owner.request("/v1/invitations", {
    method: "POST",
    body: JSON.stringify({ email: devEmail, role: "DEVELOPER" }),
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.email_sent, true);

  const developer = await signUpAndVerify(devEmail, "Dev Test");
  const inviteMail = await mailTo(devEmail, "invited you to");
  const token = linkIn(inviteMail, /\/invite\/[A-Za-z0-9_-]+/).split("/").pop()!;

  const lookup = await fetch(`${API_URL}/v1/invitations/lookup?token=${token}`);
  assert.equal(((await lookup.json()) as Json).role, "DEVELOPER");

  const accepted = await developer.request("/v1/invitations/accept", { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  developer.workspaceId = accepted.body.workspace_id;
  const reuse = await developer.request("/v1/invitations/accept", { method: "POST", body: JSON.stringify({ token }) });
  assert.equal(reuse.status, 404, "an invitation works once");
  step("developer invited by email, signed up and joined; invitation single-use");

  const devKey = await developer.request("/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "x" }) });
  assert.equal(devKey.status, 403, "developers cannot create API keys");
  const members = await developer.request("/v1/members");
  assert.equal(members.body.data.length, 2);
  const ownerMember = members.body.data.find((m: Json) => m.role === "OWNER");
  const demote = await developer.request(`/v1/members/${ownerMember.id}`, { method: "PATCH", body: JSON.stringify({ role: "VIEWER" }) });
  assert.equal(demote.status, 403, "developers cannot change roles");
  const devSandbox = await developer.request("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: `onboarding@${PLATFORM_DOMAIN}`, to: ownerEmail, subject: "Hi from dev", text: "member to member" }),
  });
  assert.equal(devSandbox.status, 200, "sandbox may email any verified member");
  step("role permissions enforced; sandbox reaches other verified members");

  const lastOwner = await owner.request(`/v1/members/${ownerMember.id}`, { method: "DELETE" });
  assert.equal(lastOwner.status, 409, "the last owner cannot leave");

  const outsider = new Session();
  outsider.workspaceId = owner.workspaceId;
  const foreign = await signUpAndVerify(`outsider-${run}@example.test`, "Outsider");
  foreign.workspaceId = owner.workspaceId;
  const intrude = await foreign.request("/v1/domains");
  assert.equal(intrude.status, 403, "non-members cannot act in a workspace");
  step("last-owner protection and workspace isolation hold");

  const audit = await owner.request("/v1/audit-logs");
  const actions = audit.body.data.map((e: Json) => e.action);
  for (const expected of ["workspace.created", "api_key.created", "invitation.created", "invitation.accepted"]) {
    assert.ok(actions.includes(expected), `audit log has ${expected}`);
  }
  step(`audit log recorded ${actions.length} entries`);

  console.log("\nAccounts test passed.");
}

main().catch((err) => {
  console.error(`\nAccounts test failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
