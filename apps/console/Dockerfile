# TredMail console (Next.js standalone output)

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
# Baked into the client bundle at build time
ARG NEXT_PUBLIC_GOOGLE_SIGN_IN=false
ENV NEXT_PUBLIC_GOOGLE_SIGN_IN=$NEXT_PUBLIC_GOOGLE_SIGN_IN
# Fallback proxy target if requests reach Next instead of Caddy's /api and /v1 routes
ARG TREDMAIL_API_INTERNAL_URL=http://api:3000
ENV TREDMAIL_API_INTERNAL_URL=$TREDMAIL_API_INTERNAL_URL
# Public console address; makes link-preview (Open Graph) image URLs absolute
ARG CONSOLE_URL=http://localhost:3010
ENV CONSOLE_URL=$CONSOLE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
