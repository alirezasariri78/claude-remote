#!/usr/bin/env bash
#
# Claude Remote - install or update on Linux or macOS.
#
# Run it as your normal user (not root) from the folder that contains the
# "server" and "mobile" folders:
#
#     ./install.sh             install (asks a few questions)
#     ./install.sh --update    update: install packages, rebuild, restart
#     ./install.sh --uninstall remove the background services (keeps your files)
#     ./install.sh --check     change nothing, show what is installed
#
# What it installs:
#   Linux  two systemd USER services:  claude-remote, claude-remote-web
#   macOS  two launchd agents:         com.clauderemote.server, com.clauderemote.web
# Both run as you, so the service sees your Claude Code sign-in and sessions.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
MOBILE_DIR="$ROOT/mobile"
WEB_DIR="$MOBILE_DIR/service"
OS="$(uname -s)"

# ------------------------------------------------------------------ helpers

if [ -t 1 ]; then C='\033[36m'; G='\033[32m'; Y='\033[33m'; R='\033[31m'; N='\033[0m'; else C=''; G=''; Y=''; R=''; N=''; fi
say()  { printf "\n${C}== %s${N}\n" "$*"; }
note() { printf "   %s\n" "$*"; }
good() { printf "   ${G}%s${N}\n" "$*"; }
warn() { printf "   ${Y}! %s${N}\n" "$*"; }
fail() { printf "\n${R}X  %s${N}\n" "$*" >&2; exit 1; }

ask() { # ask "Question" "default" -> echoes the answer
  local answer
  if [ -n "${2:-}" ]; then read -r -p "   $1 [$2] " answer || true; else read -r -p "   $1 " answer || true; fi
  printf '%s' "${answer:-${2:-}}"
}
ask_yes() { # ask_yes "Question" y|n -> exit status 0 for yes
  local hint='y/N' answer
  [ "${2:-y}" = y ] && hint='Y/n'
  read -r -p "   $1 ($hint) " answer || true
  answer="${answer:-${2:-y}}"
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

npm_in() { # npm_in <dir> <description> <args...>
  local dir="$1" what="$2"; shift 2
  note "$what ($dir)"
  (cd "$dir" && npm "$@" --no-fund --no-audit --loglevel=error) || fail "$what failed in $dir."
}

config_value() { # config_value <file> <key> -> prints the value, or nothing
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined && v !== null) process.stdout.write(String(v)); } catch {}' "$1" "$2"
}

local_ip() {
  if [ "$OS" = Darwin ]; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

# ------------------------------------------------------------------ service managers

SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/claude-remote"
NAMES=(server web)

unit_name()  { [ "$1" = server ] && echo claude-remote || echo claude-remote-web; }
agent_name() { [ "$1" = server ] && echo com.clauderemote.server || echo com.clauderemote.web; }
dir_of()     { [ "$1" = server ] && echo "$SERVER_DIR" || echo "$WEB_DIR"; }
title_of()   { [ "$1" = server ] && echo "Claude Remote" || echo "Claude Remote Web"; }

is_installed() {
  if [ "$OS" = Darwin ]; then [ -f "$LAUNCHD_DIR/$(agent_name "$1").plist" ]
  else [ -f "$SYSTEMD_DIR/$(unit_name "$1").service" ]; fi
}

# PATH for the services: where node and claude are now. Services do not read your shell profile.
service_path() {
  local p="" d
  for cmd in node npm claude; do
    if command -v "$cmd" >/dev/null 2>&1; then
      d="$(dirname "$(command -v "$cmd")")"
      case ":$p:" in *":$d:"*) ;; *) p="${p:+$p:}$d" ;; esac
    fi
  done
  echo "${p:+$p:}/usr/local/bin:/usr/bin:/bin"
}

write_service() { # write_service server|web
  local name="$1" dir node_bin path_value
  dir="$(dir_of "$name")"
  node_bin="$(command -v node)"
  path_value="$(service_path)"
  if [ "$OS" = Darwin ]; then
    mkdir -p "$LAUNCHD_DIR" "$LOG_DIR"
    cat > "$LAUNCHD_DIR/$(agent_name "$name").plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(agent_name "$name")</string>
  <key>ProgramArguments</key>
  <array><string>$node_bin</string><string>--no-warnings</string><string>$dir/index.mjs</string></array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$path_value</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/$name.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$name.err.log</string>
</dict>
</plist>
PLIST
  else
    mkdir -p "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/$(unit_name "$name").service" <<UNIT
[Unit]
Description=$(title_of "$name")
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$dir
ExecStart=$node_bin --no-warnings $dir/index.mjs
Environment=PATH=$path_value
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  fi
}

