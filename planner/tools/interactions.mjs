#!/usr/bin/env node
/**
 * interactions.mjs — checks the map interactions that smoke.mjs does not touch:
 * click-to-add on both maps, drag that must not open anything, undo, the camera
 * surviving a re-render, and the district outlines being gone.
 *
 *   node tools/interactions.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(SHOTS, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 900));

const errors = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const go = async (hash, wait = 1000) => {
  await page.goto(`${BASE}/index.html${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
};

/** Count of purple recommendation squares currently in state. */
const proposedCount = () =>
  page.evaluate(() => window.__aed.points.filter((p) => p.kind === 'proposed' && p.status !== 'rejected').length);

const mapBox = async () => (await page.locator('.map-wrap').first().boundingBox());

console.log('\n── AED Planner — interakcje mapy\n');

/* ---------------------------------------------------------------- *
 * 1. Obrysy dzielnic zniknęły z inwentaryzacji i analizy
 * ---------------------------------------------------------------- */

await go('#/inventory');
const invPolys = await page.locator('.map-fallback svg path[fill="#e8e8e4"], .map-fallback svg polygon').count();
check('inwentaryzacja: brak wypełnionych obrysów dzielnic', invPolys === 0, `${invPolys} wielokątów`);

await go('#/analysis');
const anaPolys = await page.locator('.map-fallback svg path[fill="#e8e8e4"], .map-fallback svg polygon').count();
check('analiza: brak wypełnionych obrysów dzielnic', anaPolys === 0, `${anaPolys} wielokątów`);

/* ---------------------------------------------------------------- *
 * 2. Klik w mapę analizy dodaje fioletową rekomendację
 * ---------------------------------------------------------------- */

const before = await proposedCount();
let box = await mapBox();
await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.58);
await page.waitForTimeout(900);
const after = await proposedCount();
check('analiza: klik w mapę dodaje rekomendację', after === before + 1, `${before} → ${after}`);

const lastKind = await page.evaluate(() => {
  const p = window.__aed.points[window.__aed.points.length - 1];
  return `${p.id}/${p.kind}/${p.status}`;
});
check('analiza: nowy punkt to propozycja NEW-', /^NEW-\d+\/proposed\/proposed$/.test(lastKind), lastKind);

const squares = await page.locator('.map-fallback svg rect[fill="#8a6fc7"]').count();
check('analiza: rekomendacje rysują się jako fioletowe kwadraty', squares >= after, `${squares} kwadratów`);

/* Podwójny klik przybliża — i nie dokłada przy okazji dwóch punktów. */
const beforeDbl = await proposedCount();
box = await mapBox();
await page.mouse.dblclick(box.x + box.width * 0.6, box.y + box.height * 0.35);
await page.waitForTimeout(1000);
const afterDbl = await proposedCount();
check('analiza: podwójny klik nie dodaje punktów (przybliża)', afterDbl === beforeDbl, `${beforeDbl} → ${afterDbl}`);

/* ---------------------------------------------------------------- *
 * 3. Cofnij odwraca ostatnią zmianę
 * ---------------------------------------------------------------- */

const undoEnabled = await page.locator('.topbar__undo').isEnabled();
check('pasek górny: przycisk Cofnij aktywny po zmianie', undoEnabled);

await page.locator('.topbar__undo').click();
await page.waitForTimeout(900);
const afterUndo = await proposedCount();
check('Cofnij usuwa dodaną rekomendację', afterUndo === before, `${after} → ${afterUndo}`);

const undoDisabledNow = await page.locator('.topbar__undo').isDisabled();
check('Cofnij wyłącza się, gdy stos jest pusty', undoDisabledNow);

/* ---------------------------------------------------------------- *
 * 4. Kadr przeżywa przesunięcie pinu
 * ---------------------------------------------------------------- */

// Przybliż mapę kółkiem, potem przeciągnij propozycję i sprawdź, czy skala została.
const spread = () =>
  page.evaluate(() => {
    // Rozstęp dwóch pierwszych punktów popytu rośnie proporcjonalnie do skali,
    // więc jest wygodnym miernikiem kadru mapy zapasowej.
    const dots = [...document.querySelectorAll('.map-fallback svg circle:not([stroke])')].slice(0, 2);
    if (dots.length < 2) return null;
    const dx = +dots[1].getAttribute('cx') - +dots[0].getAttribute('cx');
    const dy = +dots[1].getAttribute('cy') - +dots[0].getAttribute('cy');
    return Math.round(Math.hypot(dx, dy) * 100) / 100;
  });

