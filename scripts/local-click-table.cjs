/**
 * Local Firefox: login + vào Sexy giống session.js, rồi list DOM → click bàn 1→5.
 *
 *   USE_FIREFOX=1 HEADLESS=0 KEEP_OPEN=1 COUNT=5 node scripts/local-click-table.cjs
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { chromium, firefox } = require("playwright");
const {
  listTablesFromFrame,
  clickTableByCode,
  normTableCode,
} = require("../utilities/lobbyTables");

const DOMAIN = process.env.DOMAIN;
const USER = process.env.USERNAME_ACCOUNT || "testbotkeo01";
const PASS = process.env.PASSWORD_ACCOUNT || "123456";
const COUNT = Number(process.env.COUNT || 5);
const KEEP_OPEN = process.env.KEEP_OPEN === "1";
const AUTO_BET = process.env.AUTO_BET !== "0"; // mặc định bật demo đặt cược
const BET_SIDE_ENV = (process.env.BET_SIDE || "").toUpperCase(); // B|P|force
const SERVER_BASE = `${process.env.SERVER_HOSTNAME || "http://127.0.0.1"}:${
  process.env.SERVER_PORT || 3201
}`.replace(/\/$/, "");
const TOOL_API =
  process.env.TOOL_API_BASE || "https://tool.toolbcr79.com";
const AUTH_API =
  process.env.AUTH_API_BASE || "https://api.robotgg88.com";
const TOOL_USER = process.env.TOOL_API_USER || process.env.FE_USERNAME || "";
const TOOL_PASS = process.env.TOOL_API_PASS || process.env.FE_PASSWORD || "";
const useFirefox = process.env.USE_FIREFOX !== "0"; // mặc định firefox cho test này
const headless =
  process.env.HEADLESS === "1" ||
  process.env.HEADLESS === "true" ||
  process.env.HEADLESS === "TRUE";
const LOG = "local-click";

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function log(msg) {
  console.log(msg);
}

/** Giống session.js dismissSitePopups — nhẹ, không spam */
async function dismissSitePopups(page) {
  await page
    .evaluate(() => {
      const sels = [
        ".publicModal .tcg_modal_close",
        ".tcg_modal_close",
        ".close-btn",
      ];
      for (const s of sels) {
        document.querySelectorAll(s).forEach((el) => {
          try {
            el.click();
          } catch (_) {}
        });
      }
    })
    .catch(() => {});
}

async function fillInput(page, classElement, value) {
  const selectors = String(classElement)
    .split(",")
    .map((s) => s.trim());
  for (let retry = 0; retry <= 10; retry++) {
    await dismissSitePopups(page);
    for (const sel of selectors) {
      const inputField = await page.$(sel).catch(() => null);
      if (inputField) {
        await inputField.click({ force: true, clickCount: 3 }).catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await inputField.type(value, { delay: 40 });
        await log(`NHẬP => ${value} (${sel})`);
        return;
      }
    }
    await delay(800);
  }
  await log(`Nhập thất bại [${classElement}]`);
}

async function clickButton(page, classElement, msg = "_", numberClick = 1) {
  for (let retry = 0; retry <= 4; retry++) {
    await dismissSitePopups(page);
    const clickBtn = await page
      .waitForSelector(classElement, { timeout: 2000 })
      .catch(() => null);
    if (clickBtn) {
      await clickBtn
        .click({ clickCount: numberClick, force: true })
        .catch(() => {});
      await log(`CLICK => ${msg}`);
      return true;
    }
    await delay(800);
  }
  await log(`CLICK => ${msg} bỏ qua`);
  return false;
}

async function waitForFrame(parent, selector, timeout = 60000) {
  await parent.waitForSelector(selector, { timeout, state: "attached" });
  await delay(2000);
}

/**
 * Luồng login + vào hall — copy từ session.js (không networkidle, không spam popup)
 */
