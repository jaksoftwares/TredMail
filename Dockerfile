# TredMail backend image: API, worker and SMTP relay (one image, three commands).

# ---------------------------------------------------------------
# Build: install the workspace, generate Prisma, bundle the apps
# ---------------------------------------------------------------
FROM node:22-alpine AS builder
# Prisma's engines need OpenSSL on Alpine; it must be present before npm installs them.
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/smtp-relay/package.json apps/smtp-relay/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk-node/package.json packages/sdk-node/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/smtp-relay ./apps/smtp-relay
RUN npm run db:generate && npm run build

# ---------------------------------------------------------------
# Runtime: production dependencies and bundled output only
# ---------------------------------------------------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/smtp-relay/package.json apps/smtp-relay/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk-node/package.json packages/sdk-node/
RUN npm ci --omit=dev && npm cache clean --force

# Schema and migrations are needed at runtime for `prisma migrate deploy`.
COPY packages/db/prisma ./packages/db/prisma
# Generate the client and fetch the migration engine now, as root, so `prisma migrate deploy`
# works at run time for the unprivileged node user.
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma  && npx prisma -v > /dev/null

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/smtp-relay/dist ./apps/smtp-relay/dist

USER node
EXPOSE 3000

# API by default; the worker service overrides the command.
CMD ["node", "apps/api/dist/server.js"]
