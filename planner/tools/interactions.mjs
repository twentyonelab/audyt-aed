#!/usr/bin/env node
/**
 * interactions.mjs – checks the map interactions that smoke.mjs does not touch:
 * click-to-add on both maps, drag that must not open anything, undo, the camera
 * surviving a re-render, and the district outlines being gone.
 *
 *   node tools/interactions.mjs
 */

import { chromium } from 'playwright';
import { unlock } from './unlock.mjs';
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
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` – ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
await unlock(page);
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const go = async (hash, wait = 1000) => {
  await page.goto(`${BASE}/index.html${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
};

/** Count of lime recommendation markers currently in state. */
const proposedCount = () =>
  page.evaluate(() => window.__aed.points.filter((p) => p.kind === 'proposed' && p.status !== 'rejected').length);

const mapBox = async () => (await page.locator('.map-wrap').first().boundingBox());

console.log('\n── AED Planner – interakcje mapy\n');

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
 * 2. Klik w mapę analizy dodaje limonkową rekomendację
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

const squares = await page.locator('.map-fallback svg .pin--proposed').count();
check('analiza: rekomendacje rysują się jako limonkowe znaczniki', squares >= after, `${squares} znaczników`);

/* Podwójny klik przybliża – i nie dokłada przy okazji dwóch punktów. */
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
// Zoom wokół pierwszego limonkowego znacznika – zoom celowany w kursor trzyma
// ten punkt w miejscu, więc znacznik nie ucieknie poza kadr przed przeciąganiem.
const zoomAnchor = await page.locator('.map-fallback svg .pin--proposed').first().boundingBox();
box = await mapBox();
await page.mouse.move(
  zoomAnchor ? zoomAnchor.x + zoomAnchor.width / 2 : box.x + box.width / 2,
  zoomAnchor ? zoomAnchor.y + zoomAnchor.height / 2 : box.y + box.height / 2
);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(400);

const scaleBefore = await spread();
check(
  'mapa zapasowa: kółko realnie przybliża',
  spreadFitted !== null && scaleBefore !== null && scaleBefore > spreadFitted * 1.2,
  `${spreadFitted} → ${scaleBefore}`
);

// Przeciągnij pierwszą propozycję (limonkowy znacznik) o kawałek.
const coordsOf = () =>
  page.evaluate(() => {
    const all = [...window.__aed.points, ...window.__aed.pendingProposals];
    return all.map((p) => `${p.lat},${p.lon}`).join('|');
  });
const coordsBefore = await coordsOf();
const sq = page.locator('.map-fallback svg .pin--proposed').first();
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
  const pin = page.locator('.map-fallback svg .pin').first();
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

const dimmedPins = await page.locator('.map-fallback svg .pin[data-dimmed]').count();
check('filtr dzielnicy wygasza punkty spoza niej do 20%', dimmedPins > 0, `${dimmedPins} wygaszonych`);
const highlight = await page.locator('.map-fallback svg path[stroke="#0c9331"]').count();
check('wybrana dzielnica jest podświetlona na mapie', highlight > 0, `${highlight} obrysów`);
await page.screenshot({ path: join(SHOTS, 'interactions-district-filter.png') });

