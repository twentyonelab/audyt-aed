/**
 * map.js – the map layer.
 *
 * Two renderers behind one interface:
 *   • Mapbox GL JS when the library loaded and a real token is configured.
 *   • A schematic SVG renderer otherwise, so the makieta is never dead – it
 *     draws the same scene from the same data, just without a basemap.
 *
 * Views never touch either renderer directly. They build a `scene` object and
 * hand it to `setScene()`.
 *
 * Spec reference: ITERACJA2_SPEC.md §2, §6.2, §6.3.
 */

import {
  MAPBOX_TOKEN,
  MAP_STYLE,
  MAP_DEFAULT,
  MAP_IMPORT_ID,
  MAP_CONFIG,
  MAP_THEMES,
  MAP_DEM,
  MAP_PITCH,
  MAP_PITCH_CLOSE,
  MAP_ZOOM_CLOSE,
} from '../config.js';
import { metresPerDegLon } from './model.js';
import { ICON_PATHS, iconSvg } from './icons.js';

const TOKEN_IS_REAL = typeof MAPBOX_TOKEN === 'string' && MAPBOX_TOKEN.startsWith('pk.');

/** Ile klik na mapie czeka na ewentualny dblclick, zanim zostanie wysłany. */
const CLICK_DELAY_MS = 260;

/** Rozmiar znacznika AED na mapie roboczej – jak MapMarker size={28}. */
const MARKER_SIZE = 28;

export function mapboxAvailable() {
  return TOKEN_IS_REAL && typeof window !== 'undefined' && typeof window.mapboxgl !== 'undefined';
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/** Bounding box [west, south, east, north] of a GeoJSON geometry. */
export function bboxOf(geojson) {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      return;
    }
    coords.forEach(visit);
  };
  const geoms = geojson.type === 'FeatureCollection' ? geojson.features.map((f) => f.geometry) : [geojson.geometry || geojson];
  geoms.forEach((g) => g && visit(g.coordinates));
  return [w, s, e, n];
}

