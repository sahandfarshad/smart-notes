#!/usr/bin/env bash
# =====================================================================
#  Smart Notes - one-line installer & server manager
#  Install:  bash <(curl -fsSL https://raw.githubusercontent.com/sahandfarshad/smart-notes/main/install.sh)
#  Manage :  smartnotes
#  (English only on purpose: Persian text is not readable in many SSH terminals)
# =====================================================================
REPO="sahandfarshad/smart-notes"
IMAGE="ghcr.io/${REPO}:latest"
RAW="https://raw.githubusercontent.com/${REPO}/main"
DIR="/opt/smart-notes"
ENVF="${DIR}/.env"
BIN="/usr/local/bin/smartnotes"
APP="smart-notes"

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;36m'; W='\033[1m'; N='\033[0m'
ok()   { echo -e "${G}[OK]${N} $*"; }
info() { echo -e "${B}[..]${N} $*"; }
warn() { echo -e "${Y}[!!]${N} $*"; }
err()  { echo -e "${R}[ERROR]${N} $*"; }
pause(){ echo; read -rp "Press Enter to return to the menu..." _; }

[ "$(id -u)" -eq 0 ] || { err "Please run as root (use: sudo -i)"; exit 1; }

# ------------------------------------------------------------------ helpers
getenv() { grep -E "^$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-; }
setenv() {
  if grep -qE "^$1=" "$ENVF" 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi
}
server_ip() {
  local ip
  ip=$(curl -s4 --max-time 4 https://api.ipify.org || true)
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "${ip:-SERVER-IP}"
}
panel_url() {
  local d; d=$(getenv DOMAIN)
  if [ -n "$d" ]; then echo "https://${d}"; else echo "http://$(getenv SERVER_IP):$(getenv PORT)"; fi
}
installed() { [ -f "$ENVF" ] && [ -f "${DIR}/docker-compose.yml" ]; }
dc() {
  local prof=()
  [ -n "$(getenv DOMAIN)" ] && prof=(--profile ssl)
  (cd "$DIR" && docker compose "${prof[@]}" "$@")
}
is_running() { [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" = "true" ]; }
port_free() { ! (ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"); }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
open_fw() { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && ufw allow "$1"/tcp >/dev/null && ok "Firewall (ufw): port $1 opened"; }

ask_port() {
  local p
  while true; do
    read -rp "Panel port (e.g. 8080): " p
    if ! valid_port "$p"; then warn "Enter a number between 1 and 65535."; continue; fi
    if [ "$p" != "$(getenv PORT)" ] && ! port_free "$p"; then warn "Port $p is already in use. Choose another one."; continue; fi
    PORT_IN="$p"; return
  done
}
ask_credentials() {
  local u p p2
  read -rp "Panel username [admin]: " u; u=${u:-admin}
  while true; do
    read -rsp "Panel password (leave empty to generate one): " p; echo
    if [ -z "$p" ]; then p=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14); GENERATED=1; break; fi
    read -rsp "Repeat password: " p2; echo
    [ "$p" = "$p2" ] && break || warn "Passwords do not match."
  done
  if [[ ! "$p" =~ ^[A-Za-z0-9._@%+=!-]+$ ]]; then warn "Only letters, digits and . _ @ % + = ! - are allowed. A password was generated instead."; p=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14); GENERATED=1; fi
  [[ "$u" =~ ^[A-Za-z0-9._@-]+$ ]] || { warn "Invalid username, using 'admin'."; u=admin; }
  USER_IN="$u"; PASS_IN="$p"
}

write_compose() {
  cat > "${DIR}/docker-compose.yml" <<'EOF'
services:
  app:
    image: ${IMAGE}
    container_name: smart-notes
    restart: unless-stopped
    env_file: .env
    environment:
      PORT_INTERNAL: "8080"
      DATA_DIR: /data
    ports:
      - "${BIND}:${PORT}:8080"
    volumes:
      - ./data:/data

  caddy:
    image: caddy:2-alpine
    container_name: smart-notes-caddy
    restart: unless-stopped
    profiles: ["ssl"]
    depends_on: [app]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy_data:/data
      - ./caddy_config:/config
EOF
}
apply() { # recreate containers with the current .env
  setenv PUBLIC_URL "$(panel_url)"
  dc up -d --remove-orphans >/dev/null 2>&1 || dc up -d --remove-orphans
}

pull_image() {
  # 1) normal pull from GHCR
  dc pull app >/dev/null 2>&1 && { ok "Image downloaded"; return 0; }
  # 2) a stale "docker login ghcr.io" often causes "denied" -> retry anonymously
  warn "Registry pull failed, retrying without saved ghcr.io login..."
  docker logout ghcr.io >/dev/null 2>&1
  dc pull app >/dev/null 2>&1 && { ok "Image downloaded"; return 0; }
  # 3) fallback: download the image file from GitHub Releases
  local arch
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) err "Unsupported CPU: $(uname -m)"; return 1 ;; esac
  warn "Registry is not reachable from this server. Downloading the image from GitHub Releases instead..."
  local f="/tmp/smart-notes-image.tar.gz"
  curl -fL --progress-bar -o "$f" "https://github.com/${REPO}/releases/download/server-image/smart-notes-image-${arch}.tar.gz" || { err "Download failed."; return 1; }
  gunzip -c "$f" | docker load && rm -f "$f" && ok "Image loaded" && return 0
  return 1
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then ok "Docker is installed"; return; fi
  info "Installing Docker (this takes a minute)..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || { err "Docker installation failed. Install Docker manually and run again."; exit 1; }
  systemctl enable --now docker >/dev/null 2>&1
  docker compose version >/dev/null 2>&1 || { err "docker compose plugin is missing."; exit 1; }
  ok "Docker installed"
}
install_manager() {
  curl -fsSL "${RAW}/install.sh" -o "$BIN" 2>/dev/null && chmod +x "$BIN" && return
  [ -f "$0" ] && cp "$0" "$BIN" && chmod +x "$BIN"
}

# ------------------------------------------------------------------ actions
do_install() {
  echo -e "${W}=== Smart Notes installation ===${N}"
  command -v curl >/dev/null || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }
  install_docker
  mkdir -p "${DIR}/data"
  touch "$ENVF"; chmod 600 "$ENVF"
  ask_port; ask_credentials
  setenv IMAGE "$IMAGE"; setenv PORT "$PORT_IN"; setenv BIND "0.0.0.0"
  setenv APP_USER "$USER_IN"; setenv APP_PASSWORD "$PASS_IN"; setenv DOMAIN ""
  setenv SERVER_IP "$(server_ip)"
  write_compose
  info "Downloading the ready-made image (no compiling)..."
  pull_image || { err "Could not download the image."; exit 1; }
  apply
  open_fw "$PORT_IN"
  install_manager
  echo
  ok "Smart Notes is running!"
  echo -e "   Panel   : ${W}$(panel_url)${N}"
  echo -e "   Username: ${W}${USER_IN}${N}"
  [ -n "$GENERATED" ] && echo -e "   Password: ${W}${PASS_IN}${N}  (save it!)"
  echo -e "   Manager : type ${W}smartnotes${N} anytime"
  pause
}
do_start()   { apply && ok "Started"; }
do_stop()    { dc stop && ok "Stopped"; }
do_restart() { apply && dc restart && ok "Restarted"; }
do_status() {
  dc ps
  echo; echo "Notes: $(docker exec "$APP" node cli.js count 2>/dev/null || echo '?')"
  echo; info "Last 30 log lines:"; docker logs --tail 30 "$APP" 2>&1
}
do_credentials() {
  ask_credentials
  setenv APP_USER "$USER_IN"; setenv APP_PASSWORD "$PASS_IN"
  apply && ok "Login updated. Username: ${USER_IN}"
  [ -n "$GENERATED" ] && echo -e "   New password: ${W}${PASS_IN}${N}"
  warn "Web browsers must log in again. The Android app keeps working (it uses the sync token)."
}
do_port() {
  ask_port
  setenv PORT "$PORT_IN"
  apply && open_fw "$PORT_IN"
  ok "Port changed to ${PORT_IN}. Panel: $(panel_url)"
  [ -n "$(getenv DOMAIN)" ] || warn "Connected Android apps must re-connect with the new token (menu: Show sync token)."
}
do_ssl() {
  local d ip dip
  read -rp "Domain (must already point to this server, e.g. notes.example.com): " d
  d=$(echo "$d" | sed -E 's#^https?://##; s#/.*$##' | tr 'A-Z' 'a-z')
  [ -z "$d" ] && { warn "Cancelled."; return; }
  ip=$(getenv SERVER_IP)
  dip=$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1{print $1}')
  if [ "$dip" != "$ip" ]; then
    warn "DNS of ${d} points to '${dip:-nothing}', this server is ${ip}."
    read -rp "Continue anyway? [y/N]: " a; [[ "$a" =~ ^[Yy]$ ]] || return
  fi
  if ! docker ps --format '{{.Names}}' | grep -q '^smart-notes-caddy$'; then
    for p in 80 443; do port_free "$p" || warn "Port $p is in use by another program (nginx/apache?). SSL may fail."; done
  fi
  printf '%s {\n    encode gzip\n    reverse_proxy app:8080\n}\n' "$d" > "${DIR}/Caddyfile"
  setenv DOMAIN "$d"; setenv BIND "127.0.0.1"
  open_fw 80; open_fw 443
  info "Requesting a free Let's Encrypt certificate..."
  apply
  sleep 8
  if curl -sfo /dev/null --max-time 15 "https://${d}/api/info"; then ok "SSL is active: https://${d}"; else warn "Certificate not ready yet. Check in a minute: https://${d}  (logs: docker logs smart-notes-caddy)"; fi
  warn "Panel address changed to $(panel_url). Re-connect the Android app with the new token."
}
do_ssl_remove() {
  [ -z "$(getenv DOMAIN)" ] && { warn "SSL is not configured."; return; }
  read -rp "Remove SSL and go back to http://IP:PORT ? [y/N]: " a; [[ "$a" =~ ^[Yy]$ ]] || return
  dc stop caddy >/dev/null 2>&1; dc rm -f caddy >/dev/null 2>&1
  setenv DOMAIN ""; setenv BIND "0.0.0.0"; rm -f "${DIR}/Caddyfile"
  apply
  ok "SSL removed. Panel: $(panel_url)"
  warn "Re-connect the Android app with the new token."
}
do_token() {
  is_running || { err "Smart Notes is not running."; return; }
  echo "Copy this token into the Android app (Settings > Connect to server):"; echo
  echo -e "${W}$(docker exec "$APP" node cli.js token "$(panel_url)")${N}"
  echo; read -rp "Generate a NEW token (old one stops working)? [y/N]: " a
  if [[ "$a" =~ ^[Yy]$ ]]; then docker exec "$APP" node cli.js regen >/dev/null; echo; echo -e "${W}$(docker exec "$APP" node cli.js token "$(panel_url)")${N}"; fi
}
do_backup() {
  is_running || { err "Smart Notes is not running."; return; }
  local f="/root/smart-notes-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  docker exec "$APP" node cli.js backup /data/backup.db >/dev/null && \
  tar -czf "$f" -C "${DIR}/data" backup.db && rm -f "${DIR}/data/backup.db" && ok "Backup saved: $f"
}
do_restore() {
  local f; ls -1t /root/smart-notes-backup-*.tar.gz 2>/dev/null | head -5
  read -rp "Path of backup file (.tar.gz): " f
  [ -f "$f" ] || { err "File not found."; return; }
  read -rp "This replaces ALL current data. Continue? [y/N]: " a; [[ "$a" =~ ^[Yy]$ ]] || return
  dc stop app
  tar -xzf "$f" -C "${DIR}/data" && mv -f "${DIR}/data/backup.db" "${DIR}/data/notes.db" && rm -f "${DIR}/data/notes.db-wal" "${DIR}/data/notes.db-shm"
  apply && ok "Restored."
}
do_update() {
  info "Updating..."
  install_manager
  setenv IMAGE "$IMAGE"; write_compose
  pull_image && apply && docker image prune -f >/dev/null 2>&1
  ok "Updated to the latest version."
  exec "$BIN"
}
do_uninstall() {
  read -rp "Uninstall Smart Notes? [y/N]: " a; [[ "$a" =~ ^[Yy]$ ]] || return
  read -rp "Also DELETE all notes data? (a backup is made first) [y/N]: " d
  if [[ "$d" =~ ^[Yy]$ ]]; then do_backup; fi
  dc down --rmi all >/dev/null 2>&1
  if [[ "$d" =~ ^[Yy]$ ]]; then rm -rf "$DIR"; else rm -f "${DIR}/docker-compose.yml"; ok "Data kept in ${DIR}/data"; fi
  rm -f "$BIN"
  ok "Smart Notes uninstalled. Goodbye!"; exit 0
}

# ------------------------------------------------------------------ menu
menu() {
  while true; do
    clear
    local st ssl
    if is_running; then st="${G}running${N}"; else st="${R}stopped${N}"; fi
    if [ -n "$(getenv DOMAIN)" ]; then ssl="${G}on${N}"; else ssl="${Y}off${N}"; fi
    echo -e "${W}==============================================${N}"
    echo -e "${W}            Smart Notes - Manager${N}"
    echo -e "${W}==============================================${N}"
    echo -e "  Panel  : ${B}$(panel_url)${N}"
    echo -e "  Status : ${st}     SSL: ${ssl}     User: $(getenv APP_USER)"
    echo -e "${W}----------------------------------------------${N}"
    echo "   1) Start"
    echo "   2) Stop"
    echo "   3) Restart"
    echo "   4) Status & logs"
    echo "   5) Change username / password"
    echo "   6) Change port"
    echo "   7) Setup SSL (domain + free certificate)"
    echo "   8) Remove SSL"
    echo "   9) Show Android sync token"
    echo "  10) Backup data"
    echo "  11) Restore backup"
    echo "  12) Update"
    echo "  13) Uninstall"
    echo "   0) Exit"
    echo -e "${W}----------------------------------------------${N}"
    read -rp "Choose an option: " c
    case "$c" in
      1) do_start; pause ;;
      2) do_stop; pause ;;
      3) do_restart; pause ;;
      4) do_status; pause ;;
      5) do_credentials; pause ;;
      6) do_port; pause ;;
      7) do_ssl; pause ;;
      8) do_ssl_remove; pause ;;
      9) do_token; pause ;;
      10) do_backup; pause ;;
      11) do_restore; pause ;;
      12) do_update ;;
      13) do_uninstall; pause ;;
      0) echo "Goodbye!"; exit 0 ;;
      *) warn "Invalid option"; sleep 1 ;;
    esac
  done
}

installed || do_install
[ -x "$BIN" ] || install_manager
menu
