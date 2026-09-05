/**
 * reach.js – zasięgi dojścia pieszego po realnej sieci ulic i chodników.
 *
 * Zastępuje okrąg „promień = czas × prędkość ÷ współczynnik obejścia" realnym
 * obrysem izochrony z Mapboksa, policzonym po sieci pieszej OSM. Różnica jest
 * merytoryczna, nie kosmetyczna: tory, rzeka, ekran akustyczny albo ogrodzone
 * osiedle potrafią odciąć teren, który w linii prostej leży 200 m od AED,
 * a pieszo jest 900 m. Okrąg pokazywał tam pokrycie, którego nie ma.
 *
 * Trzy źródła zasięgu, w tej kolejności:
 *   1. cache projektu (data/reach-tychy.json) – powtarzalny, offline, bez API,
 *   2. zapytanie do Mapboksa w locie – dla punktów dodanych lub przesuniętych
 *      przez operatora; wynik zostaje w pamięci sesji,
 *   3. okrąg – gdy nie ma ani cache, ani sieci. Analiza działa dalej, ale
 *      widok mówi wprost, że to przybliżenie.
 *
 * Klucz cache to zaokrąglona współrzędna (5 miejsc ≈ 1 m) – identycznie jak
 * w tools/fetch-reach.mjs. Przesunięcie pinu o metr trafia w ten sam wpis,
 * realne przesunięcie wymusza nowe liczenie.
 */

import { MAPBOX_TOKEN } from '../config.js';
// Klucz cache mieszka w model.js, żeby aplikacja, model i narzędzie
// pobierające izochrony liczyły go dokładnie tak samo.
import { reachKey } from './model.js';

export { reachKey };

const REACH_FILE = 'data/reach-tychy.json';

/** Po tylu ms rezygnujemy z zapytania o izochronę i schodzimy do okręgu. */
const FETCH_TIMEOUT_MS = 6000;

let cache = null; // {meta, contours, routes}
let loading = null;
const live = new Map(); // klucz → {contours} dopytane w locie
const pending = new Map(); // klucz → Promise, żeby nie pytać dwa razy o to samo
const liveRoutes = new Map(); // klucz → trasy dojścia dociągnięte w tej sesji
const pendingRoutes = new Map();

export async function loadReach() {
  if (cache) return cache;
  if (!loading) {
    loading = fetch(REACH_FILE)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        cache = data || { meta: {}, contours: {}, routes: {} };
        return cache;
      });
  }
  return loading;
}

/** Czy w ogóle mamy z czego liczyć po sieci (cache albo token do zapytań). */
export function reachAvailable() {
  return !!(cache && Object.keys(cache.contours || {}).length) || tokenUsable();
}

function tokenUsable() {
  return typeof MAPBOX_TOKEN === 'string' && MAPBOX_TOKEN.startsWith('pk.');
}

/** Kontury dla lokalizacji: {2: ring, 3: ring, 5: ring, 8: ring} albo null. */
export function contoursFor(lat, lon) {
  const key = reachKey(lat, lon);
  if (live.has(key)) return live.get(key);
  return (cache && cache.contours && cache.contours[key]) || null;
}

/** Trasy dojścia, które narysowały obrys: cache projektu albo dociągnięte w tej sesji. */
export function routesFor(lat, lon) {
  const key = reachKey(lat, lon);
  if (liveRoutes.has(key)) return liveRoutes.get(key);
  return (cache && cache.routes && cache.routes[key]) || null;
}

/** Drabina konturów, na której liczony jest cache (do etykiet w UI). */
export function contourLadder() {
  return (cache && cache.meta && cache.meta.contours) || [2, 3, 5, 8];
}

/**
 * Dopytuje Mapboksa o izochronę dla jednej lokalizacji. Zwraca kontury albo
 * null (brak tokenu, brak sieci, błąd API) – wywołujący ma wtedy zejść
 * do okręgu, a nie przerywać analizy.
 */
