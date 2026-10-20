"use client";

import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, Field, Input } from "@/components/ui";

type Notice = { ok: boolean; message: string } | null;

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setNotice(null);
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setLoading(false);
    if (error) {
      setNotice({ ok: false, message: error.message ?? "Could not change the password." });
      return;
    }
    setCurrent("");
    setNext("");
    setNotice({ ok: true, message: "Password changed. Other devices have been signed out." });
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-4">
        <h2 className="font-bold">Password</h2>
        {notice && <Alert tone={notice.ok ? "success" : "danger"}>{notice.message}</Alert>}
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <Input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Button type="submit" loading={loading}>Change password</Button>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const { me, refreshMe } = useWorkspace();
  const enabled = Boolean(me.user.twoFactorEnabled);
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!setup) return;
    QRCode.toDataURL(setup.uri, { margin: 1, width: 192, color: { dark: "#000027", light: "#ffffff" } }).then(setQr, () => setQr(null));
  }, [setup]);

  async function start(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setNotice(null);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setLoading(false);
    if (error || !data || data.method !== "totp") {
      setNotice({ ok: false, message: error?.message ?? "Could not start setup." });
      return;
    }
    setPassword("");
    setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
  }

  async function confirmCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setLoading(false);
    if (error) {
      setNotice({ ok: false, message: "That code is not valid. Check your device's clock and try again." });
      return;
    }
    setSetup(null);
    setCode("");
    setNotice({ ok: true, message: "Two-step verification is on." });
    refreshMe();
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await authClient.twoFactor.disable({ password });
    setLoading(false);
    if (error) {
      setNotice({ ok: false, message: error.message ?? "Could not turn off two-step verification." });
      return;
    }
    setPassword("");
    setNotice({ ok: true, message: "Two-step verification is off." });
    refreshMe();
  }

  const secret = setup ? new URL(setup.uri).searchParams.get("secret") ?? "" : "";

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-bold">Two-step verification</h2>
        {enabled ? <Badge tone="success">on</Badge> : <Badge tone="warning">off</Badge>}
      </div>
      <p className="mb-4 text-sm text-muted">Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy) when you sign in.</p>
      {notice && <div className="mb-4"><Alert tone={notice.ok ? "success" : "danger"}>{notice.message}</Alert></div>}

      {setup ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            {qr && <img src={qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded border border-line" />}
            <div className="min-w-0 text-sm">
              <p className="font-semibold">1. Scan the code, or enter this key:</p>
              <div className="mt-2 flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-offwhite px-3 py-2 font-mono text-xs">{secret}</code>
                <CopyButton value={secret} />
              </div>
              <p className="mt-4 font-semibold">2. Save your backup codes somewhere safe:</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
                {setup.backupCodes.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>
          <form onSubmit={confirmCode} className="space-y-3">
            <Field label="3. Enter the 6-digit code to finish">
              <Input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="max-w-48" />
            </Field>
            <Button type="submit" loading={loading}>Turn on</Button>
          </form>
        </div>
      ) : (
        <form onSubmit={enabled ? disable : start} className="space-y-3">
          <Field label="Confirm your password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="max-w-sm" />
          </Field>
          <Button type="submit" variant={enabled ? "danger" : "primary"} loading={loading}>
            {enabled ? "Turn off" : "Set up two-step verification"}
          </Button>
        </form>
      )}
    </Card>
  );
}

export default function SecuritySettingsPage() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ChangePassword />
      <TwoFactor />
    </div>
  );
}
