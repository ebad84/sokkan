#!/usr/bin/env bash
# =====================================================================
# bootstrap-vps.sh — Sokkan PaaS Installer (Ubuntu 24.04 / 26.04)
#
# Sets up a lightweight, production-ready PaaS on a 2GB RAM VPS:
#   1. Base: apt update/upgrade, timezone, unattended-upgrades, 2G swap
#   2. Security: SSH hardening (no root login), fail2ban, UFW (22, 80, 443)
#   3. Docker: installed from Ubuntu repo (docker.io + docker-compose-v2),
#      auto-enables Iranian registry mirrors when Docker Hub is unreachable,
#      configures log rotation, creates shared "web" bridge network
#   4. Stack (Docker Compose):
#        - Caddy        : reverse proxy + automatic HTTPS + Basic Auth
#        - Sokkan Panel : GitHub CI/CD + One-Click Apps + Docker + Caddy UI
#                         (/api/webhooks/* bypasses Basic Auth for HMAC)
#        - Beszel       : lightweight server & container telemetry
#        - Uptime Kuma  : optional (--profile kuma)
#   5. CLI: installs global `sokkan` command to /usr/local/bin/sokkan
#
# Usage: bash bootstrap-vps.sh   (run as normal sudo user, e.g. ubuntu)
# =====================================================================
set -euo pipefail

### ---------------- Settings (override via env or interactive prompts) ----------------
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_USER="${SUDO_USER:-$USER}"

DOMAIN="${DOMAIN:-example.com}"
PANEL_SUBDOMAIN="${PANEL_SUBDOMAIN:-sokkan}"      # -> sokkan.<domain>
STATUS_SUBDOMAIN="${STATUS_SUBDOMAIN:-status}"    # -> status.<domain> (Beszel)
KUMA_SUBDOMAIN="${KUMA_SUBDOMAIN:-kuma}"          # -> kuma.<domain> (optional)
BASIC_AUTH_USER="${BASIC_AUTH_USER:-admin}"
CADDY_EMAIL="${CADDY_EMAIL:-}"

TIMEZONE="${TIMEZONE:-Asia/Tehran}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAP_SWAPPINESS="10"
ALLOW_PASSWORD_LOGIN="${ALLOW_PASSWORD_LOGIN:-yes}" # yes | no
DOCKER_MIRRORS='["https://docker.arvancloud.ir","https://registry.docker.ir"]'
DOCKER_NET="web"
PANEL_PORT="3000"
### ------------------------------------------------------------------------------------

log()  { echo -e "\n\033[1;32m[+] $*\033[0m"; }
warn() { echo -e "\n\033[1;33m[!] $*\033[0m"; }

sudo -v

if [ -t 0 ]; then
  echo "=================================================================="
  echo "  Sokkan PaaS — Automated VPS Bootstrap (Docker + Caddy + CI/CD)"
  echo "=================================================================="
  read -r -p "Primary root domain (default: ${DOMAIN}): " IN_DOMAIN
  DOMAIN="${IN_DOMAIN:-$DOMAIN}"

  read -r -p "Sokkan panel subdomain or FQDN (default: ${PANEL_SUBDOMAIN} -> ${PANEL_SUBDOMAIN}.${DOMAIN}): " IN_PANEL_SUB
  PANEL_SUBDOMAIN="${IN_PANEL_SUB:-$PANEL_SUBDOMAIN}"

  read -r -p "Beszel monitoring subdomain or FQDN (default: ${STATUS_SUBDOMAIN} -> ${STATUS_SUBDOMAIN}.${DOMAIN}): " IN_STATUS_SUB
  STATUS_SUBDOMAIN="${IN_STATUS_SUB:-$STATUS_SUBDOMAIN}"

  read -r -p "Email for Let's Encrypt SSL certificates (optional): " IN_EMAIL
  CADDY_EMAIL="${IN_EMAIL:-$CADDY_EMAIL}"

  read -r -p "Caddy Basic Auth username (default: ${BASIC_AUTH_USER}): " IN_USER
  BASIC_AUTH_USER="${IN_USER:-$BASIC_AUTH_USER}"

  read -r -p "Enable Uptime Kuma monitoring as well? [y/N]: " ANS_KUMA
  case "${ANS_KUMA:-N}" in
    [yY]|[yY][eE][sS]) INCLUDE_KUMA="yes" ;;
    *) INCLUDE_KUMA="no" ;;
  esac