/** Approximate a metric circle as a GeoJSON polygon. */
export function circlePolygon(lat, lon, radiusM, steps = 48) {
  const kx = metresPerDegLon(lat);
  const ky = 111320;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (2 * Math.PI * i) / steps;
    ring.push([lon + (radiusM * Math.cos(theta)) / kx, lat + (radiusM * Math.sin(theta)) / ky]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** Linear projection fitted to a bbox – used by every SVG rendering. */
export function makeProjection(bbox, width, height, pad = 12) {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = (e - w) * kx;
  const spanY = n - s;
  const scale = Math.min((width - 2 * pad) / (spanX || 1e-6), (height - 2 * pad) / (spanY || 1e-6));
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const project = (lon, lat) => [
    offsetX + (lon - w) * kx * scale,
    height - (offsetY + (lat - s) * scale),
  ];
  const unproject = (x, y) => [
    w + (x - offsetX) / (kx * scale),
    s + (height - y - offsetY) / scale,
  ];
  /** metres -> pixels */
  const metres = (m) => (m / 111320) * scale;
  return { project, unproject, metres, scale };
}

/* ------------------------------------------------------------------ *
 * Static SVG rendering (report maps, card mini-maps, fallback basemap)
 * ------------------------------------------------------------------ */

/* v2: paleta mapy pochodzi z design systemu marki. Zasięg jest limonkowy,
   bo limonka niesie w tym systemie znaczenie „objęte", a nie dekorację;
   statusy punktów zostają przy zieleni, żółci i czerwieni audytu. */
const COLORS = {
  boundary: '#a8a7a4',
  boundaryFill: '#ffffff',
  district: '#f4f4f2',
  districtLine: '#e0e0de',
  coverage: 'rgba(184,221,60,0.22)',
  coverageLine: 'rgba(156,189,37,0.75)',
  coveragePlan: 'rgba(11,112,48,0.12)',
  coveragePlanLine: 'rgba(11,112,48,0.55)',
  covered: '#167734',
  uncovered: '#d40b07',
  near: '#fecd14',
  highlight: 'rgba(201,238,84,0.22)',
  highlightLine: '#0c9331',
  // Trasy dojścia: ten sam odcień co obrys zasięgu, ale w pełnym nasyceniu –
  // krycie 50% nakłada się dopiero w atrybucie stroke-opacity, więc linia nie
  // gaśnie dwa razy (raz w kolorze, raz w kryciu).
  routeLine: '#9cbd25',
  routePlanLine: '#0b7030',
  /* Rekomendacja: nasycona limonka, ten sam odcień co pigułka „propozycja". */
  proposed: '#c9ee54',
  /* Podpisy na mapie – szarość techniczna i czerwień luki z palety statusów. */
  labelMuted: '#908f8f',
  labelGap: '#b30a06',
  pinStroke: '#ffffff',
  pinStrokeSelected: '#000000',
};

/**
 * Drabinka wzorów kreskowania dla płynących tras dojścia w Mapboksie.
 *
 * `line-dasharray` jest własnością dyskretną – nie interpoluje się, więc
 * animacji nie da się zrobić przejściem. Zamiast tego przechodzimy krok po
 * kroku przez wzory, w których kreska „wysuwa się" z przerwy, a po pełnym
 * okresie (4 + 3 = 7 jednostek, jak w renderze zapasowym) wzór wraca do
 * wyjściowego. Efekt: kreski przesuwają się w kierunku rysowania trasy,
 * czyli od pinu do granicy zasięgu.
 */
const ROUTE_FLOW_STEPS = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

/** Co ile ms kolejna klatka kreskowania. 14 kroków × 64 ms ≈ 0,9 s na cykl –
 *  tyle samo, ile trwa animacja CSS w renderze zapasowym. */
const ROUTE_FLOW_MS = 64;

/** Czy system prosi o ograniczenie ruchu – wtedy trasy zostają statyczne. */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/* ------------------------------------------------------------------ *
 * Znacznik AED – kropla z design systemu marki
 * ------------------------------------------------------------------ */

/**
 * Ton i ikona znacznika dla poziomu punktu.
 *
 * Wprost z komponentu MapMarker: zweryfikowany zielony z pulsem, do sprawdzenia
 * żółty z trójkątem ostrzegawczym, niezweryfikowany czerwony z pulsem,
 * rekomendacja limonkowa z plusem. Rekomendacja jest jedyną, która niesie
 * plus – bo jest propozycją dołożenia, a nie stanem faktycznym.
 */
const MARKER_STYLE = {
  ok: { fill: () => COLORS.covered, icon: 'heart-pulse', ink: false },
  warn: { fill: () => COLORS.near, icon: 'triangle-alert', ink: true },
  crit: { fill: () => COLORS.uncovered, icon: 'heart-pulse', ink: false },
  proposed: { fill: () => COLORS.proposed, icon: 'plus', ink: true },
};

function markerStyle(level) {
  return MARKER_STYLE[level] || MARKER_STYLE.crit;
}

/**
 * Ścieżka kropli o rozmiarze `size`, wyśrodkowana w (0, 0).
 *
 * Odpowiednik `border-radius: 50% 50% 50% 50% / 55% 55% 45% 45%`: górna połowa
 * to łuk elipsy o promieniu pionowym 0,55 wysokości, dolna 0,45. Najszersze
 * miejsce leży więc powyżej środka i kształt siada na mapie „cięższym" dołem.
 */
function markerPath(size) {
  const rx = size / 2;
  const top = size * 0.55;
  const bottom = size * 0.45;
  const y = top - size / 2; // środek pudełka jest w połowie wysokości
  return (
    `M${(-rx).toFixed(2)} ${y.toFixed(2)}` +
    `a${rx.toFixed(2)} ${top.toFixed(2)} 0 0 1 ${size.toFixed(2)} 0` +
    `a${rx.toFixed(2)} ${bottom.toFixed(2)} 0 0 1 ${(-size).toFixed(2)} 0Z`
  );
}

/** Znacznik jako grupa SVG gotowa do wstawienia w renderze zapasowym. */
function markerSvg(level, size, { dimmed = false, selected = false } = {}) {
  const st = markerStyle(level);
  const iconSize = Math.round(size * 0.52);
  const k = iconSize / 24;
  const glyph = ICON_PATHS[st.icon] || '';
  return (
    `<g${dimmed ? ' opacity="0.2"' : ''}>` +
    `<path d="${markerPath(size)}" fill="${st.fill()}" stroke="${
      selected ? COLORS.pinStrokeSelected : COLORS.pinStroke
    }" stroke-width="${selected ? 2 : 1.4}"/>` +
    `<g transform="translate(${(-iconSize / 2).toFixed(2)} ${(-iconSize / 2).toFixed(2)}) scale(${k.toFixed(4)})" ` +
    `fill="none" stroke="${st.ink ? COLORS.pinStrokeSelected : COLORS.pinStroke}" stroke-width="2.4" ` +
    `stroke-linecap="round" stroke-linejoin="round">${glyph}</g>` +
    `</g>`
  );
}

function ringPath(ring, project) {
  return `${ring
    .map(([lon, lat], i) => {
      const [x, y] = project(lon, lat);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join('')}Z`;
}

/**
 * Render the scene as a standalone SVG string.
 * @param {object} scene see setScene()
 * @param {object} opts  {width, height, showDemand, showCoverage, showLabels}
 */
export function renderSceneSvg(scene, opts = {}) {
  const width = opts.width || 600;
  const height = opts.height || 400;
  const bbox = scene.boundary ? bboxOf(scene.boundary) : [18.92, 50.07, 19.1, 50.18];
  // A caller may supply its own projection (the interactive fallback does, so
  // that panning and zooming reuse this exact renderer).
  const { project, metres } = opts.projection || makeProjection(bbox, width, height, opts.pad ?? 10);
  const parts = [];

  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.district}"/>`);

  if (scene.boundary) {
    const ring = scene.boundary.geometry.coordinates[0];
    parts.push(
      `<path d="${ringPath(ring, project)}" fill="${COLORS.boundaryFill}" stroke="${COLORS.boundary}" stroke-width="1" stroke-dasharray="4 3"/>`
    );
  }

  if (scene.districts && opts.showDistricts !== false) {
    for (const f of scene.districts.features) {
      parts.push(
        `<path d="${ringPath(f.geometry.coordinates[0], project)}" fill="${COLORS.district}" stroke="${COLORS.districtLine}" stroke-width="0.8"/>`
      );
    }
  }

  // Podświetlenie jednej dzielnicy (np. wybranej w filtrze) – działa też przy
  // showDistricts: false, bo wtedy jest jedynym rysowanym wielokątem dzielnicy.
  if (scene.highlightDistrictId && scene.districts) {
    const f = scene.districts.features.find((d) => d.properties.id === scene.highlightDistrictId);
    if (f) {
      parts.push(
        `<path d="${ringPath(f.geometry.coordinates[0], project)}" fill="${COLORS.highlight}" stroke="${COLORS.highlightLine}" stroke-width="1.6"/>`
      );
    }
  }

  // Realne zasięgi dojścia (izochrony) – nieregularne obrysy po sieci pieszej.
  if (scene.reach && opts.showReach !== false) {
    for (const r of scene.reach) {
      if (!r.ring || r.ring.length < 3) continue;
      const plan = r.kind === 'proposed';
      parts.push(
        `<path d="${ringPath(r.ring, project)}" fill="${plan ? COLORS.coveragePlan : COLORS.coverage}" ` +
          `stroke="${plan ? COLORS.coveragePlanLine : COLORS.coverageLine}" stroke-width="${
            r.emphasis ? 1.6 : 0.9
          }" stroke-linejoin="round"${plan ? ' stroke-dasharray="3 2"' : ''}/>`
      );
    }
  }

  // Trasy, które narysowały obrys: przerywane, półprzejrzyste i w kolorze
  // obrysu tego punktu – nie wprowadzają nowego koloru do legendy.
  if (scene.routes && opts.showRoutes !== false) {
    for (const r of scene.routes) {
      const line = r && (r.line || r);
      if (!line || line.length < 2) continue;
      const stroke = r && r.kind === 'proposed' ? COLORS.routePlanLine : COLORS.routeLine;
      const d = line
        .map(([lon, lat], i) => {
          const [x, y] = project(lon, lat);
          return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join('');
      // Klasa .route-flow animuje stroke-dashoffset w CSS: kreski płyną od
      // pinu (pierwszy punkt trasy) w stronę granicy zasięgu. Animacja żyje
      // w arkuszu, nie w JS, więc nic nie odlicza klatek, gdy mapa stoi.
      parts.push(
        `<path class="route-flow" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" ` +
          `stroke-opacity="0.5" stroke-dasharray="4 3" stroke-linecap="round"/>`
      );
    }
  }

  if (scene.coverage && opts.showCoverage !== false) {
    for (const c of scene.coverage) {
      const [cx, cy] = project(c.lon, c.lat);
      const r = metres(c.radiusM);
      const plan = c.kind === 'proposed';
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${
          plan ? COLORS.coveragePlan : COLORS.coverage
        }" stroke="${plan ? COLORS.coveragePlanLine : COLORS.coverageLine}" stroke-width="0.8"${
          plan ? ' stroke-dasharray="3 2"' : ''
        }/>`
      );
    }
  }

  if (scene.demand && opts.showDemand !== false) {
    for (const d of scene.demand) {
      const [x, y] = project(d.lon, d.lat);
      const fill = d.covered ? COLORS.covered : d.nearestMin <= (scene.targetMinutes || 5) * 2 ? COLORS.near : COLORS.uncovered;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9" fill="${fill}" opacity="0.75"/>`);
    }
  }

  // Znaczniki: kropla z ikoną, ten sam kształt co w prototypie. W miniaturach
  // (raport, mini-mapa karty) rysujemy je mniejsze, żeby nie zjadły kadru.
  const markerSize = opts.markerSize || 18;
  for (const p of scene.points || []) {
    const [x, y] = project(p.lon, p.lat);
    parts.push(
      `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
        markerSvg(p.level, markerSize, { dimmed: p.dimmed }) +
        `</g>`
    );
  }

  if (opts.showLabels && scene.labels) {
    for (const l of scene.labels) {
      const [x, y] = project(l.lon, l.lat);
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Archivo, Helvetica, sans-serif" font-size="8" fill="${COLORS.labelMuted}" text-anchor="middle">${l.text}</text>`
      );
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">${parts.join('')}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Interactive map
 * ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} container
 * @param {object} opts {center, zoom, interactive}
 * @returns {object} handle
 */
export function createMap(container, opts = {}) {
  return mapboxAvailable() ? createMapboxMap(container, opts) : createFallbackMap(container, opts);
}

function emitterMixin() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event).delete(fn);
    },
    emit(event, payload) {
      for (const fn of handlers.get(event) || []) fn(payload);
    },
  };
}

