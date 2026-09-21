#!/usr/bin/env bash
# Outbound HTTPS viewer via Cloudflare (no 80/443 inbound). $0.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb
fi
cat >/usr/local/bin/nightshift-view.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
rm -f /tmp/cf-view.log
/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 2>&1 | tee /tmp/cf-view.log
EOF
chmod +x /usr/local/bin/nightshift-view.sh
cat >/etc/systemd/system/nightshift-view.service <<'EOF'
[Unit]
Description=NIGHTSHIFT Tokyo HTTPS viewer (Cloudflare tunnel)
After=network-online.target nightshift-hunt.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/nightshift-view.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now nightshift-view
sleep 6
echo "---- tunnel url (wait if empty, then: journalctl -u nightshift-view -n 40 --no-pager) ----"
grep -oE 'https://[a-z0-9-]+\.trycloudflare.com' /tmp/cf-view.log | tail -1 || true
journalctl -u nightshift-view -n 25 --no-pager
