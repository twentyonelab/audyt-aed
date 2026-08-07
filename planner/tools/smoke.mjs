#!/usr/bin/env node
/**
 * smoke.mjs — drives the makieta in a real browser and checks that the whole
 * operator path 0 -> 5 works with no console errors and no dead controls.
 *
 *   node tools/smoke.mjs            # run checks, write screenshots to tools/shots/
 *   node tools/smoke.mjs --shots    # same, but also capture every step
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const WANT_SHOTS = true;

mkdirSync(SHOTS, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

await new Promise((r) => setTimeout(r, 900));

const errors = [];
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const go = async (hash, wait = 900) => {
  await page.goto(`${BASE}/index.html${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
};
const shot = async (name) => {
  if (WANT_SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

console.log('\n── Sinecco AED Planner — smoke test\n');

/* ---------- 0. boot + dashboard ---------- */
await go('#/', 1600);
check('pulpit renderuje kafelki projektów', (await page.locator('.project-card').count()) >= 3);
check('pulpit pokazuje presety P1–P5', (await page.locator('.preset-card').count()) === 5);
const dashKpi = await page.locator('.project-card__kpi').first().innerText().catch(() => '');
check('kafelek Tychów ma policzony wskaźnik', /\d/.test(dashKpi), dashKpi.replace(/\n/g, ' ').slice(0, 40));
await shot('00-dashboard');

/* ---------- 1. setup ---------- */
await go('#/setup');
check('setup: formularz obecny', (await page.locator('.field').count()) >= 4);
check('setup: segmented control standardu', (await page.locator('.seg__btn').count()) >= 3);
await shot('01-setup');

/* ---------- 2. inventory ---------- */
await go('#/inventory', 1400);
const invRows = await page.locator('.list-row').count();
check('inwentaryzacja: lista punktów', invRows >= 14, `${invRows} wierszy`);
const meta = await page.locator('.subbar__meta').innerText().catch(() => '');
check('inwentaryzacja: licznik w sub barze', /\d+\s*punkt/i.test(meta), meta.slice(0, 48));
check('inwentaryzacja: mapa lub fallback', (await page.locator('.map-wrap svg, .map-wrap canvas').count()) > 0);
await shot('02-inventory');

/* ---------- 3. analysis ---------- */
await go('#/analysis', 1800);
const kpiCount = await page.locator('.kpi').count();
check('analiza: cztery kafelki KPI', kpiCount >= 4, `${kpiCount}`);
const kpiText = await page.locator('.kpi').first().innerText().catch(() => '');
check('analiza: KPI ma wartość liczbową', /\d/.test(kpiText), kpiText.replace(/\n/g, ' ').slice(0, 40));
check('analiza: sekcja luk', (await page.getByText(/luki/i).count()) > 0);

// scenario switch must change the numbers
const before = await page.locator('.kpi__value').first().innerText().catch(() => '');
const planBtn = page.locator('.subbar__controls .seg__btn', { hasText: /plan/i }).first();
if (await planBtn.count()) {
  await planBtn.click();
  await page.waitForTimeout(1200);
}
const after = await page.locator('.kpi__value').first().innerText().catch(() => '');
check('analiza: przełącznik Plan przelicza KPI', before !== after, `${before} → ${after}`);
await shot('03-analysis-plan');

// propose new points
const proposeBtn = page.locator('button', { hasText: /zaproponuj/i }).first();
if (await proposeBtn.count()) {
  await proposeBtn.click();
  await page.waitForTimeout(1600);
  check('analiza: przycisk propozycji zwraca wynik', (await page.locator('.panel .card').count()) > 0);
} else {
  check('analiza: przycisk propozycji obecny', false, 'nie znaleziono');
}
await shot('04-analysis-proposals');

/* ---------- 4. cards ---------- */
await go('#/cards', 1400);
const rows = await page.locator('.table tbody tr').count();
check('lista kart: wiersze tabeli', rows >= 14, `${rows}`);
check('lista kart: paski kompletności', (await page.locator('.table .bar').count()) > 0);
await shot('05-cards');

/* ---------- 5. single card ---------- */
await go('#/card/AED-003', 1600);
const sections = await page.locator('.card-section').count();
check('karta punktu: sekcje 1–9', sections >= 9, `${sections}`);

