import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/aed-iso';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

await page.route('**/basemaps.cartocdn.com/**', (r) => r.abort());
await page.route('**/api.mapbox.com/styles/**', (r) => r.abort());
// izochrona wokół SP6 (18.99944,50.14593) — nieregularny wielokąt (mock realnego kształtu)
let isoCalled = 0;
await page.route('**/isochrone/v1/mapbox/walking/**', (r) => {
  isoCalled++;
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { contour: 4 }, geometry: { type: 'Polygon', coordinates: [[
      [18.9940,50.1500],[18.9975,50.1495],[19.0010,50.1470],[19.0005,50.1445],
      [18.9970,50.1430],[18.9930,50.1435],[18.9905,50.1460],[18.9915,50.1490],[18.9940,50.1500]
    ]] } }],
  }) });
});

await page.goto('file://' + path.resolve('index.html') + '?mbtoken=pk.test_dummy', { waitUntil: 'load' });
await page.waitForSelector('.aed-icon');

// otwórz dowolny popup AED i kliknij „Obszar dojścia 4 min"
await page.locator('.aed-icon').first().click();
await page.waitForSelector('a[data-iso]');
await page.click('a[data-iso]');
await page.waitForTimeout(700);

const isoLayers = await page.evaluate(() => layers.iso.getLayers().length);
const hint = await page.locator('.route-hint').innerText().catch(() => '(brak)');
await page.screenshot({ path: `${OUT}/iso.png` });

console.log(JSON.stringify({
  isoCalled, isoLayersDrawn: isoLayers, hint: hint.replace(/\s+/g, ' ').trim(), errors,
}, null, 2));
await browser.close();
if (errors.length) process.exitCode = 2;