async function loginAndEnterHall(page) {
  await log(`goto ${DOMAIN}`);
  await page.goto(DOMAIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.bringToFront().catch(() => {});

  await delay(1500);
  for (let i = 0; i < 4; i++) {
    await dismissSitePopups(page);
    await delay(300);
  }

  await clickButton(
    page,
    process.env.CLOSE_DIALOG_WELCOME || ".publicModal .tcg_modal_close",
    "ĐÓNG THÔNG BÁO SỰ KIỆN"
  );
  await dismissSitePopups(page);

  const userExist = await page
    .$(
      ".username_input, input[placeholder*='Tên đăng nhập'], input[name='username'], input[type='text']"
    )
    .catch(() => null);
  if (!userExist) {
    await clickButton(
      page,
      ".submit_btn, button:has-text('Đăng nhập'), .login_btn",
      "HIỂN THỊ DIALOG ĐĂNG NHẬP"
    );
  }

  const userInputSelector =
    ".username_input, input[placeholder*='Tên đăng nhập'], input[placeholder*='tài khoản'], input[name='username'], input[type='text']";
  const passInputSelector =
    ".password_input, input[placeholder*='Mật khẩu'], input[name='password'], input[type='password']";

  await fillInput(page, userInputSelector, USER);
  await fillInput(page, passInputSelector, PASS);

  await clickButton(
    page,
    'button[type="submit"].submit_btn, button.submit_btn, button:has-text("Đăng nhập"), .login_btn',
    "ĐĂNG NHẬP"
  );
  await delay(10000);

  // Xác nhận đã login — nếu fail thì dừng sớm
  let loggedIn = false;
  for (let i = 0; i < 8; i++) {
    loggedIn = await page
      .evaluate(() => {
        const t = (document.body?.innerText || "").toLowerCase();
        if (
          t.includes("đăng xuất") ||
          t.includes("logout") ||
          t.includes("nạp tiền") ||
          t.includes("tài khoản")
        )
          return true;
        if (document.querySelector(".hd_login .user_name, .username, .user-info, .user_balance"))
          return true;
        // form login đã biến mất
        if (!document.querySelector(".username_input, .password_input")) return true;
        return false;
      })
      .catch(() => false);
    if (loggedIn) break;
    await delay(1500);
  }
  if (!loggedIn) {
    await page
      .screenshot({
        path: path.resolve(__dirname, "../local-click-login-fail.png"),
      })
      .catch(() => {});
    throw new Error(
      "Login chưa thành công (không thấy Đăng xuất) — check user/pass hoặc captcha. Shot: local-click-login-fail.png"
    );
  }
  await log("Login OK (thấy trạng thái đã đăng nhập)");

  try {
    if (process.env.SHOW_DIALOG_LOGIN_SUCCESS) {
      await page.waitForSelector(process.env.SHOW_DIALOG_LOGIN_SUCCESS, {
        timeout: 15000,
      });
      await clickButton(
        page,
        process.env.SHOW_DIALOG_LOGIN_SUCCESS,
        "ĐÓNG DIALOG SAU LOGIN"
      );
    } else {
      await clickButton(
        page,
        ".publicModal .tcg_modal_close, .tcg_modal_close",
        "ĐÓNG DIALOG SAU LOGIN"
      );
    }
  } catch (_) {
    await log("Không có dialog success — tiếp tục");
  }

  await dismissSitePopups(page);
  await delay(2000);

  // Giống session.js: LIVE menu → Chơi ngay
  let liveOk = await clickButton(
    page,
    "div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1",
    "VÀO MENU GAME SEXY"
  );
  if (!liveOk) {
    liveOk = await clickButton(
      page,
      "div.nav_item_btn.LIVE, div.nav_item_btn.LIVE div.name1",
      "VÀO MENU LIVE (fallback)"
    );
  }
  if (!liveOk) {
    await page.locator("div.nav_item_btn.LIVE").first().click({ force: true }).catch(() => {});
    await log("CLICK => LIVE locator fallback");
  }
  await delay(2000);
  await dismissSitePopups(page);

  // Thử SEXY trong dropdown nếu có
  await page
    .locator("span.game_name")
    .filter({ hasText: /^SEXY/i })
    .first()
    .click({ force: true })
    .catch(() => {});
  await delay(1500);

  let clickedPlay = false;
  const playBtnSelectors = [
    ".play-btn",
    "div.play-btn",
    "button:has-text('Chơi ngay')",
    "a[href*='seamless']",
  ];
  for (let round = 0; round < 4; round++) {
    for (const sel of playBtnSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click({ force: true }).catch(() => {});
        clickedPlay = true;
        await log(`VÀO SẢNH SEXY (${sel}) round=${round + 1}`);
        break;
      }
    }
    if (!clickedPlay) {
      const byText = page.getByText(/^Chơi ngay$/i).first();
      if (await byText.isVisible().catch(() => false)) {
        await byText.click({ force: true }).catch(() => {});
        clickedPlay = true;
        await log(`VÀO SẢNH SEXY (text) round=${round + 1}`);
      }
    }
    if (clickedPlay) {
      await delay(8000);
      const src = await page
        .evaluate(() => document.querySelector("#seamless-game")?.src || "")
        .catch(() => "");
      if (src && src.length > 20 && !/about:blank/i.test(src)) {
        await log(`[SEAMLESS] src ok len=${src.length}`);
        break;
      }
      await log(`[SEAMLESS] src chưa sẵn (len=${(src || "").length}) — chờ thêm`);
    }
    await delay(2000);
  }

  if (!clickedPlay) {
    const base = String(DOMAIN || "").replace(/\/$/, "");
    const pathSexy =
      process.env.ROUTER_URL_BACARAT_SEXY || "/seamless?gameType=LIVE";
    const sexyUrl = `${base}${pathSexy.startsWith("/") ? pathSexy : `/${pathSexy}`}`;
    await log(`DIRECT GOTO fallback ${sexyUrl}`);
    await page
      .goto(sexyUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(() => {});
    await delay(5000);
  }

  await waitForFrame(page, "iframe#seamless-game", 90000);
  let seamlessEl = await page.$("iframe#seamless-game");
  let seamless = await seamlessEl.contentFrame();
  await log(`[SEAMLESS] url=${seamless?.url?.() || "?"}`);

  // Hall thường bị chặn bởi popup "trình duyệt hỗ trợ" — đóng rồi poll
  let hall = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !hall) {
    await dismissBrowserWarn(page, seamless, null);
    await dismissSitePopups(page);

    // rebind seamless (có thể reload)
    seamlessEl = await page.$("iframe#seamless-game").catch(() => null);
    seamless = seamlessEl ? await seamlessEl.contentFrame() : null;

    let hallEl = seamless
      ? await seamless.$("iframe#iframeGameHall").catch(() => null)
      : null;
    if (!hallEl) {
      // fallback: tìm trong mọi frame theo name/url
      for (const f of page.frames()) {
        const u = f.url() || "";
        const n = f.name() || "";
        if (/iframeGameHall|gamehall|GameHall/i.test(u + n)) {
          hall = f;
          break;
        }
        const nested = await f
          .$("iframe#iframeGameHall")
          .catch(() => null);
        if (nested) {
          hall = await nested.contentFrame();
          if (hall) break;
        }
      }
    } else {
      hall = await hallEl.contentFrame();
    }

    if (hall) break;
    await delay(1500);
  }

  if (!hall) {
    const urls = page.frames().map((f) => f.url()).filter(Boolean);
    await log(`[HALL] FAIL frames:\n${urls.map((u) => "  " + u).join("\n")}`);
    throw new Error("Không thấy iframe#iframeGameHall sau seamless");
  }

  await delay(3000);
  await dismissBrowserWarn(page, seamless, hall);
  await dismissSitePopups(page);

  const sniff = await hall
    .evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 180)
    )
    .catch(() => "");
  await log(`[HALL] sniff: ${sniff || "(empty)"}`);
  return { seamless, hall };
}

