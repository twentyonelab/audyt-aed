#!/usr/bin/env node
/**
 * generate-demo.mjs — builds the Tychy demo dataset and reports the KPIs it
 * produces, so the numbers in the makieta can be tuned against the targets in
 * ITERACJA2_SPEC.md §8 using the very same model the app runs.
 *
 *   node tools/generate-demo.mjs            # write files + report
 *   node tools/generate-demo.mjs --report   # report only, write nothing
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  analyze,
  buildDemandPoints,
  proposeNewPoints,
  offsetLatLon,
  coverageRadiusM,
  fmtMin,
} from '../js/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'data');
const REPORT_ONLY = process.argv.includes('--report');

/* ================================================================== *
 * TUNING KNOBS — adjust these, re-run, read the report at the bottom.
 * ================================================================== */

const STANDARD_MINUTES = 5; // demo default; see report for 2 / 3 / 5 comparison
const POPULATION = 127500;

/**
 * Districts: compact built-up cores, not administrative outlines.
 * Populations follow the real shape of Tychy — dense letter-named estates in
 * the centre, small villages on the rim — and sum to POPULATION.
 */
const DISTRICTS = [
  { id: 'srodmiescie-wschod', name: 'Śródmieście-Wschód', population: 20800, lat: 50.1272, lon: 19.0105, r: 700, seed: 11 },
  { id: 'srodmiescie-zachod', name: 'Śródmieście-Zachód', population: 17000, lat: 50.1198, lon: 18.9902, r: 620, seed: 12 },
  { id: 'srodmiescie-polnoc', name: 'Śródmieście-Północ', population: 17500, lat: 50.1366, lon: 19.0042, r: 635, seed: 13 },
  { id: 'osiedle-no',         name: 'Osiedle N/O',        population: 10500, lat: 50.1136, lon: 19.0008, r: 420, seed: 14 },
  { id: 'osiedle-tu',         name: 'Osiedle T/U',        population: 13500, lat: 50.0982, lon: 18.9942, r: 470, seed: 15 },
  { id: 'osiedle-mp',         name: 'Osiedle M/P',        population: 11000, lat: 50.1332, lon: 19.0182, r: 430, seed: 16 },
  { id: 'stare-tychy',        name: 'Stare Tychy',        population: 7500,  lat: 50.1236, lon: 18.9856, r: 380, seed: 17 },
  { id: 'paprocany',          name: 'Paprocany',          population: 8200,  lat: 50.0906, lon: 19.0088, r: 545, seed: 18 },
  { id: 'zwakow',             name: 'Żwaków',             population: 9500,  lat: 50.1042, lon: 18.9722, r: 515, seed: 19 },
  { id: 'wilkowyje',          name: 'Wilkowyje',          population: 3600,  lat: 50.1300, lon: 18.9532, r: 360, seed: 20 },
  { id: 'czulow',             name: 'Czułów',             population: 4500,  lat: 50.1528, lon: 18.9890, r: 380, seed: 21 },
  { id: 'urbanowice',         name: 'Urbanowice-Cielmice', population: 3900, lat: 50.1098, lon: 19.0448, r: 430, seed: 22 },
];

/**
 * Existing AED points. `dx`/`dy` are metres from the district centre — that
 * is the main lever for coverage tuning.
 */
