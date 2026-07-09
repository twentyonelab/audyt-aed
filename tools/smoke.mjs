import { chromium } from 'playwright';
import path from 'node:path';

const FILE = 'file://' + path.resolve('index.html');
const OUT = process.env.OUT_DIR || '/tmp/aed-shots';
import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  headless: true,
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const errors = [];
const tiles = { ok: 0, fail: 0 };
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.url().includes('api.mapbox.com')) (r.ok() ? tiles.ok++ : tiles.fail++); });
page.on('requestfailed', (r) => { if (r.url().includes('api.mapbox.com')) tiles.fail++; });

await page.goto(FILE, { waitUntil: 'load' });
await page.waitForTimeout(500);

// Moduł A — inwentaryzacja
await page.waitForSelector('#inv-rows tr');
const nAed = await page.$$eval('#inv-rows tr', (rows) => rows.length);
const invTiles = await page.$eval('#inv-tiles', (el) => el.innerText.replace(/\s+/g, ' ').trim());
await page.screenshot({ path: `${OUT}/A-inwentaryzacja.png` });

// Moduł B — analiza + rekomendacje
await page.click('.tabs button[data-tab="b"]');
await page.waitForTimeout(200);
const covBefore = await page.$eval('#stats-tiles', (el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
await page.click('#btn-opt');            // wygeneruj rekomendacje (optymalizator)
await page.waitForTimeout(400);
const roadmap = await page.$eval('#roadmap', (el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 100));
await page.screenshot({ path: `${OUT}/B-analiza.png` });

// Moduł C — karta punktu (klik w pierwszy wiersz inwentaryzacji)
await page.click('.tabs button[data-tab="a"]');
await page.waitForTimeout(150);
await page.click('#inv-rows tr:first-child');
await page.waitForTimeout(300);          // openCard przełącza na tab C
const cardTitle = await page.$eval('#card h3', (el) => el.innerText).catch(() => '(brak karty)');
await page.screenshot({ path: `${OUT}/C-karta.png` });

// wait a bit more for tiles
await page.waitForTimeout(1500);

console.log(JSON.stringify({
  nAed, invTiles, covBefore, roadmap, cardTitle,
  mapboxTiles: tiles,
  errors: errors.slice(0, 15),
}, null, 2));

await browser.close();
if (errors.length) process.exitCode = 2;
