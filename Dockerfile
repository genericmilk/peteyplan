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

# git + ssh for the Code panel (linked project folders). Off by default so the
# plain image never needs the Debian mirrors; docker-compose.git.yml turns it on.
# Behind an intercepting proxy, drop the proxy's CA as .corp-ca.pem next to
# this file (gitignored) and apt uses HTTPS mirrors instead of plain HTTP:
#   cp ~/corp-ca.pem .corp-ca.pem
#   docker compose -f docker-compose.yml -f docker-compose.git.yml up -d --build
ARG WITH_GIT=false
# .dockerignore always matches, so this works with or without .corp-ca.pem.
COPY .corp-ca.pem* .dockerignore /tmp/corp-ca/
RUN if [ "$WITH_GIT" = "true" ]; then \
    CA=/tmp/corp-ca/.corp-ca.pem; \
    if [ -s "$CA" ] && grep -q 'BEGIN CERTIFICATE' "$CA"; then \
      mkdir -p /etc/ssl/certs /usr/local/share/ca-certificates \
      && awk '/BEGIN CERTIFICATE/{p=1} p' "$CA" > /etc/ssl/certs/ca-certificates.crt \
      && cp /etc/ssl/certs/ca-certificates.crt /usr/local/share/ca-certificates/corp-ca.crt \
      && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/*.sources; \
    fi \
    && rm -rf /tmp/corp-ca \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*; \
  fi

COPY --from=build /app/.output /app/.output

# The built server runs as an unprivileged user and sqlite needs to write.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]