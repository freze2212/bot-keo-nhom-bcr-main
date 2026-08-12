const { chromium, firefox } = require("playwright");
const path = require("path");
const os = require("os");
const fsSync = require("fs");
const readline = require("readline");
// Load .env với path tuyệt đối để đảm bảo tìm được file
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const io = require("socket.io-client");
const fs = require("fs").promises;

const { request, imageCapcha, helper, screenshotHelper } = require("../utilities");
const axios = require("axios");
const accounts = require("./account.puppeteer");
const accountIdx = Math.min(
  5,
  Math.max(1, Number(process.env.ACCOUNT_INDEX || 1) || 1)
);
const account = accounts[`account_${accountIdx}`] || accounts.account_1;
console.log(
  `[ACCOUNT] index=${accountIdx} NS=${account.nameServiceSocket} user=${account.username_game}`
);
const {
  listTablesFromFrame,
  clickTableByCode,
  normTableCode,
} = require("../utilities/lobbyTables");

let isCollecting = false;
let socket;
let browser;
let context;
let page;
let seamlessFrame;
let gameHallFrame;
let gameCurrentFrame;
let lastCapturedSessionId = null;
let lastSessionRequestBase = null;
let lastHallIngestAt = 0;
let lastHallShapeLogAt = 0;
const username_game = account.username_game;
const password_game = account.password_game;
const nameServiceSocket = account.nameServiceSocket;
const logsNameProgress = account.logsNameProgress;
const accountLockPath = path.join(
  os.tmpdir(),
  `sexy-account-${String(username_game).toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.lock`
);

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireAccountLock() {
  try {
    const oldPid = Number(fsSync.readFileSync(accountLockPath, "utf8").trim());
    if (oldPid !== process.pid && isPidAlive(oldPid)) {
      throw new Error(
        `[ACCOUNT DUPLICATE] user=${username_game} đang được process PID ${oldPid} sử dụng`
      );
    }
    fsSync.unlinkSync(accountLockPath);
  } catch (error) {
    if (error.code !== "ENOENT" && error.message?.startsWith("[ACCOUNT DUPLICATE]")) {
      throw error;
    }
  }
  fsSync.writeFileSync(accountLockPath, String(process.pid), { flag: "wx" });
  console.log(`[ACCOUNT LOCK] user=${username_game} pid=${process.pid}`);
}

function releaseAccountLock() {
  try {
    const ownerPid = Number(fsSync.readFileSync(accountLockPath, "utf8").trim());
    if (ownerPid === process.pid) fsSync.unlinkSync(accountLockPath);
  } catch (_) {}
}

acquireAccountLock();
process.once("exit", releaseAccountLock);

/** Chống spawn nhiều Chromium: chỉ 1 main / 1 reset tại một thời điểm */
let mainInFlight = null;
let resetInFlight = null;
let pendingResetAfterMain = false;

async function closeBrowserHard(reason = "") {
  try {
    if (page) await page.close().catch(() => {});
  } catch (_) {}
  try {
    if (context) await context.close().catch(() => {});
  } catch (_) {}
  try {
    if (browser) {
      console.log(`[BROWSER] closeHard${reason ? ` (${reason})` : ""}`);
      await browser.close().catch(() => {});
    }
  } catch (_) {}
  page = null;
  context = null;
  browser = null;
  seamlessFrame = null;
  gameHallFrame = null;
  gameCurrentFrame = null;
}

let shutdownInFlight = false;
async function gracefulShutdown(signal) {
  if (shutdownInFlight) return;
  shutdownInFlight = true;
  console.log(`[SHUTDOWN] ${signal} — đóng browser và nhả account lock`);
  await Promise.race([
    closeBrowserHard(signal),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
  releaseAccountLock();
  process.exit(0);
}
process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

// Khởi tạo socket
socket = io(`${process.env.SERVER_HOSTNAME}:${process.env.SERVER_PORT}`);
socket.on("connect", () => {
  console.log("(SOCKET) Connecting");
  if (lastCapturedSessionId) {
    sendSessionData(
      lastCapturedSessionId,
      nameServiceSocket,
      lastSessionRequestBase,
      true
    ).catch(() => {});
  }
});
socket.on("disconnect", () => console.log("(SOCKET) Disconnected"));
// Hall API chỉ được poll khi server nhận heartbeat session liên tục.
// Không phụ thuộc việc trang có tạo response chứa JSESSIONID mới hay không.
setInterval(() => {
  if (lastCapturedSessionId && socket?.connected) {
    sendSessionData(
      lastCapturedSessionId,
      nameServiceSocket,
      lastSessionRequestBase,
      true
    ).catch(() => {});
  }
}, 5000);

// Đọc tín hiệu từ phím '!' gõ trực tiếp trong Terminal
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", async (str, key) => {
    if (str === "!") {
      console.log("\n📸 [KEYBOARD !] Nhận tín hiệu phím '!' từ Terminal -> CHỤP ẢNH BÀN HIỆN TẠI NGAY!");
      const target = currentInTable || requestedTargetTable || "C01";
      await captureTableRound(target, { roundNum: "KEY_" + Date.now() });
    }
    if (key && key.ctrl && key.name === "c") process.exit();
  });
}

main();

