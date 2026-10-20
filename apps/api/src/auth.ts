import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins/two-factor";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { resetPasswordTemplate, verifyEmailTemplate } from "@tredmail/core/mail/templates";
import { sendSystemEmail } from "@tredmail/core/services/system-mailer";

const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

async function sendAccountEmail(kind: string, to: string, send: () => Promise<void>) {
  try {
    await send();
  } catch (err) {
    // Do not fail the sign-up or reset request; the user can ask for the email again.
    console.error(`[auth] could not send ${kind} email to ${to}`, err);
  }
}

/**
 * Console identity: email and password with mandatory verification, optional Google
 * sign-in, and TOTP two-factor. Auth routes are served through the console's origin
 * (it proxies /api/auth to this API), so session cookies are first-party.
 */
export const auth = betterAuth({
  appName: "TredMail",
  baseURL: env.CONSOLE_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  trustedOrigins: env.CORS_ORIGIN_LIST,
  telemetry: { enabled: false },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) =>
      sendAccountEmail("password reset", user.email, () =>
        sendSystemEmail(user.email, resetPasswordTemplate({ name: user.name, url }))
      ),
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) =>
      sendAccountEmail("verification", user.email, () =>
        sendSystemEmail(user.email, verifyEmailTemplate({ name: user.name, url }))
      ),
  },

  socialProviders: googleEnabled
    ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
    : {},

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily while in use
  },

  rateLimit: {
    enabled: env.NODE_ENV !== "test",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/send-verification-email": { window: 60, max: 3 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
    },
  },

  advanced: {
    ipAddress: { ipAddressHeaders: env.TRUST_PROXY ? ["x-forwarded-for"] : [] },
  },

  plugins: [twoFactor({ issuer: "TredMail" })],
});

export type AuthSession = typeof auth.$Infer.Session;
