"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, Button, Field, Input } from "@/components/ui";

/** Only allow same-site relative paths as post-login destinations. */
export function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/overview";
}

function authError(error: { message?: string; status?: number; code?: string } | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  return error.message ?? "Something went wrong. Try again.";
}

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setUnverified(false);
    const { data, error } = await authClient.signIn.email({ email, password });
    setLoading(false);
    if (error) {
      if (error.status === 403) setUnverified(true);
      setError(error.status === 401 ? "Email or password is incorrect." : authError(error));
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return; // client plugin redirects
    router.replace(next);
  }

  async function resend() {
    await authClient.sendVerificationEmail({ email, callbackURL: next });
    router.push(`/check-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Welcome back to TredMail.</p>
      </div>
      {error && (
        <Alert tone="danger">
          {error}
          {unverified && (
            <button type="button" onClick={resend} className="ml-1 font-semibold underline">
              Resend the verification email
            </button>
          )}
        </Alert>
      )}
      <Field label="Email">
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-sm font-semibold text-navy underline-offset-2 hover:underline">
          Forgot password?
        </Link>
      </div>
      <Button type="submit" className="w-full" loading={loading}>
        Sign in
      </Button>
      <GoogleButton next={next} />
      <p className="text-center text-sm text-muted">
        New to TredMail?{" "}
        <Link href={`/sign-up${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-navy underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError("Use at least 10 characters for your password.");
      return;
    }
    setLoading(true);
    setError(null);
    const { error } = await authClient.signUp.email({ name, email, password, callbackURL: next });
    setLoading(false);
    if (error) {
      setError(authError(error));
      return;
    }
    router.push(`/check-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Send your first email in a few minutes, before any DNS setup.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Full name">
        <Input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Work email">
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" hint="At least 10 characters.">
        <Input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" className="w-full" loading={loading}>
        Create account
      </Button>
      <GoogleButton next={next} />
      <p className="text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href={`/sign-in${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-navy underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

function GoogleButton({ next }: { next: string }) {
  if (process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN !== "true") return null;
  return (
    <Button
      type="button"
      variant="secondary"
      className="w-full"
      onClick={() => authClient.signIn.social({ provider: "google", callbackURL: next })}
    >
      Continue with Google
    </Button>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setLoading(false);
    setSent(true); // same message whether or not the account exists
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">We will email you a link to choose a new one.</p>
      </div>
      {sent ? (
        <Alert tone="success">If an account exists for {email}, a reset link is on its way. It expires in 1 hour.</Alert>
      ) : (
        <>
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={loading}>
            Send reset link
          </Button>
        </>
      )}
      <p className="text-center text-sm">
        <Link href="/sign-in" className="font-semibold text-navy underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error") ? "This reset link is invalid or has expired." : null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (error) {
      setError(authError(error));
      return;
    }
    router.replace("/sign-in?reset=1");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-xl font-bold">Choose a new password</h1>
      {error && <Alert tone="danger">{error}</Alert>}
      {!token ? (
        <Alert tone="danger">This reset link is missing its token. Request a new one.</Alert>
      ) : (
        <>
          <Field label="New password" hint="At least 10 characters. You will be signed out everywhere else.">
            <Input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={loading}>
            Save password
          </Button>
        </>
      )}
    </form>
  );
}

export function CheckEmail() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [resent, setResent] = useState(false);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Check your inbox</h1>
      <p className="text-sm text-muted">
        We sent a confirmation link to <span className="font-semibold text-navy">{email || "your email"}</span>. Open it to finish setting up your account. The link
        expires in 24 hours.
      </p>
      {resent && <Alert tone="success">A new link is on its way.</Alert>}
      {email && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={async () => {
            await authClient.sendVerificationEmail({ email, callbackURL: "/overview" });
            setResent(true);
          }}
        >
          Resend the email
        </Button>
      )}
      <p className="text-center text-sm">
        <Link href="/sign-in" className="font-semibold text-navy underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export function TwoFactorForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, ""), trustDevice: trust });
    setLoading(false);
    if (error) {
      setError(error.status === 401 ? "That code is not valid." : authError(error));
      return;
    }
    router.replace(next);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Two-step verification</h1>
        <p className="mt-1 text-sm text-muted">
          {useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={useBackup ? "Backup code" : "Authentication code"}>
        <Input
          inputMode={useBackup ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="size-4 accent-orange" />
        Trust this device for 30 days
      </label>
      <Button type="submit" className="w-full" loading={loading}>
        Verify
      </Button>
      <button type="button" className="w-full text-center text-sm font-semibold text-navy underline" onClick={() => setUseBackup(!useBackup)}>
        {useBackup ? "Use an authenticator code" : "Use a backup code instead"}
      </button>
    </form>
  );
}
