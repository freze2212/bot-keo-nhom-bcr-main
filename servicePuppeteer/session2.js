const { firefox } = require("playwright");
const path = require("path");
// Load .env với path tuyệt đối để đảm bảo tìm được file
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const io = require("socket.io-client");
const fs = require("fs").promises;

const { request, imageCapcha, helper, screenshotHelper } = require("../utilities");
const axios = require("axios");
const { account_2: account } = require("./account.puppeteer");

let isCollecting = false;
let socket;
let browser;
let context;
let page;
let seamlessFrame;
let gameHallFrame;
let gameCurrentFrame;
let timeSendSessionDelay = Number(account.timeSendSessionDelay);
let timeSendSessionNearest = helper.getCurrentTime().timeUnix;
const username_game = account.username_game;
const password_game = account.password_game;
const nameServiceSocket = account.nameServiceSocket;
const logsNameProgress = account.logsNameProgress;

// Khởi tạo socket
socket = io(`${process.env.SERVER_HOSTNAME}:${process.env.SERVER_PORT}`);
socket.on("connect", () => console.log("(SOCKET) Connecting (NS2)"));
socket.on("disconnect", () => console.log("(SOCKET) Disconnected (NS2)"));

main();

async function main() {
  try {
    browser = await firefox.launch({
      headless: false,
      args: ["--start-maximized"],
      firefoxUserPrefs: {
        "media.peerconnection.enabled": true,
        "dom.webdriver.enabled": false,
        "privacy.trackingprotection.enabled": false,
      },
      ignoreHTTPSErrors: true,
    });

    // Tạo persistent context với viewport null để tràn 100% màn hình
    context = await browser.newContext({
      userDataDir: "./servicePuppeteer/dataDir/" + account.userDataDir,
      viewport: null,
    });

    // Tạo page từ context
    page = await context.newPage();

    // Tự động kéo to hết cỡ cửa sổ màn hình Firefox
    await page.evaluate(() => {
      window.moveTo(0, 0);
      window.resizeTo(screen.availWidth, screen.availHeight);
    }).catch(() => {});

    // Xử lý các dialog
    page.on("dialog", async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });

    // Log start
    await helper.appendToLog(
      "BẮT ĐẦU CHƯƠNG TRÌNH FIREFOX (NS2) - GHI LOGS",
      logsNameProgress
    );
    await helper.appendToLog("=".repeat(50), logsNameProgress);

    page.on("error", async (err) => {
      await helper.appendToLog(`Page error (NS2): ${err.message}`, logsNameProgress);
    });

    page.on("pageerror", async (err) => {
      await helper.appendToLog(
        `Page uncaught exception (NS2): ${err.message}`,
        logsNameProgress
      );
    });

    // Hàm thu thập response
    function startCollectingResponses(page, frames = []) {
      isCollecting = true;
      console.log("[DEBUG NS2] Starting to collect responses...");

      const handleResponse = async (response) => {
        const resSession = await request.CollectingResponseSessionV2(
          response,
          isCollecting
        );
        const timeUnixCurrent = helper.getCurrentTime().timeUnix;

        if (
          typeof resSession === "string" &&
          /^[a-zA-Z0-9]+$/.test(resSession) &&
          timeUnixCurrent > timeSendSessionNearest + timeSendSessionDelay
        ) {
          timeSendSessionNearest = timeUnixCurrent;
          console.log(`[DEBUG NS2] Sending session: ${resSession}`);
          sendSessionData(resSession, nameServiceSocket);
        }
      };

      page.on("response", handleResponse);
      frames.forEach((frame) => {
        if (frame && typeof frame.on === "function") {
          console.log("[DEBUG NS2] Adding response listener to frame");
          frame.on("response", handleResponse);
        }
      });

      console.log("[DEBUG NS2] Response listeners added to page and frames");
    }

    // Kiểm tra DOMAIN trước khi goto
    const DOMAIN = process.env.DOMAIN;
    if (!DOMAIN || typeof DOMAIN !== "string" || DOMAIN.trim() === "") {
      const errorMsg = `ENV DOMAIN không hợp lệ. Giá trị: ${JSON.stringify(DOMAIN)}`;
      await helper.appendToLog(errorMsg, logsNameProgress);
      throw new Error(errorMsg);
    }

    await helper.appendToLog(`Đang truy cập (NS2): ${DOMAIN}`, logsNameProgress);

    // Truy cập trang nhanh với domcontentloaded
    await page.goto(DOMAIN, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("Trang web NS2 đã được load xong");
    await helper.delay(2000);

    // login
    await clickButtonNotifiGame(
      logsNameProgress,
      page,
      process.env.CLOSE_DIALOG_WELCOME || ".publicModal .tcg_modal_close",
      "ĐÓNG THÔNG BÁO SỰ KIỆN"
    );

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

    const captchaInput = await page.$(".captcha_input, div.captcha_box img").catch(() => null);
    if (captchaInput) {
      await helper.appendToLog("Phát hiện ô nhập Captcha (NS2), bắt đầu giải mã...", logsNameProgress);
      try {
        const codeCapcha = await imageCapcha.getCodeCapchaLogin(logsNameProgress, page);
        await fillInput(
          logsNameProgress,
          page,
          process.env.INPUT_CAPCHA_LOGIN || ".captcha_input",
          codeCapcha
        );
      } catch (captchaErr) {
        await helper.appendToLog(`Lỗi xử lý captcha (NS2): ${captchaErr.message}`, logsNameProgress);
      }
    }

    await clickButton(
      logsNameProgress,
      page,
      'button[type="submit"].submit_btn, button.submit_btn, button:has-text("Đăng nhập"), .login_btn',
      "ĐĂNG NHẬP"
    );
    await helper.delay(8000);

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
        "❌ ĐĂNG NHẬP THẤT BẠI (NS2): Trang xuất hiện thông báo 'Vui lòng đăng nhập vào tài khoản trước'. Khởi động lại luồng login...",
        logsNameProgress
      );
      return resetMain();
    }

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

    await closeAllModals(page);

    await helper.delay(2000);
    await clickButton(
      logsNameProgress,
      page,
      "div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1",
      "VÀO MENU GAME SEXY"
    );

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle",
        timeout: 60000,
      });
    } catch (error) {
      await helper.appendToLog(
        "Navigation timeout, tiếp tục...",
        logsNameProgress
      );
    }

    await helper.delay(2000);

    await scrollDownSlowly(
      logsNameProgress,
      page,
      1500,
      "CUỘN XUỐNG - TÌM NÚT BUTTON VÀO GAME"
    );
    await helper.delay(1000);

    const playBtnSelectors = [
      ".play-btn",
      "div.play-btn",
      "button:has-text('Chơi ngay')",
      "div:has-text('Chơi ngay')",
      "div[class*='play']",
      "a[href*='seamless']"
    ];

    let clickedPlay = false;
    for (const sel of playBtnSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click().catch(() => {});
        clickedPlay = true;
        await helper.appendToLog(`✅ [VÀO SẢNH SEXY NS2] Đã click nút vào sảnh Sexy (${sel})`, logsNameProgress);
        break;
      }
    }

    if (!clickedPlay) {
      await helper.appendToLog("🔄 [DIRECT GOTO NS2] Chuyển thẳng URL tới sảnh Sexy Baccarat: https://www.rr3199.com/seamless?gameType=LIVE", logsNameProgress);
      await page.goto("https://www.rr3199.com/seamless?gameType=LIVE", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
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
      await helper.appendToLog("✅ [THAO TÁC CỦA BẠN NS2] Đã click icon SVG (X: 1230, Y: 184) theo yêu cầu!", logsNameProgress);
    } catch (e) {}

    await waitForFrame(page, "iframe#seamless-game", 30000);
    const seamlessFrameElement = await page.$("iframe#seamless-game");
    seamlessFrame = await seamlessFrameElement.contentFrame();

    await waitForFrame(seamlessFrame, "iframe#iframeGameHall", 30000);
    let gameHallFrameElement = await seamlessFrame.$("iframe#iframeGameHall");
    gameHallFrame = await gameHallFrameElement.contentFrame();

    await helper.delay(3000);

    // VÀO NGAY 1 BÀN BACCARAT BẤM THỦ CÔNG / TỰ ĐỘNG
    await helper.appendToLog("🎰 [AUTO ENTER TABLE NS2] Tiến hành chọn và vào ngay 1 bàn cược trong sảnh...", logsNameProgress);
    await enterTargetTable(gameHallFrame).catch(() => {});
    await helper.delay(3000);

    console.log(`\n===============================================================`);
    console.log(`✅ [BÀN CƯỢC NS2 ${currentInTable || 'TARGET'}] ĐÃ VÀO THẲNG BÀN CƯỢC ${currentInTable || 'TARGET'}!`);
    console.log(`===============================================================\n`);
  } catch (error) {
    await helper.appendToLog(
      `Error in main function (NS2): ${error.message}`,
      logsNameProgress
    );
    await resetMain();
  }
}

