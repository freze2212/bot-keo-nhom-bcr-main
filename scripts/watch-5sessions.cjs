/**
 * Theo dõi NS1-NS5 + Mongo C04 cập nhật round mới.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { predictResultSchema } = require('../config/schema/index.schema');

const DURATION_MS = Number(process.env.WATCH_MS || 240000);
const INTERVAL_MS = 15000;

(async () => {
  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    authSource: 'admin',
    serverSelectionTimeoutMS: 15000,
  });

  let prev = null;
  const start = Date.now();
  console.log('Watching Mongo + waiting for sessions (check server log for NS1..NS5)...\n');

  while (Date.now() - start < DURATION_MS) {
    const docs = await predictResultSchema.countDocuments({});
    const c04 = await predictResultSchema
      .findOne({ tableName: 'C04' })
      .select('totalRound percentCurrent')
      .lean();
    const rounds = c04?.totalRound?.length || 0;
    const last = Array.isArray(c04?.totalRound) && c04.totalRound.length
      ? [...c04.totalRound].sort((a, b) => Number(b.stampTime) - Number(a.stampTime))[0]
      : null;
    const snap = {
      at: new Date().toISOString().slice(11, 19),
      docs,
      c04Rounds: rounds,
      lastStamp: last?.stampTime || null,
      lastRoad: last?.roadFormat || null,
      round: c04?.percentCurrent?.Round || c04?.percentCurrent?.round || null,
    };
    const delta =
      prev && snap.lastStamp && snap.lastStamp !== prev.lastStamp
        ? ' ← NEW ROUND'
        : prev && snap.c04Rounds > prev.c04Rounds
          ? ' ← ROUNDS++'
          : '';
    console.log(
      `[${snap.at}] docs=${snap.docs} C04 rounds=${snap.c04Rounds} last=${snap.lastRoad}@${snap.lastStamp} predict=${snap.round}${delta}`
    );
    prev = snap;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  await mongoose.disconnect();
  console.log('done');
})();
