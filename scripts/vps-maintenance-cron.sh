#!/usr/bin/env bash
# Chạy định kỳ (cron) — dọn log, giữ Mongo sống, cảnh báo disk.
# Không restart PM2 trừ khi mongod vừa được khôi phục.

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/api-bcr/api-bcr}"
LOG="/var/log/bcr-maintenance.log"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-92}"
MONGOD_LOG_MAX_MB="${MONGOD_LOG_MAX_MB:-150}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

disk_use_pct() {
  df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

ensure_mongod_conf_stability() {
  local conf="/etc/mongod.conf"
  [[ -f "$conf" ]] || return 0
  if ! grep -q 'diagnosticDataCollectionEnabled: false' "$conf" 2>/dev/null; then
    printf '\nsetParameter:\n  diagnosticDataCollectionEnabled: false\n' >> "$conf"
    log "Added diagnosticDataCollectionEnabled: false to mongod.conf"
  fi
  if ! grep -q 'logRotate:' "$conf" 2>/dev/null; then
    sed -i '/^systemLog:/a\  logRotate: reopen' "$conf" 2>/dev/null || true
  fi
}

cleanup_mongo_artifacts() {
  rm -rf /var/lib/mongodb/diagnostic.data/* 2>/dev/null || true
  local mongod_log="/var/log/mongodb/mongod.log"
  if [[ -f "$mongod_log" ]]; then
    local size_mb
    size_mb=$(du -m "$mongod_log" | cut -f1)
    if (( size_mb > MONGOD_LOG_MAX_MB )); then
      : > "$mongod_log"
      log "Truncated mongod.log (${size_mb}MB > ${MONGOD_LOG_MAX_MB}MB)"
    fi
  fi
}

cleanup_system_logs() {
  journalctl --vacuum-size=400M >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
}

cleanup_pm2_logs() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 flush >/dev/null 2>&1 || true
    if pm2 describe pm2-logrotate >/dev/null 2>&1; then
      pm2 trigger pm2-logrotate rotate >/dev/null 2>&1 || true
    fi
  fi
}

ensure_mongod_running() {
  if systemctl is-active --quiet mongod 2>/dev/null; then
    return 0
  fi
  log "mongod down — attempting start"
  chown -R mongodb:mongodb /var/lib/mongodb /var/log/mongodb 2>/dev/null || true
  rm -f /var/lib/mongodb/mongod.lock 2>/dev/null || true
  cleanup_mongo_artifacts
  ensure_mongod_conf_stability
  systemctl start mongod 2>/dev/null || true
  sleep 2
  if systemctl is-active --quiet mongod 2>/dev/null; then
    log "mongod started OK"
    if [[ -d "$APP_DIR" ]]; then
      (cd "$APP_DIR" && pm2 restart server_sexy --update-env >/dev/null 2>&1) || true
    fi
    return 0
  fi
  log "mongod still down — check: journalctl -u mongod -n 30"
  return 1
}

trim_mongo_rounds() {
  [[ -d "$APP_DIR" ]] || return 0
  [[ -f "$APP_DIR/.env" ]] || return 0
  (cd "$APP_DIR" && node <<'NODE') >>"$LOG" 2>&1 || log "trim mongo rounds skip/fail"
require("dotenv").config();
const mongoose = require("mongoose");
const maxRounds = Number(process.env.MAX_TOTAL_ROUNDS_PER_TABLE) || 400;
(async () => {
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    authSource: "admin",
    serverSelectionTimeoutMS: 10000,
  });
  const col = mongoose.connection.db.collection("predictresults");
  const cursor = col.find({}, { projection: { tableName: 1, totalRound: 1 } });
  let trimmed = 0;
  for await (const doc of cursor) {
    const rounds = doc.totalRound || [];
    if (rounds.length <= maxRounds) continue;
    const sorted = [...rounds].sort((a, b) => Number(b.stampTime) - Number(a.stampTime));
    const keep = sorted.slice(0, maxRounds);
    await col.updateOne({ _id: doc._id }, { $set: { totalRound: keep } });
    trimmed++;
  }
  if (trimmed) console.log("trimmed tables:", trimmed, "maxRounds:", maxRounds);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(0);
});
NODE
}

USE=$(disk_use_pct)
log "=== maintenance start | disk ${USE}% ==="

if (( USE >= DISK_CRIT_PCT )); then
  log "CRIT disk ${USE}% — aggressive cleanup"
  cleanup_pm2_logs
  cleanup_system_logs
  cleanup_mongo_artifacts
elif (( USE >= DISK_WARN_PCT )); then
  log "WARN disk ${USE}% — light cleanup"
  cleanup_mongo_artifacts
  cleanup_pm2_logs
fi

ensure_mongod_conf_stability
ensure_mongod_running || true
trim_mongo_rounds

USE_AFTER=$(disk_use_pct)
log "=== maintenance done | disk ${USE_AFTER}% ==="