async function main() {
  if (mainInFlight) {
    console.log("[BROWSER] main() đang chạy — bỏ lệnh trùng (tránh 5 chrome-headless-shell)");
    return mainInFlight;
  }
  let shouldReset = false;
  const run = (async () => {
  try {
    // Luôn đóng browser cũ trước khi launch — resetMain spam dễ leak nhiều Chromium
    if (browser) {
      await closeBrowserHard("before launch");
    }

    const headless =
      process.env.HEADLESS === "1" ||
      process.env.HEADLESS === "true" ||
      process.env.HEADLESS === "TRUE";

    // Mặc định Firefox (ổn định sảnh Sexy trên VPS). Chromium: USE_FIREFOX=0
    const useFirefox = process.env.USE_FIREFOX !== "0";
    const launcher = useFirefox ? firefox : chromium;
    const launchOpts = {
      headless: headless,
      ignoreHTTPSErrors: true,
    };
    if (useFirefox) {
      launchOpts.firefoxUserPrefs = {
        "media.autoplay.default": 0,
        "media.autoplay.enabled.user-gestures-needed": false,
        "dom.webnotifications.enabled": false,
        // Tránh treo trắng / throttle khi cửa sổ chưa focus (Windows)
        "dom.min_background_timeout_value": 4,
        "dom.min_background_timeout_value_without_budget_throttling": 4,
        "dom.timeout.enable_budget_timer_throttling": false,
        "dom.timeout.background_throttling_max_budget": -1,
        "widget.windows.window_occlusion_tracking.enabled": false,
      };
    } else {
      // Chromium headed: chống throttle khi cửa sổ bị che / chưa click vào
      launchOpts.args = [
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-ipc-flooding-protection",
      ];
      if (!headless) launchOpts.args.push("--start-maximized");
    }
    browser = await launcher.launch(launchOpts);
    sessionRecovering = false;
    console.log(
      `[BROWSER] engine=${useFirefox ? "firefox" : "chromium"} headless=${headless} (1 instance)`
    );

    // Viewport cố định — null viewport + Firefox headed dễ trắng / không paint tới khi click
    const chromeUA =
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
    const firefoxUA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0";
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: useFirefox ? firefoxUA : chromeUA,
      locale: "vi-VN",
      ignoreHTTPSErrors: true,
    });
    console.log(
      `[BROWSER] headless=${headless} engine=${useFirefox ? "firefox" : "chromium"} UA=${useFirefox ? "Firefox" : "Chrome-spoof"}`
    );

    // Tạo page từ context
    page = await context.newPage();
    await page.bringToFront().catch(() => {});

    // Click logger IPC làm treo trắng / lag nặng — chỉ bật khi DEBUG_CLICKS=1
    const debugClicks = process.env.DEBUG_CLICKS === "1";
    if (debugClicks) {
      await page.exposeFunction("onUserClickLog", (data) => {
        console.log(`\n🖱️ [THAO TÁC CỦA BẠN DETECTED]`);
        console.log(`   ├─ Thẻ Tag: <${data.tagName}>`);
        console.log(`   ├─ Class: ${data.className ? "." + data.className : "(không có)"}`);
        console.log(`   ├─ ID: ${data.id ? "#" + data.id : "(không có)"}`);
        console.log(`   ├─ Chữ hiển thị: "${data.innerText}"`);
        console.log(`   ├─ Gợi ý Selector Playwright: ${data.suggestedSelector}`);
        console.log(`   └─ Tọa độ Click: (X: ${data.x}, Y: ${data.y})\n`);
      }).catch(() => {});

      await context.addInitScript(() => {
        window.addEventListener(
          "click",
          (e) => {
            try {
              const target = e.target;
              if (!target || !window.onUserClickLog) return;
              const tagName = (target.tagName || "").toLowerCase();
              const className = (
                typeof target.className === "string" ? target.className : ""
              ).trim();
              const id = (target.id || "").trim();
              const innerText = (target.innerText || target.textContent || "")
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 40);
              let suggestedSelector = tagName;
              if (id) suggestedSelector += `#${id}`;
              if (className)
                suggestedSelector += `.${className.split(/\s+/).filter(Boolean).join(".")}`;
              const rect = target.getBoundingClientRect
                ? target.getBoundingClientRect()
                : { left: 0, top: 0, width: 0, height: 0 };
              window.onUserClickLog({
                tagName,
                className,
                id,
                innerText,
                suggestedSelector,
                x: Math.round(e.clientX || rect.left + rect.width / 2),
                y: Math.round(e.clientY || rect.top + rect.height / 2),
              });
            } catch (_) {}
          },
          true
        );
      }).catch(() => {});
    } else {
      console.log("[BROWSER] Click logger OFF (set DEBUG_CLICKS=1 nếu cần soi class)");
    }

    // Lắng nghe phím '!' gõ trên trang Firefox
    page.on("keydown", async (event) => {
      if (event.key() === "!" || event.key() === "ExclamationMark") {
        console.log("📸 [FIREFOX KEYBOARD !] Nhận tín hiệu phím '!' trên Firefox -> CHỤP ẢNH NGAY!");
        const target = currentInTable || requestedTargetTable || "C01";
        await captureTableRound(target, { roundNum: "PAGE_KEY_" + Date.now() });
      }
    });

    // Xử lý các dialog
    page.on("dialog", async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });

    // Log start
    await helper.appendToLog(
      "BẮT ĐẦU CHƯƠNG TRÌNH FIREFOX - GHI LOGS",
      logsNameProgress
    );
    await helper.appendToLog("=".repeat(50), logsNameProgress);

    page.on("error", async (err) => {
      await helper.appendToLog(`Page error: ${err.message}`, logsNameProgress);
    });

    page.on("pageerror", async (err) => {
      await helper.appendToLog(
        `Page uncaught exception: ${err.message}`,
        logsNameProgress
      );
    });

    // Hàm thu thập response
    function startCollectingResponses(page, frames = []) {
      isCollecting = true;
      const debugNetwork = process.env.DEBUG_NETWORK === "1";
      if (debugNetwork) console.log("[DEBUG] Starting to collect responses...");

      if (debugNetwork) {
        page.on("request", (req) => {
          const url = req.url();
          if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
            console.log(`📡 [NETWORK REQUEST] ${req.method()} -> ${url}`);
            if (req.postData()) {
              console.log(`   └─ PAYLOAD: ${req.postData().slice(0, 300)}`);
            }
          }
        });
      }

      const handleResponse = async (response) => {
        try {
          const url = response.url();
          const status = response.status();
          if (
            debugNetwork &&
            (url.includes("bet") || url.includes("settle") ||
              url.includes("transaction") || url.includes("balance") ||
              url.includes("Game") || url.includes("road") || url.includes("info"))
          ) {
            console.log(`📥 [NETWORK RESPONSE ${status}] ${url}`);
            try {
              const body = await response.text();
              if (body && body.length < 500) {
                console.log(`   └─ RESPONSE BODY: ${body}`);
              }
            } catch (e) {}
          }
          if (
            status === 200 &&
            /\/player\/query\/(queryInitWebGameHall|queryWebGameHallInformation|queryWebGameHallRoad)/i.test(url) &&
            Date.now() - lastHallIngestAt >= 1000
          ) {
            try {
              let hallData = await response.json();
              if (typeof hallData === "string") {
                try {
                  hallData = JSON.parse(hallData);
                } catch (_) {}
              }
              const tableItems =
                hallData?.tableItems ||
                hallData?.data?.tableItems ||
                hallData?.result?.tableItems;
              if (Array.isArray(tableItems) && tableItems.length) {
                lastHallIngestAt = Date.now();
                const serverPort = process.env.SERVER_PORT || 3201;
                await axios.post(
                  `http://localhost:${serverPort}/api/ingest-hall-data`,
                  {
                    nameService: nameServiceSocket,
                    tableItems,
                  },
                  { timeout: 15000, maxBodyLength: Infinity }
                );
                console.log(
                  `[HALL FORWARD] ${nameServiceSocket} tables=${tableItems.length}`
                );
              } else if (
                debugNetwork &&
                Date.now() - lastHallShapeLogAt > 10000
              ) {
                lastHallShapeLogAt = Date.now();
                console.log(
                  `[HALL RESPONSE NO TABLES] ${nameServiceSocket} url=${url} ` +
                  `type=${typeof hallData} keys=${
                    hallData && typeof hallData === "object"
                      ? Object.keys(hallData).join(",")
                      : "-"
                  }`
                );
              }
            } catch (e) {
              if (
                debugNetwork &&
                Date.now() - lastHallShapeLogAt > 10000
              ) {
                lastHallShapeLogAt = Date.now();
                console.log(`[HALL FORWARD SKIP] ${nameServiceSocket}: ${e.message}`);
              }
            }
          }
        } catch (e) {}

        const resSession = await request.CollectingResponseSessionV2(
          response,
          isCollecting
        );
        if (
          typeof resSession === "string" &&
          /^[a-zA-Z0-9]+$/.test(resSession)
        ) {
          const previousSessionId = lastCapturedSessionId;
          const previousBase = lastSessionRequestBase;
          let nextBase = previousBase;
          try {
            const responseUrl = new URL(response.url());
            if (/\/player\/query\//i.test(responseUrl.pathname)) {
              nextBase =
                `${responseUrl.origin}/player/query/` +
                "queryInitWebGameHall;jsessionid=";
            }
          } catch (_) {}
          lastCapturedSessionId = resSession;
          lastSessionRequestBase = nextBase;
          if (
            previousSessionId !== resSession ||
            previousBase !== nextBase
          ) {
            sendSessionData(
              resSession,
              nameServiceSocket,
              nextBase
            );
          }
        }
      };

      page.on("response", handleResponse);
      frames.forEach((frame) => {
        // if (frame && typeof frame.on === 'function') frame.on('response', handleResponse);
        if (frame && typeof frame.on === "function") {
          if (debugNetwork) console.log("[DEBUG] Adding response listener to frame");
          frame.on("response", handleResponse);
        }
      });

      if (debugNetwork) {
        console.log("[DEBUG] Response listeners added to page and frames");
      }
    }

    // Bật từ trước khi goto/login để không bỏ lỡ JSESSIONID và JSON Hall.
    // page.on('response') nhận response của cả iframe tạo về sau.
    startCollectingResponses(page);

    // Kiểm tra DOMAIN trước khi goto
    const DOMAIN = process.env.DOMAIN;
    if (!DOMAIN || typeof DOMAIN !== "string" || DOMAIN.trim() === "") {
      const errorMsg = `ENV DOMAIN không hợp lệ. Giá trị: ${JSON.stringify(DOMAIN)}`;
      await helper.appendToLog(errorMsg, logsNameProgress);
      throw new Error(errorMsg);
    }

    await helper.appendToLog(`Đang truy cập: ${DOMAIN}`, logsNameProgress);

    // Xóa bàn cũ trên server — bot phải đợi session VÀO BÀN rồi mới hô
    currentInTable = null;
    sessionInTableReady = false;
    pendingPlaceBetSide = null;
    pendingPlaceBetAmount = null;
    await clearActiveTableOnServer();

    // Truy cập trang nhanh với domcontentloaded
    await page.goto(DOMAIN, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.bringToFront().catch(() => {});

    // await page.goto(process.env.DOMAIN, { timeout: 60000 });

    // Đợi trang load nhẹ rồi ĐÓNG POPUP Thông báo TRƯỚC (tránh kéo màn / click đè)
    await helper.delay(1500);
    for (let i = 0; i < 4; i++) {
      await dismissSitePopups(page);
      await helper.delay(300);
    }

    // login — chỉ sau khi đã tắt popup
    await clickButtonNotifiGame(
      logsNameProgress,
      page,
      process.env.CLOSE_DIALOG_WELCOME || ".publicModal .tcg_modal_close",
      "ĐÓNG THÔNG BÁO SỰ KIỆN"
    );
    await dismissSitePopups(page);

    // Kiểm tra xem ô username đã có sẵn chưa
    const userExist = await page.$(".username_input, input[placeholder*='Tên đăng nhập'], input[name='username'], input[type='text']").catch(() => null);
    if (!userExist) {
      await clickButton(
        logsNameProgress,
        page,
        ".submit_btn, button:has-text('Đăng nhập'), .login_btn",
        "HIỂN THỊ DIALOG ĐĂNG NHẬP"
      ).catch(() => {});
    }

    const userInputSelector = ".username_input, input[placeholder*='Tên đăng nhập'], input[placeholder*='tài khoản'], input[name='username'], input[type='text']";
    const passInputSelector = ".password_input, input[placeholder*='Mật khẩu'], input[name='password'], input[type='password']";

    await fillInput(
      logsNameProgress,
      page,
      userInputSelector,
      username_game
    );
    await fillInput(
      logsNameProgress,
      page,
      passInputSelector,
      password_game
    );

    // Kiểm tra và xử lý Captcha nếu ô Captcha xuất hiện trên form đăng nhập
    const captchaInput = await page.$(".captcha_input, div.captcha_box img").catch(() => null);
    if (captchaInput) {
      await helper.appendToLog("Phát hiện ô nhập Captcha, bắt đầu giải mã...", logsNameProgress);
      try {
        const codeCapcha = await imageCapcha.getCodeCapchaLogin(logsNameProgress, page);
        await fillInput(
          logsNameProgress,
          page,
          process.env.INPUT_CAPCHA_LOGIN || ".captcha_input",
          codeCapcha
        );
      } catch (captchaErr) {
        await helper.appendToLog(`Lỗi xử lý captcha: ${captchaErr.message}`, logsNameProgress);
      }
    }

    await clickButton(
      logsNameProgress,
      page,
      'button[type="submit"].submit_btn, button.submit_btn, button:has-text("Đăng nhập"), .login_btn',
      "ĐĂNG NHẬP"
    );
    await helper.delay(8000);

    // Kiểm tra xem có popup "Vui lòng đăng nhập vào tài khoản trước" xuất hiện do login chưa thành công không
    const isLoginErrorAlert = await page.evaluate(() => {
      const text = document.body ? document.body.innerText || "" : "";
      if (text.includes("Vui lòng đăng nhập vào tài khoản trước")) {
        const confirmBtn = Array.from(document.querySelectorAll("button, div, span, a")).find(
          (el) => el.innerText && el.innerText.trim() === "Xác nhận"
        );
        if (confirmBtn) confirmBtn.click();
        return true;
      }
      return false;
    });

    if (isLoginErrorAlert) {
      await helper.appendToLog(
        "❌ ĐĂNG NHẬP THẤT BẠI: Trang xuất hiện thông báo 'Vui lòng đăng nhập vào tài khoản trước'. Khởi động lại luồng login...",
        logsNameProgress
      );
      await announceSystemAnalyzing("LOGIN_FAIL").catch(() => {});
      return resetMain();
    }

    // Chờ đợi các element xuất hiện với timeout dài hơn
    try {
      await page.waitForSelector(process.env.SHOW_DIALOG_LOGIN_SUCCESS, {
        timeout: 15000,
      });
      await clickButton(
        logsNameProgress,
        page,
        process.env.SHOW_DIALOG_LOGIN_SUCCESS,
        "ĐÓNG THÔNG BÁO CẢNH BÁO KHI HOÀN TẤT ĐĂNG NHẬP"
      );
    } catch (error) {
      await helper.appendToLog(
        "Không tìm thấy dialog success, tiếp tục...",
        logsNameProgress
      );
    }

    // Tắt tất cả các popup thông báo đè lên màn hình ("Trung Tâm Của Tôi", v.v.)
    await closeAllModals(page);

    // redirect to baccarat sexy
    await helper.delay(2000);
    await clickButton(
      logsNameProgress,
      page,
      "div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1",
      "VÀO MENU GAME SEXY"
    );

    // Chờ 2s để menu game load — không cuộn trang (tránh xê dịch)
    await helper.delay(2000);
    await dismissSitePopups(page);

    // Thử click nút "Chơi ngay" sảnh Sexy với nhiều selectors
    const playBtnSelectors = [
      ".play-btn",
      "div.play-btn",
      "button:has-text('Chơi ngay')",
      "div:has-text('Chơi ngay')",
      "a[href*='seamless']"
    ];

    let clickedPlay = false;
    for (const sel of playBtnSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click({ force: true }).catch(() => {});
        clickedPlay = true;
        await helper.appendToLog(`✅ [VÀO SẢNH SEXY] Đã click nút vào sảnh Sexy (${sel})`, logsNameProgress);
        break;
      }
    }

    // Nếu không bấm được nút, tiến hành chuyển thẳng URL tới sảnh Sexy (đúng DOMAIN .env)
    if (!clickedPlay) {
      const base = String(process.env.DOMAIN || "").replace(/\/$/, "");
      const pathSexy = process.env.ROUTER_URL_BACARAT_SEXY || "/seamless?gameType=LIVE";
      const sexyUrl = `${base}${pathSexy.startsWith("/") ? pathSexy : `/${pathSexy}`}`;
      await helper.appendToLog(
        `🔄 [DIRECT GOTO] Chuyển thẳng URL tới sảnh Sexy: ${sexyUrl}`,
        logsNameProgress
      );
      await page
        .goto(sexyUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {});
    }

    // Thao tác click icon SVG (X: 1230, Y: 184) theo đúng yêu cầu người dùng
    await helper.delay(2000);
    try {
      const svgElem = await page.$("header svg, button svg, svg").catch(() => null);
      if (svgElem) {
        await svgElem.click().catch(() => {});
      } else {
        await page.mouse.click(1230, 184).catch(() => {});
      }
      await helper.appendToLog("✅ [THAO TÁC CỦA BẠN] Đã click icon SVG (X: 1230, Y: 184) theo yêu cầu!", logsNameProgress);
    } catch (e) {}

    // Chờ và xử lý iframe SEXY GAME SEAMLESS
    await waitForFrame(page, "iframe#seamless-game", 30000);
    const seamlessFrameElement = await page.$("iframe#seamless-game");
    seamlessFrame = await seamlessFrameElement.contentFrame();

    // Chờ và xử lý iframe GAME HALL (Sảnh chọn bàn)
    await waitForFrame(seamlessFrame, "iframe#iframeGameHall", 30000);
    let gameHallFrameElement = await seamlessFrame.$("iframe#iframeGameHall");
    gameHallFrame = await gameHallFrameElement.contentFrame();

    await helper.delay(3000);

    // Đóng popup Chrome/Safari trước khi chọn bàn
    await dismissBrowserSupportModal().catch(() => {});
    await dismissSitePopups(page).catch(() => {});
    await helper.delay(800);
    await dismissBrowserSupportModal().catch(() => {});

    // VÀO NGAY 1 BÀN BACCARAT BẤM THỦ CÔNG / TỰ ĐỘNG KHÔNG CHỜ ĐỢI DƯ THỪA
    await helper.appendToLog("🎰 [AUTO ENTER TABLE] Tiến hành chọn và vào ngay 1 bàn cược trong sảnh...", logsNameProgress);
    await enterTargetTable(gameHallFrame).catch(() => {});
    await helper.delay(3000);

    console.log(`\n===============================================================`);
    console.log(`✅ [BÀN CƯỢC ${currentInTable || 'TARGET'}] ĐÃ VÀO THẲNG BÀN CƯỢC ${currentInTable || 'TARGET'}!`);
    console.log(`🛑 Đã ngắt toàn bộ log rác ngầm. CHỈ GHI LOG BÀN THỰC TẾ & KẾT QUẢ VÁN!`);
    console.log(`===============================================================\n`);

    // Refresh frame references
    gameHallFrameElement = await seamlessFrame.$("iframe#iframeGameHall");
    gameHallFrame = await gameHallFrameElement.contentFrame();

    // Dừng chu kỳ tự cuộn ngầm (startBaccaratCycle) để tránh bị giật trang
    // await startBaccaratCycle(gameHallFrame, gameCurrentFrame);
  } catch (error) {
    await helper.appendToLog(
      `Error in main function: ${error.message}`,
      logsNameProgress
    );
    shouldReset = true;
  }
  })();
  mainInFlight = run;
  try {
    await run;
  } finally {
    if (mainInFlight === run) mainInFlight = null;
  }
  if (shouldReset) {
    if (resetInFlight) {
      pendingResetAfterMain = true;
      console.log("[RESET] main lỗi trong lúc đang reset — xếp hàng retry, không lồng deadlock");
    } else {
      await resetMain();
    }
  }
}

// Hàm hỗ trợ chờ frame với timeout
async function waitForFrame(parentFrame, selector, timeout = 60000) {
  try {
    await parentFrame.waitForSelector(selector, { timeout, state: "attached" });
    // Đợi thêm để frame ổn định
    await helper.delay(2000);
  } catch (error) {
    throw new Error(`Không thể tìm thấy frame: ${selector} - ${error.message}`);
  }
}

// Các hàm hỗ trợ
async function fillInput(logsNameProgress, page, classElement, value) {
  let retryCount = 0;
  const selectors = String(classElement).split(',').map(s => s.trim());

  while (retryCount <= 10) {
    await dismissSitePopups(page).catch(() => {});
    for (const sel of selectors) {
      try {
        const inputField = await page.$(sel).catch(() => null);
        if (inputField) {
          // Không scrollIntoView — tránh xê dịch màn khi popup còn
          await inputField.click({ force: true, clickCount: 3 }).catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await inputField.type(value, { delay: 40 });
          await helper.appendToLog(
            `NHẬP => ${value} THÀNH CÔNG (${sel})`,
            logsNameProgress
          );
          return;
        }
      } catch (error) {}
    }

    retryCount++;
    await helper.delay(800);
  }

  await helper.appendToLog(
    `Nhập thất bại selector [${classElement}] - tiếp tục luồng`,
    logsNameProgress
  );
}

