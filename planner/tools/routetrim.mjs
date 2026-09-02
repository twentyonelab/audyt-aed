#!/usr/bin/env node
/**
 * routetrim.mjs – sprawdza przycinanie tras dojścia na danych z cache.
 *
 * Dla każdego punktu z data/reach-tychy.json, który ma izochronę standardu
 * i trasy, przycinamy trasy tak jak widok analizy i sprawdzamy dwa warunki,
 * które na mapie były widoczne jako błąd: żaden wierzchołek nie leży poza
 * obrysem, a czas żadnej trasy nie przekracza standardu.
 *
 *   node tools/routetrim.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimRouteToReach, pointInRing } from '../js/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const cache = JSON.parse(readFileSync(join(HERE, '..', 'data', 'reach-tychy.json'), 'utf8'));
const standard = cache.meta.standardMinutes || 5;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` – ${detail}` : ''}`);
};

console.log(`\n── Przycinanie tras dojścia do obrysu i do ${standard} min\n`);

let sites = 0;
let routesAll = 0;
let rawOutside = 0;
let rawOverTime = 0;
let trimmedOutside = 0;
let trimmedOverTime = 0;
let dropped = 0;
let maxTrimmedMin = 0;

for (const [key, routes] of Object.entries(cache.routes)) {
  const ring = cache.contours[key] && cache.contours[key][standard];
  if (!ring) continue;
  sites++;
  for (const r of routes) {
    routesAll++;
    if (r.line.some(([lon, lat]) => !pointInRing({ lat, lon }, ring))) rawOutside++;
    if (r.durationMin > standard) rawOverTime++;

    const cut = trimRouteToReach(r.line, ring, {
      maxMinutes: standard,
      distanceM: r.distanceM,
      durationMin: r.durationMin,
    });
    if (!cut.line.length) {
      dropped++;
      continue;
    }
    // Ostatni punkt leży NA obrysie (z bisekcji), więc tolerujemy go jako „w środku".
    const inner = cut.line.slice(0, -1);
    if (inner.some(([lon, lat]) => !pointInRing({ lat, lon }, ring))) trimmedOutside++;
    if (cut.minutes > standard + 1e-9) trimmedOverTime++;
    maxTrimmedMin = Math.max(maxTrimmedMin, cut.minutes);
  }
}

check('cache ma punkty z izochroną i trasami', sites > 0 && routesAll > 0, `${sites} punktów · ${routesAll} tras`);
check(
  'surowe trasy faktycznie wychodziły poza obrys lub poza czas (to był ten błąd)',
  rawOutside + rawOverTime > 0,
  `${rawOutside} poza obrysem · ${rawOverTime} ponad ${standard} min`
);
check('po przycięciu żadna trasa nie ma wierzchołka poza obrysem', trimmedOutside === 0, `${trimmedOutside} tras`);
check(
  `po przycięciu żadna trasa nie przekracza ${standard} min`,
  trimmedOverTime === 0,
  `najdłuższa ${maxTrimmedMin} min`
);
check('przycinanie nie gubi tras (każda ma ≥ 2 punkty)', dropped === 0, `${dropped} odrzuconych`);

// Kierunek: trasa z Directions zaczyna się w pinie – to widok ją odwraca.
const [k0, r0] = Object.entries(cache.routes)[0];
const [lat0, lon0] = k0.split(',').map(Number);
const start = r0[0].line[0];
const startDist = Math.hypot((start[1] - lat0) * 111320, (start[0] - lon0) * 71500);
check('trasa z cache zaczyna się przy pinie (widok odwraca ją do „biegu po AED")', startDist < 60, `${Math.round(startDist)} m od pinu`);

console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
