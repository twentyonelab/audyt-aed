import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/aed-route';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

// utnij kafelki (brak sieci w sandboksie), zamockuj Directions realnym kształtem trasy
await page.route('**/basemaps.cartocdn.com/**', (r) => r.abort());
await page.route('**/api.mapbox.com/styles/**', (r) => r.abort());
let directionsCalled = 0;
await page.route('**/directions/v5/mapbox/walking/**', (r) => {
  directionsCalled++;
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 842.5, duration: 611.4, geometry: { type: 'LineString',
      coordinates: [[18.9985,50.1150],[18.9990,50.1158],[18.9998,50.1163],[19.0007,50.1169]] } }],
  }) });
});

// token w URL -> tryb Mapbox + Directions aktywne
await page.goto('file://' + path.resolve('index.html') + '?mbtoken=pk.test_dummy', { waitUntil: 'load' });
await page.waitForSelector('.aed-icon');

// otwórz popup pierwszego AED i kliknij „Trasa piesza stąd"
await page.locator('.aed-icon').first().click();
await page.waitForSelector('a[data-route]');
await page.click('a[data-route]');
const hintShown = await page.locator('.route-hint').isVisible();
const active = await page.evaluate(() => routeState.active);

// kliknij mapę jako punkt docelowy
await page.locator('#map').click({ position: { x: 900, y: 500 } });
await page.waitForTimeout(600);

const routeLayers = await page.evaluate(() => layers.route.getLayers().length);
const popupText = await page.locator('.leaflet-popup-content').innerText().catch(() => '(brak popupu)');
await page.screenshot({ path: `${OUT}/route.png` });

console.log(JSON.stringify({
  directionsCalled, hintShown, routeStateActiveAfterStart: active,
  routeLayersDrawn: routeLayers, popupText: popupText.replace(/\s+/g, ' ').trim(),
  errors,
}, null, 2));
await browser.close();
if (errors.length) process.exitCode = 2;
