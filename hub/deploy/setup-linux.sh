#!/usr/bin/env bash
# One-command MarketHub setup on a Linux VPS (Ubuntu/Debian):
#   sudo bash setup-linux.sh
# Installs Python + Chrome, builds the server version, tests the Shoonya login,
# and installs a systemd service (starts on boot, restarts on crash).
# Safe to run again: it updates everything in place.
set -euo pipefail

ROOT=/opt/markethub
SRC="$(cd "$(dirname "$0")" && pwd)"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mOK\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mWARN\033[0m %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "run it with sudo: sudo bash setup-linux.sh"
for f in shoonya_auto_login.py hub/Cargo.toml hub/config.toml hub/deploy/markethub.service; do
    [ -e "$SRC/$f" ] || fail "$f is missing next to this script"
done
# Broker logins never come in the package: the .env next to this script (if you
# put one there) or the one already installed. First install: a blank one to fill in.
if [ ! -e "$SRC/.env" ] && [ ! -e "$ROOT/.env" ]; then
    [ -e "$SRC/.env.example" ] || fail ".env is missing: copy yours next to this script"
    install -m 600 "$SRC/.env.example" "$SRC/.env"
    fail "made .env from .env.example: fill in your broker logins (nano $SRC/.env), then run this again"
fi

step "System packages (Python, build tools, Chrome)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv build-essential pkg-config curl wget ca-certificates >/dev/null
if ! command -v google-chrome >/dev/null; then
    wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb >/dev/null
fi
ok "python3, google-chrome"

step "Files into $ROOT"
id markethub &>/dev/null || useradd -m -s /usr/sbin/nologin markethub
systemctl stop markethub 2>/dev/null || true
mkdir -p "$ROOT"
[ "$SRC" = "$ROOT" ] || cp -a "$SRC"/. "$ROOT"/
rm -f "$ROOT"/hub/*.exe
ok "$ROOT"

step "Login script packages"
[ -x "$ROOT/.venv/bin/python" ] || python3 -m venv "$ROOT/.venv"
"$ROOT/.venv/bin/pip" install -q --disable-pip-version-check selenium pyotp requests python-dotenv
ok "selenium, pyotp, requests, python-dotenv"

step "Building MarketHub (first time ~5-10 min)"
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ] && ! swapon --show | grep -q .; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "added 2 GB swap so the build has enough memory"
fi
command -v cargo >/dev/null || [ -x "$HOME/.cargo/bin/cargo" ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
export PATH="$HOME/.cargo/bin:$PATH"
(cd "$ROOT/hub" && cargo build --release --no-default-features)
sed -i 's#"../.venv/Scripts/python.exe"#"../.venv/bin/python"#' "$ROOT/hub/config.toml"
chmod 600 "$ROOT/.env"
chown -R markethub: "$ROOT"
ok "$ROOT/hub/target/release/hub"

step "Testing the Shoonya login (headless Chrome, ~20 s)"
if sudo -u markethub -H "$ROOT/.venv/bin/python" "$ROOT/shoonya_auto_login.py" --save >/dev/null 2>/tmp/markethub-login.err; then
    ok "Shoonya login works; token saved"
else
    warn "$(grep -v '^\s*$' /tmp/markethub-login.err | tail -1)"
    warn "MarketHub will still start and keep retrying the login."
fi

step "Service (starts on boot, restarts on crash)"
cp "$ROOT/hub/deploy/markethub.service" /etc/systemd/system/markethub.service
systemctl daemon-reload
systemctl enable --now markethub >/dev/null 2>&1
systemctl restart markethub
ok "markethub.service running"

step "First status (waiting 15 s)"
sleep 15
journalctl -u markethub -n 8 -o cat --no-pager || true

printf '\n\033[1;32mDone.\033[0m MarketHub runs in the background and starts on boot.\n'
printf 'Live status any time:  journalctl -u markethub -f -o cat\n'
