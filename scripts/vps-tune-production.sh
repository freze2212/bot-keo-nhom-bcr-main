#!/usr/bin/env bash
# Chạy TRÊN VPS freze — dedupe Mongo + PM2 gọn, tránh tràn RAM/CPU
# Usage:
#   cd /var/www/api-bcr/api-bcr
#   bash scripts/vps-tune-production.sh
#
# Tùy chọn (Mongo VPS nhanh, cùng db_bacarat — cần whitelist IP freze trên mongo đó):
#   FAST_MONGO_URL='mongodb://USER:PASS@103.90.226.14:27017/db_bacarat' bash scripts/vps-tune-production.sh

set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

echo "========== 1) Kiểm tra tài nguyên =========="
echo "load: $(uptime)"
free -h | head -3
df -h / | tail -1
echo "PM2 hiện tại:"
pm2 list 2>/dev/null || true

echo ""
echo "========== 2) Benchmark Mongo (URL trong .env) =========="
node <<'NODE'
require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  const url = process.env.URL_CONNECT_MONGODB || "";
  const masked = url.replace(/:([^:@/]+)@/, ":****@");
  console.log("URL:", masked);

  const t0 = Date.now();
  await mongoose.connect(url, {
    authSource: "admin",
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  const connectMs = Date.now() - t0;

  const col = mongoose.connection.db.collection("predictresults");
  const count = await col.countDocuments();
  const distinct = (await col.distinct("tableName")).length;

  let t = Date.now();
  await col.find({}).project({ tableName: 1 }).limit(50).toArray();
  const findMs = Date.now() - t;

  console.log(JSON.stringify({ connectMs, count, distinct, findSampleMs: findMs }, null, 2));
  await mongoose.disconnect();
})().catch((e) => {
  console.error("Mongo FAIL:", e.message);
  process.exit(1);
});
NODE

if [[ -n "${FAST_MONGO_URL:-}" ]]; then
  echo ""
  echo "========== 2b) Đổi sang Mongo VPS nhanh =========="
  cp -a .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
  if grep -q '^URL_CONNECT_MONGODB=' .env; then
    sed -i "s|^URL_CONNECT_MONGODB=.*|URL_CONNECT_MONGODB=\"${FAST_MONGO_URL}\"|" .env
  else
    echo "URL_CONNECT_MONGODB=\"${FAST_MONGO_URL}\"" >> .env
  fi
  echo "Đã cập nhật .env — test lại connect..."
  node <<'NODE'
require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  const t0 = Date.now();
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    authSource: "admin",
    serverSelectionTimeoutMS: 15000,
  });
  console.log("connectMs after switch:", Date.now() - t0);
  await mongoose.disconnect();
})();
NODE
fi

echo ""
echo "========== 3) Cập nhật code + .env production =========="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull origin main 2>/dev/null || git pull 2>/dev/null || echo "git pull skip"
fi
npm install --omit=dev 2>/dev/null || npm install

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
ensure_env "POLL_INTERVAL_MS" "2000"
ensure_env "MAX_TOTAL_ROUNDS_PER_TABLE" "400"
echo ".env: SERVER_VERBOSE_LOG=false, POLL_INTERVAL_MS=2000, MAX_TOTAL_ROUNDS_PER_TABLE=400"

echo ""
echo "========== 4) Stop PM2 (không dùng restart all) =========="
pm2 stop all 2>/dev/null || true
sleep 8

echo ""
echo "========== 5) Dedupe + unique index tableName =========="
node <<'NODE'
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    authSource: "admin",
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
  });
  const col = mongoose.connection.db.collection("predictresults");

  const before = await col.countDocuments();
  console.log("documents before:", before);

  const keepRows = await col
    .aggregate([
      { $addFields: { lastStamp: { $max: "$totalRound.stampTime" } } },
      { $sort: { tableName: 1, lastStamp: -1, _id: -1 } },
      { $group: { _id: "$tableName", keepId: { $first: "$_id" } } },
    ])
    .toArray();

  const keepIds = keepRows.map((r) => r.keepId);
  const del = await col.deleteMany({ _id: { $nin: keepIds } });
  console.log("unique tableName:", keepIds.length, "| deleted:", del.deletedCount);

  try {
    await col.dropIndex("tableName_1");
  } catch (_) {}
  try {
    await col.createIndex({ tableName: 1 }, { unique: true, name: "tableName_unique" });
  } catch (e) {
    if (e.codeName === "IndexOptionsConflict") {
      await col.dropIndex("tableName_unique").catch(() => {});
      await col.createIndex({ tableName: 1 }, { unique: true, name: "tableName_unique" });
    } else throw e;
  }

  const after = await col.countDocuments();
  const t0 = Date.now();
  await col
    .find({})
    .project({ tableName: 1, dealerImage: 1, percentCurrent: 1, shuffle: 1, maintenance: 1 })
    .toArray();
  console.log("documents after:", after, "| find-all ms:", Date.now() - t0);

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
NODE

