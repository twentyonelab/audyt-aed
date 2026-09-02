/**
 * map.js — the map layer.
 *
 * Two renderers behind one interface:
 *   • Mapbox GL JS when the library loaded and a real token is configured.
 *   • A schematic SVG renderer otherwise, so the makieta is never dead — it
 *     draws the same scene from the same data, just without a basemap.
 *
 * Views never touch either renderer directly. They build a `scene` object and
 * hand it to `setScene()`.
 *
 * Spec reference: ITERACJA2_SPEC.md §2, §6.2, §6.3.
 */

import { MAPBOX_TOKEN, MAP_STYLE, MAP_DEFAULT } from '../config.js';
import { metresPerDegLon } from './model.js';

const TOKEN_IS_REAL = typeof MAPBOX_TOKEN === 'string' && MAPBOX_TOKEN.startsWith('pk.');

/** Ile klik na mapie czeka na ewentualny dblclick, zanim zostanie wysłany. */
const CLICK_DELAY_MS = 260;

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

/** Linear projection fitted to a bbox — used by every SVG rendering. */
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

const COLORS = {
  boundary: '#b9b9b4',
  boundaryFill: '#ffffff',
  district: '#e6e6e2',
  districtLine: '#d0d0d0',
  coverage: 'rgba(76,175,125,0.16)',
  coverageLine: 'rgba(76,175,125,0.55)',
  coveragePlan: 'rgba(138,111,199,0.16)',
  coveragePlanLine: 'rgba(138,111,199,0.6)',
  covered: '#4caf7d',
  uncovered: '#d9534f',
  near: '#e8b33c',
  highlight: 'rgba(76,175,125,0.12)',
  highlightLine: '#4caf7d',
  // Trasy dojścia: ten sam odcień co obrys zasięgu, ale w pełnym nasyceniu —
  // krycie 50% nakłada się dopiero w atrybucie stroke-opacity, więc linia nie
  // gaśnie dwa razy (raz w kolorze, raz w kryciu).
  routeLine: '#4caf7d',
  routePlanLine: '#8a6fc7',
};

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

  parts.push(`<rect width="${width}" height="${height}" fill="#f2f2ef"/>`);

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

  // Podświetlenie jednej dzielnicy (np. wybranej w filtrze) — działa też przy
  // showDistricts: false, bo wtedy jest jedynym rysowanym wielokątem dzielnicy.
  if (scene.highlightDistrictId && scene.districts) {
    const f = scene.districts.features.find((d) => d.properties.id === scene.highlightDistrictId);
    if (f) {
      parts.push(
        `<path d="${ringPath(f.geometry.coordinates[0], project)}" fill="${COLORS.highlight}" stroke="${COLORS.highlightLine}" stroke-width="1.6"/>`
      );
    }
  }

  // Realne zasięgi dojścia (izochrony) — nieregularne obrysy po sieci pieszej.
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
  // obrysu tego punktu — nie wprowadzają nowego koloru do legendy.
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
      parts.push(
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-opacity="0.5" ` +
          `stroke-dasharray="4 3" stroke-linecap="round"/>`
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

  for (const p of scene.points || []) {
    const [x, y] = project(p.lon, p.lat);
    const fill =
      p.level === 'ok' ? COLORS.covered : p.level === 'warn' ? '#e8b33c' : p.level === 'proposed' ? '#8a6fc7' : COLORS.uncovered;
    const dim = p.dimmed ? ' opacity="0.2"' : '';
    if (p.level === 'proposed') {
      parts.push(
        `<rect x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9" fill="${fill}" stroke="#fff" stroke-width="1.6"${dim}/>`
      );
    } else {
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${fill}" stroke="#fff" stroke-width="1.6"${dim}/>`);
    }
  }

  if (opts.showLabels && scene.labels) {
    for (const l of scene.labels) {
      const [x, y] = project(l.lon, l.lat);
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Inter, sans-serif" font-size="8" fill="#8d8d8d" text-anchor="middle">${l.text}</text>`
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
  const map = new window.mapboxgl.Map({
    container: canvas,
    style: MAP_STYLE,
    center: opts.center || MAP_DEFAULT.center,
    zoom: opts.zoom || MAP_DEFAULT.zoom,
    attributionControl: false,
  });
  map.addControl(new window.mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');

  let markers = [];
  let labelMarkers = [];
  let scene = {};
  let ready = false;
  let addMode = false;
  // A click that terminates a pin drag must not open anything.
  let dragged = false;

  const src = (id, data) => {
    if (map.getSource(id)) map.getSource(id).setData(data);
    else map.addSource(id, { type: 'geojson', data });
  };
  const emptyFc = { type: 'FeatureCollection', features: [] };

  map.on('load', () => {
    src('boundary', emptyFc);
    src('districts', emptyFc);
    src('district-hl', emptyFc);
    src('coverage', emptyFc);
    src('reach', emptyFc);
    src('routes', emptyFc);
    src('demand', emptyFc);

    map.addLayer({ id: 'districts-fill', type: 'fill', source: 'districts', paint: { 'fill-color': '#e8e8e4', 'fill-opacity': 0.55 } });
    map.addLayer({ id: 'districts-line', type: 'line', source: 'districts', paint: { 'line-color': '#c9c9c4', 'line-width': 1 } });
    map.addLayer({ id: 'district-hl-fill', type: 'fill', source: 'district-hl', paint: { 'fill-color': '#4caf7d', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'district-hl-line', type: 'line', source: 'district-hl', paint: { 'line-color': '#4caf7d', 'line-width': 1.8 } });
    map.addLayer({
      id: 'coverage-fill',
      type: 'fill',
      source: 'coverage',
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'proposed'], '#8a6fc7', '#4caf7d'],
        'fill-opacity': 0.15,
      },
    });
    map.addLayer({
      id: 'coverage-line',
      type: 'line',
      source: 'coverage',
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], '#8a6fc7', '#4caf7d'],
        'line-width': 1,
        'line-dasharray': [2, 1.5],
      },
    });
    // Realny zasięg dojścia po sieci pieszej — pod punktami popytu,
    // żeby kolory kropek pozostały czytelne.
    map.addLayer({
      id: 'reach-fill',
      type: 'fill',
      source: 'reach',
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'proposed'], '#8a6fc7', '#4caf7d'],
        'fill-opacity': ['case', ['get', 'emphasis'], 0.22, 0.13],
      },
    });
    map.addLayer({
      id: 'reach-line',
      type: 'line',
      source: 'reach',
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], '#8a6fc7', '#4caf7d'],
        'line-width': ['case', ['get', 'emphasis'], 2, 1],
      },
    });
    map.addLayer({
      id: 'routes-line',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'proposed'], '#8a6fc7', '#4caf7d'],
        'line-width': 2,
        'line-opacity': 0.5,
        'line-dasharray': [3, 2],
      },
    });
    map.addLayer({
      id: 'demand-dots',
      type: 'circle',
      source: 'demand',
      paint: {
        'circle-radius': 2.6,
        'circle-opacity': 0.75,
        'circle-color': [
          'case',
          ['get', 'covered'], '#4caf7d',
          ['<=', ['get', 'ratio'], 2], '#e8b33c',
          '#d9534f',
        ],
      },
    });
    map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', paint: { 'line-color': '#7c7c78', 'line-width': 1.4, 'line-dasharray': [3, 2] } });

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

    src('routes', {
      type: 'FeatureCollection',
      features: (scene.showRoutes === false ? [] : scene.routes || [])
        .map((r) => ({ line: (r && (r.line || r)) || null, kind: (r && r.kind) || 'existing' }))
        .filter((r) => r.line && r.line.length > 1)
        .map((r) => ({
          type: 'Feature',
          properties: { kind: r.kind },
          geometry: { type: 'LineString', coordinates: r.line },
        })),
    });

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
      const node = document.createElement('div');
      node.className = `pin pin--${p.level}${p.id === scene.selectedId ? ' is-selected' : ''}`;
      node.title = p.name || '';
      if (p.dimmed) node.style.opacity = '0.2';
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
      const marker = new window.mapboxgl.Marker({ element: node, draggable: !!p.draggable })
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
      return new window.mapboxgl.Marker({ element: node }).setLngLat([l.lon, l.lat]).addTo(map);
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
 * placeholder: pan with the mouse, zoom with the wheel, drag pins — so the
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
    : 'Mapa schematyczna — podstaw własny token w <code>config.js</code> (MAPBOX_TOKEN), aby zobaczyć podkład Mapbox.';
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
  // — o tym, że klik należy do pinu, decyduje ten zapis z pointerdown.
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
    // not draw them too — otherwise every pin renders twice.
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
      // Bez obrysów dzielnic podpis siada dokładnie tam, gdzie bywa pin —
      // 14 px niżej mija się z nim, a biała otoczka trzyma go czytelnym.
      t.setAttribute('y', (y + 14).toFixed(1));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', l.kind === 'gap' ? '10.5' : '10');
      t.setAttribute('fill', l.kind === 'gap' ? '#a5322e' : '#8d8d8d');
      t.setAttribute('font-weight', '600');
      t.setAttribute('stroke', '#ffffff');
      t.setAttribute('stroke-width', '2.6');
      t.setAttribute('paint-order', 'stroke');
      t.setAttribute('stroke-linejoin', 'round');
      t.setAttribute('pointer-events', 'none');
      t.textContent = l.text;
      svg.appendChild(t);
    }

    for (const p of scene.points || []) {
      const [x, y] = projection.project(p.lon, p.lat);
      const isProposed = p.level === 'proposed';
      const node = document.createElementNS('http://www.w3.org/2000/svg', isProposed ? 'rect' : 'circle');
      const fill =
        p.level === 'ok' ? '#4caf7d' : p.level === 'warn' ? '#e8b33c' : isProposed ? '#8a6fc7' : '#d9534f';
      if (isProposed) {
        node.setAttribute('x', (x - 6).toFixed(1));
        node.setAttribute('y', (y - 6).toFixed(1));
        node.setAttribute('width', '12');
        node.setAttribute('height', '12');
      } else {
        node.setAttribute('cx', x.toFixed(1));
        node.setAttribute('cy', y.toFixed(1));
        node.setAttribute('r', '6');
      }
      node.setAttribute('fill', fill);
      node.setAttribute('stroke', p.id === scene.selectedId ? '#1e1e1e' : '#ffffff');
      node.setAttribute('stroke-width', p.id === scene.selectedId ? '2.4' : '2');
      if (p.dimmed) node.setAttribute('opacity', '0.2');
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
        // dlatego ruch liczy się dopiero od 3 px — tak samo jak przy panoramie.
        const px0 = ev.clientX - rect.left;
        const py0 = ev.clientY - rect.top;
        if (dragging.from) {
          if (Math.hypot(px0 - dragging.from[0], py0 - dragging.from[1]) > 3) dragging.moved = true;
        } else {
          dragging.from = [px0, py0];
        }
        // Pin bez `draggable` tylko notuje ruch — przesuwać się nie może.
        if (!dragging.draggable) return;
        const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        if (dragging.node.tagName === 'rect') {
          dragging.node.setAttribute('x', (px - 6).toFixed(1));
          dragging.node.setAttribute('y', (py - 6).toFixed(1));
        } else {
          dragging.node.setAttribute('cx', px.toFixed(1));
          dragging.node.setAttribute('cy', py.toFixed(1));
        }
        bus.emit('pointdrag', { ...dragging.point, lat, lon });
        return;
      }

      if (panning) {
        // Move the whole SVG with a transform and commit the offset on release
        // — redrawing a thousand demand dots per pointermove would stutter.
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
          // Gest zakończony ruchem nigdy nie jest kliknięciem — ani w pin,
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

    // Podwójny klik przybliża — tak samo jak w Mapboksie. Anuluje przy tym
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
        // Klik w pin nigdy nie dokłada punktu w tle — inaczej wybranie AED
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
