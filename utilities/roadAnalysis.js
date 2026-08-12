/**
 * Phân tích cầu thực tế trên N tay B/P gần nhất.
 * Mirror logic bot.py analyze_road_profile — dùng để chọn bàn cầu đẹp.
 */

const ROAD_ANALYSIS_WINDOW = Number(process.env.ROAD_ANALYSIS_WINDOW) || 20;
const ROAD_ANALYSIS_MIN_BP = Number(process.env.ROAD_ANALYSIS_MIN_BP) || 20;
const ROAD_ANALYSIS_MIN_CONF = Number(process.env.ROAD_ANALYSIS_MIN_CONF) || 0.72;

function roadToSide(roadOrFormat) {
  if (roadOrFormat === "B" || roadOrFormat === "P" || roadOrFormat === "T") {
    return roadOrFormat;
  }
  if (typeof roadOrFormat === "string") {
    const u = roadOrFormat.trim().toUpperCase();
    if (u === "B" || u === "BANKER") return "B";
    if (u === "P" || u === "PLAYER") return "P";
    if (u === "T" || u === "TIE" || u === "HÒA" || u === "HOA") return "T";
  }
  const code = Number(roadOrFormat);
  if (!Number.isFinite(code)) return null;
  if (code === 0 || code === 1 || code === 2) return "B";
  if (code === 8 || code === 9 || code === 10) return "P";
  return "T";
}

function extractBpSequence(totalRound, limit = 48) {
  if (!Array.isArray(totalRound) || !totalRound.length) return [];
  const ordered = [];
  for (const r of totalRound) {
    if (!r || typeof r !== "object") continue;
    const st = r.stampTime != null ? Number(r.stampTime) : NaN;
    if (!Number.isFinite(st)) continue;
    const side = roadToSide(r.roadFormat || r.road);
    if (side !== "B" && side !== "P") continue;
    ordered.push({ st, side });
  }
  ordered.sort((a, b) => a.st - b.st);
  const seq = ordered.map((x) => x.side);
  if (limit && seq.length > limit) return seq.slice(-limit);
  return seq;
}

function currentStreak(seq) {
  if (!seq.length) return { side: null, n: 0 };
  const last = seq[seq.length - 1];
  let n = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) n += 1;
    else break;
  }
  return { side: last, n };
}

function maxStreakInSeq(seq) {
  if (!seq.length) return { side: null, n: 0 };
  let bestSide = seq[0];
  let bestLen = 1;
  let curSide = seq[0];
  let curLen = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) curLen += 1;
    else {
      curSide = seq[i];
      curLen = 1;
    }
    if (curLen > bestLen) {
      bestSide = curSide;
      bestLen = curLen;
    }
  }
  return { side: bestSide, n: bestLen };
}

function isTwoTwo(seq) {
  if (seq.length < 6) return false;
  const t = seq.slice(-6);
  return (
    t[0] === t[1] &&
    t[2] === t[3] &&
    t[4] === t[5] &&
    t[0] !== t[2] &&
    t[2] !== t[4] &&
    t[0] === t[4]
  );
}

function runLengthPattern(seq) {
  if (!Array.isArray(seq) || seq.length < 8) return null;
  const runs = [];
  for (const side of seq) {
    const last = runs[runs.length - 1];
    if (last && last.side === side) last.length += 1;
    else runs.push({ side, length: 1 });
  }
  if (runs.length < 5) return null;

  const completed = runs.slice(0, -1);
  const lengths = completed.map((r) => r.length);
  const current = runs[runs.length - 1];
  const maxContext = Math.min(5, lengths.length - 1);
  for (let contextSize = maxContext; contextSize >= 2; contextSize--) {
    const needle = lengths.slice(-contextSize);
    const targets = [];
    for (let i = 0; i < lengths.length - contextSize; i++) {
      const same = needle.every((n, j) => lengths[i + j] === n);
      if (!same) continue;
      const target = lengths[i + contextSize];
      if (target >= 1 && target <= 8) targets.push(target);
    }
    if (!targets.length || new Set(targets).size !== 1) continue;
    const targetLength = targets[0];
    if (current.length > targetLength) continue;
    const side =
      current.length < targetLength
        ? current.side
        : current.side === "B"
          ? "P"
          : "B";
    const confidence = Math.min(
      0.9,
      0.72 + contextSize * 0.015 + Math.min(targets.length, 3) * 0.02
    );
    const expanded = [...lengths, targetLength];
    let rhythm = [...needle, targetLength];
    for (
      let period = 2;
      period <= Math.min(6, Math.floor(expanded.length / 2));
      period++
    ) {
      const latest = expanded.slice(-period);
      const previous = expanded.slice(-period * 2, -period);
      if (latest.every((n, i) => previous[i] === n)) {
        rhythm = latest;
        break;
      }
    }
    return {
      side,
      confidence: Math.round(confidence * 1000) / 1000,
      rhythm,
      targetLength,
      currentLength: current.length,
      matches: targets.length,
    };
  }
  return null;
}

