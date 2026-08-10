const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { account_1: account } = require('../servicePuppeteer/account.puppeteer');

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const hits = [];

  page.on('request', (req) => {
    const u = req.url();
    if (/gctpjt|bpcdf|jsessionid|seamless|launch|sexy|gamehall|iframe|player\/query/i.test(u)) {
      hits.push(u.slice(0, 200));
      log('REQ', req.resourceType(), u.slice(0, 170));
    }
  });
  page.on('response', async (res) => {
    const u = res.url();
    if (/gctpjt|bpcdf|jsessionid|launch|queryInit/i.test(u)) {
      log('RES', res.status(), u.slice(0, 170));
      const sc = await res.headerValue('set-cookie').catch(() => null);
      if (sc && /JSESSION/i.test(sc)) log('SETCOOKIE', sc.slice(0, 140));
    }
  });

  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() =>
    document.querySelectorAll('.close-btn,.tcg_modal_close').forEach((e) => e.click())
  );
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const e = document.querySelector('.hd_login .submit_btn, .submit_btn');
    if (e) e.click();
  });
  await page.waitForTimeout(1000);
  await page.fill('.username_input', account.username_game, { force: true });
  await page.fill('.password_input', account.password_game, { force: true });
  await page.evaluate(() =>
    document.querySelector('button[type="submit"].submit_btn')?.click()
  );
  await page.waitForTimeout(8000);
  await page.evaluate(() => document.querySelector('.tcg_modal_close')?.click());

  await page.evaluate(() => document.querySelector('div.nav_item_btn.LIVE')?.click());
  await page.waitForTimeout(1000);
  await page
    .locator('span.game_name')
    .filter({ hasText: /SEXY/i })
    .first()
    .click({ force: true });
  await page.waitForTimeout(5000);
  log('url', page.url());

  for (let i = 0; i < 25; i++) {
    const info = await page.evaluate(() => {
      const f = document.querySelector('#seamless-game');
      return {
        src: f?.src || '',
        srcAttr: f?.getAttribute('src') || '',
        frames: [...document.querySelectorAll('iframe')].map((x) => ({
          id: x.id,
          src: (x.src || '').slice(0, 120),
        })),
      };
    });
    log('poll', i, 'srcLen', (info.src || '').length, JSON.stringify(info.frames));
    if (info.src && info.src.length > 10) {
      log('SRC READY', info.src.slice(0, 250));
      break;
    }
    await page.waitForTimeout(3000);
  }

  const handle = await page.$('#seamless-game');
  if (handle) {
    const frame = await handle.contentFrame();
    if (frame) {
      const inner = await frame
        .evaluate(() => ({
          title: document.title,
          body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 250),
          iframes: [...document.querySelectorAll('iframe')].map((x) => ({
            id: x.id,
            src: (x.src || '').slice(0, 140),
          })),
          href: location.href,
        }))
        .catch((e) => ({ err: e.message }));
      log('INNER', JSON.stringify(inner));
    } else {
      log('no contentFrame yet');
    }
  }

  log('HIT COUNT', hits.length);
  hits.slice(0, 40).forEach((h) => log('HIT', h));
  await page.screenshot({
    path: path.join(__dirname, '..', 'diag-seamless.png'),
    fullPage: true,
  });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