else
  INCLUDE_KUMA="${INCLUDE_KUMA:-no}"
fi

resolve_fqdn() {
  local input="$1"
  local base="$2"
  if [[ "$input" == *.* ]]; then
    echo "$input"
  else
    echo "${input}.${base}"
  fi
}

PANEL_FQDN="$(resolve_fqdn "$PANEL_SUBDOMAIN" "$DOMAIN")"
STATUS_FQDN="$(resolve_fqdn "$STATUS_SUBDOMAIN" "$DOMAIN")"
KUMA_FQDN="$(resolve_fqdn "$KUMA_SUBDOMAIN" "$DOMAIN")"

############################ BASE SYSTEM ############################
log "1/11 Updating system and installing base packages"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git jq openssl ufw fail2ban unattended-upgrades python3-systemd htop ncdu
sudo timedatectl set-timezone "$TIMEZONE"

log "2/11 Enabling automatic security updates"
sudo systemctl unmask unattended-upgrades 2>/dev/null || true
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
sudo systemctl enable --now unattended-upgrades

log "3/11 Configuring swap (${SWAP_SIZE})"
if ! swapon --show | grep -q /swapfile; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "$SWAP_SIZE" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  fi
  sudo swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
echo "vm.swappiness=${SWAP_SWAPPINESS}" | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
sudo sysctl --system >/dev/null

log "4/11 Hardening SSH (port remains 22)"
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<SSH
PermitRootLogin no
PasswordAuthentication ${ALLOW_PASSWORD_LOGIN}
KbdInteractiveAuthentication no
MaxAuthTries 3
LoginGraceTime 30
SSH
sudo sshd -t
sudo systemctl restart ssh

log "5/11 Configuring Fail2ban"
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'F2B'
[sshd]
enabled = true
backend = systemd
maxretry = 3
findtime = 10m
bantime = 24h
F2B
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
sleep 3

log "6/11 Configuring UFW firewall (22, 80, 443)"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable

############################ DOCKER (IRAN-FRIENDLY) ############################
log "7/11 Installing Docker from Ubuntu repository"
sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc
sudo apt-get update
if ! command -v docker >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
elif ! docker compose version >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2
fi
sudo systemctl enable --now docker
if [ "$TARGET_USER" != "root" ]; then
  sudo usermod -aG docker "$TARGET_USER" || true
fi

log "8/11 Configuring Docker daemon (log limits + automatic registry mirrors)"
HUB_CODE=$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://registry-1.docker.io/v2/ || echo "000")
echo "Docker Hub HTTP code: ${HUB_CODE}"
if [ "$HUB_CODE" = "401" ]; then
  sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
