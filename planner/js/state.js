/**
 * state.js – the single application state object, its IndexedDB persistence
 * and the photo blob store.
 *
 * Everything the UI renders comes from `state`. Views mutate it through the
 * helpers here and then call `save()`, which persists and notifies subscribers.
 *
 * Spec reference: ITERACJA2_SPEC.md §2, §4.
 */

import { DB_NAME, DB_VERSION, DEMO_PROJECT_FILE, TODAY } from '../config.js';
import { buildDemandPoints } from './model.js';

/* ------------------------------------------------------------------ *
 * The state object
 * ------------------------------------------------------------------ */

export const state = {
  /** Dashboard project index. Only `tychy-2026` carries demo data. */
  projects: [
    { id: 'tychy-2026', name: 'Tychy', label: 'TYCHY – Audyt 2026', status: 'w_toku', available: true },
    { id: 'brodnica-2026', name: 'Brodnica', label: 'BRODNICA – Audyt 2026', status: 'oferta', available: false },
    { id: 'czluchow-2026', name: 'Człuchów', label: 'CZŁUCHÓW – Audyt 2026', status: 'oferta', available: false },
  ],

  project: null,        // active project (spec §4 "project")
  points: [],           // spec §4 "points"
  photos: [],           // spec §4 "photos" – metadata only, blobs live in IDB
  recommendations: [],  // spec §4 "recommendations"
  presets: [],          // spec §4 "presets"
  candidates: [],       // sites the optimiser may choose from

  boundary: null,       // GeoJSON Feature
  districtsGeo: null,   // GeoJSON FeatureCollection
  demandPoints: [],     // derived, never persisted

  /** Transient interface state – persisted so a reload feels continuous. */
  ui: {
    scenario: 'now',    // 'now' | 'plan'
    mode: 'day',        // 'day' | 'night'
    selectedPointId: null,
    inventoryFilter: 'all',
    cardsFilter: 'all',
    roadmapView: 'kanban', // 'kanban' | 'timeline'
    proposeCount: 2,
    reportSections: null,  // null = all on
  },

  /** Proposals produced by the optimiser but not yet accepted or rejected. */
  pendingProposals: [],

  ready: false,
};

export const TODAY_DATE = TODAY;

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of [...listeners]) fn(state);
}

/* ------------------------------------------------------------------ *
 * IndexedDB
 * ------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB niedostępne'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbGet(store, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbPut(store, key, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDelete(store, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/* ------------------------------------------------------------------ *
 * Photo blob store – the only two functions that touch photo bytes.
 * Iteration 3 swaps their bodies for disk access; nothing else changes.
 * ------------------------------------------------------------------ */

const objectUrls = new Map();

export async function savePhotoBlob(key, blob) {
  await idbPut('photos', key, blob);
  const stale = objectUrls.get(key);
  if (stale) {
    URL.revokeObjectURL(stale);
    objectUrls.delete(key);
  }
  return key;
}