async function clickButton(
  logsNameProgress,
  page,
  classElement,
  msg = "_",
  numberClick = 1,
  isFatal = false
) {
  let retryCount = 0;
  const action = numberClick > 1 ? "DOUBLE CLICK" : "CLICK";

  while (retryCount <= 4) {
    await dismissSitePopups(page).catch(() => {});
    try {
      const clickBtn = await page.waitForSelector(classElement, { timeout: 2000 }).catch(() => null);

      if (clickBtn) {
        // force click — KHÔNG scrollIntoView (gây xê dịch màn)
        await clickBtn.click({ clickCount: numberClick, force: true }).catch(() => {});
        await helper.appendToLog(
          `${action} => ${msg} THÀNH CÔNG`,
          logsNameProgress
        );
        return true;
      }
    } catch (error) {}

    retryCount++;
    await helper.delay(800);
  }

  await helper.appendToLog(
    `${action} => ${msg} KHÔNG THỰC HIỆN ĐƯỢC - bỏ qua`,
    logsNameProgress
  );
  if (isFatal) {
    await resetMain();
  }
  return false;
}

async function scrollDownSlowly(
  logsNameProgress,
  frame,
  duration = 2000,
  msg = "SCROLL DOWN"
) {
  await helper.appendToLog(`CUỘN => ${msg}`, logsNameProgress);
  await frame.evaluate((duration) => {
    const scrollHeight =
      document.documentElement.scrollHeight || document.body.scrollHeight;
    const step = scrollHeight / (duration / 16);
    let currentScroll = 0;

    function scroll() {
      if (currentScroll < scrollHeight) {
        window.scrollTo(0, currentScroll);
        currentScroll += step;
        requestAnimationFrame(scroll);
      }
    }
    scroll();
  }, duration);
}

async function clickButtonNotifiGame(
  logsNameProgress,
  page,
  classElement,
  msg = "_",
  numberClick = 1
) {
  const action = numberClick > 1 ? "DOUBLE CLICK" : "CLICK";
  try {
    const clickBtn = await page.waitForSelector(classElement, { timeout: 1500 }).catch(() => null);
    if (clickBtn) {
      await clickBtn.click({ clickCount: numberClick });
      await helper.appendToLog(`${action} => ${msg} THÀNH CÔNG`, logsNameProgress);
    }
  } catch (error) {
    // Không có thông báo game -> bỏ qua
  }
}

let currentInTable = null; // Theo dõi tên bàn hiện tại đang mở
let activeTableHeartbeatTimer = null;
let placeBetInFlight = false;
let pendingPlaceBetSide = null; // xếp hàng nếu bot hô trước khi vào bàn xong
let pendingPlaceBetAmount = null;
let sessionInTableReady = false; // true sau khi notify bàn thật
let sessionRecovering = false; // overlay lỗi / hết phiên — cấm chụp, đang restart
let lastPauseAnnounceAt = 0;
let enterInFlight = null;

async function clearActiveTableOnServer() {
  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    await axios.post(`http://localhost:${serverPort}/api/notify-active-table`, {
      tableName: "NONE",
      nameService: nameServiceSocket,
    });
    sessionInTableReady = false;
    await helper.appendToLog(
      "🧹 [CLEAR] Đã xóa active_table cũ — chờ vào bàn rồi mới báo bot",
      logsNameProgress
    );
  } catch (e) {
    await helper.appendToLog(
      `⚠️ [CLEAR active_table] ${e.message}`,
      logsNameProgress
    );
  }
}

async function fetchOccupiedTableCodes() {
  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    const res = await axios.get(
      `http://localhost:${serverPort}/api/occupied-tables`,
      { timeout: 3000 }
    );
    return (res.data?.tables || []).map((t) =>
      String(t).trim().toUpperCase()
    );
  } catch (_) {
    return [];
  }
}

/** Chọn bàn cầu đẹp từ danh sách free (API server phân tích ≥20 tay). */
async function pickBeautifulTableFromServer(freeCodes) {
  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    const res = await axios.post(
      `http://localhost:${serverPort}/api/pick-beautiful-table`,
      {
        freeCodes: (freeCodes || []).map((c) => String(c).trim().toUpperCase()),
        nameService: nameServiceSocket,
      },
      { timeout: 8000 }
    );
    const data = res.data || {};
    if (data.success && data.tableName) {
      return {
        tableName: String(data.tableName).trim().toUpperCase(),
        profile: data.profile || null,
        ranked: data.ranked || [],
      };
    }
    return { tableName: null, profile: null, ranked: data.ranked || [], message: data.message };
  } catch (e) {
    console.error(`[PICK BEAUTIFUL] lỗi API: ${e.message}`);
    return { tableName: null, profile: null, ranked: [], message: e.message };
  }
}

async function goHomeToLobby() {
  try {
    for (const f of [page, seamlessFrame, gameHallFrame, gameCurrentFrame].filter(Boolean)) {
      const ok = await f
        .evaluate(() => {
          const el =
            document.querySelector("button#goHome2") ||
            document.querySelector("button#goHome") ||
            document.querySelector(".goHome");
          if (el) {
            el.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (ok) break;
    }
  } catch (_) {}
  currentInTable = null;
  sessionInTableReady = false;
  await clearActiveTableOnServer().catch(() => {});
  await helper.delay(3500);
  try {
    const hallEl = seamlessFrame
      ? await seamlessFrame.$("iframe#iframeGameHall").catch(() => null)
      : null;
    if (hallEl) gameHallFrame = await hallEl.contentFrame().catch(() => null);
  } catch (_) {}
}

async function reserveTableOnServer(tableName) {
  const key = String(tableName || "").trim().toUpperCase();
  if (!key) return false;
  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    await axios.post(`http://localhost:${serverPort}/api/reserve-table`, {
      tableName: key,
      nameService: nameServiceSocket,
    });
    return true;
  } catch (e) {
    const status = e.response?.status;
    const data = e.response?.data || {};
    if (status === 409 || data.code === "TABLE_OCCUPIED") {
      return {
        conflict: true,
        occupiedBy: data.occupiedBy,
        tableName: key,
      };
    }
    console.error(`[RESERVE TABLE ERROR] ${key}: ${e.message}`);
    return false;
  }
}

async function notifyActiveTableToServer(tableName) {
  const key = String(tableName || "").trim().toUpperCase();
  if (!key || key === "NONE" || key === "LOBBY") return false;
  const shouldLogReady = !sessionInTableReady;

  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    await axios.post(`http://localhost:${serverPort}/api/notify-active-table`, {
      tableName: key,
      nameService: nameServiceSocket,
    });
    sessionInTableReady = true;
    sessionRecovering = false;
    if (shouldLogReady) {
      console.log(`✅ [API NOTIFY] active_table=${key} → bot có thể hô`);
      await helper.appendToLog(
        `✅ [API NOTIFY] Đã vào bàn → báo bot hô: active_table=${key}`,
        logsNameProgress
      );
    }
    // Nếu bot đã gửi place_bet sớm → đặt ngay 1 lần
    if (pendingPlaceBetSide) {
      const side = pendingPlaceBetSide;
      const amount = pendingPlaceBetAmount;
      pendingPlaceBetSide = null;
      pendingPlaceBetAmount = null;
      await helper.appendToLog(
        `[AUTOBET] Chạy lệnh place_bet đang xếp hàng: ${side} ${amount || ""}K`,
        logsNameProgress
      );
      await runPlaceBetCommand(side, amount).catch(() => {});
    }
    return true;
  } catch (e) {
    const status = e.response?.status;
    const data = e.response?.data || {};
    if (status === 409 || data.code === "TABLE_OCCUPIED") {
      await helper.appendToLog(
        `⚠️ [TABLE CONFLICT] ${key} đã có ${data.occupiedBy} — phải đổi bàn`,
        logsNameProgress
      );
      console.log(
        `[TABLE CONFLICT] ${key} occupied by ${data.occupiedBy}`
      );
      return { conflict: true, occupiedBy: data.occupiedBy, tableName: key };
    }
    await helper.appendToLog(
      `⚠️ [API NOTIFY ERROR] ${e.message}`,
      logsNameProgress
    );
    return false;
  }
}

function startActiveTableHeartbeat() {
  if (activeTableHeartbeatTimer) clearInterval(activeTableHeartbeatTimer);
  let missDetect = 0;
  let heartbeatBusy = false;
  activeTableHeartbeatTimer = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      if (!page || page.isClosed()) return;

      // Kick / hết phiên → out bàn + restart ngay (không chụp overlay)
      const fatalUi = await detectFatalUiError().catch(() => null);
      if (fatalUi === "SESSION_EXPIRED" || fatalUi === "PAGE_CLOSED") {
        console.log(`❌ [KICK/SESSION] ${fatalUi} — restart ngay`);
        recoverFromFatalUi(fatalUi).catch((e) =>
          console.error("[RECOVER]", e.message)
        );
        return;
      }

      const detected = await detectCurrentTableInRoom().catch(() => null);
      if (detected) {
        missDetect = 0;
        if (detected !== currentInTable) {
          console.log(`🔄 [ĐỔI BÀN DOM] ${currentInTable || "?"} → ${detected}`);
          await helper.appendToLog(
            `🔄 [ĐỔI BÀN DOM] ${currentInTable || "?"} → ${detected} (đè bàn cũ)`,
            logsNameProgress
          );
        }
        currentInTable = detected;
        await notifyActiveTableToServer(currentInTable);
        return;
      }

      // Đã có bàn sẵn: tiếp tục notify, KHÔNG clear (tránh mất báo bot khi DOM tạm không đọc được)
      if (currentInTable && sessionInTableReady) {
        missDetect = 0;
        await notifyActiveTableToServer(currentInTable);
        return;
      }

      missDetect += 1;
      // Chỉ coi là out bàn sau ~1 phút miss liên tiếp khi chưa từng ready
      if (missDetect >= 8) {
        console.log(`⚠️ [OUT BÀN] miss=${missDetect} — vào bàn mới`);
        await helper.appendToLog(
          `⚠️ [OUT BÀN] Không thấy mã bàn (miss=${missDetect}) — vào bàn mới đè bàn cũ`,
          logsNameProgress
        );
        sessionInTableReady = false;
        currentInTable = null;
        missDetect = 0;
        await clearActiveTableOnServer();
        enterTargetTable(gameHallFrame || seamlessFrame || page).catch((e) => {
          console.error("[RE-ENTER ERROR]", e.message);
        });
      }
    } catch (error) {
      console.warn(`[HEARTBEAT ERROR] ${error.message}`);
    } finally {
      heartbeatBusy = false;
    }
  }, 4000);
}

/** Dialog kick / hết phiên — quét mọi node text (overlay canvas vẫn có DOM text). */
async function detectSessionExpired() {
  const kickNeedles = [
    "hội thoại của bạn đã kết thúc",
    "session has expired",
    "your session has expired",
    "đăng nhập lại trò chơi",
    "please log in to the game again",
    "bạn đã liên tục đăng nhập",
    "tự động đăng xuất",
    "xin lỗi",
    "logged on at another location",
    "logged in at another location",
    "logged off because you have logged on",
    "logged off because you have logged in",
    "another location",
  ];
  const frames = [
    gameCurrentFrame,
    seamlessFrame,
    gameHallFrame,
    page,
    ...(page && typeof page.frames === "function" ? page.frames() : []),
  ].filter(Boolean);
  const seen = new Set();
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    const hit = await withTimeout(
      f.evaluate((needles) => {
        const norm = (s) =>
          String(s || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
        const matchText = (raw) => {
          const t = norm(raw);
          if (!t) return false;
          return needles.some((n) => t.includes(norm(n)));
        };
        if (matchText(document.documentElement?.innerText || "")) return true;
        if (matchText(document.body?.innerText || "")) return true;
        const nodes = document.querySelectorAll(
          "div, span, p, h1, h2, h3, label, section, aside, button, .modal, .dialog, .van-dialog, .van-overlay"
        );
        for (const el of nodes) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (!txt || txt.length > 240) continue;
          try {
            const st = window.getComputedStyle(el);
            if (
              st.display === "none" ||
              st.visibility === "hidden" ||
              Number(st.opacity) === 0
            ) {
              continue;
            }
          } catch (_) {}
          if (matchText(txt)) return true;
        }
        return false;
      }, kickNeedles).catch(() => false),
      900,
      false
    );
    if (hit) return true;
  }
  return false;
}

/** Toast/banner: đang làm mới đường truyền — chỉ bắt overlay ngắn, không quét cả trang */
async function detectConnectionRefreshing() {
  const frames = [gameCurrentFrame, seamlessFrame, page].filter(Boolean);
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    const hit = await withTimeout(
      f.evaluate(() => {
        const needles = [
          "làm mới đường truyền",
          "refreshing the connection",
          "refreshing connection",
        ];
        const nodes = Array.from(
          document.querySelectorAll("div, span, p, section, aside")
        );
        for (const el of nodes) {
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            continue;
          }
          const t = (el.innerText || "").trim().toLowerCase();
          if (!t || t.length > 90) continue;
          if (needles.some((n) => t.includes(n))) return true;
        }
        return false;
      }).catch(() => false),
      900,
      false
    );
    if (hit) return true;
  }
  return false;
}

