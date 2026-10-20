"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { WORKSPACE_STORAGE_KEY, api, ApiError, errorMessage } from "@/lib/api";
import { Alert, Button, Field, Input, Spinner, Textarea } from "@/components/ui";

interface MeLite {
  user: { name: string; emailVerified: boolean };
  workspaces: { id: string }[];
}

export default function OnboardingPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeLite | null>(null);
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<MeLite>("/v1/me")
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/sign-in?next=/onboarding");
        else setError(errorMessage(err));
      });
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/v1/workspaces", {
        method: "POST",
        body: { name, use_case: useCase || undefined, website: website || undefined },
      });
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, created.id);
      } catch {
        // ignore unavailable storage
      }
      router.replace("/overview");
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  if (!me && !error) return <Spinner />;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-orange-600">Step 1 of 2</p>
        <h1 className="text-xl font-bold">Create your workspace</h1>
        <p className="mt-1 text-sm text-muted">
          A workspace holds your domains, API keys and email logs. You can invite your team to it next.
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Workspace name" hint="Usually your company or product name.">
        <Input required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
      </Field>
      <Field label="What will you send?" hint="For example: password resets, receipts, notifications. Helps us set your sending limits.">
        <Textarea rows={3} maxLength={500} value={useCase} onChange={(e) => setUseCase(e.target.value)} />
      </Field>
      <Field label="Website (optional)">
        <Input type="url" placeholder="https://" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </Field>
      <Button type="submit" className="w-full" loading={loading}>
        Create workspace
      </Button>
    </form>
  );
}
