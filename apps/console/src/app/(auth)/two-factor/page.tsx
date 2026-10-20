import type { Metadata } from "next";
import { Suspense } from "react";
import { TwoFactorForm } from "@/components/auth-forms";
import { Spinner } from "@/components/ui";

export const metadata: Metadata = { title: "Two-step verification" };

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <TwoFactorForm />
    </Suspense>
  );
}