async function detectFatalUiError() {
  if (!page || page.isClosed()) return "PAGE_CLOSED";
  const expired = await detectSessionExpired().catch(() => false);
  if (expired) return "SESSION_EXPIRED";
  return null;
}

async function announceSystemAnalyzing(reason) {
  const now = Date.now();
  if (now - lastPauseAnnounceAt < 90000) {
    console.log(`[PAUSE TELE] cooldown — skip (${reason})`);
    return;
  }
  lastPauseAnnounceAt = now;
  try {
    const serverPort = process.env.SERVER_PORT || 3201;
    await axios.post(
      `http://localhost:${serverPort}/api/system-pause`,
      { nameService: nameServiceSocket, reason: reason || "recover" },
      { timeout: 4000 }
    );
    console.log(`[PAUSE TELE] đã báo nhóm ${nameServiceSocket} reason=${reason}`);
  } catch (e) {
    console.warn(`[PAUSE TELE] không gửi được: ${e.message}`);
  }
}

async function recoverFromFatalUi(reason) {
  if (sessionRecovering || resetInFlight) {
    console.log(`[RECOVER] đang recover rồi (${reason}) — bỏ lệnh trùng`);
    return resetInFlight;
  }
  sessionRecovering = true;
  sessionInTableReady = false;
  currentInTable = null;
  pendingPlaceBetSide = null;
  pendingPlaceBetAmount = null;
  console.log(`❌ [FATAL UI] ${reason} — bỏ chụp, RESTART session`);
  await helper.appendToLog(
    `❌ [FATAL UI] ${reason} — không chụp overlay lỗi, TỰ ĐỘNG resetMain`,
    logsNameProgress
  );
  await clearActiveTableOnServer().catch(() => {});
  if (reason === "SESSION_EXPIRED") {
    await announceSystemAnalyzing(reason).catch(() => {});
  }
  return resetMain();
}

// Quay về sảnh nếu đang ở trong bàn
async function returnToHallIfNeeded(gameCurrentFrame) {
  if (!currentInTable) return;
  try {
    await helper.appendToLog(
      `Đang ở bàn ${currentInTable}, quay trở về sảnh game...`,
      logsNameProgress
    );
    await clickButton(
      logsNameProgress,
      gameCurrentFrame,
      "button#goHome2",
      "TRỞ VỀ SẢNH GAME",
      2
    );
    await helper.delay(3000);
    currentInTable = null;
  } catch (err) {
    await helper.appendToLog(
      `Lỗi khi quay về sảnh: ${err.message}`,
      logsNameProgress
    );
  }
}

// Tắt 2 popup nhỏ xíu ở góc dưới bên phải - CHỈ THỰC HIỆN KHI ĐÃ TRUY CẬP VÀO BÀN
async function closeInTableModals(targetFrame) {
  try {
    const framesToClean = [targetFrame, gameCurrentFrame, gameHallFrame, seamlessFrame, page].filter(Boolean);
    for (const f of framesToClean) {
      if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
      await f.evaluate(() => {
        const badSelectors = [
          "#betLimitWrongSet", "div#betLimitWrongSet",
          "promo-widget", ".notification_closeBtn", "div.notification_closeBtn",
          ".tcg_modal_close", ".publicModal .tcg_modal_close", ".van-dialog"
        ];
        badSelectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => {
            try {
              if (el.click) el.click();
              el.remove();
            } catch (e) {}
          });
        });
      }).catch(() => {});
    }
    await helper.appendToLog("🧹 [DOM CLEANUP IN TABLE] Đã tự động xóa sạch các popup/lỗi khỏi màn hình trước khi chụp ảnh!", logsNameProgress);
  } catch (err) {}
}

async function detectTableFromCookie() {
  try {
    const cookies = await context.cookies().catch(() => []);
    for (const c of cookies) {
      if (!c || !c.value) continue;
      // aswl_cookie={"hall":"cb","stname":"BTCB19.flv"}
      const m = String(c.value).match(/BTCB(\d+)/i) || String(c.name + c.value).match(/BTCB(\d+)/i);
      if (m && m[1]) {
        return `C${String(m[1]).padStart(2, "0")}`;
      }
      try {
        const parsed = JSON.parse(decodeURIComponent(c.value));
        const st = parsed && (parsed.stname || parsed.tableName);
        const m2 = st && String(st).match(/BTCB(\d+)/i);
        if (m2 && m2[1]) return `C${String(m2[1]).padStart(2, "0")}`;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function withTimeout(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// Đọc mã bàn từ <dt id="currentGameTable">Baccarat C07</dt> → "C07"
async function detectCurrentTableInRoom() {
  try {
    const seen = new Set();
    const framesToCheck = [
      page.frame({ name: "iframeGameTable" }),
      page.frame({ name: "iframeGame" }),
      gameCurrentFrame,
      seamlessFrame,
      page,
    ].filter(Boolean);

    for (const frame of framesToCheck) {
      if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
      try {
        const url = frame.url ? frame.url() : "";
        if (seen.has(url + String(frame))) continue;
        seen.add(url + String(frame));
      } catch (_) {}

      // Timeout 2.5s — tránh evaluate treo khi iframe Sexy lỗi / headless
      const detected = await withTimeout(
        frame
          .evaluate(() => {
            const dt = document.querySelector("#currentGameTable, dt#currentGameTable");
            if (dt) {
              const txt = (dt.innerText || dt.textContent || "").trim();
              const m = txt.match(/Baccarat\s+(C\d+)/i) || txt.match(/\b(C\d{1,3})\b/i);
              if (m && m[1]) return m[1].toUpperCase();
            }
            // Chỉ query selector hẹp — KHÔNG quét toàn bộ div/span (dễ treo)
            const titleElems = Array.from(
              document.querySelectorAll(
                ".table-name, .room-title, .game-title, .header-title, [class*='tableName'], [class*='table-info'], dt#currentGameTable, dt"
              )
            ).slice(0, 40);
            for (const el of titleElems) {
              const txt = (el.innerText || el.textContent || "").trim();
              if (txt.length > 80) continue;
              const matchBtcb = txt.match(/BTCB(\d+)/i);
              if (matchBtcb && matchBtcb[1]) {
                return `C${matchBtcb[1].padStart(2, "0")}`;
              }
              const matchBaccarat = txt.match(/Baccarat\s+(C\d+)/i);
              if (matchBaccarat && matchBaccarat[1]) {
                return matchBaccarat[1].toUpperCase();
              }
            }
            return null;
          })
          .catch(() => null),
        2500,
        null
      );

      if (detected) {
        return detected.startsWith("C") ? detected : `C${detected.padStart(2, "0")}`;
      }
    }

    // Fallback cookie BTCB19 → C19
    return await withTimeout(detectTableFromCookie(), 2000, null);
  } catch (err) {}
  return null;
}

/** Popup trình duyệt hỗ trợ đang hiện ở frame nào đó? */
async function isBrowserSupportModalVisible() {
  const frames = [
    seamlessFrame,
    gameHallFrame,
    page,
    ...(page && typeof page.frames === "function" ? page.frames() : []),
  ].filter(Boolean);
  const seen = new Set();
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    let key = "";
    try {
      key = f.url() || "";
    } catch (_) {}
    if (seen.has(key)) continue;
    seen.add(key);

    const hasText = await withTimeout(
      f
        .evaluate(() => {
          const t = (document.body && document.body.innerText) || "";
          return (
            /trình duyệt hỗ trợ/i.test(t) ||
            /Chrome 60/i.test(t) ||
            /Không hiển thị lần nữa/i.test(t)
          );
        })
        .catch(() => false),
      1200,
      false
    );
    if (hasText) return true;

    try {
      const confirm = f.getByText(/Xác nhận/i).first();
      if (await confirm.isVisible({ timeout: 400 }).catch(() => false)) {
        // Chỉ coi là popup browser nếu cùng frame có chữ Chrome/Safari gần đó
        const nearby = await withTimeout(
          f
            .evaluate(() => {
              const t = (document.body && document.body.innerText) || "";
              return /Chrome|Safari|trình duyệt/i.test(t);
            })
            .catch(() => false),
          800,
          false
        );
        if (nearby) return true;
      }
    } catch (_) {}
  }
  return false;
}

/** Đóng popup "Bạn nên sử dụng các trình duyệt hỗ trợ..." (Chrome/Safari) */
async function dismissBrowserSupportModal() {
  const frames = [
    seamlessFrame,
    gameHallFrame,
    page,
    ...(page && typeof page.frames === "function" ? page.frames() : []),
  ].filter(Boolean);
  const seen = new Set();
  let closed = false;

  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    let key = "";
    try {
      key = f.url() || String(Math.random());
    } catch (_) {
      key = String(Math.random());
    }
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const bodyHas = await withTimeout(
        f
          .evaluate(() => {
            const t = (document.body && document.body.innerText) || "";
            return (
              /trình duyệt hỗ trợ/i.test(t) ||
              /Chrome 60/i.test(t) ||
              /Không hiển thị lần nữa/i.test(t)
            );
          })
          .catch(() => false),
        1200,
        false
      );
      if (!bodyHas) continue;

      // Tick "Không hiển thị lần nữa"
      const dontShow = f.getByText(/Không hiển thị lần nữa/i).first();
      if ((await dontShow.count().catch(() => 0)) > 0) {
        await dontShow.click({ force: true, timeout: 1200 }).catch(() => {});
      }

      // Nút Xác nhận
      const confirm = f.getByText(/Xác nhận/i).first();
      if (await confirm.isVisible({ timeout: 800 }).catch(() => false)) {
        await confirm.click({ force: true, timeout: 2000 });
        closed = true;
        console.log("✅ [BROWSER WARN] Đã click Xác nhận");
        await helper.appendToLog(
          "✅ [BROWSER WARN] Đóng popup trình duyệt hỗ trợ (Xác nhận)",
          logsNameProgress
        );
        await helper.delay(500);
        break;
      }

      // Fallback evaluate click
      const ok = await f
        .evaluate(() => {
          document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            try {
              if (!cb.checked) cb.click();
            } catch (_) {}
          });
          const btns = Array.from(
            document.querySelectorAll("button, div, span, a, [role='button']")
          );
          const confirmBtn = btns.find((el) =>
            /Xác nhận/i.test((el.innerText || el.textContent || "").trim())
          );
          if (confirmBtn) {
            confirmBtn.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (ok) {
        closed = true;
        console.log("✅ [BROWSER WARN] Đã click Xác nhận (evaluate)");
        await helper.delay(500);
        break;
      }
    } catch (_) {}
  }
  return closed;
}

/** Chỉ coi là vào bàn khi có #currentGameTable hoặc zone_bet / odds */
async function isReallyInTableRoom() {
  const frames = [
    page.frame({ name: "iframeGameTable" }),
    page.frame({ name: "iframeGame" }),
    gameCurrentFrame,
    gameHallFrame,
    seamlessFrame,
    page,
    ...(page && typeof page.frames === "function" ? page.frames() : []),
  ].filter(Boolean);
  const seen = new Set();
  for (const frame of frames) {
    if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
    let key = "";
    try {
      key = frame.url() || String(Math.random());
    } catch (_) {
      key = String(Math.random());
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const ok = await withTimeout(
      frame
        .evaluate(() => {
          const dt = document.querySelector("#currentGameTable, dt#currentGameTable");
          const banker =
            document.querySelector(".zone_bet_banker") ||
            document.getElementById("bankerOdds");
          const player =
            document.querySelector(".zone_bet_player") ||
            document.getElementById("playerOdds");
          const goHome =
            document.querySelector("button#goHome2") ||
            document.querySelector("button#goHome") ||
            document.querySelector(".goHome");
          const hallList = document.querySelector(
            ".vue-recycle-scroller__item-view"
          );
          // Trong bàn: có zone/odds/currentGameTable, hoặc có goHome mà không còn list sảnh
          return !!(dt || banker || player || (goHome && !hallList));
        })
        .catch(() => false),
      3500,
      false
    );
    if (ok) return true;
  }
  return false;
}

/** Đã vào phòng? — nới hơn isReallyInTableRoom (cookie / #currentGameTable / iframe bàn) */
async function probeEnteredTable(fallbackCode = null) {
  const detected = await detectCurrentTableInRoom().catch(() => null);
  const cookie = await withTimeout(detectTableFromCookie(), 2000, null);
  const inDom = await isReallyInTableRoom().catch(() => false);
  let hasTableFrame = false;
  try {
    hasTableFrame = (page.frames() || []).some((f) => {
      try {
        const n = (f.name && f.name()) || "";
        const u = (f.url && f.url()) || "";
        return /iframeGameTable|GameTable/i.test(n + u);
      } catch (_) {
        return false;
      }
    });
  } catch (_) {}
  const table =
    detected || cookie || (fallbackCode ? normTableCode(fallbackCode) : null);
  // Có mã bàn (detect/cookie) hoặc DOM bet zone, hoặc iframe bàn + mã click
  const inRoom = !!(inDom || detected || cookie || (hasTableFrame && table));
  return { inRoom, table: table || null, inDom, detected, cookie, hasTableFrame };
}

/** Click .notification_closeBtn sau khi vào bàn */
async function clickNotificationCloseBtn() {
  const frames = [gameCurrentFrame, gameHallFrame, seamlessFrame, page].filter(Boolean);
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    const clicked = await f
      .evaluate(() => {
        const el =
          document.querySelector(".notification_closeBtn") ||
          document.querySelector("div.notification_closeBtn") ||
          document.querySelector("#notification_closeBtn");
        if (el) {
          if (typeof el.click === "function") el.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (clicked) {
      await helper.appendToLog(
        "✅ [NOTIF] Đã click .notification_closeBtn",
        logsNameProgress
      );
      return true;
    }
  }
  return false;
}

/** Click .btn_refresh sau khi vào bàn */
async function clickBtnRefresh() {
  const frames = [
    gameCurrentFrame,
    gameHallFrame,
    seamlessFrame,
    page,
    ...(page && typeof page.frames === "function" ? page.frames() : []),
  ].filter(Boolean);
  const seen = new Set();
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    try {
      const key = f.url ? f.url() : String(f);
      if (seen.has(key)) continue;
      seen.add(key);
    } catch (_) {}
    const clicked = await withTimeout(
      f
        .evaluate(() => {
          const el =
            document.querySelector(".btn_refresh") ||
            document.querySelector("button.btn_refresh") ||
            document.querySelector("[class*='btn_refresh']");
          if (!el) return false;
          if (typeof el.click === "function") el.click();
          return true;
        })
        .catch(() => false),
      2000,
      false
    );
    if (clicked) {
      console.log("✅ [REFRESH] Đã click .btn_refresh");
      await helper.appendToLog(
        "✅ [REFRESH] Đã click .btn_refresh sau khi vào bàn",
        logsNameProgress
      );
      return true;
    }
  }
  console.log("⚠️ [REFRESH] Không thấy .btn_refresh");
  return false;
}

/** Frame bàn cược thật — ưu tiên in-table; fallback toàn bộ frames nếu thiếu */
function getInTableBetFrames() {
  const preferred = [gameCurrentFrame, seamlessFrame, gameHallFrame].filter(Boolean);
  const all =
    page && typeof page.frames === "function"
      ? page.frames().filter((f) => f && !(typeof f.isClosed === "function" && f.isClosed()))
      : [];
  const merged = [...preferred, ...all, page].filter(Boolean);
  return [...new Set(merged)];
}

/** Hủy chip đang nằm trên bàn (tránh cộng dồn → Maximum chip selection is [5]) */
async function cancelPendingChips(maxClicks = 6) {
  const frames = getInTableBetFrames();
  let cancelled = 0;
  for (let i = 0; i < maxClicks; i++) {
    let clicked = false;
    for (const frame of frames) {
      if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
      const res = await frame
        .evaluate(() => {
          const candidates = [
            document.getElementById("cancel"),
            document.querySelector("button#cancel, button.btn_cancel, .btn_cancel"),
            ...Array.from(document.querySelectorAll("button, div[role='button']")).filter((el) =>
              /hủy|cancel|clear/i.test((el.innerText || el.textContent || "").trim())
            ),
          ].filter(Boolean);
          for (const el of candidates) {
            const cls = typeof el.className === "string" ? el.className : "";
            if (/\bdisabled\b/i.test(cls) || el.disabled) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            el.click();
            return { ok: true, id: el.id || "", className: cls };
          }
          return { ok: false };
        })
        .catch(() => ({ ok: false }));
      if (res && res.ok) {
        clicked = true;
        cancelled += 1;
        console.log(`[CHIP CANCEL] #${cancelled} via id=${res.id || "?"} cls=${res.className || ""}`);
        break;
      }
    }
    if (!clicked) break;
    await helper.delay(180);
  }
  if (cancelled) {
    await helper.appendToLog(`[CHIP CANCEL] Đã hủy ${cancelled} lần chip pending`, logsNameProgress);
  }
  return cancelled;
}

/** Selector chuẩn đặt cược Sexy */
const BET_ZONE = {
  B: ".zone_bet_banker",
  P: ".zone_bet_player",
};
const BET_CONFIRM_SEL = ".btn_confirm";

function pickBetZoneSelector(sideNorm) {
  return sideNorm === "B" ? BET_ZONE.B : BET_ZONE.P;
}

/** Click ĐÚNG 1 LẦN trên frame đầu có selector — không PW+evaluate, không multi-frame */
async function clickCssOnce(selector, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of getInTableBetFrames()) {
      if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;

      const r = await frame
        .evaluate((sel) => {
          let target = document.querySelector(sel);
          if (!target) {
            const want = String(sel || "").replace(/^\./, "");
            target =
              Array.from(document.querySelectorAll("[class]")).find((n) => {
                const c = typeof n.className === "string" ? n.className : "";
                return c.split(/\s+/).includes(want);
              }) || null;
          }
          if (!target) return { ok: false, reason: "missing" };
          const className =
            typeof target.className === "string"
              ? target.className
              : String(target.className || "");
          if (
            target.disabled ||
            target.getAttribute("aria-disabled") === "true" ||
            /\bdisabled\b|\bdisable\b|\bbtndisable\b|\bbtn_disable\b/i.test(className)
          ) {
            return { ok: false, reason: "disabled", className };
          }
          try {
            if (window.getComputedStyle(target).pointerEvents === "none") {
              return { ok: false, reason: "pointer-none", className };
            }
          } catch (_) {}
          const rect = target.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) {
            return { ok: false, reason: "hidden", className };
          }
          // ĐÚNG 1 click — không mouseevent x5, không click trùng
          target.click();
          return {
            ok: true,
            className,
            hit: className.slice(0, 80),
          };
        }, selector)
        .catch(() => null);

      if (r && r.ok) return r;
      // disabled/hidden → tiếp tục đợi trong vòng (confirm hay bật chậm sau khi đặt chip)
    }
    await helper.delay(150);
  }
  return { ok: false, reason: "timeout" };
}

/** Đọc trạng thái .btn_confirm */
async function readConfirmState() {
  for (const frame of getInTableBetFrames()) {
    if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
    const st = await frame
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const className = typeof el.className === "string" ? el.className : String(el.className || "");
        const rect = el.getBoundingClientRect();
        const aria = el.getAttribute("aria-disabled");
        let pe = "";
        try {
          pe = window.getComputedStyle(el).pointerEvents;
        } catch (_) {}
        const locked = !!(
          el.disabled ||
          aria === "true" ||
          /\bdisabled\b|\bdisable\b|\bbtndisable\b|\bbtn_disable\b/i.test(className) ||
          pe === "none"
        );
        return {
          found: true,
          disabled: locked,
          className,
          ariaDisabled: aria,
          pointerEvents: pe,
          visible: rect.width > 1 && rect.height > 1,
        };
      }, BET_CONFIRM_SEL)
      .catch(() => null);
    if (st && st.found) return st;
  }
  return { found: false, disabled: true, visible: false };
}