await page.locator('.chips .chip').first().click(); // powrót do „Wszystkie"
await page.waitForTimeout(400);
check(
  'zdjęcie filtra gasi podświetlenie',
  (await page.locator('.map-fallback svg path[stroke="#0c9331"]').count()) === 0
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
const pdfBytes = readFileSync(await pdfDl.path());
const pdfHead = pdfBytes.subarray(0, 5).toString('latin1');
check('pojedyncza karta pobiera się jako PDF', pdfHead === '%PDF-', `${pdfDl.suggestedFilename()} · ${pdfHead}`);
// AED-001 (pierwszy wiersz) ma dwa zdjęcia demo – w PDF muszą być osadzone JPEG-i.
check(
  'zdjęcia karty są osadzone w PDF (DCTDecode)',
  pdfBytes.includes('/DCTDecode'),
  `${Math.round(pdfBytes.length / 1024)} KB`
);

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
// Pierwsza zakładka to domek na pulpit – bez podpisu, więc kroki liczymy
// od zakładek, które jakiś tekst mają.
const navTabs = (await page.locator('.topbar__tab:not(.topbar__tab--home)').allInnerTexts()).filter((t) =>
  t.trim()
);
check(
  'nawigacja kroków siedzi w belce górnej, numerowana od 01',
  navTabs.length === 6 && /^01/.test(navTabs[0].replace(/\s+/g, '')),
  navTabs.map((t) => t.replace(/\s+/g, ' ')).join(' · ')
);
const homeTab = await page.locator('.topbar__tab--home').count();
const homeIsHouse = await page.locator('.topbar__tab--home .lucide-house, .topbar__tab--home svg').count();
check('domek w belce prowadzi na pulpit', homeTab === 1 && homeIsHouse >= 1, `zakładek domku: ${homeTab}`);
await page.locator('.topbar__tab--home').click();
await page.waitForTimeout(700);
check('klik w domek wraca na pulpit', page.url().endsWith('#/'), page.url().split('#')[1] || '(brak)');
const brandGoesHome = await page.locator('.topbar__brand').count();
check('znak marki wraca na pulpit', brandGoesHome === 1);

/* ---------------------------------------------------------------- *
 * 12. Aktywna karta punktu w analizie: to samo miejsce co w inwentaryzacji,
 *     ✕ odklikuje punkt, trasy dojścia rysują się przerywane.
 * ---------------------------------------------------------------- */

await go('#/analysis', 1400);

/** Ile przerywanych linii dojścia jest na mapie zapasowej. */
const routeLines = () =>
  page.locator('.map-fallback svg path[stroke-dasharray="4 3"][stroke-opacity="0.5"]').count();

const cardPlace = () =>
  page.evaluate(() => {
    const box = document.querySelector('.panel .panel__selected');
    if (!box || box.style.display === 'none') return null;
    const panel = box.parentElement;
    const head = panel.querySelector('.panel__head');
    const body = panel.querySelector('.panel__body');
    const cs = getComputedStyle(box);
    return {
      afterHead: head && head.nextElementSibling === box,
      beforeBody: body && box.nextElementSibling === body,
      gapBelow: Math.round(box.getBoundingClientRect().bottom * 10) / 10,
      bodyTop: body ? Math.round(body.getBoundingClientRect().top * 10) / 10 : null,
      marginBottom: parseFloat(cs.marginBottom),
      paddingTop: parseFloat(cs.paddingTop),
      paddingRight: parseFloat(cs.paddingRight),
      proposed: box.classList.contains('panel__selected--proposed'),
      text: box.innerText.replace(/\s+/g, ' '),
    };
  });

check('analiza: karta punktu ukryta, dopóki nic nie wybrano', (await cardPlace()) === null);
check('analiza: bez wyboru nie ma linii dojścia', (await routeLines()) === 0);

await page.locator('.map-fallback svg .pin:not(.pin--proposed)').first().click();
await page.waitForTimeout(1200);

const place = await cardPlace();
check(
  'analiza: aktywna karta stoi pod belką panelu, nad rejestrem',
  !!place && place.afterHead && place.beforeBody,
  place ? `afterHead=${place.afterHead} beforeBody=${place.beforeBody}` : 'brak karty'
);
check(
  'analiza: wyraźna przerwa między kartą a danymi niżej (10–20 px)',
  !!place && place.marginBottom >= 10 && place.marginBottom <= 20,
  place ? `margin-bottom ${place.marginBottom}px` : 'brak karty'
);
check(
  'analiza: karta ma margines górny i prawy w środku',
  !!place && place.paddingTop >= 8 && place.paddingRight >= 8,
  place ? `padding ${place.paddingTop}/${place.paddingRight}px` : 'brak karty'
);

const linesAfterClick = await routeLines();
check(
  'analiza: klik w punkt rysuje przerywane trasy dojścia (50% krycia)',
  linesAfterClick > 0,
  `${linesAfterClick} linii`
);

const routeStroke = await page
  .locator('.map-fallback svg path[stroke-dasharray="4 3"][stroke-opacity="0.5"]')
  .first()
  .getAttribute('stroke');
check(
  'analiza: linie dojścia w kolorze obrysu zasięgu',
  routeStroke === '#9cbd25',
  String(routeStroke)
);

/* Kreski mają płynąć od pinu do granicy: animacja rusza stroke-dashoffset.
   Mierzymy go dwa razy – jeśli stoi, animacji nie ma. */
const dashOffsetNow = () =>
  page.evaluate(() => {
    const el = document.querySelector('.map-fallback svg path.route-flow');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { offset: parseFloat(cs.strokeDashoffset), name: cs.animationName, dur: cs.animationDuration };
  });
const flowA = await dashOffsetNow();
await page.waitForTimeout(280);
const flowB = await dashOffsetNow();
check(
  'analiza: trasy dojścia są animowane (kreski płyną)',
  !!flowA && flowA.name === 'route-flow' && flowB.offset !== flowA.offset,
  flowA ? `${flowA.name} ${flowA.dur} · offset ${flowA.offset} → ${flowB.offset}` : 'brak trasy'
);
check(
  'analiza: kreski płyną w kierunku rysowania trasy, czyli do pinu (offset maleje)',
  !!flowA && flowB.offset <= 0 && flowA.offset <= 0,
  flowA ? `${flowA.offset} → ${flowB.offset}` : 'brak trasy'
);

await page.screenshot({ path: join(SHOTS, 'interactions-analysis-selected.png') });

const closeBtn = page.locator('.panel .panel__selected button[title*="Zamknij"]');
check('analiza: karta ma ✕ do zamknięcia', (await closeBtn.count()) === 1);
await closeBtn.first().click();
await page.waitForTimeout(700);
check('✕ zamyka kartę i odklikuje punkt', (await cardPlace()) === null);
check('✕ gasi też linie dojścia', (await routeLines()) === 0);

/* ---------------------------------------------------------------- *
 * 13. Nowa rekomendacja: własny obrys, podświetlone pole, wpływ na pokrycie
 * ---------------------------------------------------------------- */

/** Fioletowe obrysy zasięgu (propozycje) – kreskowane, w odróżnieniu od zielonych. */
const planRings = () =>
  page.locator('.map-fallback svg path[stroke-dasharray="3 2"][fill="rgba(11,112,48,0.12)"]').count();
const ringsBefore = await planRings();
box = await mapBox();
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
await page.waitForTimeout(1400);

const newPlace = await cardPlace();
check(
  'nowa rekomendacja od razu jest aktywna w karcie',
  !!newPlace && /rekomendacja/i.test(newPlace.text),
  newPlace ? newPlace.text.slice(0, 70) : 'brak karty'
);
check(
  'pole karty nowego punktu podświetlone kolorem rekomendacji',
  !!newPlace && newPlace.proposed,
  newPlace ? `klasa --proposed=${newPlace.proposed}` : 'brak karty'
);
check(
  'karta nowego punktu pokazuje wpływ na pokrycie',
  !!newPlace && /\+[\d,]+%\s*pokrycia/.test(newPlace.text),
  newPlace ? (newPlace.text.match(/\+[\d,]+% pokrycia[^·]*·[^A-Z]*/) || [''])[0].trim() : 'brak karty'
);

const ringsAfter = await planRings();
check(
  'nowy punkt dorysowuje własny obrys zasięgu planu',
  ringsAfter === ringsBefore + 1,
  `${ringsBefore} → ${ringsAfter} obrysów`
);
await page.screenshot({ path: join(SHOTS, 'interactions-analysis-proposal.png') });

// Sprzątamy po sobie, żeby kolejne uruchomienie startowało z tych samych danych.
await page.locator('.topbar__undo').click();
await page.waitForTimeout(800);

/* ---------------------------------------------------------------- *
 * 14. Ta sama interakcja w inwentaryzacji: klik w pin, karta pod belką, ✕
 * ---------------------------------------------------------------- */

await go('#/inventory', 1300);
// Wybór punktu jest zapisany w projekcie, więc po wcześniejszych sekcjach
// karta może być już otwarta – zamykamy ją, żeby test startował z czystego stanu.
if (await cardPlace()) {
  await page.locator('.panel .panel__selected button[title*="Zamknij"]').first().click();
  await page.waitForTimeout(600);
}
check('inwentaryzacja: karta ukryta, dopóki nic nie wybrano', (await cardPlace()) === null);

await page.locator('.map-fallback svg .pin:not(.pin--proposed)').first().click();
await page.waitForTimeout(900);
const invPlace = await cardPlace();
check(
  'inwentaryzacja: karta punktu stoi pod belką panelu, nad rejestrem',
  !!invPlace && invPlace.afterHead && invPlace.beforeBody,
  invPlace ? invPlace.text.slice(0, 60) : 'brak karty'
);
check(
  'inwentaryzacja: ta sama przerwa i marginesy co w analizie',
  !!invPlace && invPlace.marginBottom >= 10 && invPlace.marginBottom <= 20 && invPlace.paddingTop >= 8,
  invPlace ? `margin ${invPlace.marginBottom}px · padding ${invPlace.paddingTop}/${invPlace.paddingRight}px` : 'brak karty'
);

const invSelected = await page.locator('.map-fallback svg .pin.is-selected').count();
check('inwentaryzacja: wybrany pin jest wyróżniony', invSelected === 1, `${invSelected} pinów`);

await page.locator('.panel .panel__selected button[title*="Zamknij"]').first().click();
await page.waitForTimeout(700);
check('inwentaryzacja: ✕ zamyka kartę', (await cardPlace()) === null);
check(
  'inwentaryzacja: ✕ odklikuje pin na mapie',
  (await page.locator('.map-fallback svg .pin.is-selected').count()) === 0
);

/* ---------------------------------------------------------------- *
 * 15. Rekomendacje mają obrys zawsze, nie tylko w scenariuszu „po planie"
 * ---------------------------------------------------------------- */

await go('#/analysis', 1400);
const proposedInState = await proposedCount();
const ringsNow = await planRings();
check(
  'analiza: każda rekomendacja ma obrys w scenariuszu „teraz"',
  ringsNow === proposedInState,
  `${ringsNow} obrysów / ${proposedInState} rekomendacji`
);
const scenarioNow = await page.evaluate(() => window.__aed.ui.scenario);
check('… a scenariusz to faktycznie „teraz"', scenarioNow !== 'plan', String(scenarioNow));

/* ---------------------------------------------------------------- *
 * 16. Usuwanie rekomendacji: karta na mapie w analizie, w inwentaryzacji, cała karta
 * ---------------------------------------------------------------- */

/** Klik w przycisk potwierdzenia w oknie modalnym. */
const confirmModal = async (label) => {
  const btn = page.locator(`.modal__foot .btn--primary:has-text("${label}")`);
  await btn.first().click();
  await page.waitForTimeout(900);
};

// Zaznacz limonkowy znacznik propozycji i usuń go z mini-karty.
await page.locator('.map-fallback svg .pin--proposed').first().click();
await page.waitForTimeout(1200);
const delBtn = page.locator('.panel .panel__selected button:has-text("USUŃ PUNKT")');
check('analiza: karta rekomendacji ma USUŃ PUNKT', (await delBtn.count()) === 1);
const beforeDel = await proposedCount();
await delBtn.first().click();
await page.waitForTimeout(500);
await confirmModal('USUŃ');
const afterDel = await proposedCount();
check('analiza: USUŃ PUNKT zdejmuje rekomendację', afterDel === beforeDel - 1, `${beforeDel} → ${afterDel}`);
check('… i zamyka kartę wybranego punktu', (await cardPlace()) === null);
check(
  '… a jego obrys znika z mapy',
  (await planRings()) === afterDel,
  `${await planRings()} obrysów / ${afterDel} rekomendacji`
);

await page.locator('.topbar__undo').click();
await page.waitForTimeout(900);
check('Cofnij przywraca usuniętą rekomendację', (await proposedCount()) === beforeDel, `${await proposedCount()}`);

// Punkt istniejący takiego przycisku nie dostaje.
await page.locator('.map-fallback svg .pin:not(.pin--proposed)').first().click();
await page.waitForTimeout(1100);
check(
  'analiza: punkt istniejący NIE ma USUŃ PUNKT',
  (await page.locator('.panel .panel__selected button:has-text("USUŃ PUNKT")').count()) === 0
);

// Ta sama akcja w inwentaryzacji.
await go('#/inventory', 1300);
await page.locator('.map-fallback svg .pin--proposed').first().click();
await page.waitForTimeout(900);
const invDel = page.locator('.panel .panel__selected button:has-text("USUŃ")');
check('inwentaryzacja: karta rekomendacji ma USUŃ', (await invDel.count()) === 1);
const invBefore = await proposedCount();
await invDel.first().click();
await page.waitForTimeout(500);
await confirmModal('USUŃ');
check(
  'inwentaryzacja: USUŃ zdejmuje rekomendację z rejestru',
  (await proposedCount()) === invBefore - 1,
  `${invBefore} → ${await proposedCount()}`
);
await page.locator('.topbar__undo').click();
await page.waitForTimeout(900);

// I na całej karcie punktu.
const proposedId = await page.evaluate(
  () => (window.__aed.points.find((p) => p.kind === 'proposed' && p.status !== 'rejected') || {}).id
);
await go(`#/card/${proposedId}`, 1400);
const cardDel = page.locator('.panel--card .panel__foot button:has-text("USUŃ PUNKT")');
check('karta punktu: rekomendacja ma USUŃ PUNKT', (await cardDel.count()) === 1, String(proposedId));
const cardBefore = await proposedCount();
await cardDel.first().click();
await page.waitForTimeout(500);
await confirmModal('USUŃ PUNKT');
check(
  'karta punktu: USUŃ PUNKT usuwa i wraca do analizy',
  (await proposedCount()) === cardBefore - 1 && page.url().includes('#/analysis'),
  `${cardBefore} → ${await proposedCount()} · ${page.url().split('#')[1]}`
);
await page.locator('.topbar__undo').click();
await page.waitForTimeout(900);

await go('#/card/AED-003', 1300);
check(
  'karta punktu: istniejący AED NIE ma USUŃ PUNKT',
  (await page.locator('.panel--card .panel__foot button:has-text("USUŃ PUNKT")').count()) === 0
);

/* ---------------------------------------------------------------- *
 * 17. Roadmapa: edycja pozycji tym samym formularzem co „+ pozycja"
 * ---------------------------------------------------------------- */

await go('#/roadmap', 1500);
const editBtn = page.locator('.kanban__card button[title="Edytuj pozycję"]');
const editCount = await editBtn.count();
check('roadmapa: każdy kafelek ma przycisk edycji', editCount > 0, `${editCount} przycisków`);

const firstCardText = await page.locator('.kanban__card h4').first().innerText();
await editBtn.first().click();
await page.waitForTimeout(600);

const formFields = await page.evaluate(() => {
  const box = document.querySelector('.modal__body');
  if (!box) return null;
  return {
    title: document.querySelector('.modal__head').textContent,
    inputs: box.querySelectorAll('input').length,
    selects: box.querySelectorAll('select').length,
    text: box.querySelector('input[type="text"]').value,
    cost: box.querySelector('input[type="number"]').value,
  };
});
check(
  'roadmapa: formularz edycji jest wypełniony danymi pozycji',
  !!formFields && formFields.text === firstCardText,
  formFields ? `„${formFields.text}"` : 'brak formularza'
);
check(
  'roadmapa: te same pola co przy dodawaniu (treść, odpowiedzialny, ważność, koszt)',
  !!formFields && formFields.inputs === 2 && formFields.selects === 2,
  formFields ? `${formFields.inputs} input · ${formFields.selects} select` : 'brak formularza'
);

await page.fill('.modal__body input[type="text"]', 'Pozycja po edycji');
await page.fill('.modal__body input[type="number"]', '4200');
await page.selectOption('.modal__body select >> nth=1', 'high');
await confirmModal('ZAPISZ ZMIANY');

const edited = await page.evaluate(() =>
  window.__aed.recommendations.filter((r) => r.text === 'Pozycja po edycji').map((r) => `${r.cost}/${r.priority}`)
);
check('roadmapa: edycja zapisuje treść, koszt i ważność', edited[0] === '4200/high', String(edited));
const editedOnBoard = await page.locator('.kanban__card h4:has-text("Pozycja po edycji")').count();
check('roadmapa: zmiana widoczna na kafelku', editedOnBoard === 1, `${editedOnBoard} kafelków`);
await page.screenshot({ path: join(SHOTS, 'interactions-roadmap-edit.png') });

await page.locator('.topbar__undo').click();
await page.waitForTimeout(900);
check(
  'Cofnij odwraca edycję pozycji',
  (await page.locator('.kanban__card h4:has-text("Pozycja po edycji")').count()) === 0
);

/* ---------------------------------------------------------------- *
 * 18. Ludzik świadka: przeciągnięcie na mapę, droga do najbliższego AED
 * ---------------------------------------------------------------- */

await go('#/analysis', 1600);

const dock = page.locator('.walker-dock');
check('analiza: dok ludzika jest przy krawędzi mapy', (await dock.count()) === 1);
check('ludzik startuje w doku, nie na mapie', (await page.locator('.walker-card').isVisible()) === false);

/** Przeciąga ludzika w podane miejsce mapy (ułamki szerokości i wysokości). */
const dropWalker = async (fx, fy) => {
  const d = await page.locator('.walker-dock').boundingBox();
  const m = await mapBox();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + m.width * fx, m.y + m.height * fy, { steps: 12 });
  await page.waitForTimeout(220);
  const ghost = await page.locator('.walker-ghost').count();
  const armed = await page.locator('.map-wrap.is-walker-target').count();
  await page.mouse.up();
  // Czekamy na werdykt, a nie na stały czas: trasa idzie do Directions API,
  // a gdy sieć jest odcięta, wynik pojawia się dopiero po limicie czasu.
  await page.locator('.walker-card__verdict').waitFor({ timeout: 12000 }).catch(() => {});
  return { ghost, armed };
};

