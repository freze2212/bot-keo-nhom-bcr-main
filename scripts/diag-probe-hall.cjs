const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

async function probeHall(label, baseUrl, sessionId) {
  const url = baseUrl + sessionId;
  const payload = new URLSearchParams();
  payload.append('gameGroupId', 2);
  try {
    const r = await axios.post(url, payload, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.rr2299.com',
        Referer: 'https://www.rr2299.com/',
      },
      validateStatus: () => true,
    });
    const tables = r.data?.tableItems?.length;
    log(
      'PROBE',
      label,
      'http',
      r.status,
      'status',
      r.data?.status,
      'tables',
      tables,
      'keys',
      r.data && Object.keys(r.data).slice(0, 8).join(',')
    );
    return tables > 0;
  } catch (e) {
    log('PROBE fail', label, e.message);
    return false;
  }
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
  await page.waitForTimeout(4000);
  if (!/seamless/i.test(page.url())) {
    await page.goto(
      process.env.DOMAIN.replace(/\/$/, '') + '/seamless?gameType=LIVE',
      { waitUntil: 'domcontentloaded', timeout: 120000 }
    );
  }

  // wait for hall traffic
  await page.waitForTimeout(15000);

  const cookies = await context.cookies();
  const jsessions = cookies.filter((c) => c.name.toUpperCase() === 'JSESSIONID');
  log(
    'JSESSIONS',
    jsessions.map((c) => `${c.domain}=${c.value}`).join(' || ')
  );
  log(
    'ALL domains',
    [...new Set(cookies.map((c) => c.domain))].join(', ')
  );

  const bases = [
    'https://bpcdf.gctpjt77.com/player/query/queryInitWebGameHall;jsessionid=',
    'https://bpcdf.doerkm88.com/player/query/queryInitWebGameHall;jsessionid=',
    'https://bpcdf.awsgroup06.com/player/query/queryInitWebGameHall;jsessionid=',
  ];

  let ok = null;
  for (const j of jsessions) {
    for (const base of bases) {
      const good = await probeHall(`${j.domain} -> ${base.split('/')[2]}`, base, j.value);
      if (good) {
        ok = { domain: j.domain, value: j.value, base };
        break;
      }
    }
    if (ok) break;
  }

  log('BEST', JSON.stringify(ok));
  await browser.close();
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
