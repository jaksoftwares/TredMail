# -------------------------------------------------------------
# Stage 1: Build Application & Console
# -------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies for both root and console
COPY package*.json ./
COPY console/package*.json ./console/
COPY prisma ./prisma/

RUN npm install
RUN cd console && npm install

# Copy source files
COPY tsconfig.json ./
COPY src ./src/
COPY console ./console/

# Generate Prisma Client & compile TypeScript
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm run build
RUN cd console && npm run build

# -------------------------------------------------------------
# Stage 2: Production Lightweight Runtime
# -------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy generated Prisma artifacts & compiled code
COPY prisma ./prisma/
RUN npx prisma generate --schema=prisma/schema.prisma

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/console/dist ./console/dist/

# Expose API and Console
EXPOSE 3000

# Start production API and BullMQ worker
CMD ["node", "dist/api/server.js"]