/** Dump DOM khi fail */
async function probeBetDom(zoneSel) {
  for (const frame of getInTableBetFrames()) {
    if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
    const dump = await frame
      .evaluate(
        ({ zoneSel, confirmSel }) => {
          const zone = document.querySelector(zoneSel);
          const confirm = document.querySelector(confirmSel);
          return {
            zone: zone
              ? {
                  className: String(zone.className || ""),
                  w: Math.round(zone.getBoundingClientRect().width),
                  h: Math.round(zone.getBoundingClientRect().height),
                }
              : null,
            confirm: confirm
              ? {
                  className: String(confirm.className || ""),
                  disabledAttr: !!confirm.disabled,
                  aria: confirm.getAttribute("aria-disabled"),
                }
              : null,
          };
        },
        { zoneSel, confirmSel: BET_CONFIRM_SEL }
      )
      .catch(() => null);
    if (dump && (dump.zone || dump.confirm)) return dump;
  }
  return null;
}

/** Chọn chip 1 lần (vd 50 → #Chips_50). Không bắt buộc visible — tray có thể ngoài viewport. */
async function selectBetChip(amountK) {
  const amt = Math.max(1, Math.round(Number(amountK) || 50));
  const frames = getInTableBetFrames();
  let lastProbe = null;

  for (const frame of frames) {
    if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
    const ok = await withTimeout(
      frame
        .evaluate((amount) => {
          const chipIds = Array.from(document.querySelectorAll("[id*='Chip'], [id*='chip']")).map(
            (el) => el.id
          );
          const ids = [
            `Chips_${amount}`,
            `Chips_${amount}k`,
            `Chips_${amount}K`,
            `chip_${amount}`,
            `chip_${amount}k`,
          ];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            const cls = typeof el.className === "string" ? el.className : "";
            if (/\bselect\b|\bactive\b|\bselected\b/i.test(cls)) {
              return { ok: true, via: "already_selected", id, chipIds };
            }
            el.click();
            return { ok: true, via: "id", id, chipIds };
          }
          const lis = Array.from(
            document.querySelectorAll("li[id*='Chip'], li[id*='chip'], .chip, [class*='chip']")
          );
          const wantExact = new Set(
            [`${amount}K`, `${amount}k`, String(amount)].map((s) =>
              s.replace(/\s+/g, "").toUpperCase()
            )
          );
          for (const el of lis) {
            const t = (el.innerText || el.textContent || "").replace(/\s+/g, "").toUpperCase();
            if (!wantExact.has(t)) continue;
            const cls = typeof el.className === "string" ? el.className : "";
            if (/\bselect\b|\bactive\b|\bselected\b/i.test(cls)) {
              return { ok: true, via: "text_selected", id: el.id || t, chipIds };
            }
            el.click();
            return { ok: true, via: "text", id: el.id || t, chipIds };
          }
          return { ok: false, chipIds };
        }, amt)
        .catch(() => ({ ok: false })),
      2500,
      { ok: false }
    );
    if (ok && ok.chipIds) lastProbe = ok.chipIds;
    if (ok && ok.ok) {
      console.log(`✅ [CHIP] Đã chọn chip ${amt} via=${ok.via} id=${ok.id || "?"}`);
      await helper.appendToLog(
        `✅ [CHIP] Chọn chip ${amt} (${ok.via}/${ok.id || "?"})`,
        logsNameProgress
      );
      return true;
    }
  }
  console.log(
    `⚠️ [CHIP] Không tìm thấy chip ${amt} | probeIds=${JSON.stringify(lastProbe || [])}`
  );
  return false;
}

/** Đóng toast lỗi cược (noBetOverNaN, Maximum chip selection, ...) */
async function dismissBetErrorToast() {
  const frames = getInTableBetFrames();
  for (const f of frames) {
    if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
    await f
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll("div, span, p, section"));
        for (const el of nodes) {
          const t = (el.innerText || "").trim();
          if (
            /noBetOverNaN|Không thể đặt|Maximum chip selection|Sorry!|NaN/i.test(t) &&
            t.length < 160
          ) {
            const closer =
              el.querySelector(".close, .tcg_modal_close, [class*='close']") ||
              el.parentElement?.querySelector(".close, [class*='close']");
            if (closer && closer.click) closer.click();
            try {
              el.remove();
            } catch (_) {}
          }
        }
      })
      .catch(() => {});
  }
}

/** Đợi cửa cược mở: thấy .zone_bet_banker / .zone_bet_player đủ to */
async function waitBettingWindowOpen(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of getInTableBetFrames()) {
      if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;
      const st = await frame
        .evaluate(() => {
          const banker =
            document.querySelector(".zone_bet_banker") ||
            document.getElementById("bankerOdds");
          const player =
            document.querySelector(".zone_bet_player") ||
            document.getElementById("playerOdds");
          const confirm =
            document.querySelector(".btn_confirm") || document.getElementById("confirm");
          if (!banker || !player) return { open: false, reason: "no_odds" };
          const br = banker.getBoundingClientRect();
          const pr = player.getBoundingClientRect();
          if (br.width < 2 || pr.width < 2) return { open: false, reason: "odds_hidden" };
          const statusEl =
            document.querySelector(".game-status, .status-text, #gameStatus, .bet-timer") || null;
          const statusTxt = statusEl
            ? (statusEl.innerText || statusEl.textContent || "").trim()
            : "";
          if (/Đang mở bài|Đang chia bài|No more bets|Hết giờ/i.test(statusTxt)) {
            return { open: false, reason: "status_closed", statusTxt };
          }
          return { open: true, hasConfirm: !!confirm };
        })
        .catch(() => null);
      if (st && st.open) return st;
    }
    await helper.delay(250);
  }
  return { open: false, reason: "timeout" };
}

/**
 * Đặt cược chuẩn class:
 * CÁI → .zone_bet_banker | CON → .zone_bet_player | xác nhận → .btn_confirm
 * Bước nào lag/không click được → bỏ qua ván đó (không spam).
 */