start_service() {
  local name="$1"
  if [ "$OS" = Darwin ]; then
    local label plist; label="$(agent_name "$name")"; plist="$LAUNCHD_DIR/$label.plist"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || fail "launchd could not start $label."
  else
    systemctl --user daemon-reload
    systemctl --user enable --now "$(unit_name "$name")" >/dev/null 2>&1 || fail "systemd could not start $(unit_name "$name"). See: journalctl --user -u $(unit_name "$name")"
    systemctl --user restart "$(unit_name "$name")"
  fi
}

stop_service() {
  local name="$1"
  is_installed "$name" || return 0
  if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/$(agent_name "$name")" >/dev/null 2>&1 || true
  else systemctl --user stop "$(unit_name "$name")" >/dev/null 2>&1 || true; fi
}

remove_service() {
  local name="$1"
  is_installed "$name" || return 0
  stop_service "$name"
  if [ "$OS" = Darwin ]; then rm -f "$LAUNCHD_DIR/$(agent_name "$name").plist"
  else
    systemctl --user disable "$(unit_name "$name")" >/dev/null 2>&1 || true
    rm -f "$SYSTEMD_DIR/$(unit_name "$name").service"
    systemctl --user daemon-reload
  fi
  good "$(title_of "$name") removed."
}

service_running() {
  if [ "$OS" = Darwin ]; then launchctl print "gui/$(id -u)/$(agent_name "$1")" 2>/dev/null | grep -q 'state = running'
  else systemctl --user is-active --quiet "$(unit_name "$1")"; fi
}

# ------------------------------------------------------------------ start

MODE=install
case "${1:-}" in
  --update) MODE=update ;;
  --uninstall) MODE=uninstall ;;
  --check) MODE=check ;;
  ""|--install) ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *) fail "Unknown option: $1 (use --update, --uninstall or --check)" ;;
esac

printf '\nClaude Remote - install / update (%s)\n' "$OS"
[ "$OS" = Linux ] || [ "$OS" = Darwin ] || fail "This script is for Linux and macOS. On Windows, use install.ps1."
[ -f "$SERVER_DIR/index.mjs" ] && [ -f "$MOBILE_DIR/package.json" ] || fail "Run this from the folder that contains 'server' and 'mobile' (now: $ROOT)."
[ "$(id -u)" -ne 0 ] || fail "Run this as your normal user, not with sudo: the service must run as you to see your Claude sign-in."

if [ "$MODE" = check ]; then
  say 'Check only - nothing is changed'
  for n in "${NAMES[@]}"; do
    if is_installed "$n"; then
      if service_running "$n"; then note "$(title_of "$n"): installed, running"; else note "$(title_of "$n"): installed, not running"; fi
    else note "$(title_of "$n"): not installed"; fi
  done
  exit 0
fi

if [ "$MODE" = uninstall ]; then
  say 'Removing the background services'
  for n in "${NAMES[@]}"; do remove_service "$n"; done
  if ask_yes 'Also remove the desktop-app permission hook from your Claude settings?' n; then
    (cd "$SERVER_DIR" && node hook/install.mjs uninstall) || warn 'Could not remove the hook.'
  fi
  note "Your files and settings in $ROOT were not touched."
  exit 0
fi

if [ "$OS" = Linux ] && ! command -v systemctl >/dev/null 2>&1; then
  fail 'systemd was not found. Run the service yourself instead:  cd server && npm install && npm start'
fi

say 'Checking the tools'
command -v node >/dev/null 2>&1 || fail 'Node.js is not installed. Install version 20 or newer (https://nodejs.org) and run this again.'
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $(node -v) is too old; install version 20 or newer."
good "Node.js $(node -v)"
command -v npm >/dev/null 2>&1 || fail 'npm was not found. Install it with Node.js.'
if command -v claude >/dev/null 2>&1; then good 'Claude Code found'
else warn "Claude Code was not found in PATH. Install it and sign in ('claude', then '/login') before using the service."; fi

