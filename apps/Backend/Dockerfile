FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# Client generation validates the URL shape but does not connect during image build.
# Runtime and migration containers replace this credential-free placeholder from a secret.
RUN DATABASE_URL=postgresql://localhost/build npm run build

# Standalone image for running `prisma migrate deploy` as its own job/service,
# e.g. `docker build --target migration` or a separate Railway service.
FROM dependencies AS migration
ENV NODE_ENV=production
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["npm", "run", "prisma:migrate:deploy"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    DATABASE_PROVIDER=postgres
WORKDIR /app
COPY package*.json ./
# Full install (not --omit=dev): the Prisma CLI (a devDependency) is needed at
# startup to run `prisma migrate deploy` before the server boots below.
RUN npm ci
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
COPY scripts/migrate-before-start.mjs ./scripts/migrate-before-start.mjs
COPY scripts/build-before-start.mjs ./scripts/build-before-start.mjs
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
# Applies any pending migrations (idempotent; a no-op once the schema is
# current) and then starts the server. Railway injects PORT, DATABASE_URL,
# and the other runtime env vars directly, so this never depends on a local
# .env file.
CMD ["sh", "-c", "node scripts/migrate-before-start.mjs && node dist/src/bootstrap/server.js"]