async function executePlaceBet(betSide, requestedAmount) {
  const sideNorm = String(betSide || "P").toUpperCase().startsWith("B") ? "B" : "P";
  const zoneSel = pickBetZoneSelector(sideNorm);
  const chipAmount =
    Number(requestedAmount) || Number(process.env.BET_AMOUNT || 50) || 50;

  try {
    if (await detectSessionExpired().catch(() => false)) {
      recoverFromFatalUi("SESSION_EXPIRED").catch((e) =>
        console.error("[RECOVER]", e.message)
      );
      return { success: false, side: sideNorm, reason: "SESSION_EXPIRED", skipped: true };
    }
    await dismissBetErrorToast().catch(() => {});

    console.log("[AUTOBET] Chờ 2s sau hô rồi đặt cược...");
    await helper.appendToLog(
      `[AUTOBET] Chờ 2s → click ${zoneSel} → ${BET_CONFIRM_SEL}`,
      logsNameProgress
    );
    await helper.delay(2000);

    await cancelPendingChips(2);

    console.log(`[AUTOBET] Đợi cửa mở rồi: ${zoneSel} + ${BET_CONFIRM_SEL}`);
    const win = await waitBettingWindowOpen(20000);
    if (!win || !win.open) {
      await helper.appendToLog(
        `[AUTOBET SKIP] cửa chưa mở (${win && win.reason}) — bỏ qua`,
        logsNameProgress
      );
      return { success: false, side: sideNorm, reason: "window_closed", skipped: true };
    }

    const chipOk = await selectBetChip(chipAmount);
    if (!chipOk) {
      await helper.appendToLog(
        `[AUTOBET SKIP] không chọn được chip ${chipAmount} — bỏ qua`,
        logsNameProgress
      );
      return { success: false, side: sideNorm, reason: "no_chip", skipped: true };
    }
    await helper.delay(150);

    // Click zone CÁI/CON — timeout ngắn, lag thì skip
    const zoneClick = await clickCssOnce(zoneSel, 2500);
    if (!zoneClick || !zoneClick.ok) {
      await helper.appendToLog(
        `[AUTOBET SKIP] không click ${zoneSel} (${zoneClick && zoneClick.reason}) — bỏ qua`,
        logsNameProgress
      );
      return {
        success: false,
        side: sideNorm,
        reason: "zone_fail",
        skipped: true,
        selector: zoneSel,
      };
    }
    console.log(`[AUTOBET] Click ${zoneSel} OK hit=${zoneClick.hit || "?"}`);
    await helper.delay(300);

    // Chờ .btn_confirm bật rồi mới ấn (thường disabled tới khi đã đặt chip lên zone)
    let confClick = null;
    const confDeadline = Date.now() + 6000;
    while (Date.now() < confDeadline) {
      const st = await readConfirmState();
      if (st && st.found && st.visible && !st.disabled) {
        confClick = await clickCssOnce(BET_CONFIRM_SEL, 2500);
        break;
      }
      await helper.delay(120);
    }
    if (!confClick || !confClick.ok) {
      await cancelPendingChips(2).catch(() => {});
      await dismissBetErrorToast().catch(() => {});
      const dump = await probeBetDom(zoneSel);
      await helper.appendToLog(
        `[AUTOBET SKIP] không click ${BET_CONFIRM_SEL} (${(confClick && confClick.reason) || "still_disabled"}) — bỏ qua | ` +
          `dom=${JSON.stringify(dump)}`,
        logsNameProgress
      );
      return {
        success: false,
        side: sideNorm,
        reason: "confirm_fail",
        skipped: true,
        selector: BET_CONFIRM_SEL,
        dom: dump,
      };
    }

    await helper.delay(150);
    await dismissBetErrorToast().catch(() => {});
    await helper.appendToLog(
      `[AUTOBET OK] side=${sideNorm} chip=${chipAmount} | ${zoneSel} + ${BET_CONFIRM_SEL}`,
      logsNameProgress
    );
    return {
      success: true,
      side: sideNorm,
      betSuccess: true,
      confirmOk: true,
      chipOk: true,
      selector: zoneSel,
      tableName: currentInTable,
    };
  } catch (err) {
    await cancelPendingChips(2).catch(() => {});
    await helper.appendToLog(`[AUTOBET SKIP] error ${err.message} — bỏ qua`, logsNameProgress);
    return { success: false, error: err.message, skipped: true };
  }
}

// Mở bàn chơi và tự động đọc mã bàn thực tế từ DOM
async function enterTargetTable(gameHallFrame, tableName, isRetry = false) {
  if (enterInFlight && !isRetry) {
    console.log("[ENTER] đang vào bàn — bỏ lệnh trùng");
    return { success: false, reason: "busy" };
  }
  if (!isRetry) enterInFlight = true;
  try {
    // NẾU ĐÃ Ở TRONG BÀN CƯỢC THỰC TẾ -> NỔI KHÔNG OUT RA HAY VÀO LẠI!
    if (currentInTable && currentInTable !== "NONE" && currentInTable !== "LOBBY") {
      await helper.appendToLog(`✅ [ALREADY IN TABLE] Đã ở sẵn bên trong bàn ${currentInTable}! Giữ nguyên không out ra!`, logsNameProgress);
      return { success: true, tableName: currentInTable };
    }

    const rawName = String(tableName || "C01").trim();
    const cleanUpper = rawName.toUpperCase();
    const numOnly = rawName.replace(/\D/g, "");
    const numInt = numOnly ? String(parseInt(numOnly, 10)) : "";

    const exactSearchPatterns = [
      `BACCARAT ${cleanUpper}`,
      `BACCARAT C${numOnly}`,
      `BACCARAT ${numOnly}`,
      `BACCARAT ${numInt}`,
      `BACCARAT C${numInt}`,
      `BTCB${numOnly}`,
      `BTCB${numInt}`,
      `C${numOnly}`,
      `C${numInt}`,
      numOnly,
      cleanUpper
    ].filter(Boolean);

    let clickedSuccess = false;

    // Thao tác click vào phần tử #loadingFrameWithDirectPoker / vị trí trung tâm (X: 720, Y: 403) theo yêu cầu người dùng
    try {
      if (seamlessFrame) {
        await seamlessFrame.evaluate(() => {
          const el = document.querySelector("#loadingFrameWithDirectPoker, div.loading_con, .loading_con");
          if (el) {
            const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(evt);
            if (el.click) el.click();
          }
        }).catch(() => {});
      }
      await page.mouse.click(720, 403).catch(() => {});
      await helper.appendToLog("✅ [THAO TÁC CỦA BẠN] Đã click vị trí màn hình game (X: 720, Y: 403 / #loadingFrameWithDirectPoker)!", logsNameProgress);
    } catch (e) {}

    // Refresh gameHallFrame reference if missing
    if (!gameHallFrame && seamlessFrame) {
      const gameHallElement = await seamlessFrame.$("iframe#iframeGameHall").catch(() => null);
      if (gameHallElement) gameHallFrame = await gameHallElement.contentFrame().catch(() => null);
    }

    let clickedTableCode = null;
    // NS1 ưu tiên free[0], NS2 free[1]… — tránh 2 session cùng dãy C03→C04
    const pickOffset = Math.max(0, accountIdx - 1);

    if (gameHallFrame) {
      let listedOnce = await listTablesFromFrame(gameHallFrame, { scrolls: 4 }).catch(
        () => []
      );

      // Thử lại tối đa 20 lần: đóng popup → chỉ click bàn cầu đẹp
      for (let attempt = 0; attempt < 20; attempt++) {
        console.log(`[ENTER] attempt ${attempt + 1}/20 — đóng popup rồi mới click bàn cầu đẹp`);
        await dismissBrowserSupportModal().catch(() => {});
        await helper.delay(300);
        await dismissBrowserSupportModal().catch(() => {});

        if (await isBrowserSupportModalVisible()) {
          console.log(`[ENTER] attempt ${attempt + 1}: vẫn còn popup trình duyệt — chưa click bàn`);
          await dismissBrowserSupportModal().catch(() => {});
          await helper.delay(1000);
          continue;
        }

        // Refresh list DOM mỗi vài lần — bàn mới mở / đủ tay
        if (attempt > 0 && attempt % 4 === 0) {
          const relisted = await listTablesFromFrame(gameHallFrame, { scrolls: 4 }).catch(
            () => []
          );
          if (relisted.length) listedOnce = relisted;
        }

        // Mỗi attempt lấy lại occupied (NS kia có thể vừa khóa bàn)
        const occupied = await fetchOccupiedTableCodes();
        const freeCodes = listedOnce
          .map((t) => normTableCode(t.code))
          .filter((c) => c && !occupied.includes(c));
        console.log(
          `[ENTER] DOM list=${listedOnce.length} free=${freeCodes.slice(0, 10).join(",") || "-"} occupied=${occupied.join(",") || "-"} offset=${pickOffset}`
        );

        // Ưu tiên bàn chỉ định; không thì chỉ vào bàn cầu đẹp (≥20 tay, conf đủ)
        let prefer = null;
        if (tableName && String(tableName).trim()) {
          const forced = normTableCode(tableName);
          if (forced) prefer = forced;
        } else {
          const pick = await pickBeautifulTableFromServer(freeCodes);
          prefer = pick.tableName || null;
          if (prefer) {
            console.log(
              `[ENTER] cầu đẹp → ${prefer} type=${pick.profile?.roadType} ` +
                `conf=${pick.profile?.confidence} seq=${pick.profile?.seqDisplay || "-"}`
            );
          } else {
            console.log(
              `[ENTER] chưa có bàn cầu đẹp — chờ quét lại (${pick.message || "—"})`
            );
            await helper.delay(1500);
            continue;
          }
        }

        // Khóa bàn trước khi click — NS khác sẽ thấy occupied
        if (prefer) {
          const reserved = await reserveTableOnServer(prefer);
          if (reserved && typeof reserved === "object" && reserved.conflict) {
            console.log(
              `[ENTER] skip ${prefer} — đang giữ bởi ${reserved.occupiedBy}`
            );
            await helper.delay(400);
            continue;
          }
          if (!reserved) {
            console.log(`[ENTER] reserve ${prefer} thất bại — thử bàn khác`);
            await helper.delay(400);
            continue;
          }
          console.log(`[ENTER] reserved ${prefer} cho ${account.nameServiceSocket}`);
        }

        let tableClicked = { ok: false, table: null };
        if (prefer) {
          tableClicked = await clickTableByCode(gameHallFrame, prefer, {
            allowFallback: false,
          }).catch(() => ({ ok: false }));
        }
        // Không fallback random bàn xấu — chỉ vào bàn cầu đẹp đã chọn
        if (!tableClicked?.ok) {
          console.log(`[ENTER] click ${prefer || "?"} thất bại — thử bàn cầu đẹp khác`);
          await helper.delay(800);
          continue;
        }

        if (tableClicked && tableClicked.ok) {
          clickedSuccess = true;
          clickedTableCode = tableClicked.table
            ? normTableCode(tableClicked.table)
            : prefer;
          await helper.appendToLog(
            `✅ [CLICK TABLE SUCCESS] click card ${clickedTableCode || "?"} (lần ${attempt + 1})!`,
            logsNameProgress
          );
          console.log(`✅ [CLICK TABLE] ${clickedTableCode || "?"}`);

          // Chờ vào phòng thật
          await helper.delay(5000);
          await dismissBrowserSupportModal().catch(() => {});
          await clickNotificationCloseBtn().catch(() => {});
          // Bind iframe bàn nếu vừa xuất hiện
          try {
            const tEl =
              (await page.$("iframe#iframeGameTable, iframe[name='iframeGameTable']").catch(() => null)) ||
              (seamlessFrame &&
                (await seamlessFrame.$("iframe#iframeGameTable, iframe[name='iframeGameTable']").catch(() => null)));
            if (tEl) gameCurrentFrame = await tEl.contentFrame().catch(() => null);
          } catch (_) {}
          for (const f of page.frames()) {
            const n = (f.name && f.name()) || "";
            const u = (f.url && f.url()) || "";
            if (/iframeGameTable|GameTable/i.test(n + u)) {
              gameCurrentFrame = f;
              break;
            }
          }
          const probe = await probeEnteredTable(clickedTableCode);
          if (probe.inRoom) {
            if (probe.table) clickedTableCode = probe.table;
            console.log(
              `✅ [IN ROOM] Đã vào bàn thật sau click ${clickedTableCode || "?"} (detect=${probe.detected} cookie=${probe.cookie} frame=${probe.hasTableFrame})`
            );
            break;
          }
          console.log(`[ENTER] Click rồi nhưng chưa vào phòng (popup?) — nhả khóa rồi thử lại...`);
          clickedSuccess = false;
          await clearActiveTableOnServer().catch(() => {});
        } else if (prefer) {
          // Click fail — nhả bàn đã reserve
          await clearActiveTableOnServer().catch(() => {});
        }
        await helper.delay(800);
      }
    }

    if (!clickedSuccess && gameHallFrame) {
      console.log(
        "[ENTER] hết attempt — chưa click được bàn cầu đẹp (không fallback random)"
      );
      await clearActiveTableOnServer().catch(() => {});
      return { success: false, reason: "no_beautiful_table" };
    }

    // Chờ vào bàn + đọc mã — chỉ notify khi đã vào phòng thật
    let actualDetectedTable = null;
    let probeFinal = { inRoom: false, table: null };
    for (let i = 0; i < 8; i++) {
      await helper.delay(800);
      await dismissBrowserSupportModal().catch(() => {});
      await closeInTableModals(gameCurrentFrame || gameHallFrame || page).catch(() => {});
      await clickNotificationCloseBtn().catch(() => {});
      probeFinal = await probeEnteredTable(clickedTableCode);
      actualDetectedTable = probeFinal.detected || probeFinal.table || null;
      if (probeFinal.inRoom && actualDetectedTable) break;
      console.log(`[DETECT TABLE] retry ${i + 1}/8...`);
    }

    const cookieTable = probeFinal.cookie || (await withTimeout(detectTableFromCookie(), 2000, null));
    const reallyIn = !!(probeFinal.inRoom || actualDetectedTable || cookieTable);
    const finalTable =
      actualDetectedTable || clickedTableCode || cookieTable || null;

    if (!finalTable || !reallyIn) {
      console.log(
        `⚠️ [CHƯA VÀO BÀN] detect=${actualDetectedTable} click=${clickedTableCode} probeIn=${probeFinal.inRoom} cookie=${cookieTable} — không notify bot`
      );
      await helper.appendToLog(
        `⚠️ [CHƯA VÀO BÀN] Popup/trình duyệt chặn — chưa báo bot. inRoom=${probeFinal.inRoom}`,
        logsNameProgress
      );
      currentInTable = null;
      await clearActiveTableOnServer().catch(() => {});
      return { success: false, reason: "not_in_table_room" };
    }

    currentInTable = finalTable;
    console.log(
      `🎯 [ĐANG Ở BÀN] detect=${actualDetectedTable} click=${clickedTableCode} cookie=${cookieTable} → FINAL=${finalTable}`
    );
    await helper.appendToLog(
      `🎯 [ĐANG Ở CHÍNH XÁC BÀN]: ${finalTable}! Gửi thông báo cho Bot Telegram!`,
      logsNameProgress
    );
    const notified = await notifyActiveTableToServer(finalTable);
    if (notified && typeof notified === "object" && notified.conflict) {
      console.log(
        `[CONFLICT] ${finalTable} trùng ${notified.occupiedBy} — goHome rồi chọn bàn khác`
      );
      await helper.appendToLog(
        `⚠️ [CONFLICT] Out ${finalTable}, chọn bàn khác (đang giữ bởi ${notified.occupiedBy})`,
        logsNameProgress
      );
      await goHomeToLobby();
      return enterTargetTable(gameHallFrame, null, true);
    }
    console.log(`[NOTIFY BOT] active_table=${finalTable} ok=${!!notified}`);

    // Vào bàn XONG mới bấm btn_refresh ĐÚNG 1 LẦN
    await helper.delay(600);
    await clickBtnRefresh().catch(() => {});

    startActiveTableHeartbeat();

    await captureTableRound(finalTable, { roundNum: "INIT_" + Date.now() }).catch(() => {});

    return { success: true, tableName: finalTable };
  } catch (error) {
    await helper.appendToLog(`Lỗi khi vào bàn: ${error.message}`, logsNameProgress);
    return { success: false, reason: error.message };
  } finally {
    if (!isRetry) enterInFlight = null;
  }
}

