# Single-stage Node runtime image. Replaces Nixpacks (was ~14min/build)
# with a tuned Dockerfile (~2min/build for source-only changes) by
# splitting deps and source into separate layers — Docker caches the
# install layer until package*.json changes.
#
# Base: node:20-slim (debian, glibc). bcrypt 5.1's prebuilt binaries
# cover linux-x64-glibc, so no apt-get build-tools needed. If bcrypt
# ever loses its prebuild, add:
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         python3 make g++ && rm -rf /var/lib/apt/lists/*
FROM node:20-slim

WORKDIR /app

# Cached deps layer — invalidated only when package.json or
# package-lock.json change. Source-only edits skip this entirely.
#
# Using `npm install` (not `npm ci`) because the lockfile drifts when
# operators add deps to package.json without local node to update
# package-lock.json. `npm ci` fails on drift; `npm install` tolerates
# it and regenerates. Docker still caches this layer aggressively, so
# the speed win is preserved for source-only edits.
# --omit=dev: skip devDependencies (none right now, but defensive).
# --prefer-offline: reuse npm cache when present.
# --no-audit/--no-fund: skip noisy network calls.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --prefer-offline --no-audit --no-fund

# Source layer — changes per push, fast to copy (~2MB).
COPY src ./src
COPY saas-phase1-migration ./saas-phase1-migration

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