export async function getPhotoUrl(key) {
  if (!key) return null;
  if (objectUrls.has(key)) return objectUrls.get(key);
  const blob = await idbGet('photos', key).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

export async function deletePhotoBlob(key) {
  const url = objectUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(key);
  }
  await idbDelete('photos', key).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Load / seed / save
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'project:tychy-2026';

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Nie udało się wczytać ${path} (${res.status})`);
  return res.json();
}

/** Seed placeholder photos so demo cards are not empty. */
async function seedDemoPhotos() {
  const specs = [
    { id: 'ph-001', pointId: 'AED-001', role: 'device', caption: 'AED w holu obiektu', color: '#4caf7d', text: 'AED' },
    { id: 'ph-002', pointId: 'AED-001', role: 'signage_route', caption: 'Tabliczka kierunkowa przy wejściu', color: '#3a3a3a', text: 'ZNAK' },
    { id: 'ph-003', pointId: 'AED-003', role: 'device', caption: 'AED przy portierni', color: '#4caf7d', text: 'AED' },
    { id: 'ph-004', pointId: 'AED-002', role: 'device', caption: 'AED – wejście A', color: '#4caf7d', text: 'AED' },
    { id: 'ph-005', pointId: 'AED-002', role: 'signage_route', caption: 'Oznakowanie dojścia', color: '#3a3a3a', text: 'ZNAK' },
    { id: 'ph-006', pointId: 'AED-004', role: 'device', caption: 'AED przy kasie basenu', color: '#4caf7d', text: 'AED' },
  ];

  const metas = [];
  for (const s of specs) {
    const svg = placeholderSvg(s.color, s.text, s.caption);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    await savePhotoBlob(s.id, blob);
    await savePhotoBlob(`${s.id}-t`, blob);
    metas.push({
      id: s.id,
      pointId: s.pointId,
      role: s.role,
      caption: s.caption,
      takenAt: '2026-07-12T10:22',
      gps: null,
      width: 1600,
      height: 1200,
      bytes: svg.length,
      blobKey: s.id,
      thumbKey: `${s.id}-t`,
      demo: true,
    });
  }
  return metas;
}

function placeholderSvg(color, text, caption) {
  const safe = String(caption).replace(/[<>&]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#ededea"/>
  <rect x="0" y="0" width="400" height="300" fill="none" stroke="#d0d0d0" stroke-width="2"/>
  <rect x="150" y="105" width="100" height="70" rx="4" fill="${color}"/>
  <text x="200" y="148" font-family="Inter, sans-serif" font-size="22" font-weight="700"
        fill="#ffffff" text-anchor="middle">${text}</text>
  <text x="200" y="215" font-family="Inter, sans-serif" font-size="13"
        fill="#666666" text-anchor="middle">${safe}</text>
  <text x="200" y="238" font-family="Inter, sans-serif" font-size="11"
        fill="#999999" text-anchor="middle">zdjęcie poglądowe (demo)</text>
</svg>`;
}

/** Load persisted state, or seed from the demo JSON on first run. */
export async function initState({ reset = false } = {}) {
  let stored = null;
  if (!reset) {
    stored = await idbGet('kv', STORAGE_KEY).catch(() => null);
  }

  const [boundary, districtsGeo, presets] = await Promise.all([
    fetchJson('data/boundary-tychy.geojson'),
    fetchJson('data/districts-tychy.geojson'),
    fetchJson('data/presets.json'),
  ]);

  state.boundary = boundary;
  state.districtsGeo = districtsGeo;
  state.presets = presets;

  const demo = await fetchJson(DEMO_PROJECT_FILE);

  // Zapisany projekt sprzed zmiany danych demo (inne współrzędne punktów) nie
  // trafiałby w cache izochron i mapa pokazywałaby pustkę. Stempel wersji
  // rozstrzyga to jednoznacznie: rozjazd = wracamy do świeżego demo.
  if (stored && stored.project && stored.project.dataVersion !== demo.project.dataVersion) {
    console.info('Dane demo są nowsze niż zapisany projekt – wczytuję je od nowa.');
    stored = null;
  }

  if (stored) {
    Object.assign(state, {
      project: stored.project,
      points: stored.points,
      photos: stored.photos || [],
      recommendations: stored.recommendations || [],
      candidates: stored.candidates || [],
      pendingProposals: stored.pendingProposals || [],
      ui: { ...state.ui, ...(stored.ui || {}) },
    });
  } else {
    state.project = demo.project;
    state.points = demo.points;
    state.recommendations = demo.recommendations || [];
    state.candidates = demo.candidates || [];
    state.photos = await seedDemoPhotos().catch(() => []);
    // link seeded photos to their points
    for (const ph of state.photos) {
      const point = state.points.find((p) => p.id === ph.pointId);
      if (point && !point.photos.includes(ph.id)) point.photos.push(ph.id);
    }
  }

  // Siatka popytu jest częścią danych projektu (w produkcji: siatka GUS 1 km),
  // a nie pochodną granic dzielnic – dzielnice z OSM to warstwa administracyjna,
  // a rozkład ludności modelują osobne rdzenie gęstości zabudowy. Fallback dla
  // projektów bez własnej siatki: spirala z wielokątów dzielnic, jak dawniej.
  state.demandPoints =
    Array.isArray(demo.demandPoints) && demo.demandPoints.length
      ? demo.demandPoints
      : buildDemandPoints(districtsGeo.features);
  state.ready = true;
  if (!stored) await save({ silent: true });
  return state;
}

