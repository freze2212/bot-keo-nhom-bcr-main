const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

(async () => {
  const user = process.argv[2] || 'bminr88';
  const pass = process.argv[3] || 'bminr88123';

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

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

  await page.locator('div.nav_item_btn.LIVE').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('span.game_name')].find((x) =>
      /SEXY/i.test(x.textContent || '')
    );
    (s?.closest('a') || s?.parentElement || s)?.click();
  });
  await page.waitForTimeout(5000);

  if (!/seamless/i.test(page.url())) {
    await page.goto(
      process.env.DOMAIN.replace(/\/$/, '') + '/seamless?gameType=LIVE',
      { waitUntil: 'domcontentloaded', timeout: 120000 }
    );
  }

  let found = null;
  for (let i = 0; i < 25; i++) {
    const cookies = await context.cookies();
    const interesting = cookies.filter(
      (c) =>
        /jsession/i.test(c.name) ||
        /gctpjt|bpcdf|godbac|sexy|botion/i.test(c.domain)
    );
    log(
      'poll',
      i,
      'n=',
      cookies.length,
      interesting.map((c) => `${c.name}@${c.domain}=${String(c.value).slice(0, 24)}`).join(' | ')
    );
    const jsession = cookies.find((c) => c.name.toUpperCase() === 'JSESSIONID');
    if (jsession) {
      found = jsession.value;
      log('FOUND', jsession.domain, found);
      const url = process.env.URI_REQUEST_DATA + found;
      const payload = new URLSearchParams();
      payload.append('gameGroupId', 2);
      try {
        const r = await axios.post(url, payload, { timeout: 15000 });
        log('HALL tables', r.data?.tableItems?.length, 'status', r.data?.status);
      } catch (e) {
        log('HALL fail', e.message);
      }
      break;
    }
    await page.waitForTimeout(3000);
  }

  if (!found) {
    const all = await context.cookies();
    log(
      'ALL',
      all.map((c) => `${c.name}@${c.domain}`).join(', ')
    );
  }

  log('RESULT', found || 'NONE');
  await browser.close();
  process.exit(found ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
