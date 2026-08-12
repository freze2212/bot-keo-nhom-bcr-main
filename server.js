const axios = require("axios");
const express = require("express");
const app = express();
require("dotenv").config();
const http = require("http");
const server = http.createServer(app);
const socketIO = require("socket.io");
const cors = require("cors");
const { exec } = require("child_process");

const {
  getCurrentTime,
  isValidSession,
  appendToLog,
} = require("./utilities/helper");
const {
  filterData,
  initDatabase,
  checkAndUpdateDatabase,
} = require("./utilities/helperGameSexy");
const { sendTelegramMessage, requestData } = require("./utilities/request");
const { connect } = require("./config/mongo");
const router = require("./routers/index");
const { SESSION_LIST } = require("./config/predictResult.config");
const { predictResultSchema } = require("./config/schema/index.schema");
const { analyzeRoadProfile } = require("./utilities/roadAnalysis");
const PORT = process.env.SERVER_PORT || 3201;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const SERVER_VERBOSE_LOG = process.env.SERVER_VERBOSE_LOG === "true";

app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
connect();
router(app);

// API lưu và phát tín hiệu Báo Bàn Target cho Playwright & Telegram Bot
let currentTargetTable = null;
let activeTableReadyAt = null; // chỉ hô sau khi Playwright vào bàn thật
/** Mỗi NS 1 bàn — tránh 2 session cùng bàn */
const activeTablesByNs = {};
const reservedTablesByNs = {};
const latestScreenshots = {};
const systemPauseByNs = {};
const lastPauseTelegramAt = {};
const SYSTEM_PAUSE_MSG =
  "⏳ <b>HỆ THỐNG ĐANG PHÂN TÍCH CẦU</b>\n" +
  "Vui lòng chờ tín hiệu kế tiếp... 🔮\n" +
  "--------»-----★--—-«--------";

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Hai nguồn Hall (browser forward + poll fallback) phải cập nhật DB tuần tự,
// tránh cùng đọc một trạng thái rồi emit new_round_completed hai lần.
let hallUpdateQueue = Promise.resolve();
function enqueueHallUpdate(dataTableList) {
  const task = hallUpdateQueue.then(async () => {
    await initDatabase(dataTableList);
    await checkAndUpdateDatabase(dataTableList, io);
  });
  hallUpdateQueue = task.catch((error) => {
    console.error(`[HALL UPDATE ERROR] ${error.message}`);
  });
  return task;
}

function occupiedTablesList(exceptNs) {
  const out = [];
  const seen = new Set();
  for (const [ns, info] of Object.entries(activeTablesByNs)) {
    if (exceptNs && ns === exceptNs) continue;
    if (info?.tableName) {
      out.push({ nameService: ns, tableName: info.tableName, ready: true });
      seen.add(`${ns}|${info.tableName}`);
    }
  }
  for (const [ns, info] of Object.entries(reservedTablesByNs)) {
    if (exceptNs && ns === exceptNs) continue;
    if (info?.tableName && !seen.has(`${ns}|${info.tableName}`)) {
      out.push({ nameService: ns, tableName: info.tableName, ready: false });
    }
  }
  return out;
}

