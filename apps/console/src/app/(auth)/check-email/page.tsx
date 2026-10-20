import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckEmail } from "@/components/auth-forms";
import { Spinner } from "@/components/ui";

export const metadata: Metadata = { title: "Check your inbox" };

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <CheckEmail />
    </Suspense>
  );
}