async function dismissBrowserWarn(page, seamless, hall) {
  for (const f of [page, seamless, hall].filter(Boolean)) {
    await f
      .evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll("button, div, span, a")
        );
        const confirm = btns.find((el) =>
          /^Xác nhận$/i.test((el.innerText || "").trim())
        );
        if (confirm) confirm.click();
      })
      .catch(() => {});
  }
}

async function returnToLobby(page, seamless, hall) {
  await log("[LOBBY] goHome...");
  for (const f of [page, seamless, hall, ...page.frames()].filter(Boolean)) {
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
  await delay(4000);
}

async function rebindHall(page) {
  const seamlessEl = await page.$("iframe#seamless-game").catch(() => null);
  const seamless = seamlessEl ? await seamlessEl.contentFrame() : null;
  let hall = null;
  if (seamless) {
    const hallEl = await seamless.$("iframe#iframeGameHall").catch(() => null);
    hall = hallEl ? await hallEl.contentFrame() : seamless;
  }
  return { seamless, hall: hall || seamless };
}

/** Sau khi click: sniff mọi frame xem có mã bàn / đã rời lobby */
async function verifyInRoom(page, target) {
  const want = normTableCode(target);
  const hit = await page
    .evaluate((w) => {
      const frames = [document, ...Array.from(window.frames || [])];
      // chỉ document chính — Playwright sẽ scan frames riêng
      const body = (document.body && document.body.innerText) || "";
      const hasCode = new RegExp(`\\b${w}\\b`, "i").test(body);
      const leftLobby = !document.querySelector(
        ".vue-recycle-scroller__item-view"
      );
      return { hasCode, leftLobby, sniff: body.replace(/\s+/g, " ").slice(0, 120) };
    }, want)
    .catch(() => ({ hasCode: false, leftLobby: false, sniff: "" }));

  let frameHit = false;
  let frameSniff = "";
  for (const f of page.frames()) {
    const info = await f
      .evaluate((w) => {
        const body = (document.body && document.body.innerText) || "";
        return {
          hasCode: new RegExp(`\\b${w}\\b`, "i").test(body),
          hasGoHome: !!(
            document.querySelector("button#goHome2") ||
            document.querySelector("button#goHome") ||
            document.querySelector(".goHome")
          ),
          sniff: body.replace(/\s+/g, " ").slice(0, 100),
        };
      }, want)
      .catch(() => null);
    if (!info) continue;
    if (info.hasCode || info.hasGoHome) {
      frameHit = true;
      frameSniff = info.sniff;
      if (info.hasCode) break;
    }
  }
  return {
    inRoom: frameHit || hit.leftLobby,
    codeVisible: hit.hasCode || frameHit,
    sniff: frameSniff || hit.sniff,
  };
}

async function clickInAllFrames(page, selector) {
  for (const f of [page, ...page.frames()]) {
    const ok = await f
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      }, selector)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function closeNotification(page) {
  for (let i = 0; i < 5; i++) {
    const ok = await clickInAllFrames(page, ".notification_closeBtn");
    if (ok) {
      await log("[NOTIF] Đã click .notification_closeBtn");
      await delay(500);
      return true;
    }
    await delay(400);
  }
  await log("[NOTIF] không thấy .notification_closeBtn — bỏ qua");
  return false;
}

/** Side hô từ API: percentCurrent.Round = B|P (cùng bot.py) */
async function fetchRoundSide(tableName) {
  if (BET_SIDE_ENV === "B" || BET_SIDE_ENV === "P") {
    await log(`[API HÔ] BET_SIDE env → ${BET_SIDE_ENV}`);
    return BET_SIDE_ENV;
  }
  // 1) local server (nếu đang chạy)
  try {
    const url = `${SERVER_BASE}/predict/get-table-by-name?tableName=${encodeURIComponent(
      tableName
    )}`;
    const headers = {};
    if (process.env.API_KEY) headers["x-api-key"] = process.env.API_KEY;
    const res = await fetch(url, { headers }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      const round = data?.percentCurrent?.Round || data?.percentCurrent?.round;
      const side = String(round || "").toUpperCase().startsWith("B")
        ? "B"
        : String(round || "").toUpperCase().startsWith("P")
          ? "P"
          : null;
      if (side) {
        await log(`[API HÔ] local ${tableName} Round=${side}`);
        return side;
      }
    }
  } catch (_) {}

  // 2) tool.toolbcr79.com + JWT FE
  if (TOOL_USER && TOOL_PASS) {
    try {
      const loginRes = await fetch(`${AUTH_API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: TOOL_USER, password: TOOL_PASS }),
      });
      const login = await loginRes.json();
      const token = login.access_token;
      if (token) {
        const res = await fetch(
          `${TOOL_API}/predict/get-table-by-name?tableName=${encodeURIComponent(
            tableName
          )}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.ok) {
          const data = await res.json();
          const round =
            data?.percentCurrent?.Round || data?.percentCurrent?.round;
          const side = String(round || "").toUpperCase().startsWith("B")
            ? "B"
            : String(round || "").toUpperCase().startsWith("P")
              ? "P"
              : null;
          if (side) {
            await log(
              `[API HÔ] tool ${tableName} Round=${side} (percentCurrent.Round)`
            );
            return side;
          }
        }
      }
    } catch (e) {
      await log(`[API HÔ] tool fail: ${e.message}`);
    }
  }

  await log("[API HÔ] không lấy được Round — mặc định P");
  return "P";
}

