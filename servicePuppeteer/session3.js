const { firefox } = require("playwright");
const path = require("path");
// Load .env với path tuyệt đối để đảm bảo tìm được file
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const io = require("socket.io-client");
const fs = require("fs").promises;

const { request, imageCapcha, helper } = require("../utilities");
const { account_3: account } = require("./account.puppeteer");

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
socket.on("connect", () => console.log("(SOCKET) Connecting"));
socket.on("disconnect", () => console.log("(SOCKET) Disconnected"));

main();

async function main() {
  try {
    browser = await firefox.launch({
      headless: true,
      slowMo: 0,
      ignoreHTTPSErrors: true, // bỏ qua lỗi HTTPS
    });

    // Tạo persistent context
    context = await browser.newContext({
      // User data directory
      userDataDir: "./servicePuppeteer/dataDir/" + account.userDataDir,

      // Viewport settings
      viewport: { width: 1366, height: 768 },

      // Firefox-specific preferences
      extraHTTPHeaders: {
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    // Set Firefox-specific preferences
    await context.addInitScript(() => {
      // Firefox-specific overrides
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });

      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);

      // Firefox doesn't have chrome object
      if (!window.chrome) {
        window.chrome = undefined;
      }

      // Add Firefox-specific properties
      Object.defineProperty(navigator, "platform", {
        get: () => "Win32",
      });

      Object.defineProperty(navigator, "hardwareConcurrency", {
        get: () => 8,
      });

      // Disable webdriver
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    // Set User-Agent cho Firefox
    const UA =
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";
    await context.setExtraHTTPHeaders({
      "User-Agent": UA,
    });

    // Tạo page từ context
    page = await context.newPage();

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
      console.log("[DEBUG] Starting to collect responses...");

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
          console.log(`[DEBUG] Sending session: ${resSession}`);
          sendSessionData(resSession, nameServiceSocket);
        }
      };

      page.on("response", handleResponse);
      frames.forEach((frame) => {
        // if (frame && typeof frame.on === 'function') frame.on('response', handleResponse);
        if (frame && typeof frame.on === "function") {
          console.log("[DEBUG] Adding response listener to frame");
          frame.on("response", handleResponse);
        }
      });

      console.log("[DEBUG] Response listeners added to page and frames");
    }

    // Kiểm tra DOMAIN trước khi goto
    const DOMAIN = process.env.DOMAIN;
    if (!DOMAIN || typeof DOMAIN !== "string" || DOMAIN.trim() === "") {
      const errorMsg = `ENV DOMAIN không hợp lệ. Giá trị: ${JSON.stringify(DOMAIN)}`;
      await helper.appendToLog(errorMsg, logsNameProgress);
      throw new Error(errorMsg);
    }

    await helper.appendToLog(`Đang truy cập: ${DOMAIN}`, logsNameProgress);

    // Truy cập trang với timeout dài hơn cho Firefox
    await page.goto(DOMAIN, {
      waitUntil: "networkidle",
      timeout: 180000,
    });

    // await page.goto(process.env.DOMAIN, { timeout: 60000 });

    console.log("Trang web đã được load xong");

    // Đợi trang load hoàn toàn
    await page.waitForLoadState("networkidle");

    // login
    await clickButton(
      logsNameProgress,
      page,
      process.env.CLOSE_DIALOG_WELCOME,
      "ĐÓNG THÔNG BÁO SỰ KIỆN"
    );
    await clickButton(
      logsNameProgress,
      page,
      process.env.SHOW_DIALOG_LOGIN,
      "HIỂN THỊ DIALOG ĐĂNG NHẬP"
    );

    // const codeCapcha = await imageCapcha.getCodeCapchaLogin(
    //   logsNameProgress,
    //   page
    // );
    await fillInput(
      logsNameProgress,
      page,
      process.env.INPUT_USERNAME_LOGIN,
      username_game
    );
    await fillInput(
      logsNameProgress,
      page,
      process.env.INPUT_PASSWORD_LOGIN,
      password_game
    );
    // await fillInput(
    //   logsNameProgress,
    //   page,
    //   process.env.INPUT_CAPCHA_LOGIN,
    //   codeCapcha
    // );

    await clickButton(
      logsNameProgress,
      page,
      'button[type="submit"].submit_btn',
      "ĐĂNG NHẬP"
    );
    await helper.delay(8000);

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

    // redirect to baccarat sexy
    await helper.delay(2000);
    await clickButton(
      logsNameProgress,
      page,
      "div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1",
      "VÀO MENU GAME SEXY"
    );

    // Chờ navigation với timeout dài hơn
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

    // Cuộn và vào game
    await scrollDownSlowly(
      logsNameProgress,
      page,
      1500,
      "CUỘN XUỐNG - TÌM NÚT BUTTON VÀO GAME"
    );
    await helper.delay(1000);

    await clickButton(logsNameProgress, page, ".play-btn", "VÀO SẢNH SEXY");
    await helper.delay(25000);

    // Chờ và xử lý iframe SEXY GAME
    await waitForFrame(page, "iframe#seamless-game", 90000);
    const seamlessFrameElement = await page.$("iframe#seamless-game");
    seamlessFrame = await seamlessFrameElement.contentFrame();

    // Chờ và xử lý iframe GAME HALL
    await waitForFrame(seamlessFrame, "iframe#iframeGameHall", 90000);
    let gameHallFrameElement = await seamlessFrame.$("iframe#iframeGameHall");
    gameHallFrame = await gameHallFrameElement.contentFrame();

    // Chờ và xử lý iframe GAME
    await waitForFrame(seamlessFrame, "iframe#iframeGame", 90000);
    let gameCurrentFrameElement = await seamlessFrame.$("iframe#iframeGame");
    gameCurrentFrame = await gameCurrentFrameElement.contentFrame();

    // Cuộn và tắt thông báo
    await scrollDownSlowly(
      logsNameProgress,
      page,
      2000,
      "CUỘN TRANG XUỐNG > TOÀN MÀN HÌNH GAME"
    );
    await clickButtonNotifiGame(
      logsNameProgress,
      gameHallFrame,
      "button.size-8.cursor-pointer.outline-none",
      "TẮT THÔNG BÁO GAME SEXY"
    );
    await helper.delay(8000);

    // Refresh frame references
    gameHallFrameElement = await seamlessFrame.$("iframe#iframeGameHall");
    gameHallFrame = await gameHallFrameElement.contentFrame();

    // lấy session
    startCollectingResponses(page, [
      seamlessFrame,
      gameHallFrame,
      gameCurrentFrame,
    ]);

    // duy trì session game
    await startBaccaratCycle(gameHallFrame, gameCurrentFrame);
  } catch (error) {
    await helper.appendToLog(
      `Error in main function: ${error.message}`,
      logsNameProgress
    );
    await resetMain();
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

  while (retryCount <= 9) {
    try {
      await page.waitForSelector(classElement, { timeout: 5000 });
      const inputField = await page.$(classElement);

      if (inputField) {
        // Xóa nội dung hiện tại trước khi nhập
        await inputField.click({ clickCount: 3 });
        await page.keyboard.press("Backspace");

        // Nhập giá trị mới
        await inputField.type(value, { delay: 100 });
        await helper.appendToLog(
          `NHẬP => ${value} THÀNH CÔNG`,
          logsNameProgress
        );
        return;
      }
    } catch (error) {
      // Bỏ qua lỗi và thử lại
    }

    retryCount++;
    await helper.appendToLog(
      `NHẬP => ${value} THẤT BẠI (lần ${retryCount})`,
      logsNameProgress
    );
    await helper.delay(1000);
  }

  await helper.appendToLog(
    `Quá 9 lần nhập thất bại - khởi động lại`,
    logsNameProgress
  );
  await resetMain();
}

