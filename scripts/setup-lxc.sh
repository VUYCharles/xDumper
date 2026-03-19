#!/bin/bash
# setup-lxc.sh
#
# Installs x-gcal on an Ubuntu 22.04 LXC container.
#
# Tested on Proxmox VE 8/9 with an unprivileged LXC container.
# The container must have the "nesting" feature enabled
# (Proxmox UI -> LXC -> Options -> Features -> Nesting).
#
# Usage:
#   sudo bash scripts/setup-lxc.sh

set -euo pipefail

# --- Colours -------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }
title() { echo -e "\n${BOLD}$*${NC}"; }

# --- Guard ---------------------------------------------------------------------
[ "$EUID" -ne 0 ] && error "Run as root: sudo bash scripts/setup-lxc.sh"

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
info "Install directory: ${INSTALL_DIR}"

# --- 1. System update ----------------------------------------------------------
title "1. System update"
apt-get update -qq && apt-get upgrade -y -qq
ok "System packages up to date"

# --- 2. Timezone ---------------------------------------------------------------
title "2. Timezone"
timedatectl set-timezone 'Europe/Paris'
ok "Timezone set to $(timedatectl | grep 'Time zone' | awk '{print $3}')"

# --- 3. System dependencies ----------------------------------------------------
title "3. System dependencies"
apt-get install -y -qq \
  curl wget git ca-certificates gnupg unzip \
  chromium-browser \
  fonts-liberation fonts-noto-color-emoji \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
  libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 \
  libxfixes3 libxkbcommon0 libxrandr2 xdg-utils libasound2 \
  2>/dev/null || true
ok "Dependencies installed"

# --- 4. Tor (optional) ---------------------------------------------------------
title "4. Tor (optional)"
read -rp "$(echo -e "${YELLOW}Install Tor for IP-block bypass? [y/N]${NC} ")" INSTALL_TOR
if [[ "${INSTALL_TOR}" =~ ^[yYoO]$ ]]; then
  apt-get install -y -qq tor
  grep -q 'SocksPort 9050' /etc/tor/torrc 2>/dev/null || cat >> /etc/tor/torrc << 'TOREOF'

# aurion-gcal
SocksPort 9050
SocksPort 9052
TOREOF
  systemctl enable tor && systemctl restart tor
  ok "Tor installed (ports 9050, 9052)"
else
  info "Tor skipped"
fi

# --- 5. Node.js 20 LTS ---------------------------------------------------------
title "5. Node.js 20 LTS"
if command -v node &>/dev/null && node --version | grep -q '^v2'; then
  ok "Node.js already installed: $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
fi

# --- 6. npm dependencies -------------------------------------------------------
title "6. npm dependencies"
cd "${INSTALL_DIR}"
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --omit=dev --silent
ok "npm install complete"

# --- 7. Chromium path for Puppeteer --------------------------------------------
title "7. Puppeteer configuration"
CHROMIUM_BIN="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || true)"
if [ -n "${CHROMIUM_BIN}" ]; then
  cat > "${INSTALL_DIR}/.env" << ENVEOF
PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_BIN}
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
TZ=Europe/Paris
NODE_ENV=production
ENVEOF
  ok "Puppeteer will use system Chromium: ${CHROMIUM_BIN}"
else
  warn "chromium-browser not found — Puppeteer will download its own Chromium"
fi

# --- 8. Working directories ----------------------------------------------------
title "8. Working directories"
mkdir -p "${INSTALL_DIR}/logs" "${INSTALL_DIR}/debug"
ok "logs/ and debug/ ready"

# --- 9. Configuration file -----------------------------------------------------
title "9. Configuration"
if [ ! -f "${INSTALL_DIR}/config.js" ]; then
  cp "${INSTALL_DIR}/config.example.js" "${INSTALL_DIR}/config.js"
  warn "config.js created from template — edit it before running the sync:"
  echo ""
  echo "  nano ${INSTALL_DIR}/config.js"
  echo ""
fi

# --- 10. systemd service and timer ---------------------------------------------
title "10. systemd service and timer"
NODE_BIN="$(command -v node)"
DOTENV_LOAD=""
[ -f "${INSTALL_DIR}/.env" ] && DOTENV_LOAD="EnvironmentFile=${INSTALL_DIR}/.env"

cat > /etc/systemd/system/x-gcal.service << SERVICEEOF
[Unit]
Description=x-gcal — x x timetable sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${INSTALL_DIR}
ExecStart=/bin/bash -c "${NODE_BIN} ${INSTALL_DIR}/main.js && ${NODE_BIN} ${INSTALL_DIR}/consolidate.js"
StandardOutput=append:${INSTALL_DIR}/logs/sync.log
StandardError=append:${INSTALL_DIR}/logs/sync.log
${DOTENV_LOAD}

[Install]
WantedBy=multi-user.target
SERVICEEOF

cat > /etc/systemd/system/x-gcal.timer << TIMEREOF
[Unit]
Description=Run x-gcal daily at 04:00
Requires=x-gcal.service

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable x-gcal.timer
ok "systemd service and timer configured (daily at 04:00)"

# --- Summary -------------------------------------------------------------------
echo ""
echo -e "${BOLD}Installation complete${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit the configuration:"
echo "       nano ${INSTALL_DIR}/config.js"
echo ""
echo "  2. If you need an OAuth2 refresh token, run on your local machine:"
echo "       GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx \\"
echo "       node ${INSTALL_DIR}/scripts/oauth-setup.js"
echo ""
echo "  3. Run a manual sync to verify the setup:"
echo "       node ${INSTALL_DIR}/main.js"
echo ""
echo "  4. Enable the daily sync:"
echo "       systemctl start x-gcal.timer"
echo "       systemctl status x-gcal.timer"
echo ""
echo "  5. Monitor the logs:"
echo "       tail -f ${INSTALL_DIR}/logs/sync.log"
echo ""
