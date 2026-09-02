#!/usr/bin/env node
/**
 * fetch-reach.mjs – pobiera z Mapboksa realne zasięgi dojścia pieszego
 * (izochrony) i trasy, które te zasięgi rysują, i zapisuje je jako cache
 * projektu w data/reach-tychy.json.
 *
 *   MAPBOX_TOKEN=pk.… node tools/fetch-reach.mjs
 *   MAPBOX_TOKEN=pk.… node tools/fetch-reach.mjs --routes-only
 *
 * Po co cache, skoro aplikacja i tak umie pytać Mapboksa w locie:
 *   • demo i testy działają bez sieci i bez zużywania limitu API,
 *   • wyniki analizy są powtarzalne – ta sama karta i ten sam raport dziś
 *     i za pół roku, niezależnie od tego, że sieć pieszą w OSM ktoś poprawił,
 *   • pierwsze wejście w krok 2 nie czeka na 50 zapytań sieciowych.
 * Cache jest kluczowany zaokrągloną współrzędną, więc przesunięcie pinu
 * o kilka metrów trafia w ten sam wpis, a realne przesunięcie – nie.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Ten sam klucz, którego używa aplikacja – inaczej cache nie trafiałby w punkty.
import { reachKey } from '../js/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'reach-tychy.json');

const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN || !TOKEN.startsWith('pk.')) {
  console.error('Brak MAPBOX_TOKEN (publiczny token pk.…) w zmiennych środowiska.');
  process.exit(1);
}

/**
 * Drabina konturów. Mapbox przyjmuje maksymalnie 4 kontury na zapytanie,
 * więc jedno zapytanie na punkt obsługuje wszystkie trzy standardy z setupu
 * (2/3/5 min) plus pas 8 min, po którym widać, jak daleko naprawdę jest
 * z miejsc poza zasięgiem.
 */
const CONTOURS = [2, 3, 5, 8];

/** Ile tras dojścia rysujemy pod obrysem po kliknięciu w punkt. */
const ROUTE_SPOKES = 12;

/** Zaokrąglenie współrzędnych w cache – 5 miejsc ≈ 1 m. */
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const keyOf = reachKey;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(1500 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) {
        console.warn(`  ! ${label}: ${err.message}`);
        return null;
      }
      await sleep(700 * attempt);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Upraszczanie geometrii – cache ma być mały, nie idealny
 * ------------------------------------------------------------------ */

/** Odległość punktu od odcinka w stopniach przeliczonych na metry. */
function perpDistanceM(p, a, b) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 111320;
  const px = p[0] * kx;
  const py = p[1] * ky;
  const ax = a[0] * kx;
  const ay = a[1] * ky;
  const bx = b[0] * kx;
  const by = b[1] * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker; tolerancja w metrach. */