async function clickButton(
  logsNameProgress,
  page,
  classElement,
  msg = "_",
  numberClick = 1
) {
  let retryCount = 0;
  const action = numberClick > 1 ? "DOUBLE CLICK" : "CLICK";

  while (retryCount <= 9) {
    try {
      await page.waitForSelector(classElement, { timeout: 5000 });
      const clickBtn = await page.$(classElement);

      if (clickBtn) {
        await clickBtn.scrollIntoViewIfNeeded();
        await clickBtn.click({ clickCount: numberClick });
        await helper.appendToLog(
          `${action} => ${msg} THÀNH CÔNG`,
          logsNameProgress
        );
        return;
      }
    } catch (error) {
      // Bỏ qua lỗi và thử lại
    }

    retryCount++;
    await helper.appendToLog(
      `${action} => ${msg} THẤT BẠI (lần ${retryCount})`,
      logsNameProgress
    );
    await helper.delay(2000);
  }

  await helper.appendToLog(
    `${action} => ${msg} THẤT BẠI QUÁ 9 LẦN - khởi động lại`,
    logsNameProgress
  );
  await resetMain();
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
  let retryCount = 0;
  const maxRetries = 5;

  while (retryCount < maxRetries) {
    retryCount++;

    try {
      await page.waitForSelector(classElement, { timeout: 3000 });
      const clickBtn = await page.$(classElement);

      if (clickBtn) {
        await clickBtn.click({ clickCount: numberClick });
        await helper.appendToLog(
          `${action} => ${msg} THÀNH CÔNG (lần ${retryCount})`,
          logsNameProgress
        );
        return;
      }
    } catch (error) {
      await helper.appendToLog(
        `${action} => ${msg} LỖI KHI CLICK (lần ${retryCount}): ${error.message}`,
        logsNameProgress
      );
    }

    if (retryCount < maxRetries) {
      await helper.delay(2000);
    }
  }

  await helper.appendToLog(
    `${action} => ${msg} ĐÃ THỬ 10 LẦN KHÔNG THÀNH CÔNG - BỎ QUA`,
    logsNameProgress
  );
}