const EXISTING = [
  { id: 'AED-001', name: 'MOSiR, ul. Piłsudskiego 12', address: 'ul. Piłsudskiego 12',   district: 'srodmiescie-wschod', preset: 'P2', status: 'verified_ok',   dx: -395, dy: 205,  always: true },
  { id: 'AED-002', name: 'UM Tychy, wejście A',        address: 'al. Niepodległości 49', district: 'srodmiescie-polnoc', preset: 'P1', status: 'verified_ok',   dx: -340, dy: -230, always: true },
  { id: 'AED-003', name: 'SP nr 7 — hol główny',       address: 'ul. Szkolna 3',         district: 'zwakow',             preset: 'P1', status: 'verified_gaps', dx: 275,  dy: 250,  always: false },
  { id: 'AED-004', name: 'Basen „Paprocany”',          address: 'ul. Parkowa 17',        district: 'paprocany',          preset: 'P5', status: 'verified_gaps', dx: -300, dy: 330,  always: false },
  { id: 'AED-005', name: 'OSP Wilkowyje',              address: 'ul. Wilkowyjska 64',    district: 'wilkowyje',          preset: null, status: 'unverified',    dx: 20,   dy: -10,  always: null },
  { id: 'AED-006', name: 'Galeria „Azet”',             address: 'ul. Budowlanych 71',    district: 'srodmiescie-zachod', preset: null, status: 'unverified',    dx: 315,  dy: -265, always: null },
  { id: 'AED-007', name: 'Dworzec PKP Tychy',          address: 'pl. Dworcowy 1',        district: 'srodmiescie-zachod', preset: 'P2', status: 'verified_ok',   dx: -305, dy: 225,  always: true },
  { id: 'AED-008', name: 'Szpital Wojewódzki (SOR)',   address: 'ul. Edukacji 102',      district: 'srodmiescie-wschod', preset: 'P2', status: 'verified_ok',   dx: 400,  dy: -320, always: true },
  { id: 'AED-009', name: 'Kryta Pływalnia',            address: 'ul. Edukacji 9',        district: 'osiedle-mp',         preset: 'P1', status: 'verified_gaps', dx: 20,   dy: 40,   always: false },
  { id: 'AED-010', name: 'Mediateka',                  address: 'al. Piłsudskiego 16',   district: 'stare-tychy',        preset: 'P1', status: 'verified_ok',   dx: 40,   dy: 20,   always: false },
  { id: 'AED-011', name: 'Komenda Miejska Policji',    address: 'al. Bielska 46',        district: 'srodmiescie-polnoc', preset: 'P2', status: 'verified_ok',   dx: 330,  dy: 290,  always: true },
  { id: 'AED-012', name: 'SP nr 10 — szafka zewn.',    address: 'ul. Borowa 123',        district: 'czulow',             preset: 'P3', status: 'verified_gaps', dx: -30,  dy: 40,   always: true },
  { id: 'AED-013', name: 'Przychodnia os. N',          address: 'ul. Elfów 6',           district: 'osiedle-no',         preset: 'P1', status: 'verified_gaps', dx: 30,   dy: -20,  always: false },
  { id: 'AED-014', name: 'Market — Osiedle U',         address: 'ul. Damrota 62',        district: 'osiedle-tu',         preset: null, status: 'unverified',    dx: -40,  dy: 30,   always: null },
];

/**
 * The five sites the demo roadmap funds (spec §8). Their coordinates are NOT
 * hand-picked: the generator runs the same greedy optimiser the app uses and
 * places these five on the best candidate sites it finds, so the demo shows a
 * plan the tool itself would propose. Presets and phases are fixed to keep the
 * roadmap totals at 26 000 / 39 000 zł.
 */
const PROPOSED_SLOTS = [
  { id: 'NEW-001', preset: 'P1', phase: 2, always: false, fallbackName: 'SP nr 1 — wejście główne' },
  { id: 'NEW-002', preset: 'P1', phase: 2, always: false, fallbackName: 'Biblioteka miejska' },
  { id: 'NEW-003', preset: 'P2', phase: 2, always: true,  fallbackName: 'Hala sportowa' },
  { id: 'NEW-004', preset: 'P4', phase: 3, always: true,  fallbackName: 'Totem — plaża Paprocany' },
  { id: 'NEW-005', preset: 'P3', phase: 3, always: true,  fallbackName: 'Szafka zewnętrzna — Żwaków' },
];

