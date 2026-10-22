# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
COPY apps/sp-api/package.json apps/sp-api/package.json
COPY apps/sp-web/package.json apps/sp-web/package.json
RUN corepack enable && pnpm install --frozen-lockfile
RUN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sp?schema=public \
  ./node_modules/.bin/prisma generate --schema /app/prisma/schema.prisma

FROM deps AS build
COPY . .
RUN pnpm --filter sp-api build
RUN pnpm --filter sp-web build

# Only what the running app needs: the API's production dependencies and
# Prisma (migrations run at start). Build and test tools stay behind, which
# halves node_modules and leaves nothing in the image that only builds use.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
COPY apps/sp-api/package.json apps/sp-api/package.json
COPY apps/sp-web/package.json apps/sp-web/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter stashboard --filter sp-api
RUN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sp?schema=public \
  ./node_modules/.bin/prisma generate --schema /app/prisma/schema.prisma

FROM node:24-alpine AS runtime
WORKDIR /app
# su-exec: start-app drops from root to PUID:PGID before starting the app.
RUN apk add --no-cache openssl su-exec
RUN mkdir -p /var/lib/stashboard && chmod 700 /var/lib/stashboard
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/sp-api/package.json ./apps/sp-api/package.json
COPY --from=prod-deps /app/apps/sp-api/node_modules ./apps/sp-api/node_modules
COPY --from=build /app/apps/sp-api/dist ./apps/sp-api/dist
COPY --from=build /app/apps/sp-web/dist ./apps/sp-web/dist
COPY --from=build /app/prisma ./prisma
COPY infrastructure/docker/healthcheck.mjs /usr/local/bin/healthcheck.mjs
COPY infrastructure/docker/start-app.sh /usr/local/bin/start-app
RUN chmod +x /usr/local/bin/start-app
# What Settings → About & health shows: the version, the exact commit and
# when the image was built. Set by the publish workflow; last, so a new
# commit doesn't invalidate the cached layers above.
ARG STASHBOARD_VERSION=0.0.0-dev
ARG STASHBOARD_COMMIT=dev
ARG STASHBOARD_BUILT_AT=dev
ARG STASHBOARD_REPOSITORY=
ENV STASHBOARD_VERSION=$STASHBOARD_VERSION
ENV STASHBOARD_COMMIT=$STASHBOARD_COMMIT
ENV STASHBOARD_BUILT_AT=$STASHBOARD_BUILT_AT
ENV STASHBOARD_REPOSITORY=$STASHBOARD_REPOSITORY
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["node", "/usr/local/bin/healthcheck.mjs"]
EXPOSE 3000
CMD ["start-app"]
