const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(5000);

  // close overlays
  for (const sel of ['.close-btn', '.tcg_modal_close', '[class*="close"]']) {
    const els = await page.$$(sel);
    for (const el of els.slice(0, 5)) {
      await el.click({ force: true, timeout: 1000 }).catch(() => {});
    }
  }
  await page.waitForTimeout(1000);

  await page.locator('.hd_login .submit_btn, .submit_btn').first().click({ force: true, timeout: 10000 });
  console.log('opened login');
  await page.waitForTimeout(2000);

  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input')].map((i) => ({
      type: i.type,
      class: i.className,
      placeholder: i.placeholder,
      visible: !!(i.offsetWidth || i.offsetHeight),
    }))
  );
  console.log('inputs', inputs);

  const userSel = process.env.INPUT_USERNAME_LOGIN || '.username_input';
  const passSel = process.env.INPUT_PASSWORD_LOGIN || '.password_input';
  await page.fill(userSel, 'bminr88', { force: true, timeout: 10000 }).catch(async (e) => {
    console.log('fill user fail', e.message.slice(0, 80));
    // try placeholders
    const alt = await page.locator('input[type="text"], input[placeholder*="Tên"], input[placeholder*="tài"]').first();
    await alt.fill('bminr88', { force: true });
    console.log('filled via alt');
  });
  await page.fill(passSel, 'bminr88123', { force: true, timeout: 10000 }).catch(async (e) => {
    console.log('fill pass fail', e.message.slice(0, 80));
    await page.locator('input[type="password"]').first().fill('bminr88123', { force: true });
  });
  await page.locator('button[type="submit"].submit_btn, .login_btn, button:has-text("Đăng nhập")').first().click({ force: true });
  await page.waitForTimeout(8000);
  console.log('url', page.url());
  console.log('body', (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: path.join(__dirname, '..', 'diag-login2.png') });
  await browser.close();
})();