/** Candidate sites for the greedy optimiser (~32, spec §8). */
const CANDIDATE_SPECS = [
  // 14 szkół
  ['C-01', 'SP nr 1 — wejście główne',        'osiedle-tu',         'P1', 260, -240, 'szkoła'],
  ['C-02', 'SP nr 3',                          'srodmiescie-zachod', 'P1', 300, 240,  'szkoła'],
  ['C-03', 'SP nr 5',                          'srodmiescie-polnoc', 'P1', 320, -280, 'szkoła'],
  ['C-04', 'SP nr 11',                         'osiedle-no',         'P1', -250, 200, 'szkoła'],
  ['C-05', 'SP nr 18',                         'osiedle-mp',         'P1', 280, -230, 'szkoła'],
  ['C-06', 'SP nr 22 — Paprocany',             'paprocany',          'P1', 300, 180,  'szkoła'],
  ['C-07', 'SP nr 35 — Żwaków',                'zwakow',             'P1', -250, 90,  'szkoła'],
  ['C-08', 'SP Wilkowyje',                     'wilkowyje',          'P1', -300, 280, 'szkoła'],
  ['C-09', 'SP Czułów',                        'czulow',             'P1', 290, -260, 'szkoła'],
  ['C-10', 'SP Urbanowice',                    'urbanowice',         'P1', -280, 250, 'szkoła'],
  ['C-11', 'ZS nr 1',                          'srodmiescie-wschod', 'P1', 120, 380,  'szkoła'],
  ['C-12', 'ZS nr 6',                          'stare-tychy',        'P1', -220, -190, 'szkoła'],
  ['C-13', 'Przedszkole nr 12',                'srodmiescie-zachod', 'P1', 60, 360,   'szkoła'],
  ['C-14', 'Zespół Szkół Sportowych',          'osiedle-tu',         'P1', 330, 300,  'szkoła'],
  // 6 obiektów sportowych
  ['C-15', 'Hala sportowa',                    'srodmiescie-wschod', 'P2', 20, 30,    'sport'],
  ['C-16', 'Stadion Miejski',                  'osiedle-mp',         'P2', -300, -260, 'sport'],
  ['C-17', 'Orlik — Czułów',                   'czulow',             'P3', -300, -270, 'sport'],
  ['C-18', 'Korty tenisowe Paprocany',         'paprocany',          'P3', 380, 200,  'sport'],
  ['C-19', 'Plaża i molo — Paprocany',         'paprocany',          'P4', 120, -140, 'sport'],
  ['C-20', 'Boisko Wilkowyje',                 'wilkowyje',          'P3', 300, -270, 'sport'],
  // 5 urzędów / instytucji
  ['C-21', 'Biblioteka miejska',               'srodmiescie-polnoc', 'P1', -30, 20,   'instytucja'],
  ['C-22', 'Urząd Skarbowy',                   'srodmiescie-polnoc', 'P1', 120, 330,  'instytucja'],
  ['C-23', 'MOPS',                             'srodmiescie-zachod', 'P1', -330, -180, 'instytucja'],
  ['C-24', 'Dom kultury Wilkowyje',            'wilkowyje',          'P1', 60, 330,   'instytucja'],
  ['C-25', 'Teatr Mały',                       'stare-tychy',        'P1', 230, 180,  'instytucja'],
  // 7 innych
  ['C-26', 'Punkt przy pętli autobusowej',     'zwakow',             'P3', -110, -160, 'inne'],
  ['C-27', 'Węzeł przesiadkowy',               'srodmiescie-zachod', 'P3', 25, -20,   'inne'],
  ['C-28', 'Targowisko miejskie',              'stare-tychy',        'P3', -60, 300,  'inne'],
  ['C-29', 'Market — Urbanowice',              'urbanowice',         'P3', 40, -30,  'inne'],
  ['C-30', 'Strefa przemysłowa — portiernia',  'urbanowice',         'P3', -320, -300, 'inne'],
  ['C-31', 'Pawilony os. M',                   'osiedle-mp',         'P3', 300, 270,  'inne'],
  ['C-32', 'Kościół — Czułów',                 'czulow',             'P1', 60, 320,   'inne'],
];