echo ""
echo "========== 6) PM2 production (3 app, không cron_restart) =========="
pm2 delete all 2>/dev/null || true
sleep 3

PM2_FILE="ecosystem.config.production.js"
[[ -f "$PM2_FILE" ]] || PM2_FILE="ecosystem.config.js"

pm2 start "$PM2_FILE" --only server_sexy
echo "Đợi server connect Mongo + nhận session (30s)..."
sleep 30

pm2 start "$PM2_FILE" --only session_sexy_1
echo "Đợi session 1 login (45s)..."
sleep 45

pm2 start "$PM2_FILE" --only session_sexy_2
sleep 10

pm2 save
pm2 startup 2>/dev/null | tail -1 || true

echo ""
echo "========== 7) Nginx timeout (tránh 502 khi Node trả chậm) =========="
NGINX_CONF=""
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [[ -f "$f" ]] || continue
  if grep -qE '3201|hacksexy' "$f" 2>/dev/null; then
    NGINX_CONF="$f"
    break
  fi
done

if [[ -n "$NGINX_CONF" ]]; then
  echo "Found: $NGINX_CONF"
  if ! grep -q 'proxy_read_timeout 120s' "$NGINX_CONF"; then
    sudo sed -i '/proxy_pass/i \        proxy_connect_timeout 120s;\n        proxy_send_timeout 120s;\n        proxy_read_timeout 120s;' "$NGINX_CONF" 2>/dev/null || \
      echo "  -> Thêm tay vào $NGINX_CONF: proxy_read_timeout 120s;"
    sudo nginx -t && sudo systemctl reload nginx && echo "nginx reloaded OK" || echo "nginx reload FAIL — sửa tay"
  else
    echo "nginx timeout đã có"
  fi
else
  echo "Không tìm thấy nginx config hacksexy/3201 — bỏ qua"
fi

echo ""
echo "========== 8) Health check =========="
sleep 5
ss -lntp | grep 3201 || echo "WARN: chưa listen 3201"

node <<'NODE'
require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  const t0 = Date.now();
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    authSource: "admin",
    serverSelectionTimeoutMS: 15000,
  });
  const col = mongoose.connection.db.collection("predictresults");
  const count = await col.countDocuments();
  const distinct = (await col.distinct("tableName")).length;
  let t = Date.now();
  await col.find({}).project({ tableName: 1 }).toArray();
  console.log("HEALTH:", JSON.stringify({
    mongoConnectMs: Date.now() - t0,
    docCount: count,
    uniqueTables: distinct,
    findAllMs: Date.now() - t,
    ok: count <= 50 && count === distinct,
  }));
  await mongoose.disconnect();
})().catch((e) => console.error("HEALTH FAIL:", e.message));
NODE

echo ""
pm2 list
free -h | head -3
echo ""
echo "========== 9) Stability (cron + log rotate + Mongo FTDC off) =========="
if [[ -f scripts/vps-setup-stability.sh ]]; then
  bash scripts/vps-setup-stability.sh || echo "WARN: vps-setup-stability.sh failed — chạy lại: sudo bash scripts/vps-setup-stability.sh"
else
  echo "Skip: scripts/vps-setup-stability.sh not found"
fi

echo ""
echo "========== XONG =========="
echo "Pass nếu: docCount ~30, findAllMs <500, server_sexy online, CPU không 100% liên tục"
echo ""
echo "Test API (set TOKEN trước):"
echo '  export TOKEN="..."'
echo '  curl -s -o /dev/null -w "get-all-table: %{time_total}s HTTP:%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3201/predict/get-all-table'
echo '  curl -s -o /dev/null -w "get-table C18: %{time_total}s HTTP:%{http_code}\n" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3201/predict/get-table-by-name?tableName=C18"'
echo ""
echo "Theo dõi: pm2 monit"
