const puppeteer = require('puppeteer');
require('dotenv').config();
const io = require('socket.io-client');
const fs = require('fs').promises;
const path = require('path');

const { request, imageCapcha, helper } = require('../utilities');
const { account_1: account } = require('./account.puppeteer')

let isCollecting = false;
let socket;
let browser;
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

main()
socket = io(`${process.env.SERVER_HOSTNAME}:${process.env.SERVER_PORT}`);
socket.on('connect', () => console.log('(SOCKET) Connecting'));
socket.on('disconnect', () => console.log('(SOCKET) Disconnected'));

async function main() {
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            // headless: false,
            slowMo: 50,
            userDataDir: `./servicePuppeteer/dataDir/${account.userDataDir}`,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--start-maximized']
        });
        page = await browser.newPage();
        const { width, height } = await page.evaluate(() => {
            return {
                width: window.screen.availWidth,
                height: window.screen.availHeight
            };
        });
        await page.setViewport({ width, height });
        await page.setUserAgent(process.env.USER_AGENT);

        await helper.appendToLog('BẮT ĐẦU CHƯƠNG TRÌNH - GHI LOGS', logsNameProgress);
        await helper.appendToLog('='.repeat(50), logsNameProgress);

        page.on('error', async err => {
            await helper.appendToLog(`Page error: ${err.message}`, logsNameProgress);
        });

        page.on('pageerror', async err => {
            await helper.appendToLog(`Page uncaught exception : ${err.message}`, logsNameProgress);
        });

        function startCollectingResponses(page, frames = []) {
            isCollecting = true; // mở cờ khi được kích hoạt
            const handleResponse = async (response) => {
                const resSession = await request.CollectingResponseSession(response, isCollecting);
                const timeUnixCurrent = helper.getCurrentTime().timeUnix;

                // check định dạng session và thời gian gửi sessionId đến server
                if (typeof resSession === 'string' && /^[a-zA-Z0-9]+$/.test(resSession) && timeUnixCurrent > (timeSendSessionNearest + timeSendSessionDelay)) {
                    timeSendSessionNearest = timeUnixCurrent;
                    sendSessionData(resSession, nameServiceSocket)
                }

                // if ((timeSendSessionNearest + ((60 * 1000) * 5)) < timeUnixCurrent) {
                //     await helper.appendToLog('5 phút vẫn chưa có session - bắt đầu khởi động lại (bắt ở tool session)', logsNameProgress);
                //     await resetMain();
                //     return;
                // }
            };

            // Gắn listener cho page và tất cả các frame
            page.on('response', handleResponse);
            frames.forEach(frame => {
                frame.on('response', handleResponse);
            });
        }

        await page.goto(process.env.DOMAIN, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('Trang web đã được load xong');

        // login
        await clickButton(logsNameProgress, page, process.env.CLOSE_DIALOG_WELCOME, 'ĐÓNG THÔNG BÁO SỰ KIỆN');
        await clickButton(logsNameProgress, page, process.env.SHOW_DIALOG_LOGIN, 'HIỂN THỊ DIALOG ĐĂNG NHẬP');
        const codeCapcha = await imageCapcha.getCodeCapchaLogin(logsNameProgress, page)
        await fillInput(logsNameProgress, page, process.env.INPUT_USERNAME_LOGIN, username_game);
        await fillInput(logsNameProgress, page, process.env.INPUT_PASSWORD_LOGIN, password_game);
        await fillInput(logsNameProgress, page, process.env.INPUT_CAPCHA_LOGIN, codeCapcha);
        await clickButton(logsNameProgress, page, 'button[type="submit"].submit_btn', 'ĐĂNG NHẬP');
        await helper.delay(5000);
        await clickButton(logsNameProgress, page, process.env.SHOW_DIALOG_LOGIN_SUCCESS, 'ĐÓNG THÔNG BÁO CẢNH BÁO KHI HOÀN TẤT ĐĂNG NHẬP');

        // redirect to baccarat sexy
        await helper.delay(1000);
        await clickButton(logsNameProgress, page, 'div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1', 'VÀO MENU GAME SEXY');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await helper.delay(1000);
        await scrollDownSlowly(logsNameProgress, page, 1000, 'CUỘN XUỐNG - TÌM NÚT BUTTON VÀO GAME');
        await helper.delay(1000);
        await clickButton(logsNameProgress, page, '.play-btn', 'VÀO SẢNH SEXY');
        await helper.delay(20000);

        // iframe SEXY GAME
        await page.waitForFunction(
            () => !!document.querySelector('iframe#seamless-game'),
            { timeout: 60000, polling: 'mutation' }
        );
        const seamlessFrameElement = await page.$('iframe#seamless-game');
        seamlessFrame = await seamlessFrameElement.contentFrame();

        // iframe GAME HALL
        await seamlessFrame.waitForFunction(
            () => !!document.querySelector('iframe#iframeGameHall'),
            { timeout: 60000, polling: 'mutation' }
        );
        let gameHallFrameElement = await seamlessFrame.$('iframe#iframeGameHall');
        gameHallFrame = await gameHallFrameElement.contentFrame();

        // iframe GAME
        await seamlessFrame.waitForFunction(
            () => !!document.querySelector('iframe#iframeGame'),
            { timeout: 60000, polling: 'mutation' }
        );
        let gameCurrentFrameElement = await seamlessFrame.$('iframe#iframeGame');
        gameCurrentFrame = await gameCurrentFrameElement.contentFrame();

        await scrollDownSlowly(logsNameProgress, page, 2000, 'CUỘN TRANG XUỐNG > TOÀN MÀN HÌNH GAME');
        await clickButtonNotifiGame(logsNameProgress, gameHallFrame, 'button.size-8.cursor-pointer.outline-none', 'TẮT THÔNG BÁO GAME SEXY');
        await helper.delay(5000);

        gameHallFrameElement = await seamlessFrame.$('iframe#iframeGameHall');
        gameHallFrame = await gameHallFrameElement.contentFrame();

        // lấy session
        startCollectingResponses(page, [seamlessFrame, gameHallFrame, gameCurrentFrame]);

        // duy trì seesion game
        await startBaccaratCycle(gameHallFrame, gameCurrentFrame);

        // Vào ra bàn game baccarat
        async function playBaccaratLoop(gameHallFrame, gameCurrentFrame) {
            try {
                await clickButton(logsNameProgress, gameHallFrame, process.env.CLICK_IN_TABLE_GAME, 'VÀO BÀN BACCARAT', 2);
                await gameHallFrame.hover(process.env.CLICK_IN_TABLE_GAME);
                await helper.delay(30000);

                await clickButton(logsNameProgress, gameCurrentFrame, 'button#goHome2', 'TRỞ VỀ SẢNH GAME', 2);
                await helper.delay(2000);
            } catch (error) {
                await helper.appendToLog(`Lỗi trong chu kỳ baccarat: ${error.message}`, logsNameProgress);
                return resetMain()
            }
        }

        // lặp lại vô hạn
        async function startBaccaratCycle(gameHallFrame, gameCurrentFrame) {
            const interval = 2 * (60 * 1000);
            while (true) {
                try {
                    await helper.appendToLog('Bắt đầu chu kỳ baccarat', logsNameProgress);
                    await playBaccaratLoop(gameHallFrame, gameCurrentFrame);
                    await helper.appendToLog('Chờ đến chu kỳ tiếp theo...', logsNameProgress);
                    await new Promise(resolve => setTimeout(resolve, interval));
                } catch (error) {
                    await helper.appendToLog(`Lỗi trong startBaccaratCycle: ${error.message}`, logsNameProgress);
                    await resetMain();
                    break;
                }
            }
        }

        await helper.appendToLog('Log ended at ' + new Date().toISOString(), logsNameProgress);
        await helper.appendToLog('='.repeat(50), logsNameProgress);

    } catch (error) {
        await helper.appendToLog(`Error in main function: ${error.message}`, logsNameProgress);
        resetMain();
    }
}

