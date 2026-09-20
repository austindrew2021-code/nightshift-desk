#!/usr/bin/env bash
# Run on a fresh Ubuntu 24.04 VPS (Singapore) as root.
# Usage: GH_TOKEN=ghp_... bash deploy/vps-install.sh
set -euo pipefail
REPO="${REPO:-https://github.com/austindrew2021-code/nightshift-desk.git}"
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "Set GH_TOKEN to a GitHub PAT with repo write (pushes ict-live)."
  exit 1
fi
id -u nightshift >/dev/null 2>&1 || useradd -m -s /bin/bash nightshift
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
sudo -u nightshift bash -s <<EOF
set -euo pipefail
cd /home/nightshift
if [[ ! -d desk/.git ]]; then
  git clone "$REPO" desk
fi
cd desk
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/austindrew2021-code/nightshift-desk.git"
git fetch origin
git checkout main
git pull --ff-only origin main
npm ci
if [[ ! -d /home/nightshift/live/.git ]]; then
  git clone --branch ict-live --single-branch "$REPO" /home/nightshift/live
fi
cd /home/nightshift/live
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/austindrew2021-code/nightshift-desk.git"


cat > /home/nightshift/desk/.env <<ENV
ICT_STATE_PATH=/home/nightshift/live/ict-state.json
ICT_START_USD=100
ICT_EVERY_MS=20000
ICT_PUSH=1
GH_TOKEN=${GH_TOKEN}
ENV
chmod 600 /home/nightshift/desk/.env
EOF
install -m 644 /home/nightshift/desk/deploy/nightshift-hunt.service /etc/systemd/system/nightshift-hunt.service
systemctl daemon-reload
systemctl enable --now nightshift-hunt
systemctl --no-pager status nightshift-hunt || true
echo "hunter up · logs: journalctl -u nightshift-hunt -f"
