FROM docker:cli AS dockercli

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN set -eux; \
    if ! apt-get update -o Acquire::http::Timeout=10 -o Acquire::Retries=1; then \
      sed -i 's|http://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g; s|https://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      apt-get update; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++; \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app

RUN set -eux; \
    if ! apt-get update -o Acquire::http::Timeout=10 -o Acquire::Retries=1; then \
      sed -i 's|http://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g; s|https://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      apt-get update; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates; \
    rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/server ./server

ENV NODE_ENV=production
EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "server.ts"]