// Karta otwiera się zwinięta do przeglądu nagłówków — rozwijamy wszystko.
const expandBtn = page.locator('button', { hasText: /ROZWIŃ WSZYSTKIE/i }).first();
check('karta punktu: przycisk rozwiń wszystkie', (await expandBtn.count()) > 0);
if (await expandBtn.count()) {
  await expandBtn.click();
  await page.waitForTimeout(400);
}
check(
  'karta punktu: po rozwinięciu przycisk zmienia się na zwiń',
  (await page.locator('button', { hasText: /ZWIŃ WSZYSTKIE/i }).count()) > 0
);
check('karta punktu: sloty zdjęć', (await page.locator('.photo-slot').count()) >= 2);
check('karta punktu: pasek kompletności', (await page.locator('.panel .bar').count()) > 0);
check('karta punktu: sekcja oceny eksperckiej z suwakami', (await page.locator('.score-crit input[type=range]').count()) === 6);
const recSection = page.locator('.card-section', { hasText: 'Checklist zgodności' }).first();
const recCount = await recSection.locator('input[type=checkbox]').count();
check('karta punktu: rekomendacje z checkboxami', recCount > 0, `${recCount}`);

// Panel boczny nie może wyjeżdżać poza viewport (zgłoszony bug responsywności).
const panelBox = await page.locator('.panel--card').boundingBox();
check(
  'karta punktu: prawy panel mieści się w oknie',
  panelBox !== null && panelBox.x + panelBox.width <= 1560 + 1,
  panelBox ? `prawa krawędź ${Math.round(panelBox.x + panelBox.width)}px` : 'brak panelu'
);
await shot('06-card');

/* ---------- 6. roadmap ---------- */
await go('#/roadmap', 1600);
check('roadmapa: trzy kolumny kanbanu', (await page.locator('.kanban__col').count()) >= 3);
check('roadmapa: karty pozycji', (await page.locator('.kanban__card').count()) > 0);
const totals = await page.locator('.workspace').innerText();
check('roadmapa: suma kosztów widoczna', /68\s?200|zł/.test(totals));
check(
  'roadmapa: bez przełącznika osi czasu (usunięty na życzenie)',
  (await page.locator('.subbar__controls .seg__btn', { hasText: /oś czasu/i }).count()) === 0
);
await shot('07-roadmap-kanban');

/* ---------- 7. report ---------- */
await go('#/report', 1800);
check('raport: miniatury sekcji', (await page.locator('.report-thumb').count()) >= 6);
check('raport: strony podglądu', (await page.locator('.report-page').count()) >= 3);
check('raport: pięć KPI', (await page.locator('.report-kpi').count()) >= 5);
const quote = await page.locator('.report-quote').count();
check('raport: zdanie kontekstowe dla decydenta', quote > 0);
await shot('09-report');

/* ---------- 8. field form ---------- */
await go('#/field/AED-005', 1200);
check('formularz terenowy: kontener mobilny', (await page.locator('.field-form').count()) > 0);
check('formularz terenowy: przycisk wyślij', (await page.locator('button', { hasText: /wyślij/i }).count()) > 0);
await shot('10-field');

/* ---------- 9. no dead buttons ---------- */
await go('#/cards', 1200);
const dead = await page.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const disabled = b.disabled || b.classList.contains('is-disabled');
    const hasTip = b.hasAttribute('data-tip') || b.hasAttribute('title');
    if (disabled && !hasTip) out.push(b.textContent.trim().slice(0, 30));
  }
  return out;
});
check('brak wyłączonych przycisków bez wyjaśnienia', dead.length === 0, dead.join(', '));

/* ---------- summary ---------- */
const realErrors = errors.filter(
  (e) => !/mapbox|Failed to load resource|net::ERR|favicon/i.test(e)
);
check('brak błędów w konsoli', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
stop();

console.log(`\n${results.length - failures}/${results.length} sprawdzeń zaliczonych`);
if (realErrors.length) {
  console.log('\nbłędy konsoli:');
  realErrors.slice(0, 12).forEach((e) => console.log('  -', e.slice(0, 200)));
}
process.exit(failures ? 1 : 0);