/**
 * Đặt 1 cửa: tắt notif → zone_bet_banker|player → btn_confirm
 * (giống session.js executePlaceBet / bot place-bet)
 */
async function autoPlaceBet(page, tableName) {
  await closeNotification(page);
  await delay(1000);

  const side = await fetchRoundSide(tableName);
  const zoneSel =
    side === "B" ? ".zone_bet_banker" : ".zone_bet_player";
  await log(
    `[AUTOBET] ${tableName} → ${side === "B" ? "CÁI" : "CON"} (${zoneSel}) rồi .btn_confirm`
  );

  // chờ cửa cược
  let zoneOk = false;
  for (let i = 0; i < 40; i++) {
    zoneOk = await clickInAllFrames(page, zoneSel);
    if (zoneOk) break;
    await delay(500);
  }
  if (!zoneOk) {
    await log(`[AUTOBET SKIP] không click được ${zoneSel}`);
    return { ok: false, side, reason: "zone" };
  }
  await log(`[AUTOBET] clicked ${zoneSel}`);
  await delay(400);

  let confOk = false;
  for (let i = 0; i < 20; i++) {
    confOk = await clickInAllFrames(page, ".btn_confirm");
    if (confOk) break;
    await delay(300);
  }
  if (!confOk) {
    await log("[AUTOBET SKIP] không click được .btn_confirm");
    return { ok: false, side, reason: "confirm" };
  }
  await log(`[AUTOBET OK] ${tableName} side=${side}`);
  await page
    .screenshot({
      path: path.resolve(__dirname, `../local-click-bet-${tableName}.png`),
    })
    .catch(() => {});
  return { ok: true, side };
}