function simplify(ring, toleranceM) {
  if (ring.length < 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let best = -1;
    let bestD = toleranceM;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistanceM(ring[i], ring[lo], ring[hi]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([lo, best], [best, hi]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const compact = (ring) => ring.map(([lon, lat]) => [round5(lon), round5(lat)]);

/* ------------------------------------------------------------------ *
 * Mapbox
 * ------------------------------------------------------------------ */

/** Izochrony dla jednego punktu: {2: ring, 3: ring, 5: ring, 8: ring}. */
async function fetchIsochrone(lat, lon, label) {
  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/walking/${round5(lon)},${round5(lat)}` +
    `?contours_minutes=${CONTOURS.join(',')}&polygons=true&denoise=1&generalize=12` +
    `&access_token=${TOKEN}`;
  const json = await getJson(url, `izochrona ${label}`);
  if (!json || !json.features) return null;

  const out = {};
  for (const f of json.features) {
    const minutes = f.properties && f.properties.contour;
    if (!minutes || !f.geometry) continue;
    // Mapbox zwraca Polygon albo MultiPolygon; bierzemy największy pierścień,
    // bo wysepki odcięte torami nie niosą tu informacji, a ważą w pliku.
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    let biggest = null;
    let bestLen = 0;
    for (const poly of polys) {
      const ring = poly[0];
      if (ring && ring.length > bestLen) {
        bestLen = ring.length;
        biggest = ring;
      }
    }
    if (biggest) out[minutes] = compact(simplify(biggest, 8));
  }
  return Object.keys(out).length ? out : null;
}

/** Trasa piesza punkt → cel; zwraca uproszczoną linię albo null. */
async function fetchRoute(from, to, label) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/` +
    `${round5(from.lon)},${round5(from.lat)};${round5(to[0])},${round5(to[1])}` +
    `?geometries=geojson&overview=full&access_token=${TOKEN}`;
  const json = await getJson(url, `trasa ${label}`);
  const route = json && json.routes && json.routes[0];
  if (!route || !route.geometry) return null;
  return {
    line: compact(simplify(route.geometry.coordinates, 6)),
    distanceM: Math.round(route.distance),
    durationMin: Math.round((route.duration / 60) * 10) / 10,
  };
}

/** Równomiernie po kącie wybrane wierzchołki obrysu – po nich pójdą trasy. */
function pickSpokes(ring, from, count) {
  const buckets = new Array(count).fill(null);
  for (const [lon, lat] of ring) {
    const angle = Math.atan2(lat - from.lat, lon - from.lon);
    const idx = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * count) % count;
    const d = Math.hypot(lon - from.lon, lat - from.lat);
    if (!buckets[idx] || d > buckets[idx].d) buckets[idx] = { pt: [lon, lat], d };
  }
  return buckets.filter(Boolean).map((b) => b.pt);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const demo = JSON.parse(readFileSync(join(DATA, 'demo-tychy.json'), 'utf8'));
const standard = demo.project.standardMinutes || 5;

/** Wszystko, co kiedykolwiek może być czynnym AED: punkty + kandydaci optymalizatora. */
const sites = [
  ...demo.points.map((p) => ({ key: keyOf(p.lat, p.lon), lat: p.lat, lon: p.lon, id: p.id, routes: true })),
  ...demo.candidates.map((c) => ({ key: keyOf(c.lat, c.lon), lat: c.lat, lon: c.lon, id: c.id, routes: false })),
];
const unique = new Map();
for (const s of sites) if (!unique.has(s.key)) unique.set(s.key, s);

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { contours: {}, routes: {} };
const routesOnly = process.argv.includes('--routes-only');

const out = {
  meta: {
    source: 'Mapbox Isochrone API + Directions API (profil walking)',
    contours: CONTOURS,
    standardMinutes: standard,
    routeSpokes: ROUTE_SPOKES,
    note:
      'Zasięgi liczone po realnej sieci pieszej OSM. Klucz = zaokrąglona współrzędna punktu. ' +
      'Aplikacja dopytuje Mapboksa w locie dla punktów spoza tego cache.',
    fetchedAt: new Date().toISOString().slice(0, 10),
  },
  contours: { ...prev.contours },
  routes: { ...prev.routes },
};

let isoDone = 0;
let routeDone = 0;

console.log(`\n── zasięgi dojścia: ${unique.size} lokalizacji, kontury ${CONTOURS.join('/')} min\n`);

for (const site of unique.values()) {
  if (!routesOnly && !out.contours[site.key]) {
    const iso = await fetchIsochrone(site.lat, site.lon, site.id);
    if (iso) {
      out.contours[site.key] = iso;
      isoDone += 1;
      process.stdout.write(`  izochrona ${site.id.padEnd(8)} ${Object.keys(iso).join('/')} min\n`);
    }
    await sleep(120);
  }

  if (site.routes && !out.routes[site.key]) {
    const ring = (out.contours[site.key] || {})[standard];
    if (!ring) continue;
    const spokes = pickSpokes(ring, site, ROUTE_SPOKES);
    const lines = [];
    for (const target of spokes) {
      const r = await fetchRoute(site, target, site.id);
      if (r) lines.push(r);
      await sleep(90);
    }
    if (lines.length) {
      out.routes[site.key] = lines;
      routeDone += 1;
      process.stdout.write(`  trasy     ${site.id.padEnd(8)} ${lines.length} szt.\n`);
    }
  }
}

writeFileSync(OUT, JSON.stringify(out));
const kb = Math.round(readFileSync(OUT).length / 1024);
console.log(
  `\nzapisano data/reach-tychy.json – ${kb} KB · ` +
    `${Object.keys(out.contours).length} izochron (${isoDone} nowych) · ` +
    `${Object.keys(out.routes).length} wiązek tras (${routeDone} nowych)\n`
);
