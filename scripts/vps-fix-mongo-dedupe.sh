#!/usr/bin/env bash
# Chạy TRÊN VPS — dọn duplicate predictresults (1068 → ~30 bàn)
# Usage: cd /var/www/api-bcr/api-bcr && bash scripts/vps-fix-mongo-dedupe.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Stop PM2 (tránh poll ghi DB lúc dọn)..."
pm2 stop all 2>/dev/null || true
sleep 5

echo "==> Dedupe + unique index..."
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
  console.log("unique tableName:", keepIds.length);

  const del = await col.deleteMany({ _id: { $nin: keepIds } });
  console.log("deleted:", del.deletedCount);

  const after = await col.countDocuments();
  console.log("documents after:", after);

  try {
    await col.createIndex({ tableName: 1 }, { unique: true, name: "tableName_unique" });
    console.log("unique index tableName OK");
  } catch (e) {
    if (e.code === 85 || e.codeName === "IndexOptionsConflict") {
      await col.dropIndex("tableName_1").catch(() => {});
      await col.createIndex({ tableName: 1 }, { unique: true, name: "tableName_unique" });
      console.log("replaced index with unique tableName");
    } else throw e;
  }

  console.log("indexes:", await col.indexes());

  const t0 = Date.now();
  await col.find({}).project({ tableName: 1, dealerImage: 1, percentCurrent: 1, shuffle: 1, maintenance: 1 }).toArray();
  console.log("benchmark find-all ms:", Date.now() - t0);

  const t1 = Date.now();
  await col.findOne({ tableName: "C04" });
  console.log("benchmark findOne C04 ms:", Date.now() - t1);

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
NODE

echo ""
echo "==> Start PM2 (từ từ)..."
pm2 start ecosystem.config.js --only server_sexy
sleep 30
pm2 start ecosystem.config.js --only session_sexy_1
sleep 45
pm2 start ecosystem.config.js --only session_sexy_2
pm2 save

echo ""
echo "==> DONE. Test API:"
echo 'curl -s -o /dev/null -w "get-all-table: %{time_total}s HTTP:%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3201/predict/get-all-table'