/* ---------------------------- Mapbox ------------------------------ */

function createMapboxMap(container, opts) {
  const bus = emitterMixin();
  const canvas = document.createElement('div');
  canvas.className = 'map-canvas';
  container.appendChild(canvas);

  window.mapboxgl.accessToken = MAPBOX_TOKEN;

  /** Bieżący sposób kolorowania podkładu – przełącznik nad mapą. */
  let basemapTheme = opts.basemapTheme || MAP_CONFIG.theme;

  const map = new window.mapboxgl.Map({
    container: canvas,
    style: MAP_STYLE,
    // Konfiguracja podana OD RAZU przy tworzeniu mapy, nie po jej wczytaniu –
    // inaczej pierwsza klatka mrugnęłaby domyślnym motywem i oświetleniem.
    config: { [MAP_IMPORT_ID]: { ...MAP_CONFIG, theme: basemapTheme } },
    center: opts.center || MAP_DEFAULT.center,
    zoom: opts.zoom || MAP_DEFAULT.zoom,
    pitch: opts.pitch ?? MAP_PITCH,
    bearing: opts.bearing || 0,
    logoPosition: 'bottom-right',
    // Domyślną atrybucję wyłączamy tylko po to, żeby zaraz dołożyć ją
    // w formie zwiniętej – patrz niżej.
    attributionControl: false,
  });

  /*
   * ATRYBUCJI NIE WOLNO USUNĄĆ.
   *
   * Warunki Mapboxa: mapa korzystająca ze stylów albo danych Mapboxa musi
   * pokazywać logo ORAZ atrybucję tekstową. Wyjątek dotyczy wyłącznie
   * własnych stylów i własnych danych – my używamy stylu Standard i kafli
   * Mapboxa, więc nas nie obejmuje. `compact: true` to najmniejsza forma,
   * jaką Mapbox przewiduje: krążek „i", który rozwija tekst po kliknięciu.
   * Do v3 tej kontrolki tu nie było i było to naruszenie licencji.
   */
  map.addControl(new window.mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

  // Kompas jest przy pochylonej kamerze niezbędny: bez niego po obróceniu
  // mapy nie ma jak wrócić do północy. `visualizePitch` dokłada wskaźnik
  // pochylenia, więc widać, pod jakim kątem się patrzy.
  map.addControl(
    new window.mapboxgl.NavigationControl({ visualizePitch: true }),
    'bottom-right'
  );

  let markers = [];
  let labelMarkers = [];
  let scene = {};
  let ready = false;
  let addMode = false;
  // A click that terminates a pin drag must not open anything.
  let dragged = false;
  /** Klatka animacji tras dojścia (patrz startRouteFlow). */
  let routeFlowTimer = null;

  const src = (id, data) => {
    if (map.getSource(id)) map.getSource(id).setData(data);
    else map.addSource(id, { type: 'geojson', data });
  };
  const emptyFc = { type: 'FeatureCollection', features: [] };

  /**
   * Płynąca linia przerywana na trasach dojścia.
   *
   * `line-dasharray` w Mapboksie nie da się animować przejściem – to własność
   * dyskretna, bez interpolacji. Robi się to więc krokowo: co ROUTE_FLOW_MS
   * podmieniamy wzór kresek na kolejny z drabinki, w której kreska rośnie,
   * a przerwa maleje. Po pełnym cyklu wzór wraca do wyjściowego, więc ruch
   * jest ciągły i wygląda jak przesuwanie się kresek od pinu do granicy.
   *
   * Zegar chodzi tylko wtedy, gdy na mapie faktycznie są trasy – po ich
   * zgaszeniu jest zatrzymywany, żeby nie budzić przerysowań w tle.
   */
  const startRouteFlow = () => {
    if (routeFlowTimer || prefersReducedMotion()) return;
    let step = 0;
    routeFlowTimer = setInterval(() => {
      if (!ready || !map.getLayer('routes-line')) return;
      step = (step + 1) % ROUTE_FLOW_STEPS.length;
      map.setPaintProperty('routes-line', 'line-dasharray', ROUTE_FLOW_STEPS[step]);
    }, ROUTE_FLOW_MS);
  };

  const stopRouteFlow = () => {
    if (!routeFlowTimer) return;
    clearInterval(routeFlowTimer);
    routeFlowTimer = null;
    if (ready && map.getLayer('routes-line')) {
      map.setPaintProperty('routes-line', 'line-dasharray', ROUTE_FLOW_STEPS[0]);
    }
  };

  /*
   * Rzeźba terenu. Przy widoku całego miasta to ona, obok pochylenia kamery,
   * daje wrażenie przestrzeni – bryły budynków są na tej skali za małe.
   * Wieszamy to na `style.load`, a nie na `load`, bo podmiana motywu podkładu
   * przeładowuje styl i teren trzeba dołożyć ponownie.
   */
  map.on('style.load', () => {
    if (map.getSource(MAP_DEM.id)) return;
    map.addSource(MAP_DEM.id, {
      type: 'raster-dem',
      url: MAP_DEM.url,
      tileSize: MAP_DEM.tileSize,
      maxzoom: MAP_DEM.maxzoom,
    });
    map.setTerrain({ source: MAP_DEM.id, exaggeration: MAP_DEM.exaggeration });
  });

  map.on('load', () => {
    src('boundary', emptyFc);
    src('districts', emptyFc);
    src('district-hl', emptyFc);
    src('coverage', emptyFc);
    src('reach', emptyFc);
    src('routes', emptyFc);
    src('demand', emptyFc);

    map.addLayer({ id: 'districts-fill', slot: 'bottom', type: 'fill', source: 'districts', paint: { 'fill-color': COLORS.district, 'fill-opacity': 0.55 } });
    map.addLayer({ id: 'districts-line', slot: 'bottom', type: 'line', source: 'districts', paint: { 'line-color': COLORS.districtLine, 'line-width': 1 } });
    map.addLayer({ id: 'district-hl-fill', slot: 'bottom', type: 'fill', source: 'district-hl', paint: { 'fill-color': COLORS.highlightLine, 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'district-hl-line', slot: 'bottom', type: 'line', source: 'district-hl', paint: { 'line-color': COLORS.highlightLine, 'line-width': 1.8 } });
    map.addLayer({
      id: 'coverage-fill',
      slot: 'bottom',
      type: 'fill',
      source: 'coverage',
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'proposed'], COLORS.coveragePlanLine, COLORS.coverageLine],
        'fill-opacity': 0.15,
      },
    });
    map.addLayer({
      id: 'coverage-line',
      slot: 'bottom',
      type: 'line',
      source: 'coverage',
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], COLORS.coveragePlanLine, COLORS.coverageLine],
        'line-width': 1,
        'line-dasharray': [2, 1.5],
      },
    });
    // Realny zasięg dojścia po sieci pieszej – pod punktami popytu,
    // żeby kolory kropek pozostały czytelne.
    map.addLayer({
      id: 'reach-fill',
      slot: 'bottom',
      type: 'fill',
      source: 'reach',
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'proposed'], COLORS.coveragePlanLine, COLORS.coverageLine],
        'fill-opacity': ['case', ['get', 'emphasis'], 0.22, 0.13],
      },
    });
    map.addLayer({
      id: 'reach-line',
      slot: 'bottom',
      type: 'line',
      source: 'reach',
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], COLORS.coveragePlanLine, COLORS.coverageLine],
        'line-width': ['case', ['get', 'emphasis'], 2, 1],
      },
    });
    map.addLayer({
      id: 'routes-line',
      slot: 'middle',
      type: 'line',
      source: 'routes',
      // Końcówka prosta, nie okrągła: drabinka animacji zawiera kreski
      // o długości zero, a te z okrągłą końcówką rysowałyby się jako kropki.
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], COLORS.coveragePlanLine, COLORS.coverageLine],
        'line-width': 2,
        'line-opacity': 0.5,
        'line-dasharray': ROUTE_FLOW_STEPS[0],
      },
    });
    map.addLayer({
      id: 'demand-dots',
      slot: 'middle',
      type: 'circle',
      source: 'demand',
      paint: {
        'circle-radius': 2.6,
        'circle-opacity': 0.75,
        'circle-color': [
          'case',
          ['get', 'covered'], COLORS.covered,
          ['<=', ['get', 'ratio'], 2], COLORS.near,
          COLORS.uncovered,
        ],
      },
    });
    map.addLayer({ id: 'boundary-line', slot: 'middle', type: 'line', source: 'boundary', paint: { 'line-color': COLORS.boundary, 'line-width': 1.4, 'line-dasharray': [3, 2] } });

    ready = true;
    if (scene.boundary) applyScene(scene);
  });

  // Podwójny klik przybliża mapę i po drodze wysyła dwa zwykłe kliknięcia.
  // Skoro klik dokłada punkt, emisja czeka na ewentualny dblclick.
  let clickTimer = null;
  map.on('click', (e) => {
    if (clickTimer) clearTimeout(clickTimer);
    const payload = { lat: e.lngLat.lat, lon: e.lngLat.lng, addMode };
    clickTimer = setTimeout(() => {
      clickTimer = null;
      bus.emit('mapclick', payload);
    }, CLICK_DELAY_MS);
  });
  map.on('dblclick', () => {
    if (!clickTimer) return;
    clearTimeout(clickTimer);
    clickTimer = null;
  });

  function applyScene(next) {
    scene = { ...scene, ...next };
    if (!ready) return;

    if (scene.boundary) src('boundary', scene.boundary);
    src('districts', scene.showDistricts === false ? emptyFc : scene.districts || emptyFc);

    const hlFeature =
      scene.highlightDistrictId && scene.districts
        ? scene.districts.features.find((f) => f.properties.id === scene.highlightDistrictId)
        : null;
    src('district-hl', hlFeature ? { type: 'FeatureCollection', features: [hlFeature] } : emptyFc);

    src('coverage', {
      type: 'FeatureCollection',
      features: (scene.showCoverage === false ? [] : scene.coverage || []).map((c) => ({
        type: 'Feature',
        properties: { kind: c.kind || 'existing' },
        geometry: circlePolygon(c.lat, c.lon, c.radiusM),
      })),
    });

    src('reach', {
      type: 'FeatureCollection',
      features: (scene.showReach === false ? [] : scene.reach || [])
        .filter((r) => r.ring && r.ring.length > 2)
        .map((r) => ({
          type: 'Feature',
          properties: { kind: r.kind || 'existing', emphasis: !!r.emphasis },
          geometry: { type: 'Polygon', coordinates: [r.ring] },
        })),
    });

    const routeFeatures = (scene.showRoutes === false ? [] : scene.routes || [])
      .map((r) => ({ line: (r && (r.line || r)) || null, kind: (r && r.kind) || 'existing' }))
      .filter((r) => r.line && r.line.length > 1)
      .map((r) => ({
        type: 'Feature',
        properties: { kind: r.kind },
        geometry: { type: 'LineString', coordinates: r.line },
      }));
    src('routes', { type: 'FeatureCollection', features: routeFeatures });
    // Zegar animacji chodzi tylko wtedy, gdy trasy są na mapie.
    if (routeFeatures.length) startRouteFlow();
    else stopRouteFlow();

    src('demand', {
      type: 'FeatureCollection',
      features: (scene.showDemand === false ? [] : scene.demand || []).map((d) => ({
        type: 'Feature',
        properties: {
          covered: !!d.covered,
          ratio: Number.isFinite(d.nearestMin) ? d.nearestMin / (scene.targetMinutes || 5) : 99,
        },
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      })),
    });

    markers.forEach((m) => m.remove());
    markers = (scene.points || []).map((p) => {
      // Znacznik to kropla z ikoną – ten sam kształt i te same ikony co
      // w renderze zapasowym, tyle że tu rysuje je CSS na elemencie DOM.
      const st = markerStyle(p.level);
      const node = document.createElement('div');
      node.className = `pin pin--${p.level}${p.id === scene.selectedId ? ' is-selected' : ''}`;
      node.style.background = st.fill();
      node.style.color = st.ink ? COLORS.pinStrokeSelected : COLORS.pinStroke;
      node.innerHTML = iconSvg(st.icon, Math.round(MARKER_SIZE * 0.52));
      node.dataset.level = p.level;
      node.dataset.pin = p.id;
      node.title = p.name || '';
      if (p.dimmed) {
        node.style.opacity = '0.2';
        node.dataset.dimmed = 'true';
      }
      node.addEventListener('pointerdown', () => {
        dragged = false;
      });
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (dragged) {
          dragged = false;
          return;
        }
        bus.emit('pointclick', p);
      });
      const marker = new window.mapboxgl.Marker({
        element: node,
        draggable: !!p.draggable,
        // Kropla wskazuje miejsce swoim środkiem.
        anchor: 'center',
        // Znacznik stoi pionowo niezależnie od pochylenia kamery. Bez tego
        // przy 52 stopniach położyłby się na mapie i przestał być czytelny.
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      })
        .setLngLat([p.lon, p.lat])
        .addTo(map);
      if (p.draggable) {
        marker.on('dragstart', () => {
          dragged = true;
        });
        marker.on('drag', () => {
          const ll = marker.getLngLat();
          bus.emit('pointdrag', { ...p, lat: ll.lat, lon: ll.lng });
        });
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          bus.emit('pointdragend', { ...p, lat: ll.lat, lon: ll.lng });
        });
      }
      return marker;
    });

    labelMarkers.forEach((m) => m.remove());
    labelMarkers = (scene.labels || []).map((l) => {
      const node = document.createElement('div');
      node.className = l.kind === 'gap' ? 'gap-label' : 'pin--district-label';
      node.textContent = l.text;
      return new window.mapboxgl.Marker({
        element: node,
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      })
        .setLngLat([l.lon, l.lat])
        .addTo(map);
    });
  }

  return {
    isFallback: false,
    on: bus.on,
    setScene: applyScene,
    setAddMode(value) {
      addMode = value;
      canvas.style.cursor = value ? 'crosshair' : '';
    },

    /** Sposoby kolorowania podkładu do przełącznika w widoku. */
    basemapThemes: MAP_THEMES,
    getBasemapTheme: () => basemapTheme,

    /**
     * Podmiana motywu podkładu. Idzie przez konfigurację importu, a nie przez
     * podmianę stylu, więc warstwy, źródła i kadr zostają nietknięte.
     */
    setBasemapTheme(id) {
      if (!MAP_THEMES.some((t) => t.id === id)) return;
      basemapTheme = id;
      if (ready) map.setConfigProperty(MAP_IMPORT_ID, 'theme', id);
    },

    /**
     * Przelot do punktu: bliżej i mocniej pochylony, żeby było widać bryły.
     * `essential` sprawia, że ruch wykona się także u kogoś, kto wyłączył
     * animacje w systemie – inaczej mapa po prostu by stanęła.
     */
    flyToPoint(lat, lon) {
      map.flyTo({
        center: [lon, lat],
        zoom: Math.max(map.getZoom(), MAP_ZOOM_CLOSE),
        pitch: MAP_PITCH_CLOSE,
        duration: 1200,
        essential: true,
      });
    },
    /** Camera so a view can restore the framing after a re-render. */
    getCamera() {
      const c = map.getCenter();
      return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    },
    setCamera(cam) {
      // Shapes differ per renderer; ignore a camera saved by the other one.
      if (!cam || !Array.isArray(cam.center)) return;
      map.jumpTo({
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing || 0,
        pitch: cam.pitch || 0,
      });
    },
    fit(geojson) {
      const [w, s, e, n] = bboxOf(geojson || scene.boundary);
      map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 });
    },
    flyTo(lat, lon, zoom = 14.5) {
      map.flyTo({ center: [lon, lat], zoom, duration: 400 });
    },
    destroy() {
      if (clickTimer) clearTimeout(clickTimer);
      stopRouteFlow();
      markers.forEach((m) => m.remove());
      labelMarkers.forEach((m) => m.remove());
      map.remove();
      canvas.remove();
    },
  };
}

