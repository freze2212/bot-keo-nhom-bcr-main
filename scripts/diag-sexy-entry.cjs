const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(process.env.DOMAIN, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);
  await page.locator('.close-btn').first().click({ force: true, timeout: 3000 }).catch(() => {});
  await page.locator('.hd_login .submit_btn, .submit_btn').first().click({ force: true });
  await page.waitForTimeout(1500);
  await page.fill('.username_input', 'bminr88', { force: true });
  await page.fill('.password_input', 'bminr88123', { force: true });
  await page.locator('button[type="submit"].submit_btn').click({ force: true });
  await page.waitForTimeout(8000);
  await page.locator('.tcg_modal_close').first().click({ force: true, timeout: 5000 }).catch(() => {});

  // click LIVE menu
  await page
    .locator('div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1')
    .click({ force: true, timeout: 15000 })
    .catch(async () => {
      await page.getByText('LIVE', { exact: false }).first().click({ force: true });
    });
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('a, button, div, span')]
      .filter((el) => {
        const t = (el.textContent || '').trim();
        const c = el.className?.toString?.() || '';
        return (
          /chơi|play|vào|sexy|sảnh/i.test(t) ||
          /play/i.test(c)
        );
      })
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName,
        class: String(el.className).slice(0, 80),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
        visible: !!(el.offsetWidth || el.offsetHeight),
      }));
    return {
      url: location.href,
      playBtn: !!document.querySelector('.play-btn'),
      candidates,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(__dirname, '..', 'diag-sexy.png'), fullPage: true });
  await browser.close();
})();