export async function save({ silent = false } = {}) {
  if (state.project) state.project.updatedAt = TODAY;
  const snapshot = {
    project: state.project,
    points: state.points,
    photos: state.photos,
    recommendations: state.recommendations,
    candidates: state.candidates,
    pendingProposals: state.pendingProposals,
    ui: state.ui,
  };
  await idbPut('kv', STORAGE_KEY, snapshot).catch(() => {});
  if (!silent) notify();
}

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

/**
 * One entry per discrete operator action – adding a point on the map, moving a
 * pin, accepting a proposal. Field-level edits inside a card are not stacked;
 * they would bury the map actions the button is there for.
 *
 * Photo blobs are not rolled back: undoing a photo upload drops its metadata
 * and leaves an orphan blob in IndexedDB, which nothing reads.
 */
const undoStack = [];
const UNDO_LIMIT = 30;

const UNDO_SLICES = ['project', 'points', 'photos', 'recommendations', 'candidates', 'pendingProposals'];

function cloneUndoSlice() {
  const raw = {};
  for (const key of UNDO_SLICES) raw[key] = state[key];
  return typeof structuredClone === 'function' ? structuredClone(raw) : JSON.parse(JSON.stringify(raw));
}

/** Record the state as it is *before* a mutation. Call it, then mutate, then save(). */
export function checkpoint(label) {
  undoStack.push({ label: label || 'ostatnią zmianę', data: cloneUndoSlice() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

/** Discard the last checkpoint without restoring it – for an action that turned out to be a no-op. */
export function dropCheckpoint() {
  undoStack.pop();
}

export function canUndo() {
  return undoStack.length > 0;
}

/** Label of the action the next undo would reverse. */
export function undoLabel() {
  return undoStack.length ? undoStack[undoStack.length - 1].label : '';
}

/** Roll back the last checkpointed action. Returns its label, or null. */
export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  for (const key of UNDO_SLICES) state[key] = entry.data[key];
  if (state.ui.selectedPointId && !getPoint(state.ui.selectedPointId)) {
    state.ui.selectedPointId = null;
  }
  await save();
  return entry.label;
}

/** Wipe persisted data and reload the demo project. */
export async function resetToDemo() {
  undoStack.length = 0;
  await idbDelete('kv', STORAGE_KEY).catch(() => {});
  for (const ph of state.photos) {
    await deletePhotoBlob(ph.blobKey);
    await deletePhotoBlob(ph.thumbKey);
  }
  await initState({ reset: true });
  notify();
}

/* ------------------------------------------------------------------ *
 * Export / import (spec §1 – ZIP is iteration 3; here it is JSON)
 * ------------------------------------------------------------------ */

export function exportProject() {
  return {
    format: 'sinecco-aed-planner/1',
    exportedAt: TODAY,
    project: state.project,
    points: state.points,
    photos: state.photos.map((p) => ({ ...p, blobKey: p.blobKey, thumbKey: p.thumbKey })),
    recommendations: state.recommendations,
    candidates: state.candidates,
  };
}

export async function importProject(data) {
  if (!data || !data.project || !Array.isArray(data.points)) {
    throw new Error('Plik nie wygląda na projekt AED Planner.');
  }
  state.project = data.project;
  state.points = data.points;
  state.photos = data.photos || [];
  state.recommendations = data.recommendations || [];
  state.candidates = data.candidates || [];
  state.pendingProposals = [];
  await save();
}

/* ------------------------------------------------------------------ *
 * Accessors and mutations
 * ------------------------------------------------------------------ */

export function getPoint(id) {
  return state.points.find((p) => p.id === id) || null;
}

export function getPreset(id) {
  return state.presets.find((p) => p.id === id) || null;
}

export function getDistrict(id) {
  return (state.project?.districts || []).find((d) => d.id === id) || null;
}

export function districtName(id) {
  const d = getDistrict(id);
  return d ? d.name : '–';
}

export function photosForPoint(pointId) {
  return state.photos.filter((p) => p.pointId === pointId);
}

export function recommendationsForPoint(pointId) {
  return state.recommendations.filter((r) => r.pointId === pointId);
}

/** Next free id for a given prefix, e.g. nextId('AED') -> 'AED-015'. */
export function nextId(prefix) {
  const used = state.points
    .map((p) => p.id)
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => parseInt(id.slice(prefix.length + 1), 10))
    .filter((n) => !Number.isNaN(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

export function upsertPoint(point) {
  const i = state.points.findIndex((p) => p.id === point.id);
  if (i >= 0) state.points[i] = point;
  else state.points.push(point);
}

export function removePoint(id) {
  state.points = state.points.filter((p) => p.id !== id);
  state.recommendations = state.recommendations.filter((r) => r.pointId !== id);
  state.photos = state.photos.filter((p) => p.pointId !== id);
}

export function upsertRecommendation(rec) {
  const i = state.recommendations.findIndex((r) => r.id === rec.id);
  if (i >= 0) state.recommendations[i] = { ...state.recommendations[i], ...rec };
  else state.recommendations.push(rec);
}

export function removeRecommendation(id) {
  state.recommendations = state.recommendations.filter((r) => r.id !== id);
}

/** Mark a step as completed in the stepper. */
export function markStepDone(step) {
  if (!state.project) return;
  const done = new Set(state.project.stepsDone || []);
  done.add(step);
  state.project.stepsDone = [...done].sort((a, b) => a - b);
}

/** Blank point used by "+ DODAJ PUNKT" and the setup import. */
export function makePoint({ id, name, lat, lon, presetId = 'P1', districtId = null, kind = 'existing' }) {
  return {
    id,
    kind,
    status: kind === 'proposed' ? 'proposed' : 'unverified',
    name,
    address: '',
    districtId,
    lat,
    lon,
    presetId,
    placement: '',
    access: { always: null, hours: '', weekend: '', barriers: '' },
    keeper: { org: null, person: null, contact: null },
    signage: { atDevice: null, route: null },
    device: { model: null, inspectionDue: null, padsDue: null },
    dispatcherRegistered: null,
    technical: { power: null, distanceToSource: null, works: null, connectionCost: null, monitoring: false },
    expert: null, // ocena ekspercka {D,W,N,Z,O,R, note} – null, dopóki audytor nie oceni
    photos: [],
    verification: { date: null, by: null, source: null },
    recommendations: [],
    notes: '',
  };
}

/**
 * Which district polygon contains a coordinate – used when the operator drops
 * a pin on the map so the point lands in the right gap statistics.
 */
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function districtAt(lat, lon) {
  const features = state.districtsGeo?.features || [];
  for (const f of features) {
    if (pointInRing(lat, lon, f.geometry.coordinates[0])) return f.properties.id;
  }

  // Realne granice z OSM miewają szczeliny (cztery relacje Tychów są w źródle
  // niedomknięte). Punkt wewnątrz miasta, który nie trafił w żaden wielokąt,
  // dostaje najbliższą dzielnicę po centroidzie – zamiast null, które
  // blokowałoby dodawanie punktów.
  const boundary = state.boundary?.geometry?.coordinates?.[0];
  if (!boundary || !pointInRing(lat, lon, boundary)) return null;

  let best = null;
  let bestD = Infinity;
  for (const f of features) {
    const ring = f.geometry.coordinates[0];
    let cx = 0;
    let cy = 0;
    for (const [x, y] of ring) {
      cx += x;
      cy += y;
    }
    cx /= ring.length;
    cy /= ring.length;
    const d = (cx - lon) * (cx - lon) + (cy - lat) * (cy - lat);
    if (d < bestD) {
      bestD = d;
      best = f.properties.id;
    }
  }
  return best;
}
