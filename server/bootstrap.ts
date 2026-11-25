export interface BootstrapOptions {
  panelDomain: string;
  caddyEmail: string;
  dockerNetwork: string;
  panelPort: number;
  basicAuthUser?: string;
  includeBeszel: boolean;
  configureUfw: boolean;
  panelRepoOrImage: string;
}

export function generateBootstrapScript(opts: BootstrapOptions): string {
  const safeDomain = opts.panelDomain.trim() || ':80';
  const safeEmail = opts.caddyEmail.trim() || 'admin@example.com';
  const safeNet = opts.dockerNetwork.trim() || 'caddy_net';
  const safePort = Number(opts.panelPort) || 3000;
  const safeUser = (opts.basicAuthUser || 'admin').replace(/[^a-zA-Z0-9._-]/g, '') || 'admin';

  return `#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# اسکریپت راه‌اندازی کامل سرور VPS از صفر (سکان‌یار + Docker + Caddy Basic Auth)
# سیستم‌عامل پیشنهادی: Ubuntu 22.04 / 24.04 یا Debian 12
# اجرا داخل پوشه کلون‌شده مخزن: sudo bash bootstrap-vps.sh
# ==============================================================================

INSTALL_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PANEL_DOMAIN="\${PANEL_DOMAIN:-${safeDomain}}"
CADDY_EMAIL="\${CADDY_EMAIL:-${safeEmail}}"
DOCKER_NET="\${DOCKER_NET:-${safeNet}}"
PANEL_PORT="\${PANEL_PORT:-${safePort}}"
BASIC_AUTH_USER="\${BASIC_AUTH_USER:-${safeUser}}"
INCLUDE_BESZEL="\${INCLUDE_BESZEL:-${opts.includeBeszel ? 'true' : 'false'}}"

GENERATED_PASS="false"
if [ -z "\${BASIC_AUTH_PASS:-}" ] && [ -t 0 ]; then
  read -r -s -p "رمز عبور Caddy Basic Auth (خالی = رمز تصادفی): " BASIC_AUTH_PASS
  echo ""
fi
if [ -z "\${BASIC_AUTH_PASS:-}" ]; then
  BASIC_AUTH_PASS="\$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  GENERATED_PASS="true"
fi

echo "[1/6] به‌روزرسانی بسته‌های پایه سیستم..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git ufw jq openssl

echo "[2/6] نصب Docker از مخزن Ubuntu (سازگار با سرورهای ایران) و تنظیم میرورها..."
sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc
sudo apt-get update -y
if ! command -v docker >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
fi
sudo systemctl enable --now docker
HUB_CODE=\$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://registry-1.docker.io/v2/ || echo "000")
if [ "\$HUB_CODE" != "401" ]; then
  sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "registry-mirrors": ["https://docker.arvancloud.ir","https://registry.docker.ir"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  sudo systemctl restart docker
fi

${
  opts.configureUfw
    ? `echo "[3/6] پیکربندی فایروال UFW (پورت‌های 22, 80, 443)..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable`
    : `echo "[3/6] تنظیم خودکار فایروال غیرفعال شد (رد شدن)."`
}

echo "[4/6] ساخت پوشه‌های ماندگار و شبکه مشترک داکر (\${DOCKER_NET})..."
mkdir -p "\${INSTALL_DIR}/data/workspaces" "\${INSTALL_DIR}/caddy"
sudo docker network inspect "\${DOCKER_NET}" >/dev/null 2>&1 || sudo docker network create "\${DOCKER_NET}"

echo "[5/6] تولید کلیدهای امنیتی (.env) و Caddyfile با Basic Auth (لایه اول امنیت)..."
if [ ! -f "\${INSTALL_DIR}/.env" ]; then
  SESSION_SECRET="\$(openssl rand -hex 32)"
  DATA_ENCRYPTION_KEY="\$(openssl rand -hex 32)"
  cat <<EOF > "\${INSTALL_DIR}/.env"
NODE_ENV=production
PORT=\${PANEL_PORT}
SESSION_SECRET=\${SESSION_SECRET}
DATA_ENCRYPTION_KEY=\${DATA_ENCRYPTION_KEY}
DATA_DIR=/app/data
WORKSPACES_DIR=/app/data/workspaces
CADDYFILE_PATH=/etc/caddy/Caddyfile
CADDY_ADMIN_URL=http://caddy:2019
EOF
  chmod 600 "\${INSTALL_DIR}/.env"