const spreadFitted = await spread();
box = await mapBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(400);

const scaleBefore = await spread();
check(
  'mapa zapasowa: kółko realnie przybliża',
  spreadFitted !== null && scaleBefore !== null && scaleBefore > spreadFitted * 1.2,
  `${spreadFitted} → ${scaleBefore}`
);

// Przeciągnij pierwszą propozycję (fioletowy kwadrat) o kawałek.
const coordsOf = () =>
  page.evaluate(() => {
    const all = [...window.__aed.points, ...window.__aed.pendingProposals];
    return all.map((p) => `${p.lat},${p.lon}`).join('|');
  });
const coordsBefore = await coordsOf();
const sq = page.locator('.map-fallback svg rect[fill="#8a6fc7"]').first();
const sqBox = await sq.boundingBox();
if (sqBox) {
  await page.mouse.move(sqBox.x + sqBox.width / 2, sqBox.y + sqBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sqBox.x + 60, sqBox.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1100);
}

check('analiza: przeciągnięcie faktycznie zmieniło współrzędne', (await coordsOf()) !== coordsBefore);

const scaleAfter = await spread();
check(
  'po przesunięciu pinu kadr zostaje (mapa się nie oddala)',
  scaleBefore !== null && scaleAfter !== null && Math.abs(scaleAfter - scaleBefore) < 0.6,
  `${scaleBefore} → ${scaleAfter}`
);

/* ---------------------------------------------------------------- *
 * 5. Przeciągnięcie pinu niczego nie otwiera
 * ---------------------------------------------------------------- */

const hashAfterDrag = await page.evaluate(() => window.location.hash);
check('przeciągnięcie pinu nie otwiera karty punktu', hashAfterDrag === '#/analysis', hashAfterDrag);

/* Inwentaryzacja: przeciągnięcie uzbrojonego pinu nie otwiera mini-karty. */
await go('#/inventory');
await page.locator('.list-row, .row-item, tr').first().click().catch(() => {});
await page.waitForTimeout(500);

const moveBtn = page.locator('button', { hasText: /PRZESU/i }).first();
if (await moveBtn.count()) {
  await moveBtn.click();
  await page.waitForTimeout(600);
  const pin = page.locator('.map-fallback svg circle[stroke], .map-fallback svg rect[stroke]').first();
  const pinBox = await pin.boundingBox();
  if (pinBox) {
    await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(pinBox.x + 50, pinBox.y + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1100);
  }
  const invHash = await page.evaluate(() => window.location.hash);
  check('inwentaryzacja: przeciągnięcie pinu zostaje w widoku', invHash === '#/inventory', invHash);
  check('inwentaryzacja: przeciągnięcie zapisało nową pozycję (Cofnij aktywny)', await page.locator('.topbar__undo').isEnabled());
} else {
  check('inwentaryzacja: przycisk przesunięcia dostępny', false, 'nie znaleziono przycisku');
}

/* ---------------------------------------------------------------- *
 * 6. Klik w mapę inwentaryzacji nadal proponuje dodanie punktu
 * ---------------------------------------------------------------- */

await go('#/inventory');
box = await mapBox();
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.7);
await page.waitForTimeout(600);
const promptVisible = await page.locator('text=Dodaj punkt tutaj').count();
check('inwentaryzacja: klik w mapę proponuje dodanie punktu', promptVisible > 0);

/* ---------------------------------------------------------------- *
 * 7. Filtr dzielnicy: podświetlenie + wygaszenie punktów
 * ---------------------------------------------------------------- */

await go('#/inventory');
const districtSelect = page.locator('.chips select').first();
check('inwentaryzacja: pogrubiona etykieta Dzielnica:', (await page.locator('.chips b', { hasText: 'Dzielnica:' }).count()) > 0);
await districtSelect.selectOption({ index: 1 });
await page.waitForTimeout(600);

const dimmedPins = await page.locator('.map-fallback svg [stroke][opacity="0.2"]').count();
check('filtr dzielnicy wygasza punkty spoza niej do 20%', dimmedPins > 0, `${dimmedPins} wygaszonych`);
const highlight = await page.locator('.map-fallback svg path[stroke="#4caf7d"]').count();
check('wybrana dzielnica jest podświetlona na mapie', highlight > 0);
await page.screenshot({ path: join(SHOTS, 'interactions-district-filter.png') });

