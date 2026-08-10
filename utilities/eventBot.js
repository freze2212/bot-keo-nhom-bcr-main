const { delay, appendToLog } = require('./helper');

async function fillInput(logsNameProgress, page, classElement, value) {
    const inputField = await page.$(classElement);

    if (inputField) {
        await inputField.type(value);
        await appendToLog(`NHẬP => ${value} THÀNH CÔNG`, logsNameProgress);
    } else {
        await appendToLog(`NHẬP => ${value} THẤT BẠI`, logsNameProgress);
        fillInput(logsNameProgress, page, classElement, value)
    }
}

async function clickButton(logsNameProgress, page, classElement, msg = "_", numberClick = 1) {
    await delay(500);
    const clickBtn = await page.$(classElement);
    const action = numberClick > 1 ? 'DOUBLE CLICK' : 'CLICK';
    if (clickBtn) {
        await clickBtn.click({ clickCount: numberClick });
        await appendToLog(`${action} => ${msg} THÀNH CÔNG`, logsNameProgress);
    } else {
        await appendToLog(`${action} => ${msg} THẤT BẠI`, logsNameProgress);
        await delay(2000);
        return clickButton(logsNameProgress, page, classElement, msg, numberClick = 1)
    }
}

async function scrollDownSlowly(logsNameProgress, frame, duration = 2000, msg = 'SCROLL DOWN') {
    await appendToLog(`CUỘN => ${msg}`, logsNameProgress);
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

module.exports = {
    fillInput,
    clickButton,
    scrollDownSlowly
};