else
  warn "Docker Hub blocked or unreachable (${HUB_CODE}) -> enabling Iranian registry mirrors"
  sudo tee /etc/docker/daemon.json >/dev/null <<JSON
{
  "registry-mirrors": ${DOCKER_MIRRORS},
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
fi
sudo systemctl restart docker
sleep 5
sudo docker network inspect "$DOCKER_NET" >/dev/null 2>&1 || sudo docker network create "$DOCKER_NET"
sudo docker pull hello-world >/dev/null 2>&1 && echo "Docker pull test OK" || warn "Docker pull test FAILED: check mirrors in /etc/docker/daemon.json"

############################ DNS + ACME CHECK ############################
log "9/11 Checking DNS records and Let's Encrypt reachability"
for h in "$DOMAIN" "$PANEL_FQDN" "$STATUS_FQDN"; do
  if getent hosts "$h" >/dev/null 2>&1; then
    echo "DNS OK: $h -> $(getent hosts "$h" | awk '{print $1}')"
  else
    warn "DNS for $h is not resolving yet. Add an A record (or wildcard *.${DOMAIN}) pointing to this server."
  fi
done
printf "Let's Encrypt API: "
curl -s -o /dev/null -m 10 -w '%{http_code}\n' https://acme-v02.api.letsencrypt.org/directory || echo "FAIL"

############################ INFRA + SOKKAN ############################
log "10/11 Generating .env, Caddyfile, enable-agent.sh, and installing 'sokkan' CLI"
cd "$INSTALL_DIR"
mkdir -p "${INSTALL_DIR}/data/workspaces" "${INSTALL_DIR}/caddy"

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
DOCKER_NETWORK=${DOCKER_NET}
CADDYFILE_PATH=/etc/caddy/Caddyfile
CADDY_ADMIN_URL=http://caddy:2019
CADDY_CONTAINER_NAME=caddy
BESZEL_KEY=
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  echo "Created .env with secure random keys."
else
  grep -q '^DOCKER_NETWORK=' "${INSTALL_DIR}/.env" || echo "DOCKER_NETWORK=${DOCKER_NET}" >> "${INSTALL_DIR}/.env"
  grep -q '^CADDY_CONTAINER_NAME=' "${INSTALL_DIR}/.env" || echo "CADDY_CONTAINER_NAME=caddy" >> "${INSTALL_DIR}/.env"
  grep -q '^BESZEL_KEY=' "${INSTALL_DIR}/.env" || echo "BESZEL_KEY=" >> "${INSTALL_DIR}/.env"
  echo "Existing .env preserved."
fi

GENERATED_PASS="no"
BASIC_AUTH_HASH=""
if [ ! -f "${INSTALL_DIR}/caddy/Caddyfile" ]; then
  if [ -z "${BASIC_AUTH_PASS:-}" ] && [ -t 0 ]; then
    echo "Enter Caddy Basic Auth password (Layer 1 protection for Sokkan panel):"
    read -rsp "Password (leave empty to auto-generate): " PASS1; echo
    if [ -n "$PASS1" ]; then
      read -rsp "Repeat password: " PASS2; echo
      [ "$PASS1" = "$PASS2" ] || { echo "Error: Passwords do not match."; exit 1; }
      BASIC_AUTH_PASS="$PASS1"
      unset PASS1 PASS2
    fi
  fi
  if [ -z "${BASIC_AUTH_PASS:-}" ]; then
    BASIC_AUTH_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
    GENERATED_PASS="yes"
  fi

  echo "Generating bcrypt hash via caddy:2..."
  BASIC_AUTH_HASH="$(sudo docker run --rm caddy:2 caddy hash-password --plaintext "$BASIC_AUTH_PASS")"

  {
    printf '{\n'
    if [ -n "$CADDY_EMAIL" ]; then
      printf '  email %s\n' "$CADDY_EMAIL"
    fi
    printf '  admin 0.0.0.0:2019\n'
    printf '}\n\n'

    printf '%s {\n' "$PANEL_FQDN"
    printf '  encode zstd gzip\n\n'
    printf '  handle /api/webhooks/* {\n'
    printf '    reverse_proxy sokkan-panel:%s\n' "$PANEL_PORT"
    printf '  }\n\n'
    printf '  handle {\n'
    printf '    basic_auth {\n'
    printf '      %s %s\n' "$BASIC_AUTH_USER" "$BASIC_AUTH_HASH"
    printf '    }\n'
    printf '    reverse_proxy sokkan-panel:%s {\n' "$PANEL_PORT"
    printf '      header_up X-Forwarded-User {http.auth.user.id}\n'
    printf '    }\n'
    printf '  }\n'
    printf '}\n\n'

    printf '%s {\n' "$STATUS_FQDN"
    printf '  # Beszel uses PocketBase Authorization header internally; rely on Beszel built-in login\n'
    printf '  reverse_proxy beszel:8090\n'
    printf '}\n\n'

    if [ "$INCLUDE_KUMA" = "yes" ]; then
      printf '%s {\n' "$KUMA_FQDN"
      printf '  basic_auth {\n'
      printf '    %s %s\n' "$BASIC_AUTH_USER" "$BASIC_AUTH_HASH"
      printf '  }\n'
      printf '  reverse_proxy kuma:3001\n'
      printf '}\n\n'
    fi

    printf '# BEGIN MANAGED ROUTES\n'
    printf '# Sokkan managed project and service routes are injected here automatically\n'
    printf '# END MANAGED ROUTES\n'
  } > "${INSTALL_DIR}/caddy/Caddyfile"
  echo "Created caddy/Caddyfile with Basic Auth."
else
  echo "Existing caddy/Caddyfile preserved."
fi

# Beszel agent activation helper
cat > "${INSTALL_DIR}/enable-agent.sh" <<'HELPER'
#!/usr/bin/env bash
# Usage: ./enable-agent.sh  (or: sokkan enable-agent)
# Paste the Public Key shown in Beszel (Add System) to start beszel-agent.
set -euo pipefail
cd "$(dirname "$0")"
read -rp "Paste the Beszel public key (ssh-ed25519 ...): " KEY
[ -n "$KEY" ] || { echo "Error: Empty key."; exit 1; }
grep -v '^BESZEL_KEY=' .env | grep -v '^COMPOSE_PROFILES=' > .env.tmp || true
mv .env.tmp .env
printf 'BESZEL_KEY="%s"\nCOMPOSE_PROFILES=agent\n' "$KEY" >> .env
chmod 600 .env
sudo docker compose up -d
sleep 3
sudo docker logs beszel-agent --tail 15
echo
echo "Now go to Beszel and click Add System (host: /beszel_socket/beszel.sock)."
HELPER
chmod +x "${INSTALL_DIR}/enable-agent.sh"

# Install global 'sokkan' CLI command
if [ -f "${INSTALL_DIR}/bin/sokkan" ]; then
  chmod +x "${INSTALL_DIR}/bin/sokkan"
  sudo ln -sf "${INSTALL_DIR}/bin/sokkan" /usr/local/bin/sokkan
  echo "Installed global CLI command: /usr/local/bin/sokkan"
fi

# Fix directory ownership back to normal user
if [ "$TARGET_USER" != "root" ]; then
  sudo chown -R "${TARGET_USER}:${TARGET_USER}" "$INSTALL_DIR"
fi

log "11/11 Validating Caddyfile and starting stack (Caddy + Sokkan + Beszel)"
sudo docker compose config -q && echo "docker-compose.yml OK"
sudo docker run --rm -v "${INSTALL_DIR}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && echo "Caddyfile OK" || warn "Caddyfile validation failed!"

PROFILE_ARGS=()
if [ "$INCLUDE_KUMA" = "yes" ]; then
  PROFILE_ARGS+=(--profile kuma)
fi

sudo docker compose "${PROFILE_ARGS[@]}" up -d --build --remove-orphans

echo "Waiting for Sokkan health check..."
for i in $(seq 1 25); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
    echo "Sokkan is UP and healthy!"
    break
  fi
  sleep 2
done

sudo docker compose ps

log "Done!"
cat <<EOM

NEXT STEPS
 1. Log out/in once so the 'docker' group applies to ${TARGET_USER}.
 2. Open Sokkan PaaS Panel:     https://${PANEL_FQDN}
      - Layer 1 (Caddy Basic Auth): user=${BASIC_AUTH_USER} $([ "$GENERATED_PASS" = "yes" ] && echo "pass=${BASIC_AUTH_PASS}" || echo "(your chosen password)")
      - Layer 2 (Admin Login): set your Sokkan admin password on first visit.
      - Note: /api/webhooks/* bypasses Basic Auth so GitHub Webhooks work cleanly.
 3. Open Beszel Monitoring:     https://${STATUS_FQDN}
      a) Create admin user in Beszel
      b) Click "Add System": Name=vps, Host=/beszel_socket/beszel.sock
      c) Copy Public Key and run:  sokkan enable-agent
      d) In Sokkan Overview -> Connect Beszel API with URL: http://beszel:8090
 4. Useful CLI commands:
      sokkan status          sokkan logs          sokkan update
      sokkan reload-caddy    sokkan prune         sokkan doctor
EOM
