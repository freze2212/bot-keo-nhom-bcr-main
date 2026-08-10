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
const PORT = process.env.SERVER_PORT || 3201;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const SERVER_VERBOSE_LOG = process.env.SERVER_VERBOSE_LOG === "true";

app.use(express.json());
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
const latestScreenshots = {};

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

function setActiveTable(tableName, nameService) {
  if (!tableName) return null;
  const key = String(tableName).trim().toUpperCase();
  if (key === "NONE" || key === "LOBBY" || key === "CLEAR") {
    currentTargetTable = null;
    activeTableReadyAt = null;
    console.log(`[ACTIVE TABLE] CLEARED (${nameService || "NS"}) — chờ Playwright vào bàn`);
    io.emit("active_table_updated", {
      tableName: null,
      nameService: nameService || null,
      readyAt: null,
    });
    return null;
  }
  currentTargetTable = key;
  activeTableReadyAt = Date.now();
  console.log(`\n==================================================`);
  console.log(`🎯 ACTIVE TABLE READY: ${currentTargetTable} (${nameService || "NS"}) @ ${activeTableReadyAt}`);
  console.log(`==================================================\n`);
  io.emit("active_table_updated", {
    tableName: currentTargetTable,
    nameService: nameService || null,
    readyAt: activeTableReadyAt,
  });
  return currentTargetTable;
}

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
  const key = setActiveTable(tableName, nameService);
  return res.json({ success: true, activeTable: key });
});

app.get("/api/get-active-table", (req, res) => {
  if (!currentTargetTable || currentTargetTable === "NONE" || currentTargetTable === "LOBBY") {
    return res.json({
      success: false,
      activeTable: null,
      readyAt: null,
      message: "No active table currently entered by Playwright",
    });
  }
  return res.json({
    success: true,
    activeTable: currentTargetTable,
    readyAt: activeTableReadyAt || null,
  });
});

app.post("/api/request-session-restart", (req, res) => {
  console.log(`[API RESTART] Yêu cầu Playwright restart session (NS1)`);
  io.emit("NS1_restart", { reason: "api_timeout_60s" });
  io.emit("force_reenter_table", { reason: "api_timeout_60s" });
  return res.json({ success: true });
});

app.post("/api/place-bet", (req, res) => {
  const { tableName, betSide, side } = req.body || {};
  const key = tableName
    ? String(tableName).trim().toUpperCase()
    : currentTargetTable || null;
  const bet = betSide || side || "P";
  if (!key || !currentTargetTable || key === "NONE" || key === "LOBBY") {
    console.log(`[API PLACE BET BLOCKED] Playwright chưa vào bàn — bỏ qua`);
    return res.status(409).json({
      success: false,
      message: "Playwright chưa vào bàn (chưa có active_table)",
    });
  }
  console.log(
    `[API PLACE BET] Bot Tele đặt cược bàn ${key} -> ${
      String(bet).toUpperCase().startsWith("B") ? "CÁI" : "CON"
    }`
  );
  io.emit("place_bet", { tableName: key, betSide: bet, side: bet });
  return res.json({ success: true, tableName: key, betSide: bet });
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
    const { sessionId, nameService, stampTime } = payload;

    if (sessionList.session.hasOwnProperty(nameService)) {
      sessionList.session[nameService] = {
        nameService,
        sessionId,
        stampTime: stampTime, // || Date.now()
      };
      console.info(
        `${getCurrentTime().timeFormatted} - ${nameService || "_"} = ${
          sessionId || "_"
        }`
      );
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
    if (tableName) setActiveTable(tableName, nameService || "SOCKET");
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
    const data = await requestData(selectedSession.sessionId);
    if (SERVER_VERBOSE_LOG) console.log(data);
    if (!data.tableItems) return;
    const dataTableList = filterData(data.tableItems);

    await initDatabase(dataTableList);
    await checkAndUpdateDatabase(dataTableList, io);

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
