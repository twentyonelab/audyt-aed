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
  const { project, metres } = makeProjection(bbox, width, height, opts.pad ?? 10);
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
    if (p.level === 'proposed') {
      parts.push(
        `<rect x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9" fill="${fill}" stroke="#fff" stroke-width="1.6"/>`
      );
    } else {
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${fill}" stroke="#fff" stroke-width="1.6"/>`);
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

  const src = (id, data) => {
    if (map.getSource(id)) map.getSource(id).setData(data);
    else map.addSource(id, { type: 'geojson', data });
  };
  const emptyFc = { type: 'FeatureCollection', features: [] };

  map.on('load', () => {
    src('boundary', emptyFc);
    src('districts', emptyFc);
    src('coverage', emptyFc);
    src('demand', emptyFc);

    map.addLayer({ id: 'districts-fill', type: 'fill', source: 'districts', paint: { 'fill-color': '#e8e8e4', 'fill-opacity': 0.55 } });
    map.addLayer({ id: 'districts-line', type: 'line', source: 'districts', paint: { 'line-color': '#c9c9c4', 'line-width': 1 } });
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

  map.on('click', (e) => {
    bus.emit('mapclick', { lat: e.lngLat.lat, lon: e.lngLat.lng, addMode });
  });

  function applyScene(next) {
    scene = { ...scene, ...next };
    if (!ready) return;

    if (scene.boundary) src('boundary', scene.boundary);
    src('districts', scene.showDistricts === false ? emptyFc : scene.districts || emptyFc);

    src('coverage', {
      type: 'FeatureCollection',
      features: (scene.showCoverage === false ? [] : scene.coverage || []).map((c) => ({
        type: 'Feature',
        properties: { kind: c.kind || 'existing' },
        geometry: circlePolygon(c.lat, c.lon, c.radiusM),
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
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        bus.emit('pointclick', p);
      });
      const marker = new window.mapboxgl.Marker({ element: node, draggable: !!p.draggable })
        .setLngLat([p.lon, p.lat])
        .addTo(map);
      if (p.draggable) {
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
    fit(geojson) {
      const [w, s, e, n] = bboxOf(geojson || scene.boundary);
      map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 });
    },
    flyTo(lat, lon, zoom = 14.5) {
      map.flyTo({ center: [lon, lat], zoom, duration: 400 });
    },
    destroy() {
      markers.forEach((m) => m.remove());
      labelMarkers.forEach((m) => m.remove());
      map.remove();
      canvas.remove();
    },
  };
}

/* --------------------------- Fallback ----------------------------- */

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
  let projection = null;
  let addMode = false;
  let dragging = null;

  const ro = new ResizeObserver(() => {
    size = { w: container.clientWidth || size.w, h: container.clientHeight || size.h };
    draw();
  });
  ro.observe(container);

  function draw() {
    if (!scene.boundary) return;
    const bbox = bboxOf(scene.boundary);
    projection = makeProjection(bbox, size.w, size.h, 24);
    holder.innerHTML = renderSceneSvg(scene, {
      width: size.w,
      height: size.h,
      showDemand: scene.showDemand !== false,
      showCoverage: scene.showCoverage !== false,
      showDistricts: scene.showDistricts !== false,
      pad: 24,
    });

    const svg = holder.querySelector('svg');
    if (!svg) return;
    svg.style.cursor = addMode ? 'crosshair' : 'default';

    // labels
    for (const l of scene.labels || []) {
      const [x, y] = projection.project(l.lon, l.lat);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', x.toFixed(1));
      t.setAttribute('y', y.toFixed(1));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', l.kind === 'gap' ? 'gap-label' : 'pin--district-label');
      t.setAttribute('font-size', l.kind === 'gap' ? '10.5' : '10');
      t.setAttribute('fill', l.kind === 'gap' ? '#a5322e' : '#8d8d8d');
      t.setAttribute('font-weight', '600');
      t.textContent = l.text;
      svg.appendChild(t);
    }

    // interactive pins drawn on top
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
      node.style.cursor = p.draggable ? 'grab' : 'pointer';
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!dragging) bus.emit('pointclick', p);
      });
      if (p.draggable) {
        node.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          node.setPointerCapture(ev.pointerId);
          dragging = { point: p, node, moved: false };
        });
      }
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = p.name || p.id;
      node.appendChild(title);
      svg.appendChild(node);
    }

    svg.addEventListener('pointermove', (ev) => {
      if (!dragging || !projection) return;
      const rect = svg.getBoundingClientRect();
      const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
      dragging.moved = true;
      if (dragging.node.tagName === 'rect') {
        dragging.node.setAttribute('x', (ev.clientX - rect.left - 6).toFixed(1));
        dragging.node.setAttribute('y', (ev.clientY - rect.top - 6).toFixed(1));
      } else {
        dragging.node.setAttribute('cx', (ev.clientX - rect.left).toFixed(1));
        dragging.node.setAttribute('cy', (ev.clientY - rect.top).toFixed(1));
      }
      bus.emit('pointdrag', { ...dragging.point, lat, lon });
    });

    const endDrag = (ev) => {
      if (!dragging || !projection) return;
      const rect = svg.getBoundingClientRect();
      const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
      const payload = { ...dragging.point, lat, lon };
      const moved = dragging.moved;
      dragging = null;
      if (moved) bus.emit('pointdragend', payload);
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointerleave', () => {
      dragging = null;
    });

    svg.addEventListener('click', (ev) => {
      if (ev.target !== svg && ev.target.tagName !== 'path' && ev.target.tagName !== 'rect') return;
      if (!projection) return;
      const rect = svg.getBoundingClientRect();
      const [lon, lat] = projection.unproject(ev.clientX - rect.left, ev.clientY - rect.top);
      bus.emit('mapclick', { lat, lon, addMode });
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
      if (svg) svg.style.cursor = value ? 'crosshair' : 'default';
    },
    fit() {
      draw();
    },
    flyTo() {
      /* schematic view always shows the whole city */
    },
    destroy() {
      ro.disconnect();
      holder.remove();
      notice.remove();
    },
  };
}
