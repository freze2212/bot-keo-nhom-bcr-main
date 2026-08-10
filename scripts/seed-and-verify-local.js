/**
 * Seed Mongo local + sync roundStats để test không cần Puppeteer session.
 * node scripts/seed-and-verify-local.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { predictResultSchema } = require('../config/schema/index.schema');
const { checkWhoWinRound } = require('../utilities/helper');
const {
  countPlayerTieBankerFromBigRoads,
  resolveRoundStats,
} = require('../utilities/baccaratBigRoad');

const MONGO =
  process.env.LOCAL_MONGO_URL || 'mongodb://127.0.0.1:27017/db_bacarat';

const TABLE = 'TEST_LOCAL';

/** bigRoads giả lập: B, B+hòa overlay, P, T road=12, B road=0 */
const SAMPLE_BIG_ROADS = [
  { stampTime: 1001, showX: 0, showY: 0, count: 0, road: 1 },
  { stampTime: 1002, showX: 0, showY: 0, count: 1, road: 1 },
  { stampTime: 1003, showX: 1, showY: 0, count: 0, road: 9 },
  { stampTime: 1004, showX: 2, showY: 0, count: 0, road: 12 },
  { stampTime: 1005, showX: 3, showY: 0, count: 0, road: 0 },
];

const SAMPLE_WIN_COUNTS = { Banker: 2, Player: 1, Tie: 2 };

function buildTotalRound(bigRoads) {
  return bigRoads.map((r, i) => ({
    stampTime: r.stampTime,
    showX: r.showX,
    showY: r.showY,
    count: r.count,
    road: r.road,
    win: true,
    roadFormat: checkWhoWinRound(r.road),
    roadRandom: 'B',
    id: i + 1,
  }));
}

async function main() {
  console.log('Mongo:', MONGO.replace(/\/\/[^@]+@/, '//***@'));
  await mongoose.connect(MONGO);

  const roundStats = resolveRoundStats(SAMPLE_BIG_ROADS, SAMPLE_WIN_COUNTS);
  const computedOnly = countPlayerTieBankerFromBigRoads(SAMPLE_BIG_ROADS);

  console.log('\n--- Kỳ vọng từ bigRoads (computed) ---');
  console.log(computedOnly);
  console.log('=> banker=2 (road 1 + road 0), tie=1 (overlay), player=1');

  console.log('\n--- roundStats lưu DB (ưu tiên winCounts API) ---');
  console.log(roundStats);
  console.log('=> source=api: Banker=2, Player=1, Tie=2');

  await predictResultSchema.deleteOne({ tableName: TABLE });
  await predictResultSchema.create({
    tableName: TABLE,
    tableID: 9999,
    maintenance: 0,
    dealerImage: null,
    iTime: 25,
    roundStartTime: Date.now(),
    shuffle: 0,
    statusGame: 'GP_NEW_GAME_START',
    percentCurrent: {
      Player: 40,
      Tier: 10,
      Banker: 50,
      Round: 'B',
      Forecast: 88,
    },
    winCounts: SAMPLE_WIN_COUNTS,
    roundStats,
    totalRound: buildTotalRound(SAMPLE_BIG_ROADS),
  });

  const doc = await predictResultSchema
    .findOne({ tableName: TABLE })
    .select('roundStats winCounts totalRound -_id')
    .lean();

  console.log('\n--- Đọc lại Mongo ---');
  console.log(JSON.stringify(doc, null, 2));

  const okApi =
    doc.roundStats?.source === 'api' &&
    doc.roundStats.banker === 2 &&
    doc.roundStats.player === 1 &&
    doc.roundStats.tie === 2;

  const recomputed = countPlayerTieBankerFromBigRoads(doc.totalRound);
  console.log('\n--- Đếm lại từ totalRound trong DB ---');
  console.log(recomputed);

  console.log(okApi ? '\n✓ PASS roundStats API' : '\n✗ FAIL roundStats');

  await mongoose.disconnect();

  console.log('\nChạy server + test HTTP:');
  console.log(`  $env:URL_CONNECT_MONGODB="${MONGO}"; npm start`);
  console.log(`  curl "http://localhost:3201/predict/get-table-by-name?tableName=${TABLE}" -H "Authorization: Bearer <token>"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
