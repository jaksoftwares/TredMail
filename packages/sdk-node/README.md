# @dovepeak/tredmail

Node.js SDK for TredMail, the transactional email API by Dovepeak Technologies. Node 18+, TypeScript types included, ESM and CommonJS builds.

```ts
import { TredMail, verifyWebhook } from "@dovepeak/tredmail";

const tredmail = new TredMail({ apiKey: process.env.TREDMAIL_API_KEY! });
const { data, error } = await tredmail.emails.send(
  { from: "Dovepeak <billing@your-domain.com>", to: "customer@example.com", subject: "Receipt", html: "<p>Thanks</p>" },
  { idempotencyKey: "receipt-10293" },
);
```

Every method returns `{ data, error }`. Resources: `emails`, `templates`, `domains`, `webhooks`, `suppressions`, `apiKeys`, `stats`. `verifyWebhook()` checks Standard Webhooks signatures.

Build: `npm run build -w @dovepeak/tredmail` (output in `dist/`). Full guide: console `/docs/sdks`.
