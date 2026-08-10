const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

(async () => {
  const user = process.argv[2] || 'bminr88';
  const pass = process.argv[3] || 'bminr88123';

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const net = [];

  page.on('request', (req) => {
    const u = req.url();
    if (/\.(png|jpg|jpeg|gif|webp|css|woff2?|svg|ico)(\?|$)/i.test(u)) return;
    net.push({ t: 'req', m: req.method(), u: u.slice(0, 220) });
  });
  page.on('response', async (res) => {
    const u = res.url();
    if (/\.(png|jpg|jpeg|gif|webp|css|woff2?|svg|ico)(\?|$)/i.test(u)) return;
    let body = '';
    try {
      if (/json|text|javascript|api|launch|seamless|game/i.test(u) || res.status() >= 400) {
        const ct = res.headers()['content-type'] || '';
        if (/json|text/i.test(ct) || /launch|seamless|game|api/i.test(u)) {
          body = (await res.text()).slice(0, 300);
        }
      }
    } catch (_) {}
    net.push({ t: 'res', s: res.status(), u: u.slice(0, 220), body });
    if (/launch|seamless|jsession|gctpjt|bpcdf|vendor|gameUrl|game_url/i.test(u) || body) {
      log('RES', res.status(), u.slice(0, 140), body.slice(0, 120));
    }
  });
  page.on('console', (msg) => log('CON', msg.type(), msg.text().slice(0, 160)));
  page.on('pageerror', (err) => log('PAGEERR', err.message));

  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() =>
    document.querySelectorAll('.close-btn,.tcg_modal_close').forEach((e) => e.click())
  );
  await page.evaluate(() => document.querySelector('.hd_login .submit_btn, .submit_btn')?.click());
  await page.waitForTimeout(1000);
  await page.fill('.username_input', user, { force: true });
  await page.fill('.password_input', pass, { force: true });
  await page.evaluate(() =>
    document.querySelector('button[type="submit"].submit_btn')?.click()
  );
  await page.waitForTimeout(10000);
  await page.evaluate(() => document.querySelector('.tcg_modal_close')?.click());

  // Click parent of SEXY game_name (dropdown item)
  await page.locator('div.nav_item_btn.LIVE').first().click({ force: true });
  await page.waitForTimeout(1500);

  // click the dropdown row containing SEXY CASINO
  const clicked = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span.game_name')];
    const sexy = spans.find((s) => /SEXY/i.test(s.textContent || ''));
    if (!sexy) return 'no-span';
    const row =
      sexy.closest('a') ||
      sexy.closest('[class*="game"]') ||
      sexy.closest('div') ||
      sexy;
    row.click();
    return row.className?.toString?.().slice(0, 80) || row.tagName;
  });
  log('clickedRow', clicked);
  await page.waitForTimeout(5000);
  log('url', page.url());

  // If still home, go seamless while logged in
  if (!/seamless|live/i.test(page.url())) {
    await page.goto(process.env.DOMAIN.replace(/\/$/, '') + '/seamless?gameType=LIVE', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
  }
  await page.waitForTimeout(20000);

  const dump = await page.evaluate(() => ({
    url: location.href,
    logged: (document.body?.innerText || '').toLowerCase().includes('đăng xuất'),
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    htmlIframe: document.querySelector('#seamless-game')?.outerHTML?.slice(0, 500) || null,
    scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src).slice(0, 20),
  }));
  log('DUMP', JSON.stringify(dump, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'diag-net.json'), JSON.stringify(net, null, 2));
  log('net entries', net.length);
  await page.screenshot({ path: path.join(__dirname, '..', 'diag-seamless2.png'), fullPage: true });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
