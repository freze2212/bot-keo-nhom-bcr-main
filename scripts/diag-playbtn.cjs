const { firefox } = require('playwright');
const path = require('path');
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
  let session = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const cookie = response.request().headers().cookie || '';
      const m = cookie.match(/JSESSIONID=([^;]+)/i);
      const um = url.match(/jsessionid=([^?&;/]+)/i);
      const sid = (m && m[1]) || (um && um[1]);
      if (sid && !session) {
        session = sid;
        log('GOT', sid, url.slice(0, 100));
      }
      if (/jsessionid|gctpjt|bpcdf|queryInit|launch|seamless/i.test(url)) {
        log('XHR', response.status(), url.slice(0, 150));
      }
    } catch (_) {}
  });

  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() =>
    document.querySelectorAll('.close-btn,.tcg_modal_close').forEach((e) => e.click())
  );
  await page.evaluate(() => document.querySelector('.hd_login .submit_btn, .submit_btn')?.click());
  await page.waitForTimeout(1200);
  await page.fill('.username_input', user, { force: true });
  await page.fill('.password_input', pass, { force: true });
  await page.evaluate(() =>
    document.querySelector('button[type="submit"].submit_btn')?.click()
  );
  await page.waitForTimeout(10000);
  await page.evaluate(() => document.querySelector('.tcg_modal_close')?.click());
  await page.waitForTimeout(2000);

  let logged = await page.evaluate(() =>
    (document.body?.innerText || '').toLowerCase().includes('đăng xuất')
  );
  log('logged', logged, user);
  if (!logged) {
    log('LOGIN FAIL');
    await browser.close();
    process.exit(3);
  }

  // LIVE menu -> SEXY CASINO (dropdown) — giữ session, không goto /live
  await page.locator('div.nav_item_btn.LIVE').first().click({ force: true });
  await page.waitForTimeout(1200);
  await page.locator('span.game_name').filter({ hasText: /^SEXY/i }).first().click({ force: true });
  await page.waitForTimeout(8000);
  log('url1', page.url());

  logged = await page.evaluate(() =>
    (document.body?.innerText || '').toLowerCase().includes('đăng xuất')
  );
  log('stillLogged', logged);

  // Nếu đang ở /live hoặc trang vendor — click Chơi ngay
  const playBtn = page.locator('.play-btn').first();
  if (await playBtn.count()) {
    log('click play-btn');
    await playBtn.click({ force: true });
    await page.waitForTimeout(12000);
  } else {
    log('no play-btn on', page.url());
  }
  log('url2', page.url());

  // poll
  for (let i = 0; i < 25; i++) {
    const info = await page.evaluate(() => {
      const f = document.querySelector('#seamless-game');
      return {
        src: (f && f.src) || '',
        frames: [...document.querySelectorAll('iframe')].map((x) => ({
          id: x.id,
          src: (x.src || '').slice(0, 120),
        })),
        body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      };
    });
    log('poll', i, 'srcLen', info.src.length, JSON.stringify(info.frames).slice(0, 180));
    if (session || (info.src && info.src.length > 20)) break;
    // retry play-btn
    if (i === 5 || i === 12) {
      await page.locator('.play-btn').first().click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(3000);
  }

  if (session) {
    const axios = require('axios');
    const url = process.env.URI_REQUEST_DATA + session;
    const payload = new URLSearchParams();
    payload.append('gameGroupId', 2);
    try {
      const r = await axios.post(url, payload, { timeout: 15000 });
      log('HALL', 'tables=', r.data?.tableItems?.length || 0);
    } catch (e) {
      log('HALL fail', e.message);
    }
  }

  log('RESULT', session || 'NONE');
  await page.screenshot({
    path: path.join(__dirname, '..', 'diag-playbtn.png'),
    fullPage: true,
  });
  await browser.close();
  process.exit(session ? 0 : 2);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
