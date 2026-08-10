/**
 * Xóa predictResult → theo dõi scraper cào lại.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { predictResultSchema } = require('../config/schema/index.schema');

const mongoOptions = {
  authSource: 'admin',
  serverSelectionTimeoutMS: 15000,
};

const TABLE = process.env.WATCH_TABLE || 'C04';
const DURATION_MS = Number(process.env.WATCH_MS || 300000);
const INTERVAL_MS = 10000;

async function snapshot(label) {
  const total = await predictResultSchema.countDocuments({});
  const c04 = await predictResultSchema.findOne({ tableName: TABLE }).lean();
  return {
    label,
    at: new Date().toISOString(),
    totalDocs: total,
    c04: c04
      ? {
          totalRound: Array.isArray(c04.totalRound) ? c04.totalRound.length : 0,
          percentRound: c04.percentCurrent?.round || c04.percentCurrent?.Round,
        }
      : null,
  };
}

(async () => {
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, mongoOptions);
  console.log('Mongo OK');

  const before = await snapshot('before');
  console.log('Before:', JSON.stringify(before));

  const del = await predictResultSchema.deleteMany({});
  console.log(`Deleted ${del.deletedCount} tables`);

  const start = Date.now();
  let lastRounds = -1;
  while (Date.now() - start < DURATION_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const snap = await snapshot('watch');
    const rounds = snap.c04?.totalRound ?? 0;
    const tag = rounds !== lastRounds && rounds > 0 ? ' ← DATA' : '';
    lastRounds = rounds;
    console.log(
      `[${snap.at.slice(11, 19)}] docs=${snap.totalDocs} ${TABLE} rounds=${rounds}${tag}`
    );
    if (snap.totalDocs > 5 && rounds > 0) {
      console.log('OK — data refilled');
      await mongoose.disconnect();
      process.exit(0);
    }
  }
  console.log('TIMEOUT — no refill');
  console.log(await snapshot('final'));
  await mongoose.disconnect();
  process.exit(1);
})();