function analyzeRoadProfile(totalRound, window) {
  const win = Number(window || ROAD_ANALYSIS_WINDOW) || 20;
  const seqAll = extractBpSequence(totalRound, Math.max(win, 48));
  const seq = seqAll.length >= win ? seqAll.slice(-win) : seqAll;
  const handCount = seq.length;
  const bCount = seq.filter((s) => s === "B").length;
  const pCount = seq.filter((s) => s === "P").length;

  const base = {
    ready: false,
    roadType: "WAIT",
    side: null,
    confidence: 0,
    trend: "chưa đủ dữ liệu phân tích",
    handCount,
    window: win,
    seqDisplay: seq.join(""),
    bCount,
    pCount,
    streak: 0,
    streakSide: null,
    maxStreak: 0,
    maxStreakSide: null,
    chopRatio: 0,
    reason: "",
    score: 0,
  };

  if (handCount < ROAD_ANALYSIS_MIN_BP) {
    base.reason = `thiếu cầu (${handCount}/${ROAD_ANALYSIS_MIN_BP} tay B/P)`;
    return base;
  }

  const { side: last, n: streak } = currentStreak(seq);
  const { side: maxSide, n: maxStreak } = maxStreakInSeq(seq);
  const rhythm = runLengthPattern(seq);
  const lookback = seq.length >= 18 ? seq.slice(-18) : seq;
  let flips = 0;
  for (let i = 1; i < lookback.length; i++) {
    if (lookback[i] !== lookback[i - 1]) flips += 1;
  }
  const chopRatio = flips / Math.max(1, lookback.length - 1);
  const biasRatio = Math.max(bCount, pCount) / Math.max(1, handCount);

  let roadType = "NOISE";
  let side = null;
  let confidence = 0;
  let trend = "cầu lộn xộn";

  if (chopRatio >= 0.78 && maxStreak <= 3) {
    roadType = "CHOP";
    side = last === "B" ? "P" : "B";
    confidence = 0.52 + Math.min(0.18, (chopRatio - 0.78) * 2.5);
    trend = `cầu 1-1 đảo (${flips}/${lookback.length - 1} lần lật)`;
  } else if (rhythm && (rhythm.side === "B" || rhythm.side === "P")) {
    roadType = "RHYTHM";
    side = rhythm.side;
    confidence = rhythm.confidence;
    trend =
      `nhịp ${rhythm.rhythm.join("-")}; dây hiện tại ` +
      `${rhythm.currentLength}/${rhythm.targetLength}`;
  } else if (streak >= 3 && (last === "B" || last === "P")) {
    roadType = "BET";
    side = last;
    confidence =
      0.68 +
      Math.min(0.22, (streak - 3) * 0.07 + Math.max(0, maxStreak - streak) * 0.02);
    trend = `bệt ${side === "B" ? "Cái" : "Con"} x${streak}`;
  } else if (isTwoTwo(seq)) {
    roadType = "TWO_TWO";
    side = last === "B" ? "P" : "B";
    confidence = 0.7;
    trend = "cầu 2-2 (BB PP lặp)";
  } else if (biasRatio >= 0.58) {
    roadType = "BIAS";
    side = bCount > pCount ? "B" : "P";
    confidence = 0.62 + Math.min(0.25, (Math.abs(bCount - pCount) / handCount) * 0.8);
    trend = `lệch ${side === "B" ? "Cái" : "Con"} ${bCount}/${pCount}`;
  } else if (streak === 2 && (last === "B" || last === "P")) {
    roadType = "BET";
    side = last;
    confidence = 0.64;
    trend = `bệt nhẹ ${side === "B" ? "Cái" : "Con"} x2`;
  } else {
    roadType = "NOISE";
    confidence = 0.35;
    trend = "cầu chưa rõ — không vào kèo";
  }

  const ready =
    !["CHOP", "NOISE", "WAIT"].includes(roadType) &&
    confidence >= ROAD_ANALYSIS_MIN_CONF;

  let reason = trend;
  if (roadType === "CHOP") reason = "cầu chop — bỏ bàn";
  if (roadType === "NOISE") reason = "cầu lộn xộn — chưa đủ xu hướng";

  // Score để xếp hạng bàn: ưu tiên BET/TWO_TWO > BIAS, conf cao, bệt dài
  let score = 0;
  if (ready) {
    const typeBoost =
      { BET: 3.0, RHYTHM: 2.9, TWO_TWO: 2.6, BIAS: 2.0, PATTERN: 1.8 }[
        roadType
      ] || 1.0;
    score = typeBoost + confidence * 2 + Math.min(streak, 6) * 0.15;
  }

  return {
    ready,
    roadType,
    side,
    confidence: Math.round(confidence * 1000) / 1000,
    trend,
    handCount,
    window: win,
    seqDisplay: seq.join(""),
    bCount,
    pCount,
    streak,
    streakSide: last,
    maxStreak,
    maxStreakSide: maxSide,
    chopRatio: Math.round(chopRatio * 1000) / 1000,
    reason,
    rhythm,
    score: Math.round(score * 1000) / 1000,
  };
}

module.exports = {
  ROAD_ANALYSIS_WINDOW,
  ROAD_ANALYSIS_MIN_BP,
  ROAD_ANALYSIS_MIN_CONF,
  extractBpSequence,
  analyzeRoadProfile,
  runLengthPattern,
  roadToSide,
};
