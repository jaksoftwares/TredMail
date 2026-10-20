"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WORKSPACE_STORAGE_KEY, api, ApiError, errorMessage } from "@/lib/api";
import { Alert, Button, Spinner } from "@/components/ui";

interface Invitation {
  workspace: string;
  email: string;
  role: string;
  invited_by: string | null;
}

function InvitePageContent() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    api<Invitation>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setInvitation)
      .catch((err) => setError(errorMessage(err)));
    api<{ user: { email: string } }>("/v1/me")
      .then((me) => setSignedInAs(me.user.email))
      .catch((err) => setSignedInAs(err instanceof ApiError && err.status === 401 ? null : null));
  }, [token]);

  async function accept() {
    setAccepting(true);
    setError(null);
    try {
      const result = await api<{ workspace_id: string }>("/v1/invitations/accept", { method: "POST", body: { token } });
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, result.workspace_id);
      } catch {
        // ignore unavailable storage
      }
      router.replace("/overview");
    } catch (err) {
      setError(errorMessage(err));
      setAccepting(false);
    }
  }

  if (error && !invitation) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Invitation unavailable</h1>
        <Alert tone="danger">{error}</Alert>
        <p className="text-sm text-muted">Ask the person who invited you to send a new invitation.</p>
      </div>
    );
  }
  if (!invitation || signedInAs === undefined) return <Spinner />;

  const next = encodeURIComponent(`/invite/${token}`);
  const wrongAccount = signedInAs && signedInAs !== invitation.email;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Join {invitation.workspace}</h1>
      <p className="text-sm text-muted">
        {invitation.invited_by ?? "A teammate"} invited <span className="font-semibold text-navy">{invitation.email}</span> to the{" "}
        {invitation.workspace} workspace as {invitation.role.toLowerCase()}.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {!signedInAs && (
        <div className="space-y-2">
          <Link href={`/sign-up?next=${next}&email=${encodeURIComponent(invitation.email)}`}>
            <Button className="w-full">Create an account to accept</Button>
          </Link>
          <Link href={`/sign-in?next=${next}`}>
            <Button variant="secondary" className="w-full">
              I already have an account
            </Button>
          </Link>
        </div>
      )}
      {wrongAccount && (
        <Alert tone="warning">
          You are signed in as {signedInAs}. Sign out and sign in as {invitation.email} to accept this invitation.
        </Alert>
      )}
      {signedInAs && !wrongAccount && (
        <Button className="w-full" onClick={accept} loading={accepting}>
          Accept invitation
        </Button>
      )}
    </div>
  );
}

// useParams() reads URL data that only exists at request time, so it must render inside Suspense.
export default function InvitePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <InvitePageContent />
    </Suspense>
  );
}
