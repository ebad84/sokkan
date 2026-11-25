#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# سکان‌یار (SokanYar) - اسکریپت راه‌اندازی صفر تا صد سرور VPS
# مناسب Ubuntu 22.04 / 24.04 و Debian 12
# احراز هویت پنل به صورت بومی با Caddy Basic Auth انجام می‌شود
# ==============================================================================

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_NET="${DOCKER_NET:-caddy_net}"
PANEL_PORT="${PANEL_PORT:-3000}"

echo "=================================================================="
echo "  راه‌اندازی خودکار سرور VPS با سکان‌یار (Docker + Caddy Basic Auth)"
echo "=================================================================="

# دریافت تنظیمات به صورت تعاملی (در صورت نبود متغیر محیطی)
if [ -z "${PANEL_DOMAIN:-}" ] && [ -t 0 ]; then
  read -r -p "دامنه پنل را وارد کنید (مثلاً panel.example.com یا خالی برای دسترسی با IP روی پورت 80): " PANEL_DOMAIN
fi
PANEL_DOMAIN="${PANEL_DOMAIN:-:80}"

if [ -z "${CADDY_EMAIL:-}" ] && [ -t 0 ]; then
  read -r -p "ایمیل برای گواهی SSL در Caddy (پیش‌فرض admin@example.com): " CADDY_EMAIL
fi
CADDY_EMAIL="${CADDY_EMAIL:-admin@example.com}"

if [ -z "${BASIC_AUTH_USER:-}" ] && [ -t 0 ]; then
  read -r -p "نام کاربری Caddy Basic Auth برای ورود به پنل (پیش‌فرض admin): " BASIC_AUTH_USER
fi
BASIC_AUTH_USER="${BASIC_AUTH_USER:-admin}"

GENERATED_PASS="false"
if [ -z "${BASIC_AUTH_PASS:-}" ] && [ -t 0 ]; then
  read -r -s -p "رمز عبور Caddy Basic Auth (خالی بگذارید تا رمز تصادفی ساخته شود): " BASIC_AUTH_PASS
  echo ""
fi
if [ -z "${BASIC_AUTH_PASS:-}" ]; then
  BASIC_AUTH_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  GENERATED_PASS="true"
fi

if [ -z "${INCLUDE_BESZEL:-}" ] && [ -t 0 ]; then
  read -r -p "آیا ابزار سبک Beszel برای نمودار تاریخچه منابع نصب شود؟ [Y/n]: " ans_beszel
  case "${ans_beszel:-Y}" in
    [nN]|[nN][oO]) INCLUDE_BESZEL="false" ;;
    *) INCLUDE_BESZEL="true" ;;
  esac
fi
INCLUDE_BESZEL="${INCLUDE_BESZEL:-true}"

if [ -z "${INCLUDE_KUMA:-}" ] && [ -t 0 ]; then
  read -r -p "آیا Uptime Kuma هم نصب شود؟ [y/N]: " ans_kuma
  case "${ans_kuma:-N}" in
    [yY]|[yY][eE][sS]) INCLUDE_KUMA="true" ;;
    *) INCLUDE_KUMA="false" ;;
  esac
fi
INCLUDE_KUMA="${INCLUDE_KUMA:-false}"

echo "[1/7] به‌روزرسانی بسته‌های پایه سیستم..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git ufw jq openssl

echo "[2/7] بررسی حافظه Swap (برای پایداری بیلد داکر روی سرورهای 2GB رم)..."
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "فایل Swap با حجم 2GB فعال شد."
else
  echo "حافظه Swap از قبل فعال است."
fi

echo "[3/7] نصب Docker Engine و Docker Compose Plugin..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
else
  echo "Docker از قبل نصب است."
fi

echo "[4/7] پیکربندی فایروال UFW (باز کردن 22, 80, 443)..."
sudo ufw allow OpenSSH >/dev/null 2>&1 || sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable

echo "[5/7] ساخت پوشه‌های داده و شبکه مشترک داکر (${DOCKER_NET})..."
mkdir -p "${INSTALL_DIR}/data/workspaces" "${INSTALL_DIR}/caddy" "${INSTALL_DIR}/beszel_data" "${INSTALL_DIR}/kuma_data"
sudo docker network inspect "${DOCKER_NET}" >/dev/null 2>&1 || sudo docker network create "${DOCKER_NET}"