// Tắt popup Thông báo / promo / float widget — ưu tiên click nút X, không scroll
async function dismissSitePopups(targetPage = page) {
  if (!targetPage || (typeof targetPage.isClosed === "function" && targetPage.isClosed())) {
    return;
  }

  const closeFn = () => {
    const clickSafe = (el) => {
      try {
        if (el && typeof el.click === "function") el.click();
      } catch (_) {}
    };

    // 1) Nút đóng chuẩn TCG / publicModal
    const selectors = [
      ".publicModal .tcg_modal_close",
      ".tcg_modal_close",
      ".tcg_modal_close_btn",
      ".publicModal [class*='close']",
      ".modal-close",
      ".close-btn",
      "[class*='notice'] [class*='close']",
      "[class*='Notice'] [class*='close']",
      "[class*='announce'] [class*='close']",
      "[class*='promo'] [class*='close']",
      ".notification_closeBtn",
      "div.notification_closeBtn",
      "[class*='float'] [class*='close']",
      "[class*='widget'] [class*='close']",
      "[class*='featured'] [class*='close']",
    ];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach(clickSafe);
    });

    // 2) Modal có chữ "Thông báo" → click nút X trong cùng container
    const all = Array.from(document.querySelectorAll("div, section, aside"));
    for (const box of all) {
      const txt = (box.innerText || "").slice(0, 80);
      if (!/Thông báo/i.test(txt)) continue;
      const closer =
        box.querySelector(".tcg_modal_close, .close, .close-btn, [class*='close'], i, svg, span, button") ||
        null;
      // Ưu tiên phần tử góc phải trên của box
      const candidates = Array.from(
        box.querySelectorAll("i, span, button, div, a, svg")
      ).filter((el) => {
        const c = (el.className && String(el.className)) || "";
        const t = (el.getAttribute("aria-label") || "").toLowerCase();
        return /close|cross|icon-close|modal_close/i.test(c + t) || t.includes("close");
      });
      if (candidates.length) {
        // Chọn candidate cao nhất bên phải
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.right + rb.top - (ra.right + ra.top);
        });
        clickSafe(candidates[0]);
      } else if (closer) {
        clickSafe(closer);
      }
    }

    // 3) Ẩn cứng overlay còn sót (không đụng canvas / iframe game)
    document
      .querySelectorAll(
        ".publicModal, .van-overlay, .van-popup, .modal-mask, [class*='notice-modal'], [class*='NoticeModal']"
      )
      .forEach((el) => {
        try {
          if (el.querySelector("canvas") || el.querySelector("iframe")) return;
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("visibility", "hidden", "important");
          el.style.setProperty("pointer-events", "none", "important");
        } catch (_) {}
      });
  };

  await targetPage.evaluate(closeFn).catch(() => {});
  for (const frame of targetPage.frames() || []) {
    await frame.evaluate(closeFn).catch(() => {});
  }
}

// Tắt tất cả các popup thông báo/dialog lỗi đè lên màn hình
async function closeAllModals(page) {
  if (!page || page.isClosed()) return;
  try {
    await dismissSitePopups(page);

    const handleCloseFn = () => {
      const closeSelectors = [
        "#betLimitWrongSet",
        "div#betLimitWrongSet",
        "promo-widget",
        ".notification_closeBtn",
        "div.notification_closeBtn",
        ".publicModal .tcg_modal_close",
        ".tcg_modal_close",
        ".sign-in-rules .close-btn",
        ".tcg_modal_close_btn",
        "i.van-icon-cross",
        ".close-btn",
        "[class*='close-btn']",
        "[class*='modal_close']",
      ];
      closeSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          try {
            if (typeof el.click === "function") el.click();
          } catch (e) {}
        });
      });

      const overlaySelectors = [
        ".publicModal",
        ".van-popup",
        ".van-overlay",
        ".modal-mask",
        ".van-dialog",
      ];
      overlaySelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.tagName !== "CANVAS" && !el.querySelector("canvas") && !el.id?.includes("seamless")) {
            try {
              el.style.display = "none";
              el.style.visibility = "hidden";
              el.style.opacity = "0";
              el.style.pointerEvents = "none";
            } catch (e) {}
          }
        });
      });
    };

    await page.evaluate(handleCloseFn).catch(() => {});
    const frames = page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(handleCloseFn).catch(() => {});
      } catch (e) {}
    }
    if (seamlessFrame && typeof seamlessFrame.evaluate === "function") {
      await seamlessFrame.evaluate(handleCloseFn).catch(() => {});
    }
    if (gameHallFrame && typeof gameHallFrame.evaluate === "function") {
      await gameHallFrame.evaluate(handleCloseFn).catch(() => {});
    }
    if (gameCurrentFrame && typeof gameCurrentFrame.evaluate === "function") {
      await gameCurrentFrame.evaluate(handleCloseFn).catch(() => {});
    }
  } catch (err) {
    console.error("Lỗi khi đóng popup thông báo:", err.message);
  }
}

async function verifyInTable(tableName) {
  if (!page || page.isClosed()) return false;
  try {
    const cleanTable = String(tableName).trim().toUpperCase();
    const numOnly = cleanTable.replace(/\D/g, "");
    const allFrames = [page, ...(page.frames() || [])];

    for (const frame of allFrames) {
      try {
        const info = await frame.evaluate(({ tableCode, numStr }) => {
          const bodyText = (document.body ? document.body.innerText : "") || "";
          
          const hasGoHome = !!document.querySelector(
            "button#goHome2, button#goHome, .goHome, [class*='goHome'], [class*='back-hall'], [class*='leave-table'], canvas"
          );

          const uppercaseText = bodyText.toUpperCase();
          const hasTableCode = uppercaseText.includes(tableCode) || 
                               uppercaseText.includes(`BÀN ${tableCode}`) || 
                               (numStr && uppercaseText.includes(`BTCB${numStr}`));

          return { hasGoHome, hasTableCode };
        }, { tableCode: cleanTable, numStr: numOnly }).catch(() => null);

        if (info && (info.hasGoHome || info.hasTableCode)) {
          return true;
        }
      } catch (e) {}
    }

    const seamlessEl = await page.$("iframe#seamless-game").catch(() => null);
    if (seamlessEl) return true;
  } catch (err) {}
  return false;
}

let isCapturingScreenshot = false;
let captureLockTimeout = null;

// Chụp ảnh màn hình bàn cược
async function captureTableRound(tableName, roundOptions = {}) {
  if (sessionRecovering || resetInFlight) {
    console.log(`[SCREENSHOT SKIP] đang recover — không chụp ${tableName}`);
    return { success: false, reason: "RECOVERING" };
  }
  // Nếu đang chụp — chờ lock tối đa 6s rồi mới bỏ (tránh bot nhận ảnh ảo)
  if (isCapturingScreenshot) {
    const waitUntil = Date.now() + 6000;
    while (isCapturingScreenshot && Date.now() < waitUntil) {
      await helper.delay(200);
    }
    if (isCapturingScreenshot) {
      console.log(`[SCREENSHOT] Vẫn bận sau 6s cho bàn ${tableName}, bỏ qua`);
      return { success: false, reason: "BUSY" };
    }
  }
  isCapturingScreenshot = true;
  if (captureLockTimeout) clearTimeout(captureLockTimeout);
  captureLockTimeout = setTimeout(() => { isCapturingScreenshot = false; }, 15000);

  try {
    if (!page || page.isClosed()) {
      recoverFromFatalUi("PAGE_CLOSED").catch((e) => console.error("[RECOVER]", e.message));
      return { success: false, reason: "PAGE_CLOSED" };
    }
    if (!currentInTable || currentInTable === "NONE" || currentInTable === "LOBBY") {
      console.log(`[SCREENSHOT CANCELLED] Chưa ở trong bàn cược thực tế nào, hủy chụp!`);
      return { success: false, reason: "NOT_IN_TABLE" };
    }

    const cleanTarget = String(tableName || currentInTable).trim().toUpperCase();

    const fatalUi = await detectFatalUiError().catch(() => null);
    if (fatalUi === "SESSION_EXPIRED" || fatalUi === "PAGE_CLOSED") {
      recoverFromFatalUi(fatalUi).catch((e) => console.error("[RECOVER]", e.message));
      return { success: false, reason: fatalUi };
    }

    // 2. Đảm bảo đóng/xoá mọi popup thông báo trước khi chụp ảnh
    await Promise.race([
      closeAllModals(page).catch(() => {}),
      helper.delay(1200),
    ]);

    // Overlay kick có thể xuất hiện trong lúc đóng modal; kiểm tra lại sát lúc chụp.
    const fatalImmediatelyBeforeCapture = await detectFatalUiError().catch(
      () => null
    );
    if (
      fatalImmediatelyBeforeCapture === "SESSION_EXPIRED" ||
      fatalImmediatelyBeforeCapture === "PAGE_CLOSED"
    ) {
      recoverFromFatalUi(fatalImmediatelyBeforeCapture).catch((e) =>
        console.error("[RECOVER]", e.message)
      );
      return { success: false, reason: fatalImmediatelyBeforeCapture };
    }

    await helper.appendToLog(
      `📸 Đang tiến hành chụp ảnh màn hình cho bàn ${cleanTarget}...`,
      logsNameProgress
    );

    const seamlessElement = await page.$("iframe#seamless-game").catch(() => null);
    const targetToScreenshot = seamlessElement || page;

    const result = await screenshotHelper.saveScreenshot(targetToScreenshot, cleanTarget, {
      roundNum: roundOptions.roundNum,
      shoeNum: roundOptions.shoeNum,
      isFullPage: false,
      pageObj: page,
      // VPS CPU không hỗ trợ binary Sharp hiện tại; bỏ crop để tránh load/error mỗi ván.
      trimBlack: false,
    });

    // Text kick có thể nằm hoàn toàn trên canvas, không thể thấy qua innerText.
    // screenshotHelper sẽ xóa ảnh đó; session phải restart và tuyệt đối không notify.
    if (result?.fatalUi === "SESSION_EXPIRED") {
      recoverFromFatalUi("SESSION_EXPIRED").catch((e) =>
        console.error("[RECOVER]", e.message)
      );
      return { success: false, reason: "SESSION_EXPIRED_CANVAS" };
    }

    if (result.success) {
      await helper.appendToLog(
        `📸 Đã chụp ảnh thành công: ${result.filename}`,
        logsNameProgress
      );

      const isInitCapture = String(roundOptions.roundNum || "").startsWith("INIT_");
      if (!isInitCapture) {
        const serverPort = process.env.SERVER_PORT || process.env.PORT || 3201;
        const notifyBody = {
          tableName: cleanTarget,
          filename: result.filename,
          filepath: result.filepath,
          url: `/screenshots/${result.filename}`,
          roundNum: roundOptions.roundNum || null,
          resultWinner: roundOptions.resultWinner || null,
          nameService: nameServiceSocket,
        };
        let notifyError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await axios.post(
              `http://localhost:${serverPort}/api/notify-screenshot`,
              notifyBody,
              { timeout: 5000 }
            );
            notifyError = null;
            break;
          } catch (error) {
            notifyError = error;
            if (attempt < 2) await helper.delay(250);
          }
        }
        if (notifyError) throw notifyError;
      }
    }
    return result;
  } catch (err) {
    await helper.appendToLog(
      `Lỗi khi chụp ảnh bàn ${tableName}: ${err.message}`,
      logsNameProgress
    );
  } finally {
    isCapturingScreenshot = false;
    if (captureLockTimeout) clearTimeout(captureLockTimeout);
  }
}

