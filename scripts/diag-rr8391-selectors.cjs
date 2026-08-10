/**
 * Chẩn đoán selector login RR8391 — chạy headful để xem UI.
 */
const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const closeCandidates = [...document.querySelectorAll(
      '.tcg_modal_close, .modal_close, [class*="close"], button[aria-label*="close" i], .publicModal button'
    )].slice(0, 15).map((el) => ({
      tag: el.tagName,
      class: el.className,
      text: (el.textContent || '').trim().slice(0, 40),
    }));
    const loginCandidates = [...document.querySelectorAll(
      '.submit_btn, button[type="submit"], [class*="login"], [class*="Login"]'
    )].slice(0, 10).map((el) => ({
      tag: el.tagName,
      class: el.className,
      text: (el.textContent || '').trim().slice(0, 40),
    }));
    return {
      title: document.title,
      url: location.href,
      closeCandidates,
      loginCandidates,
      hasPublicModal: !!document.querySelector('.publicModal'),
      hasTcgClose: !!document.querySelector('.tcg_modal_close'),
      bodyText: document.body.innerText.slice(0, 300),
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(__dirname, '..', 'diag-rr8391.png'), fullPage: false });
  console.log('screenshot: diag-rr8391.png');
  await browser.close();
})();