const PRESETS = [
  {
    id: 'P1', name: 'Wewnętrzny — budynek publiczny', cost: 8500,
    requiredFields: ['name', 'address', 'placement', 'access', 'keeper', 'signage.atDevice', 'signage.route', 'device.model', 'device.inspectionDue', 'dispatcherRegistered'],
    requiredPhotos: ['device', 'signage_route'],
    checklist: ['opiekun', 'oznakowanie wewnętrzne', 'oznakowanie dojścia'],
  },
  {
    id: 'P2', name: 'Wewnętrzny — obiekt 24/7', cost: 9000,
    requiredFields: ['name', 'address', 'placement', 'access', 'keeper', 'signage.atDevice', 'signage.route', 'device.model', 'device.inspectionDue', 'dispatcherRegistered'],
    requiredPhotos: ['device', 'signage_route'],
    checklist: ['dostęp całodobowy', 'opiekun', 'oznakowanie dojścia'],
  },
  {
    id: 'P3', name: 'Zewnętrzny — szafka na elewacji', cost: 15000,
    requiredFields: ['name', 'address', 'placement', 'keeper', 'signage.atDevice', 'signage.route', 'device.model', 'dispatcherRegistered', 'technical.power'],
    requiredPhotos: ['device', 'mounting_spot', 'power'],
    checklist: ['zasilanie 230 V', 'szafka ogrzewana IP55', 'oznakowanie dojścia', 'monitoring otwarcia'],
  },
  {
    id: 'P4', name: 'Zewnętrzny — słupek wolnostojący', cost: 24000,
    requiredFields: ['name', 'address', 'placement', 'keeper', 'signage.atDevice', 'signage.route', 'device.model', 'dispatcherRegistered', 'technical.power', 'technical.works'],
    requiredPhotos: ['device', 'mounting_spot', 'power', 'context'],
    checklist: ['przyłącze energetyczne', 'fundament i uzgodnienia', 'oświetlenie', 'monitoring otwarcia'],
  },
  {
    id: 'P5', name: 'Sezonowy / mobilny', cost: 6000,
    requiredFields: ['name', 'address', 'placement', 'access', 'keeper', 'device.model', 'dispatcherRegistered'],
    requiredPhotos: ['device'],
    checklist: ['harmonogram sezonu', 'miejsce przechowywania poza sezonem', 'opiekun'],
  },
];

/* ================================================================== *
 * Geometry helpers
 * ================================================================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Irregular but deterministic blob polygon around a centre. */
function makeBlob({ lat, lon, r, seed }, vertices = 26) {
  const rand = mulberry32(seed);
  const wobble = Array.from({ length: vertices }, () => 0.86 + rand() * 0.28);
  const ring = [];
  for (let i = 0; i <= vertices; i++) {
    const k = i % vertices;
    const theta = (2 * Math.PI * k) / vertices;
    // smooth the wobble so the outline is not spiky
    const prev = wobble[(k - 1 + vertices) % vertices];
    const next = wobble[(k + 1) % vertices];
    const radius = r * (0.25 * prev + 0.5 * wobble[k] + 0.25 * next);
    const p = offsetLatLon({ lat, lon }, radius * Math.cos(theta), radius * Math.sin(theta));
    ring.push([round6(p.lon), round6(p.lat)]);
  }
  return ring;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function placeAt(districtId, dx, dy) {
  const d = DISTRICTS.find((x) => x.id === districtId);
  const p = offsetLatLon({ lat: d.lat, lon: d.lon }, dx, dy);
  return { lat: round6(p.lat), lon: round6(p.lon) };
}

/* ================================================================== *
 * Build data structures
 * ================================================================== */

function buildDistrictsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: DISTRICTS.map((d) => ({
      type: 'Feature',
      properties: { id: d.id, name: d.name, population: d.population },
      geometry: { type: 'Polygon', coordinates: [makeBlob(d)] },
    })),
  };
}