// Vào ra bàn game baccarat (chu kỳ mặc định)
async function playBaccaratLoop(gameHallFrame, gameCurrentFrame) {
  try {
    await enterTargetTable(gameHallFrame, null);
    await gameHallFrame.hover(process.env.CLICK_IN_TABLE_GAME).catch(() => {});
    
    // Đợi 20s và chụp ảnh thử nghiệm
    await helper.delay(20000);
    await captureTableRound(currentInTable || "UNKNOWN", { roundNum: "LOOP" });
    
    await helper.delay(10000);
    await returnToHallIfNeeded(gameCurrentFrame);
    await helper.delay(2000);
  } catch (error) {
    await helper.appendToLog(
      `Lỗi trong chu kỳ baccarat: ${error.message}`,
      logsNameProgress
    );
    return resetMain();
  }
}

// lặp lại vô hạn
async function startBaccaratCycle(gameHallFrame, gameCurrentFrame) {
  const interval = 2 * (60 * 1000);
  while (true) {
    try {
      await helper.appendToLog("Bắt đầu chu kỳ baccarat", logsNameProgress);
      await playBaccaratLoop(gameHallFrame, gameCurrentFrame);
      await helper.appendToLog("Chờ đến chu kỳ tiếp theo...", logsNameProgress);
      await new Promise((resolve) => setTimeout(resolve, interval));
    } catch (error) {
      await helper.appendToLog(
        `Lỗi trong startBaccaratCycle: ${error.message}`,
        logsNameProgress
      );
      await resetMain();
      break;
    }
  }
}

async function sendSessionData(sessionId, nameService, uriRequestData, quiet = false) {
  if (socket && sessionId !== undefined) {
    if (!quiet) {
      console.log(
        `[SOCKET] Sending session: ${sessionId} to service: ${nameService}`
      );
    }
    socket.emit("session", {
      sessionId,
      nameService,
      stampTime: helper.getCurrentTime().timeUnix,
      uriRequestData: uriRequestData || undefined,
    });
    if (!quiet) {
      await helper.appendToLog(
        `(SOCKET) send server sessionId:: ${sessionId}`,
        logsNameProgress
      );
    }
  } else {
    console.log(
      `[SOCKET] Cannot send session - socket: ${!!socket}, sessionId: ${sessionId}`
    );
  }
}

socket.on(`${nameServiceSocket}_restart`, async (data) => {
  await helper.appendToLog(
    `(SOCKET) - RESTART ${nameServiceSocket} - (SERVER)`,
    logsNameProgress
  );
  console.log(`(SOCKET) - RESTART ${nameServiceSocket}`);
  resetMain();
});

// Bot timeout 60s / out bàn → vào bàn mới (đè bàn cũ), không full reset nếu còn page
socket.on("force_reenter_table", async (data) => {
  const targetNs = data?.nameService ? String(data.nameService).trim().toUpperCase() : null;
  if (targetNs && targetNs !== nameServiceSocket) return;
  try {
    await helper.appendToLog(
      `🔄 [FORCE RE-ENTER] ${JSON.stringify(data || {})} — vào bàn mới đè bàn cũ`,
      logsNameProgress
    );
    sessionInTableReady = false;
    currentInTable = null;
    pendingPlaceBetSide = null;
    pendingPlaceBetAmount = null;
    await clearActiveTableOnServer();
    if (!page || page.isClosed()) {
      resetMain();
      return;
    }
    await enterTargetTable(gameHallFrame || seamlessFrame || page).catch(async (e) => {
      console.error("[FORCE RE-ENTER ERROR]", e.message);
      resetMain();
    });
  } catch (err) {
    console.error("[FORCE RE-ENTER FATAL]", err.message);
    resetMain();
  }
});

// Chờ bàn target do Bot chỉ định
let requestedTargetTable = null;

socket.on("set_target_table", async (data) => {
  const { tableName } = data;
  if (tableName) requestedTargetTable = String(tableName).trim().toUpperCase();
});

socket.on("request_change_table", async (data) => {
  const targetNs = data?.nameService
    ? String(data.nameService).trim().toUpperCase()
    : null;
  if (targetNs && targetNs !== nameServiceSocket) return;
  const reason = data?.reason || "cầu xấu";
  const fromTable = data?.tableName
    ? String(data.tableName).trim().toUpperCase()
    : currentInTable;
  console.log(
    `[CHANGE TABLE] ${nameServiceSocket} out ${fromTable || "?"} — ${reason}`
  );
  await helper.appendToLog(
    `🔄 [ĐỔI BÀN] Out ${fromTable || "?"} vì ${reason} — chọn bàn cầu đẹp khác`,
    logsNameProgress
  );
  try {
    await goHomeToLobby();
    await enterTargetTable(gameHallFrame || seamlessFrame || page, null).catch(
      (e) => console.error("[CHANGE TABLE ENTER]", e.message)
    );
  } catch (e) {
    console.error("[CHANGE TABLE ERROR]", e.message);
  }
});

let lastRoundCaptureAt = 0;
let lastRoundCaptureWinner = null;
let lastRoundCaptureTable = null;

// Lắng nghe sự kiện xong ván mới từ Server (= API P/B/T cập nhật như FE)
socket.on("new_round_completed", async (data) => {
  const { tableName, latestRound } = data;
  const currentTableUpper = String(tableName).trim().toUpperCase();

  // BỎ QUA HOÀN TOÀN VÀ KHÔNG GHI LOG NẾU KHÔNG PHẢI BÀN DANG Ở (IM LẶNG 100%)
  if (!currentInTable || currentTableUpper !== currentInTable) {
    return;
  }

  const winner = latestRound?.roadFormat || data.resultWinner || null;
  await helper.appendToLog(
    `[SOCKET EVENT] Xong ván ${currentInTable} Round #${latestRound?.id || "N/A"} winner=${winner} → CAP 1 lần`,
    logsNameProgress
  );

  // Đúng 1 capture / ván, gắn resultWinner = P/B/T API
  if (page && !page.isClosed()) {
    try {
      const fatalBefore = await detectFatalUiError().catch(() => null);
      if (fatalBefore === "SESSION_EXPIRED" || fatalBefore === "PAGE_CLOSED") {
        recoverFromFatalUi(fatalBefore).catch((e) => console.error("[RECOVER]", e.message));
        return;
      }
      // Event đã xác nhận xong ván; chờ UI ổn định ngắn rồi chụp.
      // Không evaluate DOM ở đây vì iframe có thể treo vô hạn trên Firefox VPS.
      await helper.delay(1200);

      await captureTableRound(currentInTable, {
        roundNum: latestRound?.id,
        resultWinner: winner,
      });
      lastRoundCaptureAt = Date.now();
      lastRoundCaptureWinner = winner;
      lastRoundCaptureTable = currentInTable;
    } catch (err) {
      console.error("[EVENT CAPTURE ERROR]", err.message);
    }
  }
});

async function runPlaceBetCommand(betSide, betAmount) {
  if (
    !sessionInTableReady ||
    !currentInTable ||
    currentInTable === "NONE" ||
    currentInTable === "LOBBY"
  ) {
    pendingPlaceBetSide = betSide;
    pendingPlaceBetAmount = betAmount;
    console.log(
      `[SOCKET PLACE BET QUEUED] Chưa vào bàn xong — xếp hàng ` +
      `side=${betSide} amount=${betAmount || "env"} (đợi notify bàn)`
    );
    return;
  }
  if (placeBetInFlight) {
    pendingPlaceBetSide = betSide;
    pendingPlaceBetAmount = betAmount;
    console.log(
      `[SOCKET PLACE BET QUEUED] Đang đặt cược — giữ lệnh mới ` +
      `side=${betSide} amount=${betAmount || "env"}`
    );
    return;
  }
  placeBetInFlight = true;
  try {
    await helper.appendToLog(
      `🎰 [SOCKET PLACE BET] Bàn ${currentInTable} → ${
        String(betSide).toUpperCase().startsWith("B")
          ? "CÁI (.zone_bet_banker)"
          : "CON (.zone_bet_player)"
      } + .btn_confirm`,
      logsNameProgress
    );
    await withTimeout(executePlaceBet(betSide, betAmount), 28000, {
      success: false,
      reason: "timeout",
      skipped: true,
    });
  } catch (err) {
    console.error("[PLACE BET ERROR]", err.message);
  } finally {
    placeBetInFlight = false;
    if (pendingPlaceBetSide && sessionInTableReady && currentInTable) {
      const nextSide = pendingPlaceBetSide;
      const nextAmount = pendingPlaceBetAmount;
      pendingPlaceBetSide = null;
      pendingPlaceBetAmount = null;
      await helper.delay(100);
      await runPlaceBetCommand(nextSide, nextAmount);
    }
  }
}

socket.on("place_bet", async (data) => {
  const betSide = (data && (data.betSide || data.side)) || "P";
  const betAmount = Number(data?.betAmount) || null;
  const targetNs = data?.nameService ? String(data.nameService).trim().toUpperCase() : null;
  if (targetNs && targetNs !== nameServiceSocket) return;
  const reqTable = data?.tableName
    ? String(data.tableName).trim().toUpperCase()
    : null;
  if (reqTable && currentInTable && reqTable !== currentInTable) return;
  await runPlaceBetCommand(betSide, betAmount);
});

// Bot không nên force nữa — chỉ cap khi new_round (tránh xóa ảnh đúng winner)
socket.on("force_capture_now", async (data) => {
  if (sessionRecovering || resetInFlight) {
    console.log("[SOCKET FORCE CAPTURE SKIP] đang recover — không chụp overlay lỗi");
    return;
  }
  if (!currentInTable || currentInTable === "NONE" || currentInTable === "LOBBY") {
    console.log("[SOCKET FORCE CAPTURE IGNORED] Chưa ở trong bàn");
    return;
  }
  // Trong 8s sau new_round đã có ảnh đúng winner → bỏ FORCE (tránh cleanup xóa ảnh khớp P/B/T)
  if (
    lastRoundCaptureTable === currentInTable &&
    Date.now() - lastRoundCaptureAt < 8000
  ) {
    console.log(
      `[SOCKET FORCE CAPTURE SKIP] Đã có ảnh new_round winner=${lastRoundCaptureWinner} — không cap lung tung`
    );
    return;
  }

  try {
    await helper.appendToLog(
      `📸 [SOCKET EVENT] FORCE capture ${currentInTable} (fallback, không có winner)`,
      logsNameProgress
    );
    await captureTableRound(currentInTable, {
      roundNum: "FORCE_" + Date.now(),
      resultWinner: (data && data.resultWinner) || lastRoundCaptureWinner || null,
    });
  } catch (err) {
    console.error("[FORCE CAPTURE ERROR]", err.message);
  }
});

async function resetMain() {
  if (resetInFlight) {
    console.log("[RESET] Đang reset — bỏ lệnh trùng (chống nhân bản Chromium)");
    return resetInFlight;
  }
  sessionRecovering = true;
  resetInFlight = (async () => {
    try {
      await clearListeners(page, [
        seamlessFrame,
        gameHallFrame,
        gameCurrentFrame,
      ]);
      // Đóng browser NGAY — không delay 10s trước close (trước đây leak nhiều headless-shell)
      await closeBrowserHard("resetMain");
      isCollecting = false;
      await helper.delay(2000);
      timeSendSessionNearest = helper.getCurrentTime().timeUnix;
      await helper.appendToLog(
        "Khởi động lại chương trình (1 browser)...",
        logsNameProgress
      );
      await main();
    } catch (error) {
      console.error("Error during resetMain:", error.message);
      await closeBrowserHard("resetMain error").catch(() => {});
      isCollecting = false;
      await helper.delay(3000);
      await main().catch(async (err) => {
        await helper.appendToLog(
          `Lỗi khi khởi động lại main: ${err.message}`,
          logsNameProgress
        );
      });
    } finally {
      resetInFlight = null;
      if (pendingResetAfterMain) {
        pendingResetAfterMain = false;
        console.log("[RESET] retry sau main fail trong reset trước");
        setTimeout(() => {
          resetMain().catch((e) => console.error("[RESET RETRY]", e.message));
        }, 2500);
      }
    }
  })();
  return resetInFlight;
}

async function clearListeners(page, frames = []) {
  try {
    if (page) {
      await page.removeAllListeners();
    }
    for (const frame of frames) {
      if (frame && typeof frame.removeAllListeners === "function") {
        await frame.removeAllListeners();
      }
    }
  } catch (error) {
    console.error("Error clearing listeners:", error.message);
  }
}