/* --------------------------- Fallback ----------------------------- */


/**
 * Schematic renderer used when Mapbox is unavailable. It is a real map, not a
 * placeholder: pan with the mouse, zoom with the wheel, drag pins – so the
 * makieta stays usable offline and on a pendrive.
 */
function createFallbackMap(container, opts) {
  const bus = emitterMixin();
  const holder = document.createElement('div');
  holder.className = 'map-fallback';
  container.appendChild(holder);

  const notice = document.createElement('div');
  notice.className = 'map-notice';
  notice.innerHTML = TOKEN_IS_REAL
    ? 'Mapa Mapbox nie wczytała się (brak połączenia). Poniżej schemat wektorowy tych samych danych.'
    : 'Mapa schematyczna – podstaw własny token w <code>config.js</code> (MAPBOX_TOKEN), aby zobaczyć podkład Mapbox.';
  container.appendChild(notice);

  let scene = {};
  let size = { w: container.clientWidth || 900, h: container.clientHeight || 600 };
  let base = null;      // projection fitted to the boundary
  let projection = null; // base + pan/zoom
  let addMode = false;

  /** Pan/zoom applied on top of the fitted projection. */
  const view = { scale: opts.viewScale || 1, tx: opts.viewTx || 0, ty: opts.viewTy || 0 };

  let dragging = null;   // { point, node, moved, draggable }
  let panning = null;    // { x, y, tx, ty }
  let clickBlocked = false; // set after any drag so the trailing click is ignored
  let clickTimer = null;    // pending mapclick, cancelled by a dblclick
  // Pin przyciśnięty w tym gestcie. Przechwycenie wskaźnika przekierowuje
  // zdarzenie `click` na <svg>, więc listener na samym pinie by go nie zobaczył
  // – o tym, że klik należy do pinu, decyduje ten zapis z pointerdown.
  let pinPress = null;

  let rafId = 0;
  /** Coalesce redraws so a wheel or resize burst costs one repaint, not twenty. */
  function scheduleDraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      draw();
    });
  }

  const ro = new ResizeObserver(() => {
    size = { w: container.clientWidth || size.w, h: container.clientHeight || size.h };
    scheduleDraw();
  });
  ro.observe(container);

  function buildProjection() {
    const bbox = bboxOf(scene.boundary);
    base = makeProjection(bbox, size.w, size.h, 24);
    projection = {
      project: (lon, lat) => {
        const [x, y] = base.project(lon, lat);
        return [x * view.scale + view.tx, y * view.scale + view.ty];
      },
      unproject: (px, py) => base.unproject((px - view.tx) / view.scale, (py - view.ty) / view.scale),
      metres: (m) => base.metres(m) * view.scale,
      scale: base.scale * view.scale,
    };
  }

  function draw() {
    if (!scene.boundary) return;
    buildProjection();

    // Points are appended below as interactive nodes, so the static pass must
    // not draw them too – otherwise every pin renders twice.
    holder.innerHTML = renderSceneSvg(
      { ...scene, points: [] },
      {
        width: size.w,
        height: size.h,
        projection,
        showDemand: scene.showDemand !== false,
        showCoverage: scene.showCoverage !== false,
        showDistricts: scene.showDistricts !== false,
      }
    );

    const svg = holder.querySelector('svg');
    if (!svg) return;
    svg.style.cursor = addMode ? 'crosshair' : 'grab';
    svg.style.touchAction = 'none';

    for (const l of scene.labels || []) {
      const [x, y] = projection.project(l.lon, l.lat);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', x.toFixed(1));
      // Bez obrysów dzielnic podpis siada dokładnie tam, gdzie bywa pin –
      // 14 px niżej mija się z nim, a biała otoczka trzyma go czytelnym.
      t.setAttribute('y', (y + 14).toFixed(1));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', l.kind === 'gap' ? '10.5' : '10');
      t.setAttribute('fill', l.kind === 'gap' ? COLORS.labelGap : COLORS.labelMuted);
      t.setAttribute('font-weight', '600');
      t.setAttribute('stroke', COLORS.pinStroke);
      t.setAttribute('stroke-width', '2.6');
      t.setAttribute('paint-order', 'stroke');
      t.setAttribute('stroke-linejoin', 'round');
      t.setAttribute('pointer-events', 'none');
      t.textContent = l.text;
      svg.appendChild(t);
    }

    for (const p of scene.points || []) {
      const [x, y] = projection.project(p.lon, p.lat);
      // Znacznik to grupa: kropla plus ikona. Zdarzenia wiszą na grupie, więc
      // przeciąganie i klikanie działa tak samo jak przy dawnym kółku.
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      node.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      // Zaczepy dla testów i dla stylowania: kształt znacznika może się jeszcze
      // zmienić, stan punktu nie.
      node.setAttribute('class', `pin pin--${p.level}${p.id === scene.selectedId ? ' is-selected' : ''}`);
      node.setAttribute('data-level', p.level);
      node.setAttribute('data-pin', p.id);
      if (p.dimmed) node.setAttribute('data-dimmed', 'true');
      node.innerHTML = markerSvg(p.level, MARKER_SIZE, {
        dimmed: p.dimmed,
        selected: p.id === scene.selectedId,
      });
      node.style.cursor = p.draggable ? 'grab' : 'pointer';

      node.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        try {
          svg.setPointerCapture(ev.pointerId);
        } catch {
          /* capture is best-effort */
        }
        dragging = { point: p, node, moved: false, draggable: !!p.draggable };
      });

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = p.name || p.id;
      node.appendChild(title);
      svg.appendChild(node);
    }

    /* ---- panning the background ---- */
    // Any fresh gesture clears a pending suppression, so a drag whose trailing
    // click never arrives cannot swallow the next real click.
    svg.addEventListener('pointerdown', () => { clickBlocked = false; pinPress = null; }, true);

    svg.addEventListener('pointerdown', (ev) => {
      if (dragging || addMode) return;
      try {
        svg.setPointerCapture(ev.pointerId);
      } catch {
        /* best-effort */
      }
      panning = { x: ev.clientX, y: ev.clientY, dx: 0, dy: 0, moved: false };
      svg.style.cursor = 'grabbing';
    });

    svg.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();

      if (dragging && projection) {
        // Drobne drgnienie palca albo myszy nie może unieważnić kliknięcia,
        // dlatego ruch liczy się dopiero od 3 px – tak samo jak przy panoramie.
        const px0 = ev.clientX - rect.left;
        const py0 = ev.clientY - rect.top;
        if (dragging.from) {
          if (Math.hypot(px0 - dragging.from[0], py0 - dragging.from[1]) > 3) dragging.moved = true;
        } else {
          dragging.from = [px0, py0];
        }
        // Pin bez `draggable` tylko notuje ruch – przesuwać się nie może.
        if (!dragging.draggable) return;
        const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        dragging.node.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
        bus.emit('pointdrag', { ...dragging.point, lat, lon });
        return;
      }

      if (panning) {
        // Move the whole SVG with a transform and commit the offset on release
        // – redrawing a thousand demand dots per pointermove would stutter.
        panning.dx = ev.clientX - panning.x;
        panning.dy = ev.clientY - panning.y;
        if (Math.abs(panning.dx) > 2 || Math.abs(panning.dy) > 2) panning.moved = true;
        svg.style.transform = `translate(${panning.dx}px, ${panning.dy}px)`;
      }
    });

    const finish = (ev) => {
      if (dragging) {
        const rect = svg.getBoundingClientRect();
        const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
        const { point, moved, draggable } = dragging;
        dragging = null;
        if (moved) {
          // Gest zakończony ruchem nigdy nie jest kliknięciem – ani w pin,
          // ani w tło. Przeciągnięcie zapisujemy tylko dla pinów przesuwalnych.
          clickBlocked = true;
          if (draggable) bus.emit('pointdragend', { ...point, lat, lon });
        } else {
          pinPress = point;
        }
        return;
      }
      if (panning) {
        const { dx, dy, moved } = panning;
        panning = null;
        svg.style.transform = '';
        svg.style.cursor = addMode ? 'crosshair' : 'grab';
        if (moved) {
          clickBlocked = true;
          view.tx += dx;
          view.ty += dy;
          draw();
        }
      }
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', () => {
      dragging = null;
      panning = null;
      svg.style.transform = '';
    });

    /* ---- zoom: wheel and double click, both around the cursor ---- */
    const zoomAt = (px, py, factor) => {
      const next = Math.min(12, Math.max(0.9, view.scale * factor));
      const applied = next / view.scale;
      view.tx = px - (px - view.tx) * applied;
      view.ty = py - (py - view.ty) * applied;
      view.scale = next;
      scheduleDraw();
    };

    svg.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const rect = svg.getBoundingClientRect();
        zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false }
    );

    // Podwójny klik przybliża – tak samo jak w Mapboksie. Anuluje przy tym
    // pojedynczy klik, żeby przybliżenie nie dołożyło przy okazji punktu.
    svg.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      const rect = svg.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, 1.7);
    });

    svg.addEventListener('click', (ev) => {
      const pin = pinPress;
      pinPress = null;
      if (clickBlocked) {
        clickBlocked = false;
        return;
      }
      if (!projection) return;
      const rect = svg.getBoundingClientRect();
      const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        // Klik w pin nigdy nie dokłada punktu w tle – inaczej wybranie AED
        // dorzucałoby przy okazji rekomendację pod nim.
        if (pin) bus.emit('pointclick', pin);
        else bus.emit('mapclick', { lat, lon, addMode });
      }, CLICK_DELAY_MS);
    });
  }

  return {
    isFallback: true,
    on: bus.on,
    setScene(next) {
      scene = { ...scene, ...next };
      draw();
    },
    setAddMode(value) {
      addMode = value;
      const svg = holder.querySelector('svg');
      if (svg) svg.style.cursor = value ? 'crosshair' : 'grab';
    },
    /** Camera so a view can restore the framing after a re-render. */
    // Render zapasowy nie ma podkładu ani trzeciego wymiaru, ale musi mieć
    // ten sam interfejs – inaczej widoki musiałyby pytać, który renderer stoi
    // pod spodem, a to jest dokładnie ta wiedza, której nie mają mieć.
    basemapThemes: [],
    getBasemapTheme: () => null,
    setBasemapTheme() {},
    flyToPoint() {},

    getCamera() {
      return { viewScale: view.scale, viewTx: view.tx, viewTy: view.ty };
    },
    setCamera(cam) {
      if (!cam) return;
      if (typeof cam.viewScale === 'number') view.scale = cam.viewScale;
      if (typeof cam.viewTx === 'number') view.tx = cam.viewTx;
      if (typeof cam.viewTy === 'number') view.ty = cam.viewTy;
      draw();
    },
    fit() {
      view.scale = 1;
      view.tx = 0;
      view.ty = 0;
      draw();
    },
    flyTo() {
      /* the schematic view keeps whatever framing the operator set */
    },
    destroy() {
      if (clickTimer) clearTimeout(clickTimer);
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      holder.remove();
      notice.remove();
    },
  };
}