// Vào ra bàn game baccarat
async function playBaccaratLoop(gameHallFrame, gameCurrentFrame) {
  try {
    await clickButton(
      logsNameProgress,
      gameHallFrame,
      process.env.CLICK_IN_TABLE_GAME,
      "VÀO BÀN BACCARAT",
      2
    );
    await gameHallFrame.hover(process.env.CLICK_IN_TABLE_GAME);
    await helper.delay(30000);

    await clickButton(
      logsNameProgress,
      gameCurrentFrame,
      "button#goHome2",
      "TRỞ VỀ SẢNH GAME",
      2
    );
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

async function sendSessionData(sessionId, nameService) {
  if (socket && sessionId !== undefined) {
    console.log(
      `[SOCKET] Sending session: ${sessionId} to service: ${nameService}`
    );
    socket.emit("session", {
      sessionId,
      nameService,
      stampTime: helper.getCurrentTime().timeUnix,
    });
    await helper.appendToLog(
      `(SOCKET) send server sessionId:: ${sessionId}`,
      logsNameProgress
    );
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

async function resetMain() {
  try {
    await clearListeners(page, [
      seamlessFrame,
      gameHallFrame,
      gameCurrentFrame,
    ]);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await helper.delay(10000);
  } catch (error) {
    console.error("Error during cleanup:", error.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    isCollecting = false;
    await helper.delay(5000);
    timeSendSessionNearest = helper.getCurrentTime().timeUnix;
    await helper.appendToLog("Khởi động lại chương trình...", logsNameProgress);
    await main().catch(async (err) => {
      await helper.appendToLog(
        `Lỗi khi khởi động lại main: ${err.message}`,
        logsNameProgress
      );
      await resetMain();
    });
  }
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