await page.locator('.chips .chip').first().click(); // powrót do „Wszystkie"
await page.waitForTimeout(400);
check(
  'zdjęcie filtra gasi podświetlenie',
  (await page.locator('.map-fallback svg path[stroke="#4caf7d"]').count()) === 0
);

check('legenda: kwadrat rekomendacji pod statusami', (await page.locator('.map-legend .dot--square').count()) > 0);

/* ---------------------------------------------------------------- *
 * 8. Ocena ekspercka: zapis i trwałość
 * ---------------------------------------------------------------- */

await go('#/card/AED-003', 1400);
await page.locator('button', { hasText: /ROZWIŃ WSZYSTKIE/i }).first().click();
await page.waitForTimeout(300);
const slider = page.locator('.score-crit input[type=range]').first();
await slider.evaluate((el) => {
  el.value = '8';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(900);
const badge = await page.locator('.panel--card .score-badge').first().innerText();
check('ocena ekspercka liczy się i pokazuje w panelu', /\d/.test(badge), badge);

await go('#/cards', 1200);
const listBadge = await page.locator('.table .score-badge').count();
check('ocena widoczna w liście kart', listBadge > 0, `${listBadge} ocen`);

/* ---------------------------------------------------------------- *
 * 9. Raport: sekcja kart punktów + osobne PDF-y
 * ---------------------------------------------------------------- */

await go('#/report', 1600);
const cardsTab = page.locator('.subbar__controls .seg__btn', { hasText: /karty punktów/i }).first();
check('raport: przełącznik dwóch sekcji', (await cardsTab.count()) > 0);
await cardsTab.click();
await page.waitForTimeout(800);

const pdfBtn = page.locator('tbody button', { hasText: 'POBIERZ PDF' }).first();
check('raport: lista kart z przyciskami PDF', (await pdfBtn.count()) > 0);

const [pdfDl] = await Promise.all([page.waitForEvent('download'), pdfBtn.click()]);
const pdfPath = await pdfDl.path();
const pdfHead = readFileSync(pdfPath).subarray(0, 5).toString('latin1');
check('pojedyncza karta pobiera się jako PDF', pdfHead === '%PDF-', `${pdfDl.suggestedFilename()} · ${pdfHead}`);

const zipBtn = page.locator('button', { hasText: /POBIERZ WSZYSTKIE/ }).first();
const [zipDl] = await Promise.all([page.waitForEvent('download'), zipBtn.click()]);
const zipBytes = readFileSync(await zipDl.path());
check(
  'eksport wszystkich kart to ZIP z osobnymi PDF-ami',
  zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes.length > 10000,
  `${zipDl.suggestedFilename()} · ${Math.round(zipBytes.length / 1024)} KB`
);
await page.screenshot({ path: join(SHOTS, 'interactions-report-cards.png') });

/* ---------------------------------------------------------------- *
 * 10. Karta punktu mieści się na węższym oknie (zgłoszony bug)
 * ---------------------------------------------------------------- */

await page.setViewportSize({ width: 1200, height: 900 });
await go('#/card/AED-003', 1200);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('karta punktu: brak poziomego przewijania przy 1200 px', overflow <= 1, `${overflow}px nadmiaru`);
await page.setViewportSize({ width: 1560, height: 940 });

/* ---------------------------------------------------------------- *
 * 11. Nawigacja: Pulpit na górze steppera
 * ---------------------------------------------------------------- */

await go('#/inventory', 900);
const firstStep = await page.locator('.stepper .stepper__item').first().innerText();
check('Pulpit jest pierwszą pozycją nawigacji', /pulpit/i.test(firstStep), firstStep.replace(/\s+/g, ' '));

await go('#/inventory');
await page.screenshot({ path: join(SHOTS, 'interactions-inventory.png') });
await go('#/analysis');
await page.screenshot({ path: join(SHOTS, 'interactions-analysis.png') });

// Mapbox jest w tym sandboksie odcięty — to właśnie dlatego renderuje się mapa
// zapasowa, więc jego błędy sieciowe nie są usterką aplikacji.
const realErrors = errors.filter((e) => !/mapbox|Failed to load resource|net::ERR|favicon/i.test(e));
check('brak błędów w konsoli', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
stop();

console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
