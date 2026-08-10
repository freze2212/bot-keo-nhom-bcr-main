const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { account_1: account } = require('../servicePuppeteer/account.puppeteer');

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

(async () => {
  const user = process.argv[2] || account.username_game;
  const pass = process.argv[3] || account.password_game;
  log('account', user);

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  let session = null;

  const onResp = async (response) => {
    try {
      const url = response.url();
      const headers = response.request().headers();
      const cookie = headers.cookie || headers.Cookie || '';
      const m = cookie.match(/JSESSIONID=([^;]+)/i);
      const um = url.match(/jsessionid=([^?&;/]+)/i);
      const sid = (m && m[1]) || (um && um[1]);
      if (sid && !session) {
        session = sid;
        log('GOT JSESSIONID', sid, 'via', url.slice(0, 100));
      }
      if (/jsessionid|gctpjt|bpcdf|queryInit|gamehall/i.test(url)) {
        log('XHR', response.status(), url.slice(0, 140));
      }
    } catch (_) {}
  };
  page.on('response', onResp);
  context.on('page', (p) => p.on('response', onResp));

  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() =>
    document.querySelectorAll('.close-btn,.tcg_modal_close').forEach((e) => e.click())
  );
  await page.waitForTimeout(500);

  const logged = await page.evaluate(() =>
    (document.body?.innerText || '').toLowerCase().includes('đăng xuất')
  );
  if (!logged) {
    await page.evaluate(() => document.querySelector('.hd_login .submit_btn, .submit_btn')?.click());
    await page.waitForTimeout(1000);
    await page.fill('.username_input', user, { force: true });
    await page.fill('.password_input', pass, { force: true });
    await page.evaluate(() =>
      document.querySelector('button[type="submit"].submit_btn')?.click()
    );
    await page.waitForTimeout(9000);
    await page.evaluate(() => document.querySelector('.tcg_modal_close')?.click());
  }

  const bal = await page.evaluate(() =>
    (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120)
  );
  log('afterLogin', bal);

  // Path A: UI LIVE -> SEXY
  await page.evaluate(() => document.querySelector('div.nav_item_btn.LIVE')?.click());
  await page.waitForTimeout(1500);
  const sexy = page.locator('span.game_name').filter({ hasText: /SEXY/i }).first();
  if (await sexy.count()) {
    await sexy.click({ force: true });
    log('clicked SEXY');
  }
  await page.waitForTimeout(8000);
  log('urlA', page.url());

  // Path B: direct seamless if still on lobby
  if (!/seamless/i.test(page.url())) {
    const seamlessUrl =
      process.env.DOMAIN.replace(/\/$/, '') +
      (process.env.ROUTER_URL_BACARAT_SEXY || '/seamless?gameType=LIVE');
    log('goto direct', seamlessUrl);
    await page.goto(seamlessUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
  }
  log('urlB', page.url());

  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => {
      const f = document.querySelector('#seamless-game');
      return {
        src: (f && f.src) || '',
        frames: [...document.querySelectorAll('iframe')].map((x) => ({
          id: x.id,
          src: (x.src || '').slice(0, 140),
        })),
      };
    });
    log('poll', i, 'srcLen', info.src.length, JSON.stringify(info.frames).slice(0, 200));
    if (info.src.length > 20 || session) break;
    await page.waitForTimeout(3000);
  }

  if (session) {
    // probe hall API
    const axios = require('axios');
    const url = process.env.URI_REQUEST_DATA + session;
    const payload = new URLSearchParams();
    payload.append('gameGroupId', 2);
    try {
      const r = await axios.post(url, payload, { timeout: 15000 });
      const tables = r.data?.tableItems?.length || 0;
      log('HALL API tables', tables, 'status', r.data?.status || r.status);
    } catch (e) {
      log('HALL API fail', e.message);
    }
  }

  log('RESULT', session || 'NONE');
  await browser.close();
  process.exit(session ? 0 : 2);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
