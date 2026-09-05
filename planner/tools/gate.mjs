#!/usr/bin/env node
/**
 * gate.mjs – sprawdza ekran wejścia: formularz, złe hasło, blokadę prób,
 * zapamiętanie wejścia i wyjście przyciskiem „Zablokuj makietę".
 *
 * Pozostałe testy wchodzą na skróty (tools/unlock.mjs), bo sprawdzają widoki.
 * Ten jeden przechodzi przez bramkę tak, jak zrobi to człowiek.
 *
 *   node tools/gate.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_KEY, GATE_PASSWORD } from './unlock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}`;

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

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` – ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log('\n── Ekran wejścia\n');

const go = async (wait = 1300) => {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
};

await go();

check('bramka staje przed aplikacją', (await page.locator('.gate').count()) === 1);
check('aplikacja nie jest zbudowana za bramką', (await page.locator('.topbar').count()) === 0);
check('logotyp marki jest na ekranie', (await page.locator('.gate__wordmark svg').count()) === 1);
check('pole hasła jest typu password', (await page.locator('.gate__input').getAttribute('type')) === 'password');
check('pole hasła dostaje fokus od razu', await page.evaluate(() => document.activeElement?.classList.contains('gate__input')));

// Puste hasło nie przepuszcza i nie liczy się jako próba.
await page.locator('.gate__submit').click();
await page.waitForTimeout(300);
check('puste hasło nie wpuszcza', (await page.locator('.gate').count()) === 1,
  await page.locator('.gate__error').innerText());

// Złe hasło: komunikat z licznikiem prób.
await page.fill('.gate__input', 'AedSnc2026');
await page.locator('.gate__submit').click();
await page.waitForTimeout(300);
const err1 = await page.locator('.gate__error').innerText();
check('złe hasło zostaje na ekranie i mówi, ile prób zostało', /Pozostało prób: 4/.test(err1), err1);
check('pole czyści się po nieudanej próbie', (await page.inputValue('.gate__input')) === '');

// Pięć nieudanych prób blokuje pole.
for (let i = 0; i < 4; i++) {
  await page.fill('.gate__input', `zle-${i}`);
  await page.locator('.gate__submit').click();
  await page.waitForTimeout(160);
}
check('po pięciu próbach pole się blokuje', await page.locator('.gate__input').isDisabled(),
  await page.locator('.gate__error').innerText());

// Blokada mija sama.
await page.waitForTimeout(15600);
check('blokada mija sama', !(await page.locator('.gate__input').isDisabled()));

// Poprawne hasło wpuszcza i zapamiętuje wejście.
await page.fill('.gate__input', GATE_PASSWORD);
await page.locator('.gate__submit').click();
await page.waitForTimeout(2200);
check('poprawne hasło wpuszcza', (await page.locator('.gate').count()) === 0);
check('aplikacja startuje', (await page.locator('.topbar').count()) === 1);
check('wejście zapamiętane', !!(await page.evaluate((k) => window.localStorage.getItem(k), GATE_KEY)));

await go();
check('po odświeżeniu bramka nie pyta ponownie', (await page.locator('.gate').count()) === 0);

// Wyjście: przycisk na pulpicie kasuje pamięć i wraca na bramkę.
const lock = page.locator('.btn:has-text("Zablokuj makietę")');
check('pulpit ma przycisk blokady', (await lock.count()) === 1);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
  lock.first().click(),
]);
await page.waitForTimeout(1800);
check('blokada wraca na ekran wejścia', (await page.locator('.gate').count()) === 1);
check('pamięć wejścia wyczyszczona', (await page.evaluate((k) => window.localStorage.getItem(k), GATE_KEY)) === null);

// Hasło nie może leżeć w źródle otwartym tekstem.
const source = await (await fetch(`${BASE}/js/gate.js`)).text();
check('hasła nie ma w źródle otwartym tekstem', !source.includes(GATE_PASSWORD));

const real = errors.filter((e) => !/mapbox|net::ERR|favicon/i.test(e));
check('brak błędów strony', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
stop();
console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
