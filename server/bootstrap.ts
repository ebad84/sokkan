export interface BootstrapOptions {
  panelDomain: string;
  caddyEmail: string;
  dockerNetwork: string;
  panelPort: number;
  includeBeszel: boolean;
  configureUfw: boolean;
  panelRepoOrImage: string;
}

export function generateBootstrapScript(opts: BootstrapOptions): string {
  const safeDomain = opts.panelDomain.trim() || ':80';
  const safeEmail = opts.caddyEmail.trim() || 'admin@example.com';
  const safeNet = opts.dockerNetwork.trim() || 'caddy_net';
  const safePort = Number(opts.panelPort) || 3000;

  return `#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# اسکریپت راه‌اندازی کامل سرور VPS از صفر (سکان‌یار CI/CD + Docker + Caddy)
# سیستم‌عامل پیشنهادی: Ubuntu 22.04 / 24.04 یا Debian 12
# اجرا داخل پوشه کلون‌شده مخزن: sudo bash bootstrap-vps.sh
# ==============================================================================

INSTALL_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PANEL_DOMAIN="\${PANEL_DOMAIN:-${safeDomain}}"
CADDY_EMAIL="\${CADDY_EMAIL:-${safeEmail}}"
DOCKER_NET="\${DOCKER_NET:-${safeNet}}"
PANEL_PORT="\${PANEL_PORT:-${safePort}}"
INCLUDE_BESZEL="\${INCLUDE_BESZEL:-${opts.includeBeszel ? 'true' : 'false'}}"

echo "[1/6] به‌روزرسانی بسته‌های پایه سیستم..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git ufw jq openssl

echo "[2/6] نصب Docker Engine و Docker Compose Plugin..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
else
  echo "Docker از قبل نصب است."
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
docker network inspect "\${DOCKER_NET}" >/dev/null 2>&1 || docker network create "\${DOCKER_NET}"

echo "[5/6] تولید کلیدهای امنیتی یکتا در فایل .env..."
if [ ! -f "\${INSTALL_DIR}/.env" ]; then
  SESSION_SECRET=\$(openssl rand -hex 32)
  DATA_ENCRYPTION_KEY=\$(openssl rand -hex 32)
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
  cat <<EOF > "\${INSTALL_DIR}/caddy/Caddyfile"
{
  email \${CADDY_EMAIL}
  admin 0.0.0.0:2019
}

\${PANEL_DOMAIN} {
  encode zstd gzip
  reverse_proxy sokanyar-panel:\${PANEL_PORT}
}

# BEGIN MANAGED ROUTES
# مسیرهای پروژه‌ها توسط پنل در اینجا مدیریت می‌شوند
# END MANAGED ROUTES
EOF
fi

echo "[6/6] ساخت ایمیج و اجرای استک در \${INSTALL_DIR}..."
cd "\${INSTALL_DIR}"
if [ "\${INCLUDE_BESZEL}" = "true" ]; then
  docker compose --profile beszel up -d --build
else
  docker compose up -d --build
fi

echo "=================================================================="
echo "راه‌اندازی با موفقیت انجام شد!"
echo "آدرس پنل: \${PANEL_DOMAIN}"
echo "نکته: Portainer در این چیدمان نصب نشده تا رم سرور صرفه‌جویی شود."
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
      LISTEN: 45876`
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
  return `FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git docker-cli docker-cli-compose curl caddy
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