const drag = await dropWalker(0.45, 0.55);
check('podczas ciągnięcia leci duch za kursorem', drag.ghost === 1, `${drag.ghost}`);
check('mapa pokazuje, że przyjmie upuszczenie', drag.armed === 1, `${drag.armed}`);
check('po upuszczeniu duch znika', (await page.locator('.walker-ghost').count()) === 0);

const cardText = await page.locator('.walker-card').innerText();
check('karta ludzika pokazuje czas dojścia', /\d+([,.]\d+)?\s*min/.test(cardText), cardText.split('\n')[1] || cardText.slice(0, 40));
check(
  'karta nazywa najbliższe AED',
  /m drogi/.test(cardText) && cardText.length > 40,
  (cardText.match(/^.*m drogi$/m) || [''])[0]
);
check('dok pokazuje, że ludzik z niego wyszedł', await dock.evaluate((el) => el.classList.contains('is-out')));

const walkerOnMap = await page.locator('.map-fallback svg path[stroke-width="3"]').count();
check('droga do AED jest narysowana na mapie', walkerOnMap >= 1, `${walkerOnMap} linii`);

/* Werdykt i barwa muszą iść za czasem: blisko AED zielono, daleko czerwono. */
const verdictColor = () =>
  page.evaluate(() => {
    const el = document.querySelector('.walker-card__verdict');
    return el ? { text: el.textContent, color: getComputedStyle(el).color } : null;
  });