async function sendSessionData(sessionId, nameService) {
    if (socket && sessionId !== undefined) {
        socket.emit('session', { sessionId, nameService, stampTime: helper.getCurrentTime().timeUnix });
        await helper.appendToLog(`(SOCKET) send server sessionId:: ${sessionId}`, logsNameProgress);
    }
}

socket.on(`${nameServiceSocket}_restart`, async (data) => {
    await helper.appendToLog(`(SOCKET) - RESTART ${nameServiceSocket} - (SERVER)`, logsNameProgress);
    console.log(`(SOCKET) - RESTART ${nameServiceSocket}`)
    resetMain()
});

async function resetMain() {
    try {
        await clearListeners(page, [seamlessFrame, gameHallFrame, gameCurrentFrame]);
        if (gameCurrentFrame) await gameCurrentFrame.close().catch(() => {});
        if (gameHallFrame) await gameHallFrame.close().catch(() => {});
        if (seamlessFrame) await seamlessFrame.close().catch(() => {});
        if (page) await page.close().catch(() => {});
        await helper.delay(10000);

        // xoá chrome cũ
        // const folderPath = path.join(__dirname, 'dataDir', account.userDataDir);
        // await fs.rm(folderPath, { recursive: true, force: true });
    } catch (error) {
        console.error('Error during cleanup:', error.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        isCollecting = false;
        await helper.delay(5000);
        timeSendSessionNearest = helper.getCurrentTime().timeUnix;
        await helper.appendToLog('Khởi động lại chương trình...', logsNameProgress);
        await main().catch(async err => {
            await helper.appendToLog(`Lỗi khi khởi động lại main: ${err.message}`, logsNameProgress);
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
            if (frame) {
                await frame.removeAllListeners();
            }
        }
    } catch (error) {
        console.error('Error clearing listeners:', error.message);
    }
}

// event bot
async function fillInput(logsNameProgress, page, classElement, value) {
    let retryCount = 0;

    while (retryCount <= 9) {
        const inputField = await page.$(classElement);
        if (inputField) {
            await inputField.type(value);
            await helper.appendToLog(`NHẬP => ${value} THÀNH CÔNG`, logsNameProgress);
            return;
        } else {
            retryCount++;
            await helper.appendToLog(`NHẬP => ${value} THẤT BẠI (lần ${retryCount})`, logsNameProgress);
            await helper.delay(1000);
        }
    }

    await helper.appendToLog(`Quá 9 lần nhập thất bại - khởi động lại`, logsNameProgress);
    await resetMain();
}

async function clickButton(logsNameProgress, page, classElement, msg = "_", numberClick = 1) {
    let retryCount = 0;
    const action = numberClick > 1 ? 'DOUBLE CLICK' : 'CLICK';

    while (retryCount <= 9) {
        await helper.delay(500);
        const clickBtn = await page.$(classElement);

        if (clickBtn) {
            await clickBtn.evaluate(b => b.click());
            await helper.appendToLog(`${action} => ${msg} THÀNH CÔNG`, logsNameProgress);
            return;
        } else {
            retryCount++;
            await helper.appendToLog(`${action} => ${msg} THẤT BẠI (lần ${retryCount})`, logsNameProgress);
            await helper.delay(2000);
        }
    }

    await helper.appendToLog(`${action} => ${msg} THẤT BẠI QUÁ 9 LẦN - khởi động lại`, logsNameProgress);
    await resetMain();
}


async function scrollDownSlowly(logsNameProgress, frame, duration = 2000, msg = 'SCROLL DOWN') {
    await helper.appendToLog(`CUỘN => ${msg}`, logsNameProgress);
    await frame.evaluate((duration) => {
        const scrollHeight = document.body.scrollHeight;
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
    const action = numberClick > 1 ? 'DOUBLE CLICK' : 'CLICK';
    let retryCount = 0;
    const maxRetries = 10; // Tối đa 10 lần thử
    
    while (retryCount < maxRetries) {
        retryCount++;
        await helper.delay(500); // Chờ 0.5s giữa các lần thử
        
        const clickBtn = await page.$(classElement);
        
        if (clickBtn) {
            try {
                await clickBtn.evaluate(b => b.click());
                await helper.appendToLog(`${action} => ${msg} THÀNH CÔNG (lần ${retryCount})`, logsNameProgress);
                return; // Thành công thì thoát hàm
            } catch (error) {
                await helper.appendToLog(`${action} => ${msg} LỖI KHI CLICK (lần ${retryCount}): ${error.message}`, logsNameProgress);
            }
        } else {
            await helper.appendToLog(`${action} => ${msg} KHÔNG TÌM THẤY PHẦN TỬ (lần ${retryCount})`, logsNameProgress);
        }
        
        if (retryCount < maxRetries) {
            await helper.delay(2000); // Chờ 2s trước khi thử lại
        }
    }
    
    // Nếu chạy đến đây nghĩa là đã thử 10 lần không thành công
    await helper.appendToLog(`${action} => ${msg} ĐÃ THỬ 10 LẦN KHÔNG THÀNH CÔNG - BỎ QUA`, logsNameProgress);
}