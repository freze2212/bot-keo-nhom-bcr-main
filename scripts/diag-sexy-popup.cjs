const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { account_1: account } = require('../servicePuppeteer/account.puppeteer');

(async () => {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.locator('.close-btn').first().click({ force: true }).catch(() => {});
  const logged = await page.evaluate(() =>
    (document.body.innerText || '').toLowerCase().includes('đăng xuất')
  );
  if (!logged) {
    await page.locator('.submit_btn').first().click({ force: true });
    await page.waitForTimeout(1000);
    await page.fill('.username_input', account.username_game, { force: true });
    await page.fill('.password_input', account.password_game, { force: true });
    await page.locator('button[type="submit"].submit_btn').click({ force: true });
    await page.waitForTimeout(8000);
    await page.locator('.tcg_modal_close').first().click({ force: true }).catch(() => {});
  }
  console.log('logged body', (await page.innerText('body')).replace(/\s+/g,' ').slice(0,120));

  const popupPromise = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
  await page.locator('div.nav_item_btn.LIVE, .nav_item_btn.LIVE').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator('.dropdown_menu.LIVE span.game_name').first().click({ force: true });
  const popup = await popupPromise;
  await page.waitForTimeout(10000);

  const pages = context.pages();
  console.log('pages', pages.length, pages.map((p) => p.url().slice(0, 100)));
  if (popup) console.log('popup url', popup.url());

  for (const p of pages) {
    const iframes = await p.evaluate(() =>
      [...document.querySelectorAll('iframe')].map((f) => ({
        id: f.id,
        src: (f.src || '').slice(0, 120),
      }))
    );
    console.log('iframes on', p.url().slice(0, 60), iframes);
  }
  await browser.close();
})();
