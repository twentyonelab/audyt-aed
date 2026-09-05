#!/usr/bin/env node
/**
 * bundlecheck.mjs – sprawdza plik samodzielny z dist/.
 *
 * Powód istnienia: sklejka ma własną listę modułów w tools/bundle.py i łatwo
 * o niej zapomnieć, dodając nowy plik do js/. Wersja serwowana działa wtedy
 * dalej, a plik dla klienta wywala się na pierwszym imporcie. Ten test otwiera
 * bundle z file:// i przechodzi po wszystkich widokach.
 *
 *   node tools/bundlecheck.mjs
 */

import { chromium } from 'playwright';
import { unlock } from './unlock.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUNDLE = join(ROOT, 'dist', 'aed-planner-standalone.html');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` – ${detail}` : ''}`);
};

console.log('\n── Plik samodzielny (dist/aed-planner-standalone.html)\n');

if (!existsSync(BUNDLE)) {
  console.log(' FAIL  brak pliku – uruchom python3 tools/bundle.py\n');
  process.exit(1);
}

/* Każdy moduł z js/ musi być na liście sklejki – inaczej wywali się dopiero
   w przeglądarce, i to tylko w wersji samodzielnej. */
const listed = (await import('node:fs')).readFileSync(join(HERE, 'bundle.py'), 'utf8');
const onDisk = [
  ...readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...readdirSync(join(ROOT, 'js', 'views')).filter((f) => f.endsWith('.js')).map((f) => `js/views/${f}`),
];
const notListed = onDisk.filter((p) => !listed.includes(`"${p}"`));
check('każdy moduł z js/ jest na liście sklejki', notListed.length === 0, notListed.join(', ') || `${onDisk.length} modułów`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await unlock(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const VIEWS = [
  ['#/', 'pulpit', '.hero'],
  ['#/setup', 'setup', '.form'],
  ['#/inventory', 'inwentaryzacja', '.map-wrap'],
  ['#/analysis', 'analiza', '.kpi-grid'],
  ['#/cards', 'lista kart', '.table'],
  ['#/card/AED-001', 'karta punktu', '.card-section'],
  ['#/roadmap', 'roadmapa', '.kanban'],
  ['#/report', 'raport', '.report-page'],
];

for (const [hash, label, sel] of VIEWS) {
  await page.goto(`file://${BUNDLE}${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const found = await page.locator(sel).count();
  check(`widok ${label} rysuje się z pliku`, found > 0, `${sel}: ${found}`);
}

// Fotografie muszą jechać w pliku jako data URI, nie jako ścieżki obok.
await page.goto(`file://${BUNDLE}#/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);
const heroBg = await page.evaluate(() => {
  const el = document.querySelector('.hero__photo');
  return el ? getComputedStyle(el).backgroundImage.slice(0, 32) : '';
});
check('zdjęcia są wklejone jako data URI', heroBg.includes('data:image'), heroBg || 'brak');

// Znaczniki na mapie: kropla z ikoną, więc ikony też muszą być w pliku.
await page.goto(`file://${BUNDLE}#/inventory`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
const pins = await page.locator('.map-fallback .pin').count();
const glyphs = await page.locator('.map-fallback .pin path').count();
check('znaczniki mapy mają kształt i ikonę', pins > 0 && glyphs > 0, `${pins} pinów · ${glyphs} ścieżek ikon`);

// Rejestr granic jedzie w pliku jako wklejone dane – w wersji samodzielnej
// nie ma serwera, z którego dałoby się go dociągnąć.
await page.goto(`file://${BUNDLE}#/setup`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const regRows = await page.locator('.registry__row').count();
check('rejestr granic działa też w pliku samodzielnym', regRows > 3, `${regRows} pozycji`);

// Warstwa zagęszczenia liczy się w przeglądarce, więc musi działać offline.
await page.goto(`file://${BUNDLE}#/analysis`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const maskCount = await page.locator('.map-fallback svg path[fill-rule="evenodd"]').count();
check('maska poza granicą jest w pliku samodzielnym', maskCount === 1, `${maskCount} masek`);
await page.locator('.layer-dock__btn').nth(1).click();
await page.waitForTimeout(3000);
const dens = await page.locator('.map-fallback svg .density-dot').count();
check('warstwa zagęszczenia liczy się offline', dens > 1500, `${dens} kropek`);

const real = errors.filter((e) => !/mapbox|net::ERR|favicon|Failed to load resource/i.test(e));
check('brak błędów w konsoli', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
