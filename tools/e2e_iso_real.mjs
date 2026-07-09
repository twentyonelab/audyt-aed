import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const TOKEN = process.env.MB_TOKEN;
if (!TOKEN) { console.error('brak MB_TOKEN'); process.exit(1); }
const OUT = process.env.OUT_DIR || '/tmp/aed-e2e';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource|tile/i.test(m.text())) errors.push('console: ' + m.text()); });

// kafelki: pomijamy (sandbox i tak ich nie wypuści); API relay przez curl (działa przez proxy)
await page.route('**/basemaps.cartocdn.com/**', (r) => r.abort());
await page.route('**/api.mapbox.com/styles/**', (r) => r.abort());
async function relay(route) {
  const url = route.request().url();
  try {
    const body = execFileSync('curl', ['-sS', '--max-time', '30', url], { maxBuffer: 20 * 1024 * 1024 });
    route.fulfill({ status: 200, contentType: 'application/json', body });
  } catch (e) { route.fulfill({ status: 502, body: String(e) }); }
}
await page.route('**/isochrone/v1/**', relay);
await page.route('**/directions/v5/**', relay);

await page.goto('file://' + path.resolve('index.html') + '?mbtoken=' + TOKEN, { waitUntil: 'load' });
await page.waitForSelector('.aed-icon');

const n = await page.evaluate(() => {
  window.__aed = []; layers.aeds.eachLayer((m) => window.__aed.push(m)); return window.__aed.length;
});

const results = [];
for (let i = 0; i < n; i++) {
  // wyczyść poprzednią + domknij popupy + otwórz popup i-tego AED
  await page.evaluate((i) => { cancelRoute(); map.closePopup(); window.__aed[i].openPopup(); }, i);
  const link = page.locator('.leaflet-popup a[data-iso]').first();
  let clicked = false, verts = 0, err = '';
  try {
    await link.waitFor({ state: 'visible', timeout: 3000 });
    await link.click();
    clicked = true;
    // czekaj aż izochrona się narysuje (warstwa geoJSON + marker = 2 warstwy)
    await page.waitForFunction(() => layers.iso.getLayers().length >= 1, { timeout: 12000 });
    verts = await page.evaluate(() => {
      let v = 0;
      layers.iso.eachLayer((l) => { if (l.getLayers) l.eachLayer((p) => { const ll = p.getLatLngs && p.getLatLngs(); if (ll && ll[0]) v = ll[0].length; }); });
      return v;
    });
  } catch (e) { err = e.message.split('\n')[0]; }
  const label = await page.evaluate((i) => window.__aed[i].getPopup().getContent().match(/<b>(.*?)<\/b>/)?.[1] || '?', i).catch(() => '?');
  results.push({ i, clicked, verts, err });
  if (i < 3 || err) console.error(`  AED[${i}] clicked=${clicked} verts=${verts} ${err ? 'ERR=' + err : ''}`);
}
await page.evaluate(() => { cancelRoute(); window.__aed[29] && window.__aed[29].openPopup(); });
await page.click('a[data-iso]').catch(() => {});
await page.waitForFunction(() => layers.iso.getLayers().length >= 1, { timeout: 12000 }).catch(() => {});
await page.screenshot({ path: `${OUT}/iso-real.png` });

const okCount = results.filter((r) => r.clicked && r.verts > 2).length;
console.log(JSON.stringify({
  points: n, drawnOk: okCount,
  failed: results.filter((r) => !(r.clicked && r.verts > 2)),
  vertsSample: results.slice(0, 5).map((r) => r.verts),
  errors,
}, null, 2));
await browser.close();
if (okCount !== n || errors.length) process.exitCode = 2;
