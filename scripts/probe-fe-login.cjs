const { firefox } = require('playwright');
(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (/auth\/login|get-all-table|get-table-by-name|C04/i.test(u)) {
      logs.push(`${r.status()} ${u.slice(0, 120)}`);
    }
  });
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  // fill login if form present
  const user = page.locator('input[type="text"], input[name="username"], .login-field__input').first();
  const pass = page.locator('input[type="password"]').first();
  if (await user.count()) {
    await user.fill('frezefe01');
    await pass.fill('frezefe123');
    await page.locator('button:has-text("Đăng nhập"), button[type="submit"]').first().click({ force: true });
    await page.waitForTimeout(4000);
  }
  await page.goto('http://localhost:3000/casino', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const lobby = await page.evaluate(() => ({
    url: location.href,
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 250),
    hasC04: /C04/i.test(document.body?.innerText || ''),
  }));
  console.log('LOBBY', JSON.stringify(lobby));
  await page.goto('http://localhost:3000/casino/room/C04', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const room = await page.evaluate(() => ({
    url: location.href,
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    hasRound: /C04|Player|Banker|round|ván/i.test(document.body?.innerText || ''),
  }));
  console.log('ROOM', JSON.stringify(room));
  console.log('API', logs.slice(0, 20));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
