/**
 * Kiểm tra logic đếm roundStats + dữ liệu Mongo local/remote.
 * Chạy: node scripts/verify-round-stats.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { checkWhoWinRound } = require('../utilities/helper');
const {
  countPlayerTieBankerFromBigRoads,
  normalizeWinCounts,
  resolveRoundStats,
} = require('../utilities/baccaratBigRoad');
const { predictResultSchema } = require('../config/schema/index.schema');

const LOCAL_MONGO =
  process.env.LOCAL_MONGO_URL || 'mongodb://127.0.0.1:27017/db_bacarat';

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function assertEq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('  got :', got);
    console.log('  want:', want);
  }
  return ok;
}

function runUnitTests() {
  section('1) checkWhoWinRound — map road');
  assertEq('road 0 = B', checkWhoWinRound(0), 'B');
  assertEq('road 1 = B', checkWhoWinRound(1), 'B');
  assertEq('road 2 = B', checkWhoWinRound(2), 'B');
  assertEq('road 3 = T (không còn B)', checkWhoWinRound(3), 'T');
  assertEq('road 8 = P', checkWhoWinRound(8), 'P');
  assertEq('road 12 = T', checkWhoWinRound(12), 'T');

  section('2) Tie overlay — count>0 không tính thêm B');
  const bigRoadsWithTie = [
    { stampTime: 1, showX: 0, showY: 0, count: 0, road: 1 },
    { stampTime: 2, showX: 0, showY: 0, count: 1, road: 1 },
    { stampTime: 3, showX: 1, showY: 0, count: 0, road: 9 },
  ];
  const oldWrong = { player: 0, tie: 0, banker: 0 };
  for (const item of bigRoadsWithTie) {
    const r = item.road;
    if ([8, 9, 10].includes(r)) oldWrong.player += 1;
    else if ([0, 1, 2].includes(r)) oldWrong.banker += 1;
    else oldWrong.tie += 1;
  }
  const computed = countPlayerTieBankerFromBigRoads(bigRoadsWithTie);
  console.log('Đếm SAI (cũ, bỏ qua count):', oldWrong);
  console.log('Đếm MỚI (bigRoad):', computed);
  assertEq('banker=1', computed.banker, 1);
  assertEq('tie=1', computed.tie, 1);
  assertEq('player=1', computed.player, 1);

  section('3) winCounts API normalize');
  const fromApi = normalizeWinCounts({ Banker: 10, Player: 8, Tie: 2 });
  assertEq('parse Banker/Player/Tie', fromApi, { banker: 10, player: 8, tie: 2 });

  const resolved = resolveRoundStats(bigRoadsWithTie, { B: 5, P: 3, T: 1 });
  console.log('resolveRoundStats (ưu tiên API B/P/T):', resolved);
  assertEq('source=api', resolved.source, 'api');
  assertEq('banker from api', resolved.banker, 5);
}

async function inspectMongo(uri, label) {
  section(`4) Mongo — ${label}`);
  console.log('URI:', uri.replace(/\/\/[^@]+@/, '//***@'));

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('✓ Kết nối OK');

    const tables = await predictResultSchema
      .find({})
      .select('tableName roundStats winCounts totalRound -_id')
      .limit(5)
      .lean();

    if (!tables.length) {
      console.log('⚠ Không có bàn trong DB — cần chạy server + session poll trước');
      return { ok: true, tables: 0 };
    }

    console.log(`Tìm thấy ${tables.length} bàn (sample max 5):\n`);

    for (const t of tables) {
      const name = t.tableName;
      const rs = t.roundStats;
      const wc = t.winCounts;
      const rounds = Array.isArray(t.totalRound) ? t.totalRound : [];
      const recomputed = countPlayerTieBankerFromBigRoads(rounds);

      console.log(`--- ${name} ---`);
      console.log('  roundStats (DB):', rs ?? '(chưa có — cần poll scratch)');
      console.log('  winCounts (DB):', wc ?? '(null)');
      console.log('  totalRound items:', rounds.length);

      if (rs) {
        const match =
          rs.player === recomputed.player &&
          rs.tie === recomputed.tie &&
          rs.banker === recomputed.banker;
        if (rs.source === 'computed') {
          console.log(
            match
              ? '  ✓ roundStats khớp đếm lại từ totalRound'
              : '  ✗ roundStats LỆCH so với đếm totalRound'
          );
          if (!match) {
            console.log('    DB roundStats:', rs);
            console.log('    Recomputed:   ', recomputed);
          }
        } else {
          console.log('  ℹ source=api — so khớp winCounts gốc');
        }
      } else {
        console.log('  Recomputed từ totalRound (chưa sync roundStats):', recomputed);
      }
      console.log('');
    }

    const withStats = await predictResultSchema.countDocuments({
      'roundStats.player': { $exists: true },
    });
    const total = await predictResultSchema.countDocuments({});
    console.log(`Bàn có roundStats: ${withStats}/${total}`);

    return { ok: true, tables: total, withStats };
  } catch (err) {
    console.log('✗ Lỗi:', err.message);
    return { ok: false, err: err.message };
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

async function main() {
  runUnitTests();

  const local = await inspectMongo(LOCAL_MONGO, 'local');
  if (!local.ok) {
    const remote = process.env.URL_CONNECT_MONGODB;
    if (remote && remote !== LOCAL_MONGO) {
      await inspectMongo(remote, 'remote (.env)');
    }
  }

  section('5) Gợi ý');
  console.log('- Chạy server: cd tool-baccarat-v2-scratch-data && npm start');
  console.log('- Cần session Puppeteer gửi JSESSIONID → server mới poll API Sexy');
  console.log('- Sau poll ~2s, roundStats sẽ xuất hiện trong Mongo');
  console.log('- Đổi Mongo local: set LOCAL_MONGO_URL trong .env hoặc sửa URL_CONNECT_MONGODB');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
