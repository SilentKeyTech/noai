#!/bin/bash
# NOAI+ ACT III demo server. Fake data only. Secrets are made here, on the
# server, and never leave it: the vault passphrase and the admin password.
set -euxo pipefail
exec > >(tee /var/log/noai-setup.log) 2>&1

dnf install -y git tar xz openssl

NODE=v24.19.0
cd /opt
curl -fsSLO "https://nodejs.org/dist/${NODE}/node-${NODE}-linux-arm64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${NODE}/SHASUMS256.txt"
grep " node-${NODE}-linux-arm64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-${NODE}-linux-arm64.tar.xz"
ln -sfn "/opt/node-${NODE}-linux-arm64" /opt/node
export PATH=/opt/node/bin:$PATH

useradd -r -m -d /var/lib/noai -s /sbin/nologin noai || true
git clone --depth 1 -b feat/aws-role-key https://github.com/SilentKeyTech/noai.git /opt/noai
cd /opt/noai
npm ci --omit=dev --ignore-scripts
chown -R noai:noai /opt/noai

install -d -m 700 -o root -g root /etc/noai
if [ ! -f /etc/noai/env ]; then
  umask 077
  cat > /etc/noai/env <<EOF
NOAI_HOME=/var/lib/noai/data
NOAI_PASSPHRASE=$(openssl rand -base64 33 | tr -d '\n')
NOAI_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=\n')
NOAI_GATEWAY_HOST=0.0.0.0
NOAI_GATEWAY_PORT=7794
NOAI_GATEWAY_UPSTREAM=https://bedrock-runtime.eu-north-1.amazonaws.com/openai/v1
NOAI_GATEWAY_KEY=aws-role
AWS_REGION=eu-north-1
NOAI_MODEL=openai.gpt-oss-120b-1:0
NOAI_GATEWAY_MODELS=openai.gpt-oss-120b-1:0
NOAI_GATEWAY_ALLOWED_ORIGINS=
EOF
fi

run_noai() { sudo -u noai env $(grep -v '^#' /etc/noai/env | xargs) PATH=/opt/node/bin:/usr/bin /opt/node/bin/node "$@"; }

if [ ! -d /var/lib/noai/data ]; then
  install -d -m 700 -o noai -g noai /var/lib/noai/data
  run_noai src/cli.ts init
  run_noai src/cli.ts seed
  run_noai src/staff-cli.ts add admin --admin | sed -n 's/^Token, shown once: //p' > /etc/noai/admin-token
  run_noai src/staff-cli.ts add judges | sed -n 's/^Token, shown once: //p' > /etc/noai/judges-token
  chmod 600 /etc/noai/admin-token /etc/noai/judges-token
fi

cat > /etc/systemd/system/noai-gateway.service <<'EOF'
[Unit]
Description=NOAI+ gateway (ACT III demo)
After=network-online.target
Wants=network-online.target

[Service]
User=noai
Group=noai
WorkingDirectory=/opt/noai
EnvironmentFile=/etc/noai/env
ExecStart=/opt/node/bin/node src/gateway-serve.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/noai
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now noai-gateway
echo NOAI-SETUP-DONE
