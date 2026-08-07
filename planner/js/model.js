/**
 * model.js — all analytical computation for the AED planner.
 *
 * Pure functions only: no DOM, no state import, no side effects.
 * This module is imported both by the browser app and by tools/generate-demo.mjs,
 * so demo-data tuning uses exactly the same math the UI shows.
 *
 * Spec reference: ITERACJA2_SPEC.md §5.
 */

/* ------------------------------------------------------------------ *
 * Constants (spec §5)
 * ------------------------------------------------------------------ */

/** Walking speed of a bystander fetching an AED, metres per minute. */
export const WALK_SPEED = 100;

/** Straight-line -> street-network correction factor. */
export const DETOUR = 1.35;

/** Golden angle, used for deterministic demand-point scatter. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Radial density exponent for demand scatter. 0.5 spreads people evenly by
 * area; higher values pull them towards the centre of the built-up area,
 * which is how residential density actually behaves inside an estate.
 */
export const DENSITY_FALLOFF = 0.68;

const M_PER_DEG_LAT = 111320;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export function metresPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Equirectangular approximation — accurate enough at city scale. */
export function distanceM(a, b) {
  const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dx = (a.lon - b.lon) * metresPerDegLon((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

/** One-way walking time in minutes for a straight-line distance. */
export function walkTimeMin(distM) {
  return (distM * DETOUR) / WALK_SPEED;
}

/** Coverage radius for a standard expressed as one-way minutes. */
export function coverageRadiusM(standardMinutes) {
  return (standardMinutes * WALK_SPEED) / DETOUR;
}

/** Offset a lat/lon by a metric vector. */
export function offsetLatLon(origin, dxM, dyM) {
  return {
    lat: origin.lat + dyM / M_PER_DEG_LAT,
    lon: origin.lon + dxM / metresPerDegLon(origin.lat),
  };
}

/* ------------------------------------------------------------------ *
 * Polygons
 * ------------------------------------------------------------------ */

/** Area-weighted centroid of a GeoJSON linear ring ([lon,lat] pairs). */
export function ringCentroid(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    const [x, y] = ring[0];
    return { lat: y, lon: x };
  }
  area *= 0.5;
  return { lat: cy / (6 * area), lon: cx / (6 * area) };
}

export function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Distance in metres from `centre` to the ring boundary along `theta`
 * (radians, 0 = east). Works for star-shaped polygons, which is what the
 * district blobs are. Returns 0 when the ray misses (degenerate geometry).
 */
export function ringRadiusAtAngle(centre, ring, theta) {
  const kx = metresPerDegLon(centre.lat);
  const dirX = Math.cos(theta);
  const dirY = Math.sin(theta);
  let best = 0;

  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const ax = (ring[i][0] - centre.lon) * kx;
    const ay = (ring[i][1] - centre.lat) * M_PER_DEG_LAT;
    const bx = (ring[i + 1][0] - centre.lon) * kx;
    const by = (ring[i + 1][1] - centre.lat) * M_PER_DEG_LAT;

    const ex = bx - ax;
    const ey = by - ay;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-9) continue;

    const t = (ax * ey - ay * ex) / denom; // distance along ray
    const u = (ax * dirY - ay * dirX) / denom; // position along edge
    if (t > 0 && u >= 0 && u <= 1 && t > best) best = t;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Demand points (spec §5)
 * ------------------------------------------------------------------ */

/**
 * Scatter deterministic, population-weighted demand points inside district
 * polygons. Same input always yields the same output.
 *
 * @param {Array} features GeoJSON Features (Polygon) with
 *                properties {id, name, population}
 * @returns {Array<{lat,lon,weight,districtId}>}
 */
export function buildDemandPoints(features) {
  const out = [];
  for (const feature of features) {
    const props = feature.properties || {};
    const population = props.population || 0;
    if (population <= 0) continue;

    const ring = feature.geometry.coordinates[0];
    const centre = ringCentroid(ring);
    const count = Math.max(20, Math.round(population / 200));
    const weight = population / count;

    for (let i = 0; i < count; i++) {
      const theta = i * GOLDEN_ANGLE;
      const frac = Math.pow((i + 0.5) / count, DENSITY_FALLOFF); // denser core
      const edge = ringRadiusAtAngle(centre, ring, theta);
      if (edge <= 0) continue;
      const r = frac * edge;
      const p = offsetLatLon(centre, r * Math.cos(theta), r * Math.sin(theta));
      out.push({ lat: p.lat, lon: p.lon, weight, districtId: props.id });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Point selection
 * ------------------------------------------------------------------ */

/**
 * Which AED points count towards coverage.
 * @param {Array} points  state.points
 * @param {'now'|'plan'} scenario
 * @param {'day'|'night'} mode
 */
export function activePoints(points, scenario = 'now', mode = 'day') {
  return points.filter((p) => {
    if (p.kind === 'existing') {
      if (p.status === 'rejected') return false;
    } else {
      // proposed points only count in the plan scenario, once accepted
      if (scenario !== 'plan') return false;
      if (p.status !== 'accepted') return false;
    }
    if (mode === 'night' && !(p.access && p.access.always === true)) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Coverage + KPIs
 * ------------------------------------------------------------------ */

function median(sortedValues, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return 0;
  let acc = 0;
  for (let i = 0; i < sortedValues.length; i++) {
    acc += weights[i];
    if (acc >= total / 2) return sortedValues[i];
  }
  return sortedValues[sortedValues.length - 1] || 0;
}

/**
 * Full analysis for one scenario/mode combination.
 *
 * @param {object} args
 * @param {Array}  args.demandPoints  from buildDemandPoints()
 * @param {Array}  args.points        state.points
 * @param {Array}  args.districts     [{id, name, population}]
 * @param {number} args.standardMinutes
 * @param {number} args.population    project population (for per-10k)
 * @param {'now'|'plan'} args.scenario
 * @param {'day'|'night'} args.mode
 */
export function analyze({
  demandPoints,
  points,
  districts = [],
  standardMinutes = 2,
  population = 0,
  scenario = 'now',
  mode = 'day',
}) {
  const radiusM = coverageRadiusM(standardMinutes);
  const active = activePoints(points, scenario, mode);

  const perDistrict = new Map();
  for (const d of districts) {
    perDistrict.set(d.id, {
      districtId: d.id,
      name: d.name,
      population: d.population || 0,
      totalWeight: 0,
      uncoveredWeight: 0,
      maxMin: 0,
    });
  }

  const status = new Array(demandPoints.length);
  let totalWeight = 0;
  let coveredWeight = 0;
  const times = [];
  const timeWeights = [];

  for (let i = 0; i < demandPoints.length; i++) {
    const dp = demandPoints[i];
    let nearest = Infinity;
    for (const p of active) {
      const d = distanceM(dp, p);
      if (d < nearest) nearest = d;
    }
    const nearestMin = Number.isFinite(nearest) ? walkTimeMin(nearest) : Infinity;
    const covered = Number.isFinite(nearest) && nearest <= radiusM;

    status[i] = {
      lat: dp.lat,
      lon: dp.lon,
      weight: dp.weight,
      districtId: dp.districtId,
      nearestMin,
      covered,
    };

    totalWeight += dp.weight;
    if (covered) coveredWeight += dp.weight;
    times.push(nearestMin);
    timeWeights.push(dp.weight);

    let bucket = perDistrict.get(dp.districtId);
    if (!bucket) {
      bucket = {
        districtId: dp.districtId,
        name: dp.districtId,
        population: 0,
        totalWeight: 0,
        uncoveredWeight: 0,
        maxMin: 0,
      };
      perDistrict.set(dp.districtId, bucket);
    }
    bucket.totalWeight += dp.weight;
    if (!covered) bucket.uncoveredWeight += dp.weight;
    if (Number.isFinite(nearestMin) && nearestMin > bucket.maxMin) {
      bucket.maxMin = nearestMin;
    }
  }

  // weighted median of walking time
  const order = times.map((t, i) => i).sort((a, b) => times[a] - times[b]);
  const medianMin = median(
    order.map((i) => times[i]),
    order.map((i) => timeWeights[i])
  );

  const finiteTimes = times.filter(Number.isFinite);
  const meanMin = finiteTimes.length
    ? finiteTimes.reduce((s, t, i) => s + t * timeWeights[i], 0) / (totalWeight || 1)
    : 0;

  const always = points.filter(
    (p) => p.kind === 'existing' && p.access && p.access.always === true
  ).length;
  const existingCount = points.filter((p) => p.kind === 'existing').length;

  const gaps = [...perDistrict.values()]
    .filter((d) => d.uncoveredWeight > 0)
    .map((d) => ({
      districtId: d.districtId,
      name: d.name,
      uncoveredPeople: Math.round(d.uncoveredWeight),
      population: Math.round(d.totalWeight),
      maxMin: d.maxMin,
      uncoveredPct: d.totalWeight ? (100 * d.uncoveredWeight) / d.totalWeight : 0,
    }))
    .sort((a, b) => b.uncoveredPeople - a.uncoveredPeople);

  return {
    radiusM,
    scenario,
    mode,
    activeCount: active.length,
    activePoints: active,
    coveragePct: totalWeight ? (100 * coveredWeight) / totalWeight : 0,
    coveredPeople: Math.round(coveredWeight),
    totalPeople: Math.round(totalWeight),
    medianMin,
    meanMin,
    aedPer10k: population ? active.length / (population / 10000) : 0,
    always247Pct: existingCount ? (100 * always) / existingCount : 0,
    gaps,
    demandStatus: status,
  };
}

/* ------------------------------------------------------------------ *
 * Greedy maximum coverage (spec §5)
 * ------------------------------------------------------------------ */

/**
 * Pick `count` candidate sites that add the most uncovered population.
 *
 * @returns {Array<{candidateId,name,lat,lon,presetId,gainWeight,gainPct}>}
 */
export function proposeNewPoints({
  demandPoints,
  points,
  candidates,
  standardMinutes = 2,
  count = 2,
  mode = 'day',
}) {
  const radiusM = coverageRadiusM(standardMinutes);
  const base = activePoints(points, 'plan', mode);
  const usedIds = new Set(
    points.filter((p) => p.candidateId).map((p) => p.candidateId)
  );

  const covered = demandPoints.map((dp) =>
    base.some((p) => distanceM(dp, p) <= radiusM)
  );
  const totalWeight = demandPoints.reduce((s, dp) => s + dp.weight, 0) || 1;

  const chosen = [];
  const taken = new Set(usedIds);

  for (let k = 0; k < count; k++) {
    let best = null;
    let bestGain = 0;

    for (const cand of candidates) {
      if (taken.has(cand.id)) continue;
      let gain = 0;
      for (let i = 0; i < demandPoints.length; i++) {
        if (covered[i]) continue;
        if (distanceM(demandPoints[i], cand) <= radiusM) gain += demandPoints[i].weight;
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = cand;
      }
    }

    if (!best || bestGain <= 0) break;

    taken.add(best.id);
    for (let i = 0; i < demandPoints.length; i++) {
      if (!covered[i] && distanceM(demandPoints[i], best) <= radiusM) covered[i] = true;
    }

    chosen.push({
      candidateId: best.id,
      name: best.name,
      lat: best.lat,
      lon: best.lon,
      presetId: best.presetId || 'P1',
      districtId: best.districtId || null,
      gainWeight: Math.round(bestGain),
      gainPct: (100 * bestGain) / totalWeight,
    });
  }

  return chosen;
}

/**
 * Coverage gain of a single site given the current plan — used for live
 * recalculation while a proposed pin is being dragged.
 */
export function coverageGainFor(site, { demandPoints, points, standardMinutes, mode = 'day', excludeId = null }) {
  const radiusM = coverageRadiusM(standardMinutes);
  const base = activePoints(points, 'plan', mode).filter((p) => p.id !== excludeId);
  const totalWeight = demandPoints.reduce((s, dp) => s + dp.weight, 0) || 1;
  let gain = 0;
  for (const dp of demandPoints) {
    if (distanceM(dp, site) > radiusM) continue;
    if (base.some((p) => distanceM(dp, p) <= radiusM)) continue;
    gain += dp.weight;
  }
  return { gainWeight: Math.round(gain), gainPct: (100 * gain) / totalWeight };
}

/* ------------------------------------------------------------------ *
 * Card completeness (spec §5)
 * ------------------------------------------------------------------ */

function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return true; // an explicit false is an answer
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(isFilled);
  return true;
}

/**
 * Baseline requirements for a point that has no preset assigned yet — usually
 * an unverified import from OSM. Without this such a card would report 100%
 * complete simply because nothing is required of it, which is the opposite of
 * the truth.
 */
export const FALLBACK_PRESET = {
  id: null,
  name: 'Bez presetu — wymaga wizyty',
  requiredFields: [
    'name', 'address', 'placement', 'access', 'keeper',
    'signage.atDevice', 'signage.route', 'device.model', 'dispatcherRegistered',
  ],
  requiredPhotos: ['device'],
  checklist: [],
};

/**
 * @returns {{pct:number, filled:number, required:number,
 *            missingFields:string[], missingPhotos:string[]}}
 */
export function completeness(point, preset, photos = []) {
  const effective = preset || FALLBACK_PRESET;
  const requiredFields = effective.requiredFields || [];
  const requiredPhotos = effective.requiredPhotos || [];

  const missingFields = requiredFields.filter((path) => !isFilled(readPath(point, path)));
  const roles = new Set(
    photos.filter((ph) => ph.pointId === point.id).map((ph) => ph.role)
  );
  const missingPhotos = requiredPhotos.filter((role) => !roles.has(role));

  const required = requiredFields.length + requiredPhotos.length;
  const filled = required - missingFields.length - missingPhotos.length;

  return {
    pct: required ? Math.round((100 * filled) / required) : 100,
    filled,
    required,
    missingFields,
    missingPhotos,
  };
}

/** Pin colour class driven by completeness + verification status (spec §5). */
export function pointStatusLevel(point, pct) {
  if (point.kind === 'proposed') return 'proposed';
  if (point.status === 'unverified') return 'crit';
  if (pct >= 100) return 'ok';
  return 'warn';
}

/* ------------------------------------------------------------------ *
 * Auto-recommendation rules (spec §5)
 * ------------------------------------------------------------------ */

const TODAY_FALLBACK = '2026-07-29';

function isOverdue(yearMonth, today = TODAY_FALLBACK) {
  if (!yearMonth) return false;
  return String(yearMonth).slice(0, 7) < String(today).slice(0, 7);
}

/**
 * Deterministic rule engine. Ids are stable (`auto-<pointId>-<rule>`) so
 * re-running after a card save updates in place instead of duplicating.
 */
export function autoRecommendations(point, preset, photos = [], today = TODAY_FALLBACK) {
  const recs = [];
  const add = (rule, text, priority, cost, owner) =>
    recs.push({
      id: `auto-${point.id}-${rule}`,
      pointId: point.id,
      rule,
      text,
      priority,
      cost,
      owner,
      phase: null,
      auto: true,
      done: false,
    });

  if (!point.keeper || !isFilled(point.keeper.org)) {
    add('keeper', 'Wyznaczyć opiekuna punktu', 'high', 0, 'gmina');
  }
  if (point.dispatcherRegistered === false) {
    add('dispatcher', 'Zarejestrować AED u dyspozytora 112', 'high', 0, 'gmina');
  }
  if (point.device && isOverdue(point.device.inspectionDue, today)) {
    add('inspection', 'Wykonać przegląd + wymiana elektrod', 'high', 600, 'serwis');
  }
  if (point.signage && point.signage.route === false) {
    add('signage_route', 'Doznakować dojście od ulicy (ILCOR)', 'medium', 800, 'gmina');
  }
  if (point.signage && point.signage.atDevice === false) {
    add('signage_device', 'Oznakować urządzenie znakiem ILCOR', 'medium', 300, 'gmina');
  }
  if (point.access && point.access.always === false) {
    add('access', 'Rozważyć przeniesienie do strefy 24/7', 'low', 0, 'gmina');
  }
  const { missingPhotos } = completeness(point, preset, photos);
  if (missingPhotos.length) {
    add('photos', 'Uzupełnić dokumentację fotograficzną', 'low', 0, 'gmina');
  }

  return recs;
}

/* ------------------------------------------------------------------ *
 * Expert location score
 * ------------------------------------------------------------------ */

/**
 * Ważona ocena lokalizacji 0–10 wystawiana ręcznie przez audytora.
 * Wagi sumują się do 1 i są w tej iteracji stałe (per ustalenie z klientem);
 * gdy staną się konfigurowalne per projekt, wystarczy podmienić to źródło.
 */
export const EXPERT_CRITERIA = [
  { key: 'D', label: 'Dostępność czasowa', weight: 0.25 },
  { key: 'W', label: 'Widoczność i oznakowanie', weight: 0.2 },
  { key: 'N', label: 'Natężenie ruchu / ekspozycja', weight: 0.2 },
  { key: 'Z', label: 'Instalacja / zasilanie', weight: 0.15 },
  { key: 'O', label: 'Opieka nad punktem', weight: 0.1 },
  { key: 'R', label: 'Odporność na wandalizm', weight: 0.1 },
];

export const EXPERT_FORMULA = 'S = 0,25·D + 0,20·W + 0,20·N + 0,15·Z + 0,10·O + 0,10·R';

/**
 * @returns {null | {value:number, verdict:{label:string, variant:string}}}
 * null = punkt jeszcze nieoceniony (brak kompletu sześciu kryteriów).
 */
export function expertScore(point) {
  const ex = point && point.expert;
  if (!ex) return null;
  let sum = 0;
  for (const c of EXPERT_CRITERIA) {
    const v = ex[c.key];
    if (typeof v !== 'number' || Number.isNaN(v)) return null;
    sum += Math.min(10, Math.max(0, v)) * c.weight;
  }
  const value = Math.round(sum * 10) / 10;
  const verdict =
    value >= 7.5
      ? { label: 'Dobra', variant: 'ok' }
      : value >= 5
        ? { label: 'Zadowalająca', variant: 'warn' }
        : { label: 'Niska', variant: 'crit' };
  return { value, verdict };
}

/* ------------------------------------------------------------------ *
 * Roadmap aggregation
 * ------------------------------------------------------------------ */

export const PHASE_META = {
  1: { label: 'Faza 1', title: 'Zgodność podstawowa', months: '0–6 mies.' },
  2: { label: 'Faza 2', title: 'Dogęszczenie sieci', months: '6–18 mies.' },
  3: { label: 'Faza 3', title: 'Standard docelowy', months: '18–36 mies.' },
};

export function roadmapTotals(recommendations) {
  const phases = { 1: { items: [], cost: 0 }, 2: { items: [], cost: 0 }, 3: { items: [], cost: 0 } };
  for (const rec of recommendations) {
    if (!rec.phase || !phases[rec.phase]) continue;
    phases[rec.phase].items.push(rec);
    phases[rec.phase].cost += rec.cost || 0;
  }
  const total = phases[1].cost + phases[2].cost + phases[3].cost;
  return { phases, total };
}

/* ------------------------------------------------------------------ *
 * Formatting helpers (shared by every view so numbers look identical)
 * ------------------------------------------------------------------ */

export function fmtPct(value, digits = 0) {
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

export function fmtMin(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits).replace('.', ',')} min`;
}

export function fmtNum(value, digits = 0) {
  return Number(value).toLocaleString('pl-PL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtCost(value) {
  return `${fmtNum(Math.round(value || 0))} zł`;
}
