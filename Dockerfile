# TredMail API and worker image (one image, two commands).

# ---------------------------------------------------------------
# Build: install the workspace, generate Prisma, bundle the apps
# ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk-node/package.json packages/sdk-node/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN npm run db:generate && npm run build

# ---------------------------------------------------------------
# Runtime: production dependencies and bundled output only
# ---------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk-node/package.json packages/sdk-node/
RUN npm ci --omit=dev && npm cache clean --force

# Schema and migrations are needed at runtime for `prisma migrate deploy`.
COPY packages/db/prisma ./packages/db/prisma
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

USER node
EXPOSE 3000

# API by default; the worker service overrides the command.
CMD ["node", "apps/api/dist/server.js"]
