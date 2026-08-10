const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { account_1: account } = require('../servicePuppeteer/account.puppeteer');

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function forceClick(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.click();
  }, sel).catch(() => {});
  await page.locator(sel).first().click({ force: true, timeout: 5000 }).catch(() => {});
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const found = { session: null, urls: [] };

  const onResp = async (response) => {
    try {
      const url = response.url();
      const rt = response.request().resourceType();
      if (rt !== 'xhr' && rt !== 'fetch' && !/jsessionid/i.test(url)) return;
      if (/jsessionid|gctpjt|bpcdf|sexy|gamehall|queryInit/i.test(url)) {
        found.urls.push(url.slice(0, 160));
        log('XHR', response.status(), url.slice(0, 140));
      }
      const headers = response.request().headers();
      const cookie = headers.cookie || headers.Cookie || '';
      const m = cookie.match(/JSESSIONID=([^;]+)/i);
      const um = url.match(/jsessionid=([^?&;/]+)/i);
      let sid = (m && m[1]) || (um && um[1]);
      if (!sid) {
        const setCookie = await response.headerValue('set-cookie').catch(() => null);
        if (setCookie) {
          const sm = setCookie.match(/JSESSIONID=([^;]+)/i);
          if (sm) sid = sm[1];
        }
      }
      if (sid && !found.session) { found.session = sid; log('GOT JSESSIONID', sid); }
    } catch (_) {}
  };
  page.on('response', onResp);
  context.on('page', (p) => { log('NEW PAGE', p.url()); p.on('response', onResp); });

  log('goto', process.env.DOMAIN);
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);
  for (const s of ['.close-btn', '.tcg_modal_close', '.publicModal .tcg_modal_close']) {
    await forceClick(page, s);
  }
  await page.waitForTimeout(1000);

  const logged = await page.evaluate(() => (document.body?.innerText || '').toLowerCase().includes('đăng xuất'));
  log('alreadyLogged', logged, 'user', account.username_game);
  if (!logged) {
    await forceClick(page, '.hd_login .submit_btn');
    await forceClick(page, '.submit_btn');
    await page.waitForTimeout(1500);
    await page.fill('.username_input', account.username_game, { force: true });
    await page.fill('.password_input', account.password_game, { force: true });
    log('submit login');
    await forceClick(page, 'button[type="submit"].submit_btn');
    await page.waitForTimeout(10000);
    await forceClick(page, '.tcg_modal_close');
  }

  log('body', (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 180));
  const logged2 = await page.evaluate(() => (document.body?.innerText || '').toLowerCase().includes('đăng xuất'));
  log('loggedAfter', logged2);
  if (!logged2) {
    await page.screenshot({ path: path.join(__dirname, '..', 'diag-login-fail.png'), fullPage: true });
    log('LOGIN FAIL screenshot saved');
    await browser.close();
    process.exit(3);
  }

  const popupPromise = context.waitForEvent('page', { timeout: 30000 }).catch(() => null);
  await forceClick(page, 'div.nav_item_btn.LIVE');
  await page.waitForTimeout(1500);
  const sexyCount = await page.locator('.dropdown_menu.LIVE span.game_name, span.game_name').filter({ hasText: /SEXY/i }).count();
  log('sexyCandidates', sexyCount);
  if (sexyCount) {
    await page.locator('.dropdown_menu.LIVE span.game_name, span.game_name').filter({ hasText: /SEXY/i }).first().click({ force: true });
  } else {
    await forceClick(page, '.dropdown_menu.LIVE span.game_name');
    await forceClick(page, 'span.game_name');
  }
  const popup = await popupPromise;
  await page.waitForTimeout(18000);

  const pages = context.pages();
  log('pages', pages.length, pages.map((p) => p.url().slice(0, 100)));
  if (popup) log('popup', popup.url().slice(0, 140));
  for (const p of pages) {
    const iframes = await p.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => ({ id: f.id, src: (f.src || '').slice(0, 140) }))).catch(() => []);
    log('iframes', p.url().slice(0, 70), JSON.stringify(iframes));
  }
  await page.waitForTimeout(25000);
  log('RESULT session=', found.session || 'NONE', 'xhrHits=', found.urls.length);
  if (found.urls.length) log('sample', found.urls.slice(0, 10));
  await browser.close();
  process.exit(found.session ? 0 : 2);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