echo "[6/7] تولید کلیدهای امنیتی (.env) و فایل Caddyfile با Basic Auth (لایه اول امنیت)..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  cat <<EOF > "${INSTALL_DIR}/.env"
NODE_ENV=production
PORT=${PANEL_PORT}
SESSION_SECRET=${SESSION_SECRET}
DATA_ENCRYPTION_KEY=${DATA_ENCRYPTION_KEY}
DATA_DIR=/app/data
WORKSPACES_DIR=/app/data/workspaces
CADDYFILE_PATH=/etc/caddy/Caddyfile
CADDY_ADMIN_URL=http://caddy:2019
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  echo "فایل .env جدید با کلیدهای تصادفی ساخته شد."
else
  echo "فایل .env از قبل وجود دارد (حفظ شد)."
fi

if [ ! -f "${INSTALL_DIR}/caddy/Caddyfile" ]; then
  echo "در حال ساخت هش امن bcrypt برای Caddy Basic Auth..."
  BASIC_AUTH_HASH="$(sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext "${BASIC_AUTH_PASS}")"
  {
    printf '{\n'
    printf '  email %s\n' "${CADDY_EMAIL}"
    printf '  admin 0.0.0.0:2019\n'
    printf '}\n\n'
    printf '%s {\n' "${PANEL_DOMAIN}"
    printf '  encode zstd gzip\n\n'
    printf '  handle /api/webhooks/* {\n'
    printf '    reverse_proxy sokanyar-panel:%s\n' "${PANEL_PORT}"
    printf '  }\n\n'
    printf '  handle {\n'
    printf '    basic_auth {\n'
    printf '      %s %s\n' "${BASIC_AUTH_USER}" "${BASIC_AUTH_HASH}"
    printf '    }\n'
    printf '    reverse_proxy sokanyar-panel:%s {\n' "${PANEL_PORT}"
    printf '      header_up X-Forwarded-User {http.auth.user.id}\n'
    printf '    }\n'
    printf '  }\n'
    printf '}\n\n'
    printf '# BEGIN MANAGED ROUTES\n'
    printf '# مسیرهای پروژه‌ها به صورت خودکار توسط پنل سکان‌یار در اینجا مدیریت می‌شوند\n'
    printf '# END MANAGED ROUTES\n'
  } > "${INSTALL_DIR}/caddy/Caddyfile"
  echo "فایل caddy/Caddyfile با احراز هویت Basic Auth ساخته شد."
else
  echo "فایل caddy/Caddyfile از قبل وجود دارد (بدون تغییر باقی ماند)."
fi

echo "[7/7] ساخت ایمیج و بالا آوردن سرویس‌ها..."
cd "${INSTALL_DIR}"
PROFILE_ARGS=()
if [ "${INCLUDE_BESZEL}" = "true" ]; then
  PROFILE_ARGS+=(--profile beszel)
fi
if [ "${INCLUDE_KUMA}" = "true" ]; then
  PROFILE_ARGS+=(--profile kuma)
fi

sudo docker compose "${PROFILE_ARGS[@]}" up -d --build

echo ""
echo "بررسی سلامت سرویس پنل..."
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
    echo "سرویس سکان‌یار با موفقیت فعال شد!"
    break
  fi
  sleep 2
done

echo "=================================================================="
echo "راه‌اندازی کامل شد (احراز هویت دو لایه فعال است)."
if [ "${PANEL_DOMAIN}" = ":80" ]; then
  SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  echo "آدرس پنل: http://${SERVER_IP}"
else
  echo "آدرس پنل: https://${PANEL_DOMAIN}"
fi
echo "لایه ۱ (Caddy Basic Auth):"
echo "  نام کاربری: ${BASIC_AUTH_USER}"
if [ "${GENERATED_PASS}" = "true" ]; then
  echo "  رمز عبور تولیدشده: ${BASIC_AUTH_PASS}"
else
  echo "  رمز عبور: (رمزی که خودتان وارد کردید)"
fi
echo "لایه ۲ (لاگین مدیر سکان‌یار):"
echo "  پس از عبور از Basic Auth، در اولین ورود رمز عبور مدیر پنل را تنظیم و وارد شوید."
echo "نکته: مسیر /api/webhooks/* از Basic Auth مستثنی شده تا Webhook گیتهاب بدون مشکل کار کند."
if [ "${INCLUDE_BESZEL}" = "true" ]; then
  echo "آدرس داخلی Beszel برای اتصال داخل داشبورد: http://beszel:8090"
fi
echo "=================================================================="
