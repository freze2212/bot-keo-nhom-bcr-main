const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);
  await page.click('.close-btn', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // try open login
  for (const sel of ['.hd_login .submit_btn', '.hd_login', 'text=ĐĂNG NHẬP', '.submit_btn']) {
    try {
      const el = await page.$(sel.startsWith('text=') ? null : sel);
      if (sel.startsWith('text=')) {
        await page.getByText('ĐĂNG NHẬP', { exact: false }).first().click({ timeout: 3000 });
      } else if (el && (await el.isVisible())) {
        await el.click({ timeout: 3000 });
      } else continue;
      console.log('clicked', sel);
      break;
    } catch (e) {
      console.log('fail click', sel, e.message.slice(0, 60));
    }
  }
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map((i) => ({
      type: i.type,
      name: i.name,
      class: i.className,
      placeholder: i.placeholder,
      visible: !!(i.offsetWidth || i.offsetHeight),
    }));
    const btns = [...document.querySelectorAll('button, .submit_btn, [class*="login"]')]
      .slice(0, 20)
      .map((b) => ({
        tag: b.tagName,
        class: b.className,
        text: (b.textContent || '').trim().slice(0, 40),
        visible: !!(b.offsetWidth || b.offsetHeight),
      }));
    return { inputs, btns, url: location.href };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(__dirname, '..', 'diag-login.png') });
  await browser.close();
})();
