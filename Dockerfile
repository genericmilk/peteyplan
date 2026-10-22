# ── Build stage ──────────────────────────────────────────────────────────────
# No build toolchain needed: better-sqlite3 ships prebuilt binaries for all
# platforms in the npm package, and esbuild installs its binary via
# optionalDependencies.
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt binaries in the package and
# esbuild via optionalDependencies, so no postinstall compilation is required.
RUN npm ci --ignore-scripts

COPY . .

ENV NODE_ENV=production
RUN npm run build

# Drop dev dependencies from the project tree (the server output already
# contains the production deps it needs, including better-sqlite3).
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data

# git + ssh for the Code panel (linked project folders). Only used when you
# mount code into the container; see docker-compose.git.yml.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.output /app/.output

# The built server runs as an unprivileged user and sqlite needs to write.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]