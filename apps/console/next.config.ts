import type { NextConfig } from "next";

// Where the console forwards API and auth calls in development. In production, Caddy routes
// /api/* and /v1/* on the console host straight to the API, so these rewrites are a fallback.
const apiUrl = (process.env.TREDMAIL_API_INTERNAL_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// Content-Security-Policy. Scripts, API calls and fonts (next/font self-hosts them) come from
// this origin only. Images and fonts may be remote because the sandboxed email and template
// previews (iframe srcdoc) inherit this policy and customers' emails load their own. Next.js
// injects inline scripts without nonces, hence 'unsafe-inline'. Production only: `next dev`
// needs eval.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