const far = await verdictColor();
check('daleko od AED werdykt jest ostrzegawczy', !!far && /nie zdąży|poza zasięgiem|granicy/.test(far.text), far ? `${far.text} · ${far.color}` : 'brak');

// Upuść ludzika tuż przy istniejącym punkcie – wtedy ma zdążyć.
const pinBox = await page.locator('.map-fallback svg .pin--ok, .map-fallback svg .pin--warn').first().boundingBox();
const mapRect = await mapBox();
if (pinBox) {
  const d = await page.locator('.walker-dock').boundingBox();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(pinBox.x + pinBox.width / 2 + 6, pinBox.y + pinBox.height / 2 + 6, { steps: 12 });
  await page.mouse.up();
  await page.locator('.walker-card__verdict').waitFor({ timeout: 12000 }).catch(() => {});
}
const near = await verdictColor();
check(
  'przy samym AED werdykt mówi, że zdąży',
  !!near && /zdąży/.test(near.text) && !/nie zdąży/.test(near.text),
  near ? `${near.text} · ${near.color}` : 'brak'
);
check('barwa werdyktu zmienia się z czasem dojścia', !!far && !!near && far.color !== near.color, `${far?.color} → ${near?.color}`);
await page.screenshot({ path: join(SHOTS, 'interactions-walker.png') });