function groupIdsForNs(ns) {
  const key = String(ns || "NS1").trim().toUpperCase();
  const raw =
    key === "NS2"
      ? process.env.GROUP_NS2 || process.env.GROUP
      : key === "NS1"
      ? process.env.GROUP_NS1 || process.env.GROUP
      : process.env.GROUP;
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

async function announceSystemPause(ns, reason) {
  const key = String(ns || "NS1").trim().toUpperCase() || "NS1";
  const now = Date.now();
  systemPauseByNs[key] = { at: now, reason: reason || "recover" };
  try {
    setActiveTable("NONE", key);
  } catch (_) {}
  if (lastPauseTelegramAt[key] && now - lastPauseTelegramAt[key] < 90000) {
    console.log(`[SYSTEM PAUSE] ${key} skip telegram cooldown reason=${reason}`);
    return { sent: false, cooldown: true };
  }
  lastPauseTelegramAt[key] = now;
  const token = (process.env.TOKEN_BOT || "").trim().replace(/^['"]|['"]$/g, "");
  const ids = groupIdsForNs(key);
  if (!token || !ids.length) {
    console.warn(
      `[SYSTEM PAUSE] ${key} thiếu TOKEN_BOT/GROUP — không gửi Telegram`
    );
    return { sent: false, cooldown: false };
  }
  for (const id of ids) {
    await sendTelegramMessage(token, id, SYSTEM_PAUSE_MSG);
  }
  console.log(`[SYSTEM PAUSE] ${key} telegram OK reason=${reason}`);
  return { sent: true, cooldown: false };
}

app.post("/api/ingest-hall-data", async (req, res) => {
  const tableItems = req.body?.tableItems;
  const nameService = String(req.body?.nameService || "NS").trim().toUpperCase();
  if (!Array.isArray(tableItems) || !tableItems.length) {
    return res.status(400).json({ success: false, message: "Missing tableItems" });
  }
  try {
    const dataTableList = filterData(tableItems);
    await enqueueHallUpdate(dataTableList);
    if (SERVER_VERBOSE_LOG) {
      console.log(`[HALL INGEST] ${nameService} tables=${dataTableList.length}`);
    }
    return res.json({ success: true, tables: dataTableList.length });
  } catch (e) {
    console.error(`[HALL INGEST ERROR] ${nameService}: ${e.message}`);
    return res.status(500).json({ success: false, message: e.message });
  }
});

function setActiveTable(tableName, nameService) {
  if (!tableName) return null;
  const key = String(tableName).trim().toUpperCase();
  const ns = String(nameService || "NS1").trim().toUpperCase() || "NS1";
  if (key === "NONE" || key === "LOBBY" || key === "CLEAR") {
    if (!activeTablesByNs[ns] && !reservedTablesByNs[ns]) return null;
    delete activeTablesByNs[ns];
    delete reservedTablesByNs[ns];
    if (!Object.keys(activeTablesByNs).length) {
      currentTargetTable = null;
      activeTableReadyAt = null;
    } else if (currentTargetTable) {
      const still = Object.values(activeTablesByNs).some(
        (x) => x.tableName === currentTargetTable
      );
      if (!still) {
        const first = Object.values(activeTablesByNs)[0];
        currentTargetTable = first?.tableName || null;
        activeTableReadyAt = first?.readyAt || null;
      }
    }
    console.log(`[ACTIVE TABLE] CLEARED (${ns}) — chờ Playwright vào bàn`);
    io.emit("active_table_updated", {
      tableName: null,
      nameService: ns,
      readyAt: null,
      occupied: occupiedTablesList(),
    });
    return null;
  }

  // Heartbeat cùng bàn: giữ nguyên readyAt, không ghi log/emit lại.
  if (activeTablesByNs[ns]?.tableName === key) {
    delete reservedTablesByNs[ns];
    return key;
  }

  // Trùng bàn với NS khác → conflict
  for (const info of occupiedTablesList(ns)) {
    if (info?.tableName === key) {
      const err = new Error(`TABLE_OCCUPIED_BY_${info.nameService}`);
      err.code = "TABLE_OCCUPIED";
      err.occupiedBy = info.nameService;
      err.tableName = key;
      throw err;
    }
  }

  delete reservedTablesByNs[ns];
  activeTablesByNs[ns] = { tableName: key, readyAt: Date.now() };
  delete systemPauseByNs[ns];
  currentTargetTable = key;
  activeTableReadyAt = Date.now();
  console.log(`\n==================================================`);
  console.log(`🎯 ACTIVE TABLE READY: ${key} (${ns}) @ ${activeTableReadyAt}`);
  console.log(`   occupied: ${JSON.stringify(occupiedTablesList())}`);
  console.log(`==================================================\n`);
  io.emit("active_table_updated", {
    tableName: key,
    nameService: ns,
    readyAt: activeTableReadyAt,
    occupied: occupiedTablesList(),
  });
  return key;
}

app.post("/api/reserve-table", (req, res) => {
  const key = String(req.body?.tableName || "").trim().toUpperCase();
  const ns = String(req.body?.nameService || "NS1").trim().toUpperCase() || "NS1";
  if (!key || key === "NONE" || key === "LOBBY") {
    return res.status(400).json({ success: false, message: "Missing tableName" });
  }
  const conflict = occupiedTablesList(ns).find((x) => x.tableName === key);
  if (conflict) {
    return res.status(409).json({
      success: false,
      code: "TABLE_OCCUPIED",
      tableName: key,
      occupiedBy: conflict.nameService,
      occupied: occupiedTablesList(ns),
    });
  }
  reservedTablesByNs[ns] = { tableName: key, reservedAt: Date.now() };
  console.log(`[TABLE RESERVED] ${key} (${ns}) — chưa ready, bot chưa được hô`);
  return res.json({ success: true, tableName: key, nameService: ns });
});

app.post("/api/set-target-table", (req, res) => {
  const { tableName } = req.body || {};
  if (!tableName) {
    return res.status(400).json({ success: false, message: "Missing tableName" });
  }
  const key = setActiveTable(tableName, "BOT_TARGET");
  io.emit("set_target_table", { tableName: key });
  return res.json({ success: true, targetTable: key });
});

app.post("/api/notify-active-table", async (req, res) => {
  const { tableName, nameService } = req.body || {};
  if (!tableName) {
    return res.status(400).json({ success: false, message: "Missing tableName" });
  }
  try {
    const key = setActiveTable(tableName, nameService);
    return res.json({
      success: true,
      activeTable: key,
      occupied: occupiedTablesList(),
    });
  } catch (e) {
    if (e.code === "TABLE_OCCUPIED") {
      console.log(
        `[TABLE CONFLICT] ${nameService} muốn ${e.tableName} nhưng ${e.occupiedBy} đang giữ`
      );
      return res.status(409).json({
        success: false,
        code: "TABLE_OCCUPIED",
        tableName: e.tableName,
        occupiedBy: e.occupiedBy,
        occupied: occupiedTablesList(nameService),
        message: `Bàn ${e.tableName} đã có ${e.occupiedBy} — chọn bàn khác`,
      });
    }
    throw e;
  }
});

app.get("/api/occupied-tables", (req, res) => {
  return res.json({
    success: true,
    occupied: occupiedTablesList(),
    tables: occupiedTablesList().map((x) => x.tableName),
  });
});

/** Chọn bàn cầu đẹp (≥20 tay, không chop/noise) trong danh sách freeCodes. */
app.post("/api/pick-beautiful-table", async (req, res) => {
  try {
    const freeCodes = Array.isArray(req.body?.freeCodes)
      ? req.body.freeCodes
          .map((c) => String(c || "").trim().toUpperCase())
          .filter(Boolean)
      : [];
    const ns = String(req.body?.nameService || "").trim().toUpperCase() || null;
    const occupied = new Set(
      occupiedTablesList(ns).map((x) => String(x.tableName).toUpperCase())
    );
    const candidates = freeCodes.filter((c) => !occupied.has(c));
    if (!candidates.length) {
      return res.json({
        success: false,
        tableName: null,
        message: "không còn bàn free",
        ranked: [],
      });
    }

    const docs = await predictResultSchema
      .find({ tableName: { $in: candidates } })
      .select("tableName totalRound percentCurrent shuffle maintenance -_id")
      .lean();
    const byName = new Map(
      (docs || []).map((d) => [String(d.tableName).toUpperCase(), d])
    );

    const ranked = [];
    for (const code of candidates) {
      const doc = byName.get(code);
      const profile = analyzeRoadProfile(doc?.totalRound || []);
      ranked.push({
        tableName: code,
        ready: !!profile.ready,
        roadType: profile.roadType,
        side: profile.side,
        confidence: profile.confidence,
        score: profile.score,
        handCount: profile.handCount,
        trend: profile.trend,
        seqDisplay: profile.seqDisplay,
        reason: profile.reason,
      });
    }
    ranked.sort((a, b) => {
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      return (b.score || 0) - (a.score || 0);
    });

    const best = ranked.find((x) => x.ready) || null;
    if (!best) {
      console.log(
        `[PICK BEAUTIFUL] ${ns || "?"} không có bàn cầu đẹp trong ${candidates.length} free`
      );
      return res.json({
        success: false,
        tableName: null,
        message: "không có bàn cầu đẹp (≥20 tay, conf đủ)",
        ranked: ranked.slice(0, 8),
      });
    }

    console.log(
      `[PICK BEAUTIFUL] ${ns || "?"} → ${best.tableName} ` +
        `type=${best.roadType} conf=${best.confidence} score=${best.score} ` +
        `seq=${best.seqDisplay}`
    );
    return res.json({
      success: true,
      tableName: best.tableName,
      profile: best,
      ranked: ranked.slice(0, 8),
    });
  } catch (e) {
    console.error("[PICK BEAUTIFUL ERROR]", e.message);
    return res.status(500).json({
      success: false,
      tableName: null,
      message: e.message,
    });
  }
});

/** Bot yêu cầu session out bàn xấu → chọn bàn cầu đẹp khác. */
app.post("/api/request-change-table", (req, res) => {
  const ns = String(req.body?.nameService || "").trim().toUpperCase() || "NS1";
  const reason = String(req.body?.reason || "cầu xấu").trim();
  const fromTable = String(req.body?.tableName || "").trim().toUpperCase() || null;
  console.log(`[CHANGE TABLE] ${ns} từ ${fromTable || "?"} — ${reason}`);
  // Chặn bot tiếp tục hô/báo lại bàn cũ trong lúc browser đang thao tác out bàn.
  setActiveTable(null, ns);
  io.emit("request_change_table", {
    nameService: ns,
    tableName: fromTable,
    reason,
  });
  return res.json({ success: true, nameService: ns, tableName: fromTable, reason });
});

app.get("/api/get-active-table", (req, res) => {
  const ns = req.query.nameService
    ? String(req.query.nameService).trim().toUpperCase()
    : null;
  if (ns && systemPauseByNs[ns] && Date.now() - systemPauseByNs[ns].at > 90000) {
    delete systemPauseByNs[ns];
  }
  if (ns && activeTablesByNs[ns]) {
    delete systemPauseByNs[ns];
    return res.json({
      success: true,
      activeTable: activeTablesByNs[ns].tableName,
      readyAt: activeTablesByNs[ns].readyAt,
      nameService: ns,
      occupied: occupiedTablesList(),
    });
  }
  if (ns && systemPauseByNs[ns]) {
    return res.json({
      success: false,
      paused: true,
      activeTable: null,
      readyAt: null,
      nameService: ns,
      occupied: occupiedTablesList(),
      message: "Hệ thống đang phân tích cầu kèo",
    });
  }
  if (ns) {
    return res.json({
      success: false,
      activeTable: null,
      readyAt: null,
      nameService: ns,
      occupied: occupiedTablesList(),
      message: `Playwright ${ns} chưa vào bàn`,
    });
  }
  if (!currentTargetTable || currentTargetTable === "NONE" || currentTargetTable === "LOBBY") {
    return res.json({
      success: false,
      activeTable: null,
      readyAt: null,
      occupied: occupiedTablesList(),
      message: "No active table currently entered by Playwright",
    });
  }
  return res.json({
    success: true,
    activeTable: currentTargetTable,
    readyAt: activeTableReadyAt || null,
    occupied: occupiedTablesList(),
  });
});

app.post("/api/system-pause", async (req, res) => {
  const ns =
    String(req.body?.nameService || "NS1").trim().toUpperCase() || "NS1";
  const reason = String(req.body?.reason || "recover");
  const result = await announceSystemPause(ns, reason);
  return res.json({
    success: true,
    paused: true,
    nameService: ns,
    reason,
    ...result,
  });
});

app.post("/api/request-session-restart", async (req, res) => {
  const ns =
    String(req.body?.nameService || "NS1").trim().toUpperCase() || "NS1";
  console.log(`[API RESTART] Yêu cầu Playwright restart session (${ns})`);
  await announceSystemPause(ns, "api_timeout_60s");
  io.emit(`${ns}_restart`, { reason: "api_timeout_60s", nameService: ns });
  io.emit("force_reenter_table", {
    reason: "api_timeout_60s",
    nameService: ns,
  });
  return res.json({ success: true, nameService: ns, paused: true });
});

app.post("/api/place-bet", (req, res) => {
  const { tableName, betSide, side, betAmount } = req.body || {};
  const key = tableName
    ? String(tableName).trim().toUpperCase()
    : currentTargetTable || null;
  const bet = betSide || side || "P";
  let ownerNs = null;
  for (const [ns, info] of Object.entries(activeTablesByNs)) {
    if (info?.tableName === key) {
      ownerNs = ns;
      break;
    }
  }
  if (!key || key === "NONE" || key === "LOBBY" || !ownerNs) {
    console.log(`[API PLACE BET BLOCKED] Playwright chưa vào bàn — bỏ qua`);
    return res.status(409).json({
      success: false,
      message: "Playwright chưa vào bàn (chưa có active_table)",
    });
  }
  console.log(
    `[API PLACE BET] Bot Tele đặt cược bàn ${key} (${ownerNs || "?"}) -> ${
      String(bet).toUpperCase().startsWith("B") ? "CÁI" : "CON"
    }`
  );
  io.emit("place_bet", {
    tableName: key,
    betSide: bet,
    side: bet,
    betAmount: Number(betAmount) || undefined,
    nameService: ownerNs,
  });
  return res.json({
    success: true,
    tableName: key,
    betSide: bet,
    betAmount: Number(betAmount) || null,
    nameService: ownerNs,
  });
});

app.post("/api/notify-screenshot", (req, res) => {
  const {
    tableName,
    filename,
    filepath,
    url,
    roundNum,
    resultWinner,
    nameService,
  } = req.body || {};
  if (tableName && filename) {
    const key = String(tableName).trim().toUpperCase();
    const itemData = {
      tableName: key,
      filename,
      filepath,
      url,
      roundNum: roundNum || null,
      resultWinner: resultWinner || null,
      nameService: nameService || "NS",
      stampTime: Date.now(),
    };
    latestScreenshots[key] = itemData;
    latestScreenshots["LATEST"] = itemData;
    console.log(
      `[API SCREENSHOT NOTIFY] ${key} (${nameService || "NS"}) Round #${roundNum}, Winner: ${resultWinner} -> ${filepath}`
    );
    io.emit("screenshot_ready", itemData);
  }
  return res.json({ success: true });
});

app.get("/api/latest-screenshot", (req, res) => {
  const tableName = req.query.tableName
    ? String(req.query.tableName).trim().toUpperCase()
    : "LATEST";
  const data = latestScreenshots[tableName] || latestScreenshots["LATEST"] || null;
  return res.json({ success: !!data, data });
});

let sessionList = SESSION_LIST;

io.on("connection", (socket) => {
  socket.on("session", async (payload) => {
    const { sessionId, nameService, stampTime, uriRequestData } = payload;

    if (sessionList.session.hasOwnProperty(nameService)) {
      const previous = sessionList.session[nameService];
      const sessionChanged =
        previous?.sessionId !== sessionId ||
        previous?.uriRequestData !== (uriRequestData || undefined);
      sessionList.session[nameService] = {
        nameService,
        sessionId,
        stampTime: stampTime, // || Date.now()
        uriRequestData: uriRequestData || undefined,
      };
      if (sessionChanged || SERVER_VERBOSE_LOG) {
        console.info(
          `${getCurrentTime().timeFormatted} - ${nameService || "_"} = ${
            sessionId || "_"
          }`
        );
      }
    }

    if (nameService == "NS5") {
      sessionList.sessionFailover.nameService = nameService;
      sessionList.sessionFailover.sessionId = sessionId;
      sessionList.sessionFailover.stampTime = stampTime;
      // console.info(`${getCurrentTime().timeFormatted} - ${nameService} = ${sessionId} - SESSION FAILOVER`);
    }
  });

  // Playwright báo bàn đang đứng (backup cho HTTP notify)
  socket.on("notify_active_table", (payload) => {
    const tableName = payload && payload.tableName;
    const nameService = payload && payload.nameService;
    if (!tableName) return;
    try {
      setActiveTable(tableName, nameService || "SOCKET");
    } catch (e) {
      if (e.code === "TABLE_OCCUPIED") {
        console.log(
          `[SOCKET CONFLICT] ${nameService} ${e.tableName} đã có ${e.occupiedBy}`
        );
      } else {
        console.error("[SOCKET notify_active_table]", e.message);
      }
    }
  });
});

// thời gian khởi động lại service là 8 phút
setInterval(async () => {
  try {
    const timeUnixCurrent = getCurrentTime().timeUnix;

    for (const key in sessionList.session) {
      const session = sessionList.session[key];
      if (
        session.stampTime > 0 &&
        timeUnixCurrent - session.stampTime > 60 * 1000 * 10
      ) {
        await appendToLog(
          `${
            session.nameService || key
          } | QUÁ 10 PHÚT CHƯA ĐƯỢC CẬP NHẬT - YÊU CẦU KHỞI ĐỘNG LẠI`,
          process.env.LOGS_SERVER_SEXY
        );
        if (session.nameService) {
          session.stampTime = timeUnixCurrent - 60 * 1000 * 8;
          // io.emit(`${session.nameService}_restart`, {});
          // console.log(`ĐÃ GỬI YÊU CẦU KHỞI ĐỘNG LẠI => ${session.nameService}`);
          // let cmdReloadPm2 = `pm2 reload ${session.namePm2}`
          switch (session.nameService) {
            case "NS1":
              cmdReloadPm2 = "pm2 reload session_sexy_1";
              break;
            case "NS2":
              cmdReloadPm2 = "pm2 reload session_sexy_2";
              break;
            case "NS3":
              cmdReloadPm2 = "pm2 reload session_sexy_3";
              break;
            case "NS4":
              cmdReloadPm2 = "pm2 reload session_sexy_4";
              break;
          }
          exec(cmdReloadPm2, async (error, stdout, stderr) => {
            if (error) {
              await appendToLog(
                `Lỗi khi reload PM2: ${error.message}`,
                process.env.LOGS_SERVER_SEXY
              );
              return;
            }
            if (stderr) {
              console.error(`stderr: ${stderr}`);
              return;
            }
            await appendToLog(
              `stdout: ${stdout}`,
              process.env.LOGS_SERVER_SEXY
            );
            await appendToLog(
              `(PM2)KHỞI ĐỘNG LẠI SERVICE => ${session.nameService}: ${error.message}`,
              process.env.LOGS_SERVER_SEXY
            );
          });
        }
      }
    }
  } catch (error) {
    await appendToLog(
      `restart service: ${error}`,
      process.env.LOGS_SERVER_SEXY
    );
  }
}, 5000);

setInterval(async () => {
  const sessionKeys = Object.keys(sessionList.session);
  let availableSessions = sessionKeys
    .filter((key) => isValidSession(sessionList.session[key]))
    .map((key) => sessionList.session[key]);

  if (SERVER_VERBOSE_LOG) console.log("check session", availableSessions);

  if (
    availableSessions.length === 0 &&
    sessionList.sessionFailover.nameService
  ) {
    availableSessions.push(sessionList.sessionFailover);
  }

  // if (availableSessions.length === 0 && !sessionList.sessionFailover.nameService) {
  //     await appendToLog(`HẾT SESSION`, process.env.LOGS_SERVER_SEXY)
  //     await sendTelegramMessage(process.env.TOKEN_BOT, process.env.ID_TELEGRAM_RECIPIENT, "HẾT SESSION")
  //     return
  // }

  while (availableSessions.length > 0) {
    const randomIndex = Math.floor(Math.random() * availableSessions.length);
    const selectedSession = availableSessions[randomIndex];
    if (SERVER_VERBOSE_LOG) console.log(`SỬ DỤNG SESSION => ${selectedSession.sessionId}`);
    const data = await requestData(
      selectedSession.sessionId,
      selectedSession.uriRequestData
    );
    if (SERVER_VERBOSE_LOG) console.log(data);
    if (!data.tableItems) return;
    const dataTableList = filterData(data.tableItems);

    await enqueueHallUpdate(dataTableList);

    // bắn dữ liệu
    // io.emit('test_data', {
    //     data: JSON.stringify(dataTableList),
    //     stampTime: getCurrentTime().timeUnix,
    // });
    // console.log('Bắn dữ liệu socket')
    // const byteSize = Buffer.byteLength(JSON.stringify(dataTableList), 'utf8');
    // console.log(`Dung lượng JSON: ${byteSize} bytes ~ ${(byteSize / 1024).toFixed(2)} KB`);
    return;
  }
}, POLL_INTERVAL_MS);

server.listen(PORT, async () => {
  await appendToLog(
    `Running server http://localhost:${PORT}`,
    process.env.LOGS_SERVER_SEXY
  );
});