if [ "$MODE" = update ] && ! is_installed server; then
  warn 'The service is not installed yet; doing a full install instead.'
  MODE=install
fi

PROXY=""; WANT_HOOK=n; WANT_FIREWALL=n
if [ "$MODE" = install ]; then
  say 'Settings'
  PROXY="$(ask 'HTTP proxy this computer needs to reach the internet (empty = none):' "$(config_value "$SERVER_DIR/bridge-config.json" proxy)")"
  ask_yes 'Send permission prompts from the Claude desktop app and terminal sessions to your phone (installs a Claude Code hook)?' y && WANT_HOOK=y
  if [ "$OS" = Linux ] && command -v ufw >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    ask_yes 'Open the ports in the ufw firewall so your phone can connect?' y && WANT_FIREWALL=y
  fi
fi

# ------------------------------------------------------------------ packages and build

say 'Stopping the services'
for n in "${NAMES[@]}"; do stop_service "$n"; done

say 'Installing packages (this can take a few minutes the first time)'
npm_in "$SERVER_DIR" 'Server packages' install
npm_in "$MOBILE_DIR" 'App packages' install
npm_in "$WEB_DIR" 'Web host packages' install

say 'Building the web app'
npm_in "$MOBILE_DIR" 'Web app build' run build:web

# Settings files: access token and ports are created on first run; keep the proxy.
(cd "$SERVER_DIR" && node --input-type=module -e "import('./config.mjs').then(m => m.loadConfig())")
if [ "$MODE" = install ]; then
  (cd "$SERVER_DIR" && CR_PROXY="$PROXY" node --input-type=module -e "import('./config.mjs').then(m => { m.loadConfig(); m.saveSetting('proxy', process.env.CR_PROXY || ''); })")
fi

# ------------------------------------------------------------------ services

say 'Installing and starting the services'
for n in "${NAMES[@]}"; do
  write_service "$n"
  start_service "$n"
  good "$(title_of "$n") started."
done

if [ "$OS" = Linux ] && [ "$MODE" = install ]; then
  # Without "linger", user services stop when you log out.
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
    if loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"; then
      good 'The services keep running after you log out.'
    else
      warn "Run 'sudo loginctl enable-linger $USER' so the services keep running after you log out."
    fi
  fi
fi

if [ "$WANT_HOOK" = y ]; then
  say 'Permission hook for the Claude desktop app'
  (cd "$SERVER_DIR" && node hook/install.mjs install) || warn 'Could not install the hook.'
fi

SERVER_PORT="$(config_value "$SERVER_DIR/bridge-config.json" port)"; SERVER_PORT="${SERVER_PORT:-8787}"
WEB_PORT="$(config_value "$WEB_DIR/web-config.json" port)"; WEB_PORT="${WEB_PORT:-8091}"

if [ "$WANT_FIREWALL" = y ]; then
  sudo ufw allow "$SERVER_PORT/tcp" comment 'Claude Remote' >/dev/null && sudo ufw allow "$WEB_PORT/tcp" comment 'Claude Remote Web' >/dev/null \
    && good "Ports $SERVER_PORT and $WEB_PORT open in ufw." || warn 'Could not change ufw.'
fi
if [ "$OS" = Darwin ] && [ "$MODE" = install ]; then
  note 'If macOS asks whether "node" may accept incoming connections, choose Allow.'
fi

# ------------------------------------------------------------------ summary

sleep 2
IP="$(local_ip)"; IP="${IP:-<this computer IP>}"
say 'Done'
for n in "${NAMES[@]}"; do service_running "$n" || warn "$(title_of "$n") is not running yet. Logs: $([ "$OS" = Darwin ] && echo "$LOG_DIR" || echo "journalctl --user -u $(unit_name "$n")")"; done
echo "Web app:        http://$IP:$WEB_PORT"
echo "Android app:    address $IP:$SERVER_PORT"
echo "Access token:   see 'token' in $SERVER_DIR/bridge-config.json"
echo "Telegram bot:   put the bot token in that file (see docs/INSTALL.md), then run ./install.sh --update"
echo "Update later:   git pull && ./install.sh --update"
echo