function buildBoundaryGeoJSON() {
  const src = join(ROOT, '..', 'aed-audit-demo', 'data', 'tychy_boundary.json');
  if (existsSync(src)) {
    const raw = JSON.parse(readFileSync(src, 'utf8'));
    const ring = raw.ring_latlon.map(([lat, lon]) => [round6(lon), round6(lat)]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
    }
    return {
      type: 'Feature',
      properties: { name: 'Tychy', source: 'PRG (Państwowy Rejestr Granic)' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  }
  // fallback: convex-ish hull around the districts
  const ring = DISTRICTS.map((d) => [round6(d.lon), round6(d.lat)]);
  ring.push(ring[0]);
  return {
    type: 'Feature',
    properties: { name: 'Tychy', source: 'uproszczony obrys (brak PRG)' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

const OVERDUE_INSPECTION = new Set(['AED-003', 'AED-009', 'AED-013']);
const NO_ROUTE_SIGN = new Set(['AED-003']);
const NO_DEVICE_SIGN = new Set(['AED-004', 'AED-012']);
const NO_KEEPER = new Set(['AED-003', 'AED-004', 'AED-005', 'AED-006', 'AED-013', 'AED-014']);
const NOT_REGISTERED = new Set(['AED-003', 'AED-004', 'AED-009', 'AED-012', 'AED-013']);

/**
 * Przykładowe oceny eksperckie (sekcja 9 karty) — trzy punkty, po jednym na
 * każdy próg werdyktu, żeby demo pokazywało wszystkie stany od wejścia:
 * AED-002 dobra (UM, 24/7), AED-003 zadowalająca (szkoła), AED-006 niska
 * (galeria bez danych i opiekuna).
 */
const EXPERT_DEMO = {
  'AED-002': { D: 9, W: 8, N: 8, Z: 7, O: 9, R: 7, note: 'Wejście A czynne całodobowo, portiernia z obsadą — lokalizacja wzorcowa.' },
  'AED-003': { D: 4, W: 8, N: 7, Z: 8, O: 6, R: 8, note: 'Poza godzinami lekcji budynek zamknięty — dostępność ogranicza wynik.' },
  'AED-006': { D: 3, W: 4, N: 6, Z: 3, O: 2, R: 4, note: 'Prywatny właściciel, brak opiekuna i zgody na oznakowanie — do wyjaśnienia.' },
};

function buildExistingPoints() {
  const points = [];

  for (const e of EXISTING) {
    const { lat, lon } = placeAt(e.district, e.dx, e.dy);
    const unverified = e.status === 'unverified';

    points.push({
      id: e.id,
      kind: 'existing',
      status: e.status,
      name: e.name,
      address: e.address,
      districtId: e.district,
      lat,
      lon,
      presetId: e.preset,
      placement: unverified ? null : placementFor(e),
      access: unverified
        ? { always: null, hours: null, weekend: null, barriers: null }
        : accessFor(e),
      keeper: NO_KEEPER.has(e.id)
        ? { org: null, person: null, contact: null }
        : { org: keeperOrgFor(e), person: 'Anna Kowalska', contact: 'tel. 32 000 00 00' },
      signage: unverified
        ? { atDevice: null, route: null }
        : {
            atDevice: !NO_DEVICE_SIGN.has(e.id),
            route: !NO_ROUTE_SIGN.has(e.id),
          },
      device: unverified
        ? { model: null, inspectionDue: null, padsDue: null }
        : {
            model: deviceFor(e),
            inspectionDue: OVERDUE_INSPECTION.has(e.id) ? '2026-03' : '2027-05',
            padsDue: OVERDUE_INSPECTION.has(e.id) ? '2026-04' : '2027-02',
          },
      dispatcherRegistered: unverified ? null : !NOT_REGISTERED.has(e.id),
      technical: { power: null, distanceToSource: null, works: null, connectionCost: null, monitoring: false },
      expert: EXPERT_DEMO[e.id] || null,
      photos: [],
      verification: unverified
        ? { date: null, by: null, source: null }
        : { date: '2026-07-12', by: 'KB', source: 'operator' },
      recommendations: [],
      notes: unverified ? 'Punkt z importu OSM — wymaga wizyty terenowej.' : '',
    });
  }

  return points;
}

/**
 * Run the app's own greedy optimiser over the candidate list and turn the five
 * best sites into the funded proposals. Names follow the district when the
 * chosen site sits in Paprocany / Żwaków (the two outdoor units in the demo
 * roadmap), otherwise they fall back to the names used in the makieta.
 */
function buildProposedPoints(existing, candidates, demandPoints) {
  const picks = proposeNewPoints({
    demandPoints,
    points: existing,
    candidates,
    standardMinutes: STANDARD_MINUTES,
    count: PROPOSED_SLOTS.length,
    mode: 'day',
  });

  const outdoorFirst = ['paprocany', 'zwakow'];
  const slots = [...PROPOSED_SLOTS];
  const assigned = [];

  // Give the two outdoor presets (P4 / P3) to picks in Paprocany and Żwaków
  // when the optimiser selected them, so names and geography agree.
  for (const districtId of outdoorFirst) {
    const slotIndex = slots.findIndex((s) => s.preset === (districtId === 'paprocany' ? 'P4' : 'P3'));
    const pickIndex = picks.findIndex((p) => p.districtId === districtId && !p.__used);
    if (slotIndex >= 0 && pickIndex >= 0) {
      picks[pickIndex].__used = true;
      assigned.push({ slot: slots[slotIndex], pick: picks[pickIndex] });
      slots.splice(slotIndex, 1);
    }
  }
  for (const slot of slots) {
    const pick = picks.find((p) => !p.__used);
    if (!pick) continue;
    pick.__used = true;
    assigned.push({ slot, pick });
  }

  return assigned
    .sort((a, b) => a.slot.id.localeCompare(b.slot.id))
    .map(({ slot, pick }) => ({
      id: slot.id,
      kind: 'proposed',
      status: 'accepted',
      name: nameFor(slot, pick),
      address: null,
      districtId: pick.districtId,
      lat: round6(pick.lat),
      lon: round6(pick.lon),
      presetId: slot.preset,
      candidateId: pick.candidateId,
      placement: null,
      access: { always: slot.always, hours: null, weekend: null, barriers: null },
      keeper: { org: null, person: null, contact: null },
      signage: { atDevice: null, route: null },
      device: { model: null, inspectionDue: null, padsDue: null },
      dispatcherRegistered: null,
      technical: { power: null, distanceToSource: null, works: null, connectionCost: null, monitoring: false },
      photos: [],
      verification: { date: null, by: null, source: null },
      recommendations: [],
      notes: '',
      phase: slot.phase,
      gainPct: Math.round(pick.gainPct * 10) / 10,
      gainWeight: pick.gainWeight,
    }));
}

/** Outdoor presets are named after the location, indoor ones after the host. */
function nameFor(slot, pick) {
  const district = DISTRICTS.find((d) => d.id === pick.districtId);
  const where = district ? district.name : 'lokalizacja wskazana';
  if (slot.preset === 'P4') return `Totem wolnostojący — ${where}`;
  if (slot.preset === 'P3') return `Szafka zewnętrzna — ${where}`;
  return pick.name || slot.fallbackName;
}

function placementFor(e) {
  if (e.preset === 'P3') return 'szafka zewnętrzna na elewacji, od strony ulicy';
  if (e.preset === 'P5') return 'kasa główna, sezonowo maj–wrzesień';
  return 'hol główny, przy portierni';
}

function accessFor(e) {
  if (e.always) return { always: true, hours: 'całodobowo', weekend: 'całodobowo', barriers: null };
  if (e.preset === 'P5') {
    return { always: false, hours: 'V–IX, 9:00–19:00', weekend: 'V–IX, 9:00–19:00', barriers: 'poza sezonem niedostępny' };
  }
  return { always: false, hours: 'pn–pt 8:00–16:00', weekend: 'zamknięte', barriers: 'domofon po 15:00' };
}

function keeperOrgFor(e) {
  if (e.preset === 'P2') return 'MOSiR Tychy';
  return 'Urząd Miasta Tychy';
}

function deviceFor(e) {
  const models = ['Philips HS1', 'HeartSine Samaritan PAD 350P', 'Zoll AED Plus', 'Defibtech Lifeline'];
  return models[(e.id.charCodeAt(e.id.length - 1) + 1) % models.length];
}

function buildCandidates() {
  return CANDIDATE_SPECS.map(([id, name, district, preset, dx, dy, category]) => {
    const { lat, lon } = placeAt(district, dx, dy);
    return { id, name, districtId: district, presetId: preset, category, lat, lon };
  });
}

/** Roadmap items: auto-recs assigned to phase 1 + device purchases in 2/3. */
function buildRecommendations(points) {
  const recs = [];
  const presetById = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

  // Phase 1 — soft compliance actions on existing points.
  for (const p of points.filter((x) => x.kind === 'existing')) {
    if (p.device && p.device.inspectionDue && p.device.inspectionDue < '2026-07') {
      recs.push(mkRec(p, 'inspection', 'Wykonać przegląd + wymiana elektrod', 'high', 600, 'serwis', 1));
    }
    if (p.signage && p.signage.route === false) {
      recs.push(mkRec(p, 'signage_route', 'Doznakować dojście od ulicy (ILCOR)', 'medium', 800, 'gmina', 1));
    }
    if (p.signage && p.signage.atDevice === false) {
      recs.push(mkRec(p, 'signage_device', 'Oznakować urządzenie znakiem ILCOR', 'medium', 300, 'gmina', 1));
    }
    if (!p.keeper || !p.keeper.org) {
      recs.push(mkRec(p, 'keeper', 'Wyznaczyć opiekuna punktu', 'high', 0, 'gmina', 1));
    }
    if (p.dispatcherRegistered === false) {
      recs.push(mkRec(p, 'dispatcher', 'Zarejestrować AED u dyspozytora 112', 'high', 0, 'gmina', 1));
    }
  }

  // Phases 2 & 3 — the funded devices.
  for (const p of points.filter((x) => x.kind === 'proposed')) {
    const preset = presetById[p.presetId];
    recs.push({
      id: `plan-${p.id}`,
      pointId: p.id,
      rule: 'install',
      text: `Montaż AED — ${p.name} (${preset.name})`,
      priority: p.phase === 2 ? 'high' : 'medium',
      cost: preset.cost,
      owner: 'wykonawca',
      phase: p.phase,
      auto: false,
      done: false,
      startMonth: p.phase === 2 ? 7 : 19,
      lengthMonths: p.phase === 2 ? 5 : 8,
    });
  }

  // Procurement / paperwork tasks that actually drive the schedule (spec §6.6).
  recs.push(
    task('task-order', 'Zamówienie 3 szt. AED (przetarg uproszczony)', 2, 'gmina', 0, 7, 3),
    task('task-docs', 'Dokumentacja i uzgodnienia (PZT, OSD)', 3, 'wykonawca', 0, 19, 6),
    task('task-tender', 'Przetarg na roboty + dostawę', 3, 'gmina', 0, 22, 4)
  );

  return recs;
}

function mkRec(point, rule, text, priority, cost, owner, phase) {
  return {
    id: `auto-${point.id}-${rule}`,
    pointId: point.id,
    rule,
    text,
    priority,
    cost,
    owner,
    phase,
    auto: true,
    done: false,
    startMonth: 1,
    lengthMonths: 5,
  };
}

function task(id, text, phase, owner, cost, startMonth, lengthMonths) {
  return {
    id,
    pointId: null,
    rule: 'task',
    text,
    priority: 'medium',
    cost,
    owner,
    phase,
    auto: false,
    done: false,
    startMonth,
    lengthMonths,
  };
}

/* ================================================================== *
 * Report
 * ================================================================== */

function report(districtsGeo, points, candidates, recs) {
  const demand = buildDemandPoints(districtsGeo.features);
  const districts = DISTRICTS.map(({ id, name, population }) => ({ id, name, population }));

  const line = (label, value, target) =>
    `  ${label.padEnd(34)} ${String(value).padStart(12)}   ${target ? `cel: ${target}` : ''}`;

  console.log('\n══════ DEMO TYCHY — kontrola KPI (model = js/model.js) ══════');
  console.log(`  punktów popytu: ${demand.length}   ludność: ${POPULATION.toLocaleString('pl-PL')}`);

  for (const std of [2, 3, 5]) {
    const now = analyze({ demandPoints: demand, points, districts, standardMinutes: std, population: POPULATION, scenario: 'now', mode: 'day' });
    const plan = analyze({ demandPoints: demand, points, districts, standardMinutes: std, population: POPULATION, scenario: 'plan', mode: 'day' });
    const night = analyze({ demandPoints: demand, points, districts, standardMinutes: std, population: POPULATION, scenario: 'now', mode: 'night' });
    const mark = std === STANDARD_MINUTES ? ' ← DOMYŚLNY W DEMO' : '';
    console.log(`\n── standard ≤${std} min (promień ${coverageRadiusM(std).toFixed(0)} m)${mark}`);
    console.log(line('pokrycie teraz', `${now.coveragePct.toFixed(1)}%`, std === STANDARD_MINUTES ? '62%' : ''));
    console.log(line('pokrycie po planie', `${plan.coveragePct.toFixed(1)}%`, std === STANDARD_MINUTES ? '81%' : ''));
    console.log(line('pokrycie noc (24/7)', `${night.coveragePct.toFixed(1)}%`));
    console.log(line('mediana dojścia teraz', fmtMin(now.medianMin), std === STANDARD_MINUTES ? '3,2 min' : ''));
    console.log(line('mediana dojścia po planie', fmtMin(plan.medianMin), std === STANDARD_MINUTES ? '2,4 min' : ''));
    console.log(line('AED / 10 tys. teraz', now.aedPer10k.toFixed(2), std === STANDARD_MINUTES ? '1,4' : ''));
    console.log(line('AED / 10 tys. po planie', plan.aedPer10k.toFixed(2), std === STANDARD_MINUTES ? '2,1' : ''));
    console.log(line('% punktów 24/7', `${now.always247Pct.toFixed(0)}%`, std === STANDARD_MINUTES ? '43%' : ''));

    if (std === STANDARD_MINUTES) {
      console.log('  luki (teraz):');
      for (const g of now.gaps.slice(0, 5)) {
        console.log(`      ${g.name.padEnd(22)} ${String(g.uncoveredPeople).padStart(6)} os. poza · max ${fmtMin(g.maxMin)}`);
      }
      console.log('      cele: Paprocany 4 100 / 7 min · Żwaków 2 800 / 6 min · Stare Tychy 900 / 4 min');
    }
  }

  const cost = { 1: 0, 2: 0, 3: 0 };
  for (const r of recs) if (r.phase) cost[r.phase] += r.cost || 0;
  console.log('\n── roadmapa');
  console.log(line('Faza 1', `${cost[1].toLocaleString('pl-PL')} zł`, '3 200 zł'));
  console.log(line('Faza 2', `${cost[2].toLocaleString('pl-PL')} zł`, '26 000 zł'));
  console.log(line('Faza 3', `${cost[3].toLocaleString('pl-PL')} zł`, '39 000 zł'));
  console.log(line('razem', `${(cost[1] + cost[2] + cost[3]).toLocaleString('pl-PL')} zł`, '68 200 zł'));

  const byStatus = points.reduce((acc, p) => {
    if (p.kind !== 'existing') return acc;
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  console.log('\n── inwentaryzacja');
  console.log(line('verified_ok / gaps / unverified',
    `${byStatus.verified_ok || 0} / ${byStatus.verified_gaps || 0} / ${byStatus.unverified || 0}`, '6 / 5 / 3'));
  console.log(line('kandydaci', candidates.length, '~32'));
  console.log('');
}

/* ================================================================== *
 * Main
 * ================================================================== */

const districtsGeo = buildDistrictsGeoJSON();
const boundary = buildBoundaryGeoJSON();
const candidates = buildCandidates();
const demandPoints = buildDemandPoints(districtsGeo.features);
const existingPoints = buildExistingPoints();
const points = [...existingPoints, ...buildProposedPoints(existingPoints, candidates, demandPoints)];
const recommendations = buildRecommendations(points);

const demo = {
  project: {
    id: 'tychy-2026',
    name: 'Tychy',
    label: 'TYCHY — Audyt 2026',
    status: 'w_toku',
    population: POPULATION,
    standardMinutes: STANDARD_MINUTES,
    boundary: 'boundary-tychy.geojson',
    districtsFile: 'districts-tychy.geojson',
    districts: DISTRICTS.map(({ id, name, population }) => ({ id, name, population })),
    stepsDone: [0, 1, 2],
    updatedAt: '2026-07-29',
    center: [19.0, 50.118],
    zoom: 11.6,
  },
  points,
  candidates,
  photos: [],
  recommendations,
};

if (!REPORT_ONLY) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'districts-tychy.geojson'), JSON.stringify(districtsGeo));
  writeFileSync(join(DATA, 'boundary-tychy.geojson'), JSON.stringify(boundary));
  writeFileSync(join(DATA, 'presets.json'), JSON.stringify(PRESETS, null, 2));
  writeFileSync(join(DATA, 'demo-tychy.json'), JSON.stringify(demo, null, 2));
  console.log('zapisano: districts-tychy.geojson, boundary-tychy.geojson, presets.json, demo-tychy.json');
}

report(districtsGeo, points, candidates, recommendations);
