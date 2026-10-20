import type { Metadata } from "next";
import Link from "next/link";
import { BrandFrame } from "@/components/brand";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <BrandFrame>
      <p className="text-xs font-bold uppercase tracking-wider text-subtle">Error 404</p>
      <h1 className="mt-1 text-xl font-bold text-navy">Page not found</h1>
      <p className="mt-2 text-sm text-muted">The page you are looking for does not exist or has moved.</p>
      <Link
        href="/overview"
        className="mt-6 inline-flex items-center rounded-md bg-orange px-4 py-2 text-sm font-bold text-navy hover:bg-orange-600"
      >
        Go to the console
      </Link>
    </BrandFrame>
  );
}
