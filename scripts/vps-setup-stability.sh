#!/usr/bin/env bash
# Chạy 1 lần trên VPS — tự bảo trì disk + Mongo + log PM2 (không cần dọn tay hàng ngày).
#
# Usage:
#   cd /var/www/api-bcr/api-bcr
#   sudo bash scripts/vps-setup-stability.sh

set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

echo "========== BCR VPS stability setup =========="
echo "App dir: $APP_DIR"

disk_use_pct() {
  df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

echo ""
echo "========== 1) Emergency free disk (nếu >= 90%) =========="
USE=$(disk_use_pct)
echo "Disk use: ${USE}%"
if (( USE >= 90 )); then
  pm2 flush 2>/dev/null || true
  journalctl --vacuum-size=300M 2>/dev/null || true
  apt-get clean 2>/dev/null || true
  rm -rf /var/lib/mongodb/diagnostic.data/* 2>/dev/null || true
  [[ -f /var/log/mongodb/mongod.log ]] && truncate -s 0 /var/log/mongodb/mongod.log
  echo "Emergency cleanup done. Disk now: $(disk_use_pct)%"
fi

echo ""
echo "========== 2) MongoDB — tắt FTDC + log rotate =========="
MONGO_CONF="/etc/mongod.conf"
if [[ -f "$MONGO_CONF" ]]; then
  cp -a "$MONGO_CONF" "${MONGO_CONF}.bak.$(date +%Y%m%d_%H%M%S)"
  if ! grep -q 'diagnosticDataCollectionEnabled: false' "$MONGO_CONF"; then
    printf '\nsetParameter:\n  diagnosticDataCollectionEnabled: false\n' >> "$MONGO_CONF"
    echo "Added setParameter.diagnosticDataCollectionEnabled: false"
  fi
  if ! grep -q 'logRotate:' "$MONGO_CONF"; then
    sed -i '/^systemLog:/a\  logRotate: reopen' "$MONGO_CONF" 2>/dev/null || true
    echo "Added systemLog.logRotate: reopen"
  fi
  chown -R mongodb:mongodb /var/lib/mongodb /var/log/mongodb 2>/dev/null || true
  rm -f /var/lib/mongodb/mongod.lock 2>/dev/null || true
  systemctl enable mongod 2>/dev/null || true
  systemctl restart mongod 2>/dev/null || systemctl start mongod 2>/dev/null || true
  sleep 2
  systemctl is-active --quiet mongod && echo "mongod: active" || echo "WARN: mongod not active — xem journalctl -u mongod"
else
  echo "Skip: $MONGO_CONF not found"
fi

cat > /etc/logrotate.d/mongodb-bcr <<'EOF'
/var/log/mongodb/mongod.log {
  daily
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  size 100M
}
EOF
echo "logrotate: /etc/logrotate.d/mongodb-bcr"

echo ""
echo "========== 3) journald — giới hạn dung lượng =========="
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/bcr-limit.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemMaxFileSize=50M
MaxRetentionSec=5day
EOF
systemctl restart systemd-journald 2>/dev/null || true
echo "journald limited to 500M"

echo ""
echo "========== 4) PM2 log rotation =========="
if command -v pm2 >/dev/null 2>&1; then
  pm2 install pm2-logrotate 2>/dev/null || true
  pm2 set pm2-logrotate:max_size 50M
  pm2 set pm2-logrotate:retain 7
  pm2 set pm2-logrotate:compress true
  pm2 set pm2-logrotate:rotateInterval "0 3 * * *"
  pm2 save 2>/dev/null || true
  echo "pm2-logrotate: max 50M x 7 files"
else
  echo "WARN: pm2 not found"
fi

echo ""
echo "========== 5) .env production defaults =========="
ensure_env() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}
[[ -f .env ]] || cp .env.example .env
ensure_env "SERVER_VERBOSE_LOG" "false"
ensure_env "MAX_TOTAL_ROUNDS_PER_TABLE" "400"
ensure_env "POLL_INTERVAL_MS" "2000"
echo "SERVER_VERBOSE_LOG=false, MAX_TOTAL_ROUNDS_PER_TABLE=400"

echo ""
echo "========== 6) Cron bảo trì (mỗi 6 giờ) =========="
chmod +x "$APP_DIR/scripts/vps-maintenance-cron.sh"
CRON_LINE="0 */6 * * * APP_DIR=$APP_DIR $APP_DIR/scripts/vps-maintenance-cron.sh"
(crontab -l 2>/dev/null | grep -v 'vps-maintenance-cron.sh'; echo "$CRON_LINE") | crontab -
echo "crontab:"
crontab -l | grep vps-maintenance || true

echo ""
echo "========== 7) Chạy maintenance lần đầu =========="
APP_DIR="$APP_DIR" bash "$APP_DIR/scripts/vps-maintenance-cron.sh"

echo ""
echo "========== 8) Restart API (nếu PM2 đang chạy) =========="
if pm2 describe server_sexy >/dev/null 2>&1; then
  pm2 restart server_sexy --update-env
  echo "server_sexy restarted"
fi

echo ""
echo "========== XONG =========="
echo "Disk: $(disk_use_pct)% | mongod: $(systemctl is-active mongod 2>/dev/null || echo '?')"
echo "Log bảo trì: /var/log/bcr-maintenance.log"
echo "Theo dõi: tail -f /var/log/bcr-maintenance.log"
