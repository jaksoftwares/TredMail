"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/** Talks to /api/auth on this origin; the console proxies it to the TredMail API. */
export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.href = next ? `/two-factor?next=${encodeURIComponent(next)}` : "/two-factor";
      },
    }),
  ],
});