async function clickOneTable(page, seamless, hall, target, shotIdx) {
  let result = { ok: false };
  for (let attempt = 1; attempt <= 8; attempt++) {
    await log(`  [CLICK] ${target} lần ${attempt}/8`);
    await hall
      .evaluate((want) => {
        const w = String(want || "").toUpperCase();
        const cards = document.querySelectorAll(
          ".vue-recycle-scroller__item-view, .table-item, div.relative.cursor-pointer"
        );
        for (const card of cards) {
          if ((card.innerText || "").toUpperCase().includes(w)) {
            card.scrollIntoView({ block: "center" });
            return true;
          }
        }
        const sc =
          document.querySelector(".vue-recycle-scroller") ||
          document.scrollingElement;
        if (sc) sc.scrollTop += 350;
        return false;
      }, target)
      .catch(() => {});
    result = await clickTableByCode(hall, target, { allowFallback: false });
    await log(`  [CLICK] ${JSON.stringify(result)}`);
    if (result.ok && result.table === target) break;
    await delay(800);
  }
  if (!result.ok) return { ok: false, wanted: target, got: null, inRoom: false };

  for (let i = 0; i < 4; i++) {
    await dismissBrowserWarn(page, seamless, hall);
    await delay(1000);
  }
  await delay(3000);

  const check = await verifyInRoom(page, target);
  const shot = path.resolve(
    __dirname,
    `../local-click-${shotIdx}-${target}.png`
  );
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  await log(
    `  [CHECK] wanted=${target} clicked=${result.table} inRoom=${check.inRoom} codeVisible=${check.codeVisible}`
  );
  await log(`  [CHECK] sniff=${check.sniff || "(empty)"} shot=${shot}`);

  const ok =
    result.table === target && (check.inRoom || check.codeVisible || result.ok);
  return {
    ok,
    wanted: target,
    got: result.table,
    via: result.via,
    inRoom: check.inRoom,
    codeVisible: check.codeVisible,
    shot,
  };
}