fi

if [ ! -f "\${INSTALL_DIR}/caddy/Caddyfile" ]; then
  BASIC_AUTH_HASH="\$(sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext "\${BASIC_AUTH_PASS}")"
  {
    printf '{\\n  email %s\\n  admin 0.0.0.0:2019\\n}\\n\\n' "\${CADDY_EMAIL}"
    printf '%s {\\n  encode zstd gzip\\n\\n' "\${PANEL_DOMAIN}"
    printf '  handle /api/webhooks/* {\\n    reverse_proxy sokanyar-panel:%s\\n  }\\n\\n' "\${PANEL_PORT}"
    printf '  handle {\\n    basic_auth {\\n      %s %s\\n    }\\n' "\${BASIC_AUTH_USER}" "\${BASIC_AUTH_HASH}"
    printf '    reverse_proxy sokanyar-panel:%s {\\n' "\${PANEL_PORT}"
    printf '      header_up X-Forwarded-User {http.auth.user.id}\\n'
    printf '    }\\n  }\\n}\\n\\n'
    printf '# BEGIN MANAGED ROUTES\\n# مسیرهای پروژه‌ها توسط پنل در اینجا مدیریت می‌شوند\\n# END MANAGED ROUTES\\n'
  } > "\${INSTALL_DIR}/caddy/Caddyfile"
fi

echo "[6/6] ساخت ایمیج و اجرای استک در \${INSTALL_DIR}..."
cd "\${INSTALL_DIR}"
if [ "\${INCLUDE_BESZEL}" = "true" ]; then
  sudo docker compose --profile beszel up -d --build
else
  sudo docker compose up -d --build
fi

echo "=================================================================="
echo "راه‌اندازی با موفقیت انجام شد (احراز هویت دو لایه فعال است)."
echo "آدرس پنل: \${PANEL_DOMAIN}"
echo "لایه ۱ - نام کاربری Basic Auth: \${BASIC_AUTH_USER}"
if [ "\${GENERATED_PASS}" = "true" ]; then
  echo "لایه ۱ - رمز عبور تولیدشده: \${BASIC_AUTH_PASS}"
fi
echo "لایه ۲ - پس از عبور از Basic Auth، رمز مدیر پنل را تنظیم و وارد شوید."
echo "=================================================================="
`;
}

export function generatePanelComposeYaml(opts: BootstrapOptions): string {
  const safeNet = opts.dockerNetwork.trim() || 'caddy_net';
  const safePort = Number(opts.panelPort) || 3000;

  const beszelBlock = opts.includeBeszel
    ? `
  beszel:
    image: henrygd/beszel:latest
    container_name: beszel
    restart: unless-stopped
    profiles: ["beszel"]
    networks:
      - ${safeNet}
    volumes:
      - ./beszel_data:/beszel_data
    ports:
      - "127.0.0.1:8090:8090"

  beszel-agent:
    image: henrygd/beszel-agent:latest
    container_name: beszel-agent
    restart: unless-stopped
    profiles: ["beszel"]
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      LISTEN: "45876"`
    : '';

  return `services:
  caddy:
    image: caddy:2-alpine
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./caddy:/etc/caddy
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - ${safeNet}

  sokanyar-panel:
    build: .
    container_name: sokanyar-panel
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      - ./caddy:/etc/caddy
    networks:
      - ${safeNet}
    ports:
      - "127.0.0.1:${safePort}:${safePort}"
${beszelBlock}

volumes:
  caddy_data:
  caddy_config:

networks:
  ${safeNet}:
    external: true
`;
}

export function generatePanelDockerfile(): string {
  return `FROM docker:cli AS dockercli

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN set -eux; \\
    if ! apt-get update -o Acquire::http::Timeout=10 -o Acquire::Retries=1; then \\
      sed -i 's|http://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g; s|https://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \\
      apt-get update; \\
    fi; \\
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++; \\
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app

RUN set -eux; \\
    if ! apt-get update -o Acquire::http::Timeout=10 -o Acquire::Retries=1; then \\
      sed -i 's|http://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g; s|https://deb.debian.org/debian|http://mirror.arvancloud.ir/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \\
      apt-get update; \\
    fi; \\
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates; \\
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
`;
}
