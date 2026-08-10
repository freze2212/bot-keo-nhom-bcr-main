/**
 * Xóa predictResult → theo dõi scraper Firefox cào lại data.
 * Chạy khi server.js + session.js đang chạy.
 */
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const TABLE = process.env.WATCH_TABLE || 'C04';
const MONGO = process.env.URL_CONNECT_MONGODB;
const DURATION_MS = Number(process.env.WATCH_MS || 300000);
const INTERVAL_MS = 10000;

const schema = new mongoose.Schema({}, { strict: false, collection: 'predictresults' });
const Predict = mongoose.models.WatchPredict || mongoose.model('WatchPredict', schema);

async function snapshot(label) {
  const total = await Predict.countDocuments({});
  const c04 = await Predict.findOne({ tableName: TABLE }).lean();
  return {
    label,
    at: new Date().toISOString(),
    totalDocs: total,
    c04: c04
      ? {
          totalRound: Array.isArray(c04.totalRound) ? c04.totalRound.length : 0,
          percentRound: c04.percentCurrent?.round || c04.percentCurrent?.Round,
          maintenance: c04.maintenance,
        }
      : null,
  };
}

await mongoose.connect(MONGO);
console.log('Mongo connected:', MONGO.replace(/\/\/[^@]+@/, '//***@'));

const before = await snapshot('before-delete');
console.log('Before:', JSON.stringify(before));

const del = await Predict.deleteMany({});
console.log(`Deleted ${del.deletedCount} documents from predictresults`);

const afterDel = await snapshot('after-delete');
console.log('After delete:', JSON.stringify(afterDel));

console.log(`\nWatching ${TABLE} every ${INTERVAL_MS / 1000}s for ${DURATION_MS / 1000}s...`);
console.log('(Cần server.js + servicePuppeteer/session.js đang chạy)\n');

const start = Date.now();
let lastC04Rounds = -1;
while (Date.now() - start < DURATION_MS) {
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
  const snap = await snapshot('watch');
  const rounds = snap.c04?.totalRound ?? 0;
  const changed = rounds !== lastC04Rounds;
  lastC04Rounds = rounds;
  console.log(
    `[${snap.at.slice(11, 19)}] docs=${snap.totalDocs} ${TABLE} rounds=${rounds} round=${snap.c04?.percentRound ?? '—'}${changed && rounds > 0 ? ' ← NEW DATA' : ''}`
  );
  if (snap.totalDocs > 0 && rounds > 0) {
    console.log('\n✓ Data đã được cào lại vào Mongo');
    await mongoose.disconnect();
    process.exit(0);
  }
}

const final = await snapshot('timeout');
console.log('\n✗ Timeout — không thấy data mới:', JSON.stringify(final, null, 2));
await mongoose.disconnect();
process.exit(1);