async function main() {
  if (!DOMAIN) {
    console.error("Missing DOMAIN");
    process.exit(1);
  }

  const launcher = useFirefox ? firefox : chromium;
  const launchOpts = { headless, ignoreHTTPSErrors: true };
  if (useFirefox) {
    launchOpts.firefoxUserPrefs = {
      "media.autoplay.default": 0,
      "dom.webnotifications.enabled": false,
    };
  } else if (process.env.USE_REAL_CHROME === "1") {
    launchOpts.channel = "chrome";
    launchOpts.args = ["--start-maximized"];
  }

  console.log(
    `[BROWSER] engine=${useFirefox ? "firefox" : "chromium"} user=${USER} COUNT=${COUNT}`
  );
  const browser = await launcher.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "vi-VN",
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    let { seamless, hall } = await loginAndEnterHall(page);

    console.log("[HALL] Đọc list bàn từ DOM sảnh...");
    await page
      .screenshot({
        path: path.resolve(__dirname, "../local-click-hall.png"),
        fullPage: false,
      })
      .catch(() => {});
    const tables = await listTablesFromFrame(hall, { scrolls: 8 });
    const codes = tables.map((t) => t.code);
    console.log(`[HALL] Tổng ${codes.length} bàn:`);
    tables.slice(0, 30).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.code}  |  ${t.text}`);
    });
    if (!codes.length) {
      console.error("[HALL] Không đọc được bàn nào từ DOM");
      process.exit(2);
    }

    const prefer = process.env.TABLE
      ? normTableCode(process.env.TABLE)
      : null;
    let targets;
    if (prefer) {
      if (!codes.includes(prefer)) {
        console.error(`[HALL] TABLE=${prefer} không có trong list: ${codes.join(",")}`);
        process.exit(3);
      }
      targets = [prefer];
    } else {
      targets = codes.slice(0, Math.min(COUNT, codes.length));
    }
    console.log(
      "\n========== CLICK ĐÚNG MÃ ==========\n",
      targets.map((c, i) => `${i + 1}.${c}`).join(" → "),
      "\n"
    );

    const report = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      console.log(`\n--- #${i + 1} list→click ${target} ---`);
      ({ seamless, hall } = await rebindHall(page));
      // Re-list nhanh trước click để confirm mã còn trong DOM
      const nowList = await listTablesFromFrame(hall, { scrolls: 3 });
      const nowCodes = nowList.map((t) => t.code);
      console.log(
        `  [LIST] còn thấy ${target}? ${nowCodes.includes(target) ? "YES" : "NO"} (total ${nowCodes.length})`
      );
      await hall
        .evaluate(() => {
          const sc =
            document.querySelector(".vue-recycle-scroller") ||
            document.scrollingElement;
          if (sc) sc.scrollTop = 0;
        })
        .catch(() => {});
      await delay(800);

      const row = await clickOneTable(page, seamless, hall, target, i + 1);
      if (row.ok && AUTO_BET) {
        console.log(`\n--- AUTOBET ${target} (theo API hô Round B/P) ---`);
        const bet = await autoPlaceBet(page, target);
        row.bet = bet;
        console.log(`[AUTOBET RESULT] ${JSON.stringify(bet)}`);
      }
      report.push({ n: i + 1, ...row });

      if (i < targets.length - 1) {
        await returnToLobby(page, seamless, hall);
        await delay(2500);
        ({ seamless, hall } = await rebindHall(page));
      }
    }

    console.log("\n========== KẾT QUẢ ==========");
    for (const r of report) {
      const betInfo = r.bet
        ? ` bet=${r.bet.ok ? "OK" : "FAIL"}(${r.bet.side || "?"})`
        : "";
      console.log(
        `#${r.n} wanted=${r.wanted} got=${r.got || "?"} inRoom=${r.inRoom}${betInfo} => ${r.ok ? "OK" : "FAIL"}`
      );
    }
    const pass = report.filter((r) => r.ok).length;
    console.log(`Pass ${pass}/${report.length}\n`);

    if (KEEP_OPEN) {
      console.log("[KEEP_OPEN] Ctrl+C thoát");
      await new Promise(() => {});
    } else await browser.close();
    process.exit(pass === report.length ? 0 : 4);
  } catch (e) {
    console.error("[ERROR]", e.message);
    try {
      await browser.close();
    } catch (_) {}
    process.exit(1);
  }
}

main();
