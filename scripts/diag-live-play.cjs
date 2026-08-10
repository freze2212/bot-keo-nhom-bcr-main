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
  const headed = process.argv.includes('--headed');

  const browser = await firefox.launch({ headless: !headed, slowMo: headed ? 50 : 0 });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      process.env.USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  });
  const page = await context.newPage();
  const allReqs = [];

  page.on('request', (req) => {
    const u = req.url();
    if (!/\.(png|jpg|jpeg|gif|css|woff2?|svg)(\?|$)/i.test(u)) {
      allReqs.push(u.slice(0, 200));
    }
  });
  page.on('console', (msg) => {
    if (/error|fail|block|waf|restrict/i.test(msg.text())) log('CONSOLE', msg.text().slice(0, 160));
  });

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
  await page.waitForTimeout(9000);
  await page.evaluate(() => document.querySelector('.tcg_modal_close')?.click());

  // Go to /live lobby
  await page.goto(process.env.DOMAIN.replace(/\/$/, '') + '/live', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForTimeout(6000);

  const liveInfo = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('a,button,div,span')]
      .filter((el) => /sexy|chơi|play|vào game|baccarat/i.test((el.textContent || '').trim()))
      .slice(0, 30)
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 60),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      }));
    return {
      url: location.href,
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      texts,
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({
        id: f.id,
        src: (f.src || '').slice(0, 100),
      })),
    };
  });
  log('LIVE', JSON.stringify(liveInfo, null, 2));
  fs.writeFileSync(
    path.join(__dirname, '..', 'diag-live.json'),
    JSON.stringify(liveInfo, null, 2)
  );
  await page.screenshot({
    path: path.join(__dirname, '..', 'diag-live.png'),
    fullPage: true,
  });

  // Try click any SEXY / play
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,button,div,span')];
    const target =
      els.find((el) => /SEXY\s*CASINO/i.test(el.textContent || '')) ||
      els.find((el) => /sexy/i.test(el.textContent || '') && /chơi|play|vào/i.test(el.textContent || '')) ||
      els.find((el) => (el.className || '').toString().includes('play-btn'));
    if (target) {
      target.click();
      return (target.textContent || '').trim().slice(0, 40);
    }
    return null;
  });
  log('clicked', clicked);
  await page.waitForTimeout(15000);
  log('afterClick url', page.url());

  const after = await page.evaluate(() => ({
    url: location.href,
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({
      id: f.id,
      src: (f.src || '').slice(0, 160),
    })),
  }));
  log('AFTER', JSON.stringify(after));
  await page.screenshot({
    path: path.join(__dirname, '..', 'diag-after-play.png'),
    fullPage: true,
  });

  // interesting network
  const interesting = allReqs.filter((u) =>
    /seamless|launch|sexy|gctpjt|bpcdf|jsession|game|vendor|api/i.test(u)
  );
  log('interesting reqs', interesting.length);
  interesting.slice(0, 40).forEach((u) => log('REQ', u));

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
