#!/usr/bin/env bash
# HTTPS in front of the hunter so the phone reads Tokyo (~20s), not GitHub cache (~5m).
# Run as root on nightshift-tokyo after Lightsail Networking has HTTP 80 + HTTPS 443 open.
set -euo pipefail
HOST="${TOKYO_HOST:-54-95-202-110.sslip.io}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y caddy
cat >/etc/caddy/Caddyfile <<EOF
${HOST} {
  encode gzip
  header Cache-Control "no-store, no-cache, must-revalidate"
  header Access-Control-Allow-Origin "*"
  reverse_proxy 127.0.0.1:8787
}
EOF
systemctl enable --now caddy
systemctl reload caddy
echo "https://${HOST}/ict-state.json"
curl -sS -o /dev/null -w "https %{http_code}\n" "https://${HOST}/ict-state.json" || true