export async function fetchReach(lat, lon) {
  const key = reachKey(lat, lon);
  const known = contoursFor(lat, lon);
  if (known) return known;
  if (!tokenUsable()) return null;
  if (pending.has(key)) return pending.get(key);

  const ladder = contourLadder().join(',');
  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon.toFixed(5)},${lat.toFixed(5)}` +
    `?contours_minutes=${ladder}&polygons=true&denoise=1&generalize=12&access_token=${MAPBOX_TOKEN}`;

  // Twardy limit czasu: bez niego jedno wiszące zapytanie zatrzymywałoby
  // przerysowanie widoku po dodaniu punktu.
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;

  const task = fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (!json || !json.features) return null;
      const out = {};
      for (const f of json.features) {
        const minutes = f.properties && f.properties.contour;
        if (!minutes || !f.geometry) continue;
        const polys =
          f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
        let biggest = null;
        for (const poly of polys) {
          if (poly[0] && (!biggest || poly[0].length > biggest.length)) biggest = poly[0];
        }
        if (biggest) out[minutes] = biggest;
      }
      if (!Object.keys(out).length) return null;
      live.set(key, out);
      return out;
    })
    .catch(() => null)
    .finally(() => {
      if (timer) clearTimeout(timer);
      pending.delete(key);
    });

  pending.set(key, task);
  return task;
}

/**
 * Uzupełnia zasięgi dla listy lokalizacji i zwraca mapę klucz → kontury,
 * gotową do podania modelowi. Lokalizacje bez zasięgu po prostu w niej nie ma –
 * model policzy je okręgiem.
 *
 * @param {Array<{lat:number, lon:number}>} sites
 * @param {boolean} allowFetch czy wolno dopytywać Mapboksa (domyślnie tak)
 * @param {Function|null} onLater wołane, gdy zasięg dociągnięty w tle jest gotowy
 */
export async function reachMapFor(sites, { allowFetch = true, onLater = null } = {}) {
  await loadReach();
  const out = {};
  const missing = [];

  for (const s of sites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const key = reachKey(s.lat, s.lon);
    if (out[key]) continue;
    const known = contoursFor(s.lat, s.lon);
    if (known) out[key] = known;
    else missing.push(s);
  }

  // Brakujące zasięgi dociągamy W TLE. Widok nie może czekać na sieć: po
  // dodaniu punktu ma się przerysować natychmiast (nowy punkt leci wtedy
  // okręgiem), a gdy izochrona dojdzie, `onLater` prosi o kolejny render.
  // Kolejne wywołanie znajdzie ją już w cache, więc pętli nie ma.
  if (allowFetch && missing.length && tokenUsable()) {
    Promise.all(missing.map((s) => fetchReach(s.lat, s.lon)))
      .then((results) => {
        if (results.some(Boolean) && typeof onLater === 'function') onLater();
      })
      .catch(() => {});
  }

  return out;
}

/**
 * Trasy dojścia dla lokalizacji spoza cache – dociągane z Directions API
 * na żądanie (po kliknięciu w punkt). Dwanaście kierunków rozłożonych po
 * kącie, każdy do najdalszego wierzchołka konturu w swoim wycinku, więc
 * linie realnie obrysowują zasięg, a nie idą losowo.
 *
 * Zwraca [] przy braku tokenu, sieci albo konturu – widok pokaże sam obrys.
 */
export async function fetchRoutes(lat, lon, ring, count = 12) {
  const key = reachKey(lat, lon);
  if (liveRoutes.has(key)) return liveRoutes.get(key);
  if (!tokenUsable() || !Array.isArray(ring) || ring.length < 3) return [];
  if (pendingRoutes.has(key)) return pendingRoutes.get(key);

  // Najdalszy wierzchołek konturu w każdym z `count` wycinków kąta.
  const buckets = new Array(count).fill(null);
  for (const [rlon, rlat] of ring) {
    const angle = Math.atan2(rlat - lat, rlon - lon);
    const idx = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * count) % count;
    const d = Math.hypot(rlon - lon, rlat - lat);
    if (!buckets[idx] || d > buckets[idx].d) buckets[idx] = { pt: [rlon, rlat], d };
  }
  const targets = buckets.filter(Boolean).map((b) => b.pt);

  const one = async (target) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/walking/` +
        `${lon.toFixed(5)},${lat.toFixed(5)};${target[0].toFixed(5)},${target[1].toFixed(5)}` +
        `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res.ok) return null;
      const json = await res.json();
      const route = json.routes && json.routes[0];
      if (!route || !route.geometry) return null;
      return {
        line: route.geometry.coordinates,
        distanceM: Math.round(route.distance),
        durationMin: Math.round((route.duration / 60) * 10) / 10,
      };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const task = Promise.all(targets.map(one))
    .then((rs) => {
      const out = rs.filter(Boolean);
      liveRoutes.set(key, out);
      return out;
    })
    .catch(() => [])
    .finally(() => pendingRoutes.delete(key));

  pendingRoutes.set(key, task);
  return task;
}

/**
 * Trasa piesza między dwoma punktami – Directions API.
 *
 * Używana przez ludzika w analizie: świadek stoi gdzieś na mapie, AED gdzie
 * indziej, a odpowiedź „ile mu zajmie dojście" musi iść po chodnikach, a nie
 * w linii prostej. Zwraca null przy braku tokenu, sieci albo trasy – wtedy
 * wołający liczy przybliżenie z modelu i mówi o tym wprost.
 */
export async function fetchWalk(fromLat, fromLon, toLat, toLon) {
  if (!tokenUsable()) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/walking/` +
      `${fromLon.toFixed(5)},${fromLat.toFixed(5)};${toLon.toFixed(5)},${toLat.toFixed(5)}` +
      `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) return null;
    const json = await res.json();
    const route = json.routes && json.routes[0];
    if (!route || !route.geometry) return null;
    return {
      line: route.geometry.coordinates,
      distanceM: Math.round(route.distance),
      minutes: Math.round((route.duration / 60) * 10) / 10,
      network: true,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wersja synchroniczna – buduje mapę zasięgów wyłącznie z tego, co już jest
 * wczytane (cache projektu + wyniki dopytane wcześniej w tej sesji).
 * Dla widoków, które renderują się synchronicznie: roadmapa, raport, pulpit.
 * Dzięki temu KPI w każdym kroku liczy się tym samym zasięgiem – inaczej
 * krok 2 mówiłby 51%, a roadmapa 62% i nikt by nie wiedział, któremu wierzyć.
 */
export function reachMapSync(sites) {
  const out = {};
  for (const s of sites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const c = contoursFor(s.lat, s.lon);
    if (c) out[reachKey(s.lat, s.lon)] = c;
  }
  return out;
}

/** Ile lokalizacji z listy ma realny zasięg, a ile poleci okręgiem. */
export function reachCoverageOf(sites, reachMap) {
  let network = 0;
  for (const s of sites) {
    if (reachMap[reachKey(s.lat, s.lon)]) network += 1;
  }
  return { network, total: sites.length, radius: sites.length - network };
}
