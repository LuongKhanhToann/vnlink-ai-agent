#!/usr/bin/env bash
#
# setup-gemma-tunnel.sh — dựng reverse SSH tunnel VĨNH VIỄN từ máy GPU (rhass, chạy ollama
# gemma4:12b) lên box valdev, để bot (ENGINE=gemma) gọi ollama qua http://127.0.0.1:11439.
#
#   máy GPU rhass ──ssh -R──▶ valdev:127.0.0.1:11439 ──▶ bot vinalink-ai
#
# Làm gì:
#   1. Tạo keypair ed25519 riêng cho tunnel trên máy rhass (~/.ssh/valdev_tunnel)
#   2. Ghi public key vào authorized_keys của valdev với "restrict,port-forwarding"
#      (key CHỈ mở được tunnel, không chạy được lệnh — an toàn hơn copy pem sang máy GPU)
#   3. Cài systemd unit gemma-tunnel.service trên rhass (Restart=always, keepalive 30s)
#   4. Verify: curl ollama từ valdev qua tunnel
#
# Chạy:   bash setup-gemma-tunnel.sh
#         (hỏi mật khẩu rhass lúc chạy — không lưu vào đâu cả)
# Lưu ý:  IP valdev churn → chạy lại script này (nó tự resolve IP mới + sửa unit).
set -euo pipefail

RHASS="rhass@100.112.147.122"
KEY="${KEY:-/Users/khanhtoan/val/val_dev.pem}"
DEV_HOST="${DEV_HOST:-$(dig +short @1.1.1.1 dev.valgourmet.vn | tail -1)}"
[ -n "$DEV_HOST" ] || { echo "Không resolve được IP valdev; chạy DEV_HOST=x.x.x.x bash $0"; exit 1; }
SSH_DEV="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $KEY ubuntu@$DEV_HOST"

read -r -s -p "Mật khẩu SSH của $RHASS: " RPASS; echo
R() { sshpass -p "$RPASS" ssh -o StrictHostKeyChecking=no "$RHASS" "$@"; }

echo "==> [1/4] Tạo keypair tunnel trên máy GPU (nếu chưa có)"
R "[ -f ~/.ssh/valdev_tunnel ] || ssh-keygen -t ed25519 -f ~/.ssh/valdev_tunnel -N '' -C gemma-tunnel-rhass >/dev/null"
PUB=$(R "awk '{print \$1\" \"\$2\" \"\$3}' ~/.ssh/valdev_tunnel.pub")
echo "    pubkey: ${PUB:0:40}..."

echo "==> [2/4] Cho phép key này mở tunnel trên valdev ($DEV_HOST) — restrict, chỉ port-forwarding"
$SSH_DEV "grep -qF 'gemma-tunnel-rhass' ~/.ssh/authorized_keys 2>/dev/null || echo 'restrict,port-forwarding $PUB' >> ~/.ssh/authorized_keys"

echo "==> [3/4] Cài systemd unit gemma-tunnel.service trên máy GPU"
R "echo '$RPASS' | sudo -S bash -c 'cat > /etc/systemd/system/gemma-tunnel.service' <<EOF
[Unit]
Description=Reverse SSH tunnel: ollama gemma 11439 -> valdev
After=network-online.target
Wants=network-online.target

[Service]
User=rhass
ExecStart=/usr/bin/ssh -i /home/rhass/.ssh/valdev_tunnel -N \
  -R 127.0.0.1:11439:127.0.0.1:11439 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
  ubuntu@$DEV_HOST
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
echo '$RPASS' | sudo -S systemctl daemon-reload
echo '$RPASS' | sudo -S systemctl enable --now gemma-tunnel.service
sleep 3
echo '$RPASS' | sudo -S systemctl is-active gemma-tunnel.service"

echo "==> [4/4] Verify: gọi ollama từ valdev qua tunnel"
sleep 2
$SSH_DEV "curl -s -m 10 http://127.0.0.1:11439/api/tags | head -c 200; echo"
echo
echo "✔ Tunnel OK. Bot ENGINE=gemma trên valdev giờ gọi được gemma4:12b."