async function waitForFrame(parentFrame, selector, timeout = 60000) {
  try {
    await parentFrame.waitForSelector(selector, { timeout, state: "attached" });
    await helper.delay(2000);
  } catch (error) {
    throw new Error(`Không thể tìm thấy frame: ${selector} - ${error.message}`);
  }
}

async function fillInput(logsNameProgress, page, classElement, value) {
  let retryCount = 0;
  const selectors = String(classElement).split(',').map(s => s.trim());

  while (retryCount <= 10) {
    for (const sel of selectors) {
      try {
        const inputField = await page.$(sel).catch(() => null);
        if (inputField) {
          await inputField.click({ clickCount: 3 }).catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await inputField.type(value, { delay: 50 });
          await helper.appendToLog(
            `NHẬP => ${value} THÀNH CÔNG (${sel})`,
            logsNameProgress
          );
          return;
        }
      } catch (error) {}
    }

    retryCount++;
    await helper.delay(1000);
  }

  await helper.appendToLog(
    `Nhập thất bại selector [${classElement}] - tiếp tục luồng`,
    logsNameProgress
  );
}

async function clickButton(logsNameProgress, page, classElement, msg = "_", numberClick = 1, isFatal = false) {
  let retryCount = 0;
  const action = numberClick > 1 ? "DOUBLE CLICK" : "CLICK";
  while (retryCount <= 4) {
    try {
      const clickBtn = await page.waitForSelector(classElement, { timeout: 2000 }).catch(() => null);
      if (clickBtn) {
        await clickBtn.scrollIntoViewIfNeeded().catch(() => {});
        await clickBtn.click({ clickCount: numberClick });
        await helper.appendToLog(
          `${action} => ${msg} THÀNH CÔNG`,
          logsNameProgress
        );
        return true;
      }
    } catch (error) {}

    retryCount++;
    await helper.delay(1000);
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

async function scrollDownSlowly(logsNameProgress, frame, duration = 2000, msg = "SCROLL DOWN") {
  await helper.appendToLog(`CUỘN => ${msg}`, logsNameProgress);
  await frame.evaluate((duration) => {
    const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
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

async function clickButtonNotifiGame(logsNameProgress, page, classElement, msg = "_", numberClick = 1) {
  const action = numberClick > 1 ? "DOUBLE CLICK" : "CLICK";
  try {
    const clickBtn = await page.waitForSelector(classElement, { timeout: 1500 }).catch(() => null);
    if (clickBtn) {
      await clickBtn.click({ clickCount: numberClick });
      await helper.appendToLog(`${action} => ${msg} THÀNH CÔNG`, logsNameProgress);
    }
  } catch (error) {}
}

let currentInTable = null;

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
    await helper.appendToLog("🧹 [DOM CLEANUP IN TABLE NS2] Đã tự động xóa sạch các popup/lỗi khỏi màn hình trước khi chụp ảnh!", logsNameProgress);
  } catch (err) {}
}

async function enterTargetTable(gameHallFrame, tableName) {
  try {
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
      await helper.appendToLog("✅ [THAO TÁC CỦA BẠN NS2] Đã click vị trí màn hình game (X: 720, Y: 403 / #loadingFrameWithDirectPoker)!", logsNameProgress);
    } catch (e) {}

    if (!gameHallFrame && seamlessFrame) {
      const gameHallElement = await seamlessFrame.$("iframe#iframeGameHall").catch(() => null);
      if (gameHallElement) gameHallFrame = await gameHallElement.contentFrame().catch(() => null);
    }

    if (gameHallFrame) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const tableClicked = await gameHallFrame.evaluate(() => {
          const tableCards = Array.from(document.querySelectorAll(
            ".vue-recycle-scroller__item-view, .table-item, div[class*='table'], div.relative.cursor-pointer, [class*='card']"
          ));

          if (tableCards.length > 0) {
            const card = tableCards[Math.floor(Math.random() * Math.min(tableCards.length, 6))];
            card.scrollIntoView({ block: 'center' });
            const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            card.dispatchEvent(clickEvt);
            if (card.click) card.click();
            return true;
          }

          const allElems = Array.from(document.querySelectorAll("div, span, button, a"));
          const baccaratElem = allElems.find((el) => {
            const txt = (el.innerText || el.textContent || "").trim().toUpperCase();
            return (txt.includes("BACCARAT C") || txt.includes("BACCARAT 0") || txt.includes("BACCARAT 1") || txt.includes("BTCB") || txt.includes("BACCARAT")) && txt.length < 50;
          });

          if (baccaratElem) {
            baccaratElem.scrollIntoView({ block: 'center' });
            const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            baccaratElem.dispatchEvent(clickEvt);
            if (baccaratElem.click) baccaratElem.click();
            return true;
          }
          return false;
        }).catch(() => false);

        if (tableClicked) {
          clickedSuccess = true;
          await helper.appendToLog(`✅ [CLICK TABLE SUCCESS NS2] Đã tự động click tiến vào bàn Baccarat khả dụng (lần ${attempt + 1})!`, logsNameProgress);
          break;
        }
        await helper.delay(1000);
      }
    }

    if (!clickedSuccess && gameHallFrame) {
      const fallbackSelectors = [
        "div.relative.cursor-pointer",
        ".vue-recycle-scroller__item-view",
        ".table-item",
        "div[class*='table']",
        "div:has-text('Baccarat')"
      ];
      for (const sel of fallbackSelectors) {
        const el = await gameHallFrame.$(sel).catch(() => null);
        if (el) {
          await el.click({ clickCount: 2 }).catch(() => {});
          clickedSuccess = true;
          break;
        }
      }
    }

    await helper.delay(3500);

    if (page && !page.isClosed()) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await helper.appendToLog("📜 [SCROLL TO BOTTOM NS2] Đã cuộn xuống cuối trang để ẩn Header tự nhiên!", logsNameProgress);
    }

    const inTableFrame = gameCurrentFrame || gameHallFrame || page;
    await closeInTableModals(inTableFrame);

    const actualDetectedTable = await detectCurrentTableInRoom();
    const finalTable = actualDetectedTable || cleanUpper;

    currentInTable = finalTable;

    try {
      const serverPort = process.env.SERVER_PORT || 3201;
      await axios.post(`http://localhost:${serverPort}/api/notify-active-table`, {
        tableName: finalTable,
        nameService: nameServiceSocket
      });
      await helper.appendToLog(`✅ [API NOTIFY SUCCESS NS2] Đã gửi mã bàn ${finalTable} sang Server & Telegram Bot!`, logsNameProgress);
    } catch (e) {
      await helper.appendToLog(`⚠️ [API NOTIFY ERROR NS2] ${e.message}`, logsNameProgress);
    }

    return { success: true, tableName: finalTable };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

async function detectCurrentTableInRoom() {
  try {
    const framesToCheck = [
      page.frame({ name: "iframeGameTable" }),
      page.frame({ name: "iframeGame" }),
      gameCurrentFrame,
      seamlessFrame,
      page
    ].filter(Boolean);

    for (const frame of framesToCheck) {
      if (!frame || (typeof frame.isClosed === "function" && frame.isClosed())) continue;

      const detected = await frame.evaluate(() => {
        const titleElems = Array.from(document.querySelectorAll(".table-name, .room-title, .game-title, .header-title, [class*='tableName'], [class*='table-info'], div, span"));
        for (const el of titleElems) {
          const txt = (el.innerText || el.textContent || "").trim();
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
      }).catch(() => null);

      if (detected) {
        return detected.startsWith("C") ? detected : `C${detected.padStart(2, "0")}`;
      }
    }
  } catch (err) {}
  return null;
}

async function closeAllModals(page) {
  if (!page || page.isClosed()) return;
  try {
    const handleCloseFn = () => {
      const closeSelectors = [
        ".publicModal .tcg_modal_close",
        ".tcg_modal_close",
        ".sign-in-rules .close-btn",
        ".tcg_modal_close_btn",
        "button.size-8.cursor-pointer.outline-none",
        "div[class*='notify'] [class*='close']",
        "div[class*='message'] [class*='close']",
        "i.van-icon-cross",
        ".van-dialog__confirm",
        ".van-button--default",
        ".close-btn",
        "[class*='close-btn']",
        "[class*='modal_close']",
        "[class*='featured'] [class*='close']",
        "[class*='Featured'] [class*='close']"
      ];
      closeSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          try {
            if (typeof el.click === "function") el.click();
          } catch (e) {}
        });
      });

      const confirmBtns = Array.from(document.querySelectorAll("button, div, span, a"));
      confirmBtns.forEach((el) => {
        const text = (el.innerText || "").trim();
        if (text === "Xác nhận" || text === "Đồng ý" || text === "Đóng" || text === "Xác Nhận") {
          try { el.click(); } catch(e) {}
        }
      });

      const overlaySelectors = [
        ".publicModal",
        ".van-popup",
        ".van-overlay",
        ".modal-mask",
        ".van-dialog",
        "div[class*='modal']",
        "div[class*='popup']",
        "div[class*='dialog']",
        "div[class*='overlay']",
        "div[class*='notify']",
        "div[class*='toast']",
        "div[class*='featured']",
        "div[class*='Featured']"
      ];
      overlaySelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.tagName !== "CANVAS" && !el.querySelector("canvas") && !el.id?.includes("seamless")) {
            try {
              el.style.display = "none";
              el.style.visibility = "hidden";
              el.style.opacity = "0";
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
  } catch (err) {}
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
            "button#goHome2, button#goHome, .goHome, [class*='goHome'], [class*='back-hall'], [class*='leave-table']"
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
  } catch (err) {}
  return false;
}