// Zdjęcie ludzika: krzyżyk na karcie.
await page.locator('.walker-card__close').click();
await page.waitForTimeout(700);
check('krzyżyk zdejmuje ludzika z mapy', (await page.locator('.walker-card').isVisible()) === false);
check('dok wraca do stanu wyjściowego', !(await dock.evaluate((el) => el.classList.contains('is-out'))));
check('droga znika z mapy', (await page.locator('.map-fallback svg path[stroke-width="3"]').count()) === 0);

// Zdjęcie ludzika: Esc.
await dropWalker(0.5, 0.4);
check('ludzik znów stoi na mapie', await page.locator('.walker-card').isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
check('Esc też zdejmuje ludzika', (await page.locator('.walker-card').isVisible()) === false);

// Zdjęcie ludzika: upuszczenie poza mapą.
const d2 = await page.locator('.walker-dock').boundingBox();
await page.mouse.move(d2.x + d2.width / 2, d2.y + d2.height / 2);
await page.mouse.down();
await page.mouse.move(mapRect.x + mapRect.width * 0.5, mapRect.y + mapRect.height * 0.5, { steps: 8 });
await page.mouse.up();
await page.locator('.walker-card__verdict').waitFor({ timeout: 12000 }).catch(() => {});
check('ludzik postawiony po raz trzeci', await page.locator('.walker-card').isVisible());

const d3 = await page.locator('.walker-dock').boundingBox();
await page.mouse.move(d3.x + d3.width / 2, d3.y + d3.height / 2);
await page.mouse.down();
// Prawa szyna leży poza mapą – upuszczenie tam ma odstawić ludzika do doku.
await page.mouse.move(mapRect.x + mapRect.width + 220, mapRect.y + 120, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);
check('upuszczenie poza mapą odstawia ludzika do doku', (await page.locator('.walker-card').isVisible()) === false);

/* ---------------------------------------------------------------- *
 * 15. Maska poza granicą, warstwy mapy i rejestr granic
 * ---------------------------------------------------------------- */

await go('#/analysis', 1600);

const maskPaths = await page.locator('.map-fallback svg path[fill-rule="evenodd"]').count();
check('teren poza granicą gminy jest przygaszony maską', maskPaths === 1, `${maskPaths} masek`);

const maskOpacity = await page
  .locator('.map-fallback svg path[fill-rule="evenodd"]')
  .first()
  .getAttribute('fill-opacity');
check('maska kryje w 50%', maskOpacity === '0.5', `krycie ${maskOpacity}`);

// Przełączniki warstw siedzą w tej samej szynie co ludzik, pod nim.
const railKids = await page.evaluate(() =>
  [...document.querySelectorAll('.map-rail > *')].map((el) => el.className)
);
check(
  'szyna mapy: ludzik na górze, przełączniki warstw pod nim',
  railKids.length === 2 && /walker-dock/.test(railKids[0]) && /layer-dock/.test(railKids[1]),
  railKids.join(' → ')
);

const demandDots = () => page.locator('.map-fallback svg circle[r="1.9"]').count();
// Kropki gęstości mają własną klasę – zielony zasięgu to ten sam odcień
// co zielona kropka popytu, więc po samym kolorze nie da się ich rozdzielić.
const densityDots = () => page.locator('.map-fallback svg .density-dot').count();

check('punkty popytu startują włączone', (await demandDots()) > 100, `${await demandDots()} kropek`);
check('gęstość startuje wyłączona', (await densityDots()) === 0);

// Włączenie warstwy gęstości.
await page.locator('.layer-dock__btn').nth(1).click();
await page.waitForTimeout(2500);
const dens = await densityDots();
check('warstwa gęstości pokrywa gminę drobnymi kropkami', dens > 1500, `${dens} kropek`);

const green = await page.locator('.map-fallback svg .density-dot[fill="#167734"]').count();
check(
  'część kropek gęstości jest zielona – to ludzie z dostępem do AED',
  green > 0 && green < dens,
  `${green} z ${dens}`
);

// Rozmiar kropki niesie gęstość, więc promienie muszą się różnić.
const radii = await page.evaluate(() => {
  const set = new Set(
    [...document.querySelectorAll('.map-fallback svg .density-dot')].map((c) => c.getAttribute('r'))
  );
  return set.size;
});
check('wielkość kropki niesie zagęszczenie (różne promienie)', radii > 5, `${radii} różnych promieni`);

// Legenda siedzi w zwiniętym bloku, więc pytamy o atrybut hidden, a nie
// o widoczność – ta zależy też od tego, czy operator legendę rozwinął.
const legendHidden = (nth) =>
  page.locator('.legend-block').nth(nth).evaluate((el) => el.hasAttribute('hidden'));
check('legenda gęstości pokazuje się razem z warstwą', (await legendHidden(1)) === false);

// Zgaszenie punktów popytu.
await page.locator('.layer-dock__btn').nth(0).click();
await page.waitForTimeout(900);
check('przełącznik gasi punkty popytu', (await demandDots()) === 0);
check('legenda popytu znika razem z warstwą', await legendHidden(0));
check('kropki gęstości zostają', (await densityDots()) > 1500);

await page.screenshot({ path: join(SHOTS, 'interactions-density.png') });

// Rejestr granic w kroku 0 ładuje się sam.
await go('#/setup', 1800);
const regRows = await page.locator('.registry__row').count();
check('rejestr granic wczytuje się bez klikania', regRows > 3, `${regRows} pozycji`);
const regLoaded = await page.locator('.registry__row.is-on .registry__text strong').innerText();
check('gmina projektu jest w rejestrze oznaczona jako wczytana', regLoaded === 'Tychy', regLoaded);

await page.locator('.registry input[type="search"]').fill('pomorskie');
await page.waitForTimeout(300);
const filtered = await page.locator('.registry__row').allInnerTexts();
check(
  'filtr rejestru zawęża listę',
  filtered.length > 0 && filtered.length < regRows && filtered.every((t) => /pomorskie/i.test(t)),
  `${filtered.length} z ${regRows}`
);
await page.locator('.registry input[type="search"]').fill('');
await page.waitForTimeout(300);

// Podsumowanie kroku 0 nie może już mówić o promieniu, skoro liczy z sieci.
const setupMeta = await page.locator('.subbar').innerText();
check(
  'podsumowanie setupu mówi o zasięgu z sieci, nie o samym promieniu okręgu',
  // Zależnie od tego, ile punktów ma izochronę w cache, podsumowanie mówi
  // „zasięg z sieci pieszej" albo „sieć piesza (n z m) + promień … dla reszty".
  // Nie może natomiast podawać samego promienia jako sposobu liczenia zasięgu.
  /sie(ć|ci) piesz/.test(setupMeta) && !/promień \S+ m \(przybliżenie\)/.test(setupMeta),
  setupMeta.replace(/\n/g, ' | ')
);

await go('#/inventory');
await page.screenshot({ path: join(SHOTS, 'interactions-inventory.png') });
await go('#/analysis');
await page.screenshot({ path: join(SHOTS, 'interactions-analysis.png') });

// Mapbox jest w tym sandboksie odcięty – to właśnie dlatego renderuje się mapa
// zapasowa, więc jego błędy sieciowe nie są usterką aplikacji.
const realErrors = errors.filter((e) => !/mapbox|Failed to load resource|net::ERR|favicon/i.test(e));
check('brak błędów w konsoli', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
stop();

console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
