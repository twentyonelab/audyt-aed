#!/usr/bin/env node
/**
 * routeflow.mjs – sprawdza animację tras dojścia na ścieżce MAPBOKSOWEJ.
 *
 * Mapbox GL JS jest w tym środowisku nieosiągalny (Chromium nie dociąga
 * biblioteki), więc podstawiamy atrapę `window.mapboxgl` o dokładnie takim
 * API, jakiego używa js/map.js, i nagrywamy wywołania setPaintProperty.
 * Sprawdzamy to, czego CSS-owa animacja renderu zapasowego nie pokrywa:
 * czy zegar kreskowania startuje z trasami, zmienia wzór i gaśnie bez tras.
 *
 *   node tools/routeflow.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 8126;
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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log('\n── Trasy dojścia: animacja na ścieżce Mapboksa (atrapa biblioteki)\n');

// Atrapa musi stać PRZED wczytaniem modułu, żeby mapboxAvailable() ją zobaczyło.
await page.addInitScript(() => {
  window.MAPBOX_TOKEN = 'pk.test-atrapa-nie-jest-prawdziwym-tokenem';
  window.__paint = [];
  const handlers = {};
  const sources = {};
  const layers = new Set();
  class FakeMap {
    constructor() {
      setTimeout(() => (handlers.load || []).forEach((fn) => fn()), 0);
    }
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
    }
    addControl() {}
    getSource(id) {
      return sources[id];
    }
    addSource(id, cfg) {
      sources[id] = { _data: cfg.data, setData(d) { this._data = d; } };
    }
    addLayer(cfg) {
      layers.add(cfg.id);
      if (cfg.id === 'routes-line') window.__routeLayer = cfg;
    }
    getLayer(id) {
      return layers.has(id) ? { id } : undefined;
    }
    setPaintProperty(layer, prop, value) {
      window.__paint.push({ layer, prop, value: JSON.stringify(value) });
    }
    setLayoutProperty() {}
    getCenter() { return { lng: 19, lat: 50.12 }; }
    getZoom() { return 12; }
    getBearing() { return 0; }
    getPitch() { return 0; }
    fitBounds() {}
    easeTo() {}
    flyTo() {}
    remove() {}
  }
  window.mapboxgl = {
    Map: FakeMap,
    NavigationControl: class {},
    Marker: class {
      constructor(o) {
        this._el = o && o.element;
        this._i = window.__markerIndex = (window.__markerIndex || 0) + 1;
      }
      setLngLat() { return this; }
      // Prawdziwy Marker wstawia swój element do DOM – atrapa musi też,
      // inaczej pin nie istnieje i nie da się w niego kliknąć.
      addTo() {
        if (!this._el) return this;
        const host = document.querySelector('.map-canvas') || document.body;
        Object.assign(this._el.style, {
          position: 'absolute',
          left: `${20 + (this._i % 12) * 34}px`,
          top: `${20 + Math.floor(this._i / 12) * 34}px`,
          width: '14px',
          height: '14px',
        });
        host.appendChild(this._el);
        return this;
      }
      remove() {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      }
      on() { return this; }
      getLngLat() { return { lng: 19, lat: 50.12 }; }
    },
    LngLatBounds: class {
      extend() { return this; }
      isEmpty() { return false; }
    },
    accessToken: null,
  };
});

await page.goto(`${BASE}/index.html#/analysis`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);

check(
  'renderuje się ścieżka Mapboksa, nie zapasowa',
  (await page.locator('.map-canvas').count()) === 1 && (await page.locator('.map-fallback').count()) === 0,
  `canvas ${await page.locator('.map-canvas').count()} · fallback ${await page.locator('.map-fallback').count()}`
);

const layer = await page.evaluate(() => window.__routeLayer);
check(
  'warstwa tras startuje z pierwszego wzoru drabinki',
  !!layer && JSON.stringify(layer.paint['line-dasharray']) === JSON.stringify([0, 4, 3]),
  layer ? JSON.stringify(layer.paint['line-dasharray']) : 'brak warstwy'
);
check(
  'warstwa tras ma prostą końcówkę (kreski zerowej długości nie robią kropek)',
  !!layer && layer.layout['line-cap'] === undefined,
  layer ? String(layer.layout['line-cap']) : 'brak warstwy'
);

const dashCalls = () =>
  page.evaluate(() => window.__paint.filter((c) => c.layer === 'routes-line' && c.prop === 'line-dasharray').length);

// Bez wybranego punktu tras nie ma – zegar ma stać.
const idleA = await dashCalls();
await page.waitForTimeout(500);
const idleB = await dashCalls();
check('bez tras zegar kreskowania stoi', idleA === idleB, `${idleA} → ${idleB} klatek`);

// Wybierz punkt, który ma trasy w cache projektu – to wkłada je do scenerii.
const pinTitle = await page.evaluate(() => {
  const p = window.__aed.points.find((x) => x.kind === 'existing' && x.id === 'AED-001');
  return p ? p.name : null;
});
await page.locator(`.pin[title="${pinTitle}"]`).first().click();
await page.waitForTimeout(1200);

const runA = await dashCalls();
await page.waitForTimeout(500);
const runB = await dashCalls();
check('z trasami zegar tyka i podmienia wzór', runB > runA, `${runA} → ${runB} klatek`);

const distinct = await page.evaluate(
  () =>
    new Set(
      window.__paint.filter((c) => c.layer === 'routes-line' && c.prop === 'line-dasharray').map((c) => c.value)
    ).size
);
check('drabinka faktycznie przechodzi przez różne wzory', distinct >= 5, `${distinct} różnych wzorów`);

const periods = await page.evaluate(() =>
  [
    ...new Set(
      window.__paint
        .filter((c) => c.layer === 'routes-line' && c.prop === 'line-dasharray')
        .map((c) => JSON.parse(c.value).reduce((a, b) => a + b, 0))
    ),
  ].sort()
);
check(
  'każdy wzór ma ten sam okres 7 – kreski się przesuwają, a nie rozciągają',
  periods.length === 1 && periods[0] === 7,
  `okresy: ${periods.join(', ')}`
);

// Zamknięcie karty gasi trasy – zegar ma się zatrzymać.
await page.locator('.panel .panel__selected button[title*="Zamknij"]').first().click();
await page.waitForTimeout(700);
const offA = await dashCalls();
await page.waitForTimeout(500);
const offB = await dashCalls();
check('po zgaszeniu tras zegar znów stoi', offA === offB, `${offA} → ${offB} klatek`);

const real = errors.filter((e) => !/mapbox|net::ERR|favicon/i.test(e));
check('brak błędów strony', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
stop();
console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