let isCapturingScreenshot = false;
let captureLockTimeout = null;

async function captureTableRound(tableName, roundOptions = {}) {
  if (isCapturingScreenshot) {
    console.log(`[SCREENSHOT NS2] Đã có tiến trình chụp khác cho bàn ${tableName}, bỏ qua`);
    return;
  }
  isCapturingScreenshot = true;
  if (captureLockTimeout) clearTimeout(captureLockTimeout);
  captureLockTimeout = setTimeout(() => { isCapturingScreenshot = false; }, 15000);

  try {
    const cleanTarget = String(tableName).trim().toUpperCase();

    let inTableVerified = await verifyInTable(cleanTarget);
    if (!inTableVerified && gameHallFrame) {
      await enterTargetTable(gameHallFrame, cleanTarget).catch(() => {});
      
      let attempts = 0;
      while (attempts < 8) {
        await helper.delay(1000);
        inTableVerified = await verifyInTable(cleanTarget);
        if (inTableVerified) break;
        attempts++;
      }
    }

    if (!currentInTable || currentInTable === "NONE" || currentInTable === "LOBBY") {
      console.log(`[SCREENSHOT CANCELLED NS2] Chưa ở trong bàn cược thực tế nào, hủy chụp!`);
      return { success: false, reason: "NOT_IN_TABLE" };
    }

    const cleanTarget = String(tableName || currentInTable).trim().toUpperCase();

    const checkFrames = [page, seamlessFrame, gameCurrentFrame].filter(Boolean);
    let isExpiredOrError = false;

    for (const f of checkFrames) {
      if (!f || (typeof f.isClosed === "function" && f.isClosed())) continue;
      const hasError = await f.evaluate(() => {
        const dialogEls = Array.from(document.querySelectorAll(".van-dialog, .publicModal, #betLimitWrongSet, div[class*='dialog'], div[class*='modal']"));
        for (const modal of dialogEls) {
          const txt = (modal.innerText || modal.textContent || "").toLowerCase();
          if (txt.includes("hội thoại của bạn đã kết thúc") || txt.includes("session has expired") || txt.includes("đăng nhập lại trò chơi")) {
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (hasError) {
        isExpiredOrError = true;
        break;
      }
    }

    if (isExpiredOrError) {
      await helper.appendToLog("❌ [SESSION EXPIRED DETECTED NS2] Phát hiện dialog thông báo hết phiên 'Hội thoại của bạn đã kết thúc'. RESET RE-LOGIN!", logsNameProgress);
      resetMain();
      return { success: false, reason: "SESSION_EXPIRED" };
    }

    await closeInTableModals(page).catch(() => {});

    await helper.appendToLog(
      `📸 (NS2) Đang tiến hành chụp ảnh màn hình cho bàn ${cleanTarget}...`,
      logsNameProgress
    );

    const seamlessElement = await page.$("iframe#seamless-game").catch(() => null);
    const targetToScreenshot = seamlessElement || page;

    const result = await screenshotHelper.saveScreenshot(targetToScreenshot, cleanTarget, {
      roundNum: roundOptions.roundNum,
      shoeNum: roundOptions.shoeNum,
      isFullPage: false,
      pageObj: page,
    });
    if (result.success) {
      await helper.appendToLog(
        `📸 (NS2) Đã chụp ảnh thành công: ${result.filename}`,
        logsNameProgress
      );

      const serverPort = process.env.PORT || 3201;
      axios.post(`http://localhost:${serverPort}/api/notify-screenshot`, {
        tableName: cleanTarget,
        filename: result.filename,
        filepath: result.filepath,
        url: `/screenshots/${result.filename}`,
        roundNum: roundOptions.roundNum || null,
        resultWinner: roundOptions.resultWinner || null,
        nameService: "NS2"
      }).catch(() => {});
    }
    return result;
  } catch (err) {
    await helper.appendToLog(
      `Lỗi khi chụp ảnh bàn ${tableName} (NS2): ${err.message}`,
      logsNameProgress
    );
  } finally {
    isCapturingScreenshot = false;
    if (captureLockTimeout) clearTimeout(captureLockTimeout);
  }
}

async function playBaccaratLoop(gameHallFrame, gameCurrentFrame) {
  try {
    await enterTargetTable(gameHallFrame, "C01");
    await gameHallFrame.hover(process.env.CLICK_IN_TABLE_GAME).catch(() => {});
    await helper.delay(20000);
    await captureTableRound("C01", { roundNum: "LOOP_NS2" });
    await helper.delay(10000);
    await returnToHallIfNeeded(gameCurrentFrame);
    await helper.delay(2000);
  } catch (error) {
    return resetMain();
  }
}

async function startBaccaratCycle(gameHallFrame, gameCurrentFrame) {
  const interval = 2 * (60 * 1000);
  while (true) {
    try {
      await playBaccaratLoop(gameHallFrame, gameCurrentFrame);
      await new Promise((resolve) => setTimeout(resolve, interval));
    } catch (error) {
      await resetMain();
      break;
    }
  }
}

async function sendSessionData(sessionId, nameService) {
  if (socket && sessionId !== undefined) {
    socket.emit("session", {
      sessionId,
      nameService,
      stampTime: helper.getCurrentTime().timeUnix,
    });
  }
}

socket.on(`${nameServiceSocket}_restart`, async (data) => {
  resetMain();
});

let requestedTargetTable = null;

socket.on("set_target_table", async (data) => {
  const { tableName } = data;
  requestedTargetTable = tableName ? String(tableName).trim().toUpperCase() : null;
  if (page && !page.isClosed() && requestedTargetTable) {
    try {
      if (currentInTable && currentInTable !== requestedTargetTable) {
        await returnToHallIfNeeded(gameCurrentFrame);
      }
      if (!currentInTable || currentInTable !== requestedTargetTable) {
        await enterTargetTable(gameHallFrame, requestedTargetTable);
      }
    } catch (err) {}
  }
});

socket.on("new_round_completed", async (data) => {
  const { tableName, latestRound } = data;
  const currentTableUpper = String(tableName).trim().toUpperCase();

  if (page && !page.isClosed()) {
    try {
      const targetToMatch = requestedTargetTable ? String(requestedTargetTable).trim().toUpperCase() : null;
      if (targetToMatch && currentTableUpper !== targetToMatch) return;
      const activeTarget = targetToMatch || currentTableUpper;

      if (currentInTable && currentInTable !== activeTarget) {
        await returnToHallIfNeeded(gameCurrentFrame);
      }
      if (!currentInTable || currentInTable !== activeTarget) {
        await enterTargetTable(gameHallFrame, activeTarget);
      }
      await helper.delay(1000);
      await captureTableRound(activeTarget, { roundNum: latestRound?.id, resultWinner: latestRound?.roadFormat || data.resultWinner });
    } catch (err) {}
  }
});

socket.on("force_capture_now", async (data) => {
  const { tableName } = data || {};
  const activeTarget = tableName ? String(tableName).trim().toUpperCase() : (requestedTargetTable || "C01");

  if (page && !page.isClosed()) {
    try {
      if (currentInTable && currentInTable !== activeTarget) {
        await returnToHallIfNeeded(gameCurrentFrame);
      }
      if (!currentInTable || currentInTable !== activeTarget) {
        await enterTargetTable(gameHallFrame, activeTarget);
      }
      await helper.delay(2000);
      await captureTableRound(activeTarget, { roundNum: "FORCE_NS2_" + Date.now() });
    } catch (err) {}
  }
});

socket.on("place_bet", async (data) => {
  // Đã gỡ bỏ toàn bộ luồng cược tự động theo đúng yêu cầu
});

async function resetMain() {
  try {
    await clearListeners(page, [seamlessFrame, gameHallFrame, gameCurrentFrame]);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await helper.delay(10000);
  } catch (error) {
  } finally {
    if (browser) await browser.close().catch(() => {});
    isCollecting = false;
    await helper.delay(5000);
    await main().catch(async () => {
      await resetMain();
    });
  }
}

async function clearListeners(page, frames = []) {
  try {
    if (page) await page.removeAllListeners();
    for (const frame of frames) {
      if (frame && typeof frame.removeAllListeners === "function") {
        await frame.removeAllListeners();
      }
    }
  } catch (error) {}
}
