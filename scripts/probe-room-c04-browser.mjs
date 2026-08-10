/**
 * Puppeteer: login FE → /casino/room/C04 → capture API + UI state.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH = 'http://localhost:1235';
const FE = 'http://localhost:3000';
const TABLE = 'C04';
const USER = 'bminr88';
const PASS = 'bminr88123';

async function getToken() {
  const r = await fetch(`${AUTH}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error('login failed ' + r.status);
  return b.access_token;
}

const token = await getToken();
const report = { apiCalls: [], page: {} };

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('get-table-by-name')) {
    let body = '';
    try {
      body = await res.text();
    } catch {}
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    report.apiCalls.push({
      status: res.status(),
      len: body.length,
      tableName: parsed.tableName,
      totalRound: Array.isArray(parsed.totalRound) ? parsed.totalRound.length : 0,
      hasPercent: !!parsed.percentCurrent,
      round: parsed.percentCurrent?.round || parsed.percentCurrent?.Round,
    });
  }
});

await page.setCookie({
  name: 'access_token',
  value: token,
  domain: 'localhost',
  path: '/',
});

await page.goto(`${FE}/casino/room/${TABLE}`, {
  waitUntil: 'networkidle2',
  timeout: 90000,
});
await new Promise((r) => setTimeout(r, 6000));

report.page.url = page.url();
report.page.title = await page.title();
report.page.text = (await page.evaluate(() => document.body.innerText))
  .replace(/\s+/g, ' ')
  .slice(0, 600);

const out = path.join(__dirname, '..', 'probe-room-c04-browser.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));

console.log('URL:', report.page.url);
console.log('API calls from FE:', report.apiCalls);
console.log('Page text:', report.page.text.slice(0, 250));
console.log('Report:', out);

await browser.close();
process.exit(report.apiCalls.some((c) => c.status === 200 && c.totalRound > 0) ? 0 : 1);
