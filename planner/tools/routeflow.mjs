#!/usr/bin/env node
/**
 * routeflow.mjs – sprawdza ścieżkę MAPBOKSOWĄ: konfigurację mapy 3D
 * i animację tras dojścia.
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
import { unlock } from './unlock.mjs';
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
await unlock(page);
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
    constructor(opts) {
      window.__mapOpts = opts;
      // Prawdziwy Mapbox wysyła najpierw `style.load`, potem `load`.
      // Rzeźba terenu wisi na tym pierwszym, bo podmiana motywu podkładu
      // przeładowuje styl i teren trzeba założyć ponownie.
      setTimeout(() => {
        (handlers['style.load'] || []).forEach((fn) => fn());
        (handlers.load || []).forEach((fn) => fn());
      }, 0);
    }
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
    }
    addControl(c) { (window.__controls = window.__controls || []).push(c && c.constructor && c.constructor.name); }
    addLayer(cfg) {
      layers.add(cfg.id);
      window.__layerSlots = window.__layerSlots || {};
      window.__layerSlots[cfg.id] = cfg.slot || null;
      if (cfg.id === 'routes-line') window.__routeLayer = cfg;
    }
    getLayer(id) {
      return layers.has(id) ? { id } : undefined;
    }
    setPaintProperty(layer, prop, value) {
      window.__paint.push({ layer, prop, value: JSON.stringify(value) });
    }
    setLayoutProperty() {}
    // Styl Standard: konfiguracja importu, rzeźba terenu i przelot kamery.
    setConfigProperty(importId, prop, value) {
      window.__config = window.__config || [];
      window.__config.push({ importId, prop, value });
    }
    addSource(id, cfg) {
      sources[id] = { _data: cfg.data, setData(d) { this._data = d; } };
      // Widoki nie mają uchwytu do mapy, a testy muszą zajrzeć w dane warstw.
      window.__sources = sources;
    }
    getSource(id) { return sources[id]; }
    setTerrain(cfg) { window.__terrain = cfg; }
    getTerrain() { return window.__terrain || null; }
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
    AttributionControl: class {},
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

/* ---------------------------------------------------------------- *
 * Mapa 3D: styl Standard, konfiguracja podkładu, rzeźba terenu
 * ---------------------------------------------------------------- */

const opts = await page.evaluate(() => window.__mapOpts);
check(
  'mapa startuje na stylu Standard',
  !!opts && opts.style === 'mapbox://styles/mapbox/standard',
  opts ? String(opts.style) : 'brak opcji'
);
check(
  'konfiguracja podkładu idzie od razu przy tworzeniu mapy',
  !!opts && !!opts.config && !!opts.config.basemap,
  opts && opts.config ? JSON.stringify(opts.config.basemap) : 'brak config'
);
const cfg = (opts && opts.config && opts.config.basemap) || {};
check('bryły budynków włączone', cfg.show3dObjects === true, String(cfg.show3dObjects));
check('podkład w szarościach', cfg.theme === 'monochrome', String(cfg.theme));
check(
  'podpisy dróg i punktów usługowych zdjęte',
  cfg.showRoadLabels === false && cfg.showPointOfInterestLabels === false,
  `drogi=${cfg.showRoadLabels} POI=${cfg.showPointOfInterestLabels}`
);
check('kamera pochylona, inaczej „3D" to tylko nazwa', opts && opts.pitch === 52, String(opts && opts.pitch));

const terrain = await page.evaluate(() => window.__terrain);
check(
  'rzeźba terenu założona z przewyższeniem',
  !!terrain && terrain.source === 'mapbox-dem' && terrain.exaggeration === 1.4,
  terrain ? JSON.stringify(terrain) : 'brak terenu'
);

const controls = await page.evaluate(() => window.__controls || []);
check(
  'atrybucja Mapboxa jest na mapie (wymóg licencji)',
  controls.includes('AttributionControl'),
  controls.join(', ')
);
check('kompas z pochyleniem jest na mapie', controls.includes('NavigationControl'), controls.join(', '));

// Własne warstwy w stylu Standard muszą mieć slot, inaczej lądują na wierzchu
// i zasłaniają bryły oraz podpisy.
const slots = await page.evaluate(() => window.__layerSlots || {});
check(
  'każda własna warstwa ma przypisany slot',
  Object.values(slots).every(Boolean) && Object.keys(slots).length >= 8,
  Object.entries(slots).map(([k, v]) => `${k}:${v || 'BRAK'}`).join(' · ')
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

/* ---------------------------------------------------------------- *
 * Maska poza granicą i warstwa zagęszczenia – ścieżka Mapboksa
 * ---------------------------------------------------------------- */

check(
  'maska poza granicą leży w slocie „top" – nad etykietami i budynkami',
  slots['mask-fill'] === 'top',
  `slot: ${slots['mask-fill']}`
);
check(
  'kropki zagęszczenia leżą pod punktami popytu',
  slots['density-dots'] === 'bottom' && slots['demand-dots'] === 'middle',
  `gęstość: ${slots['density-dots']} · popyt: ${slots['demand-dots']}`
);

const maskData = await page.evaluate(() => {
  const src = (window.__sources || {}).mask;
  const f = src && src._data && src._data.features && src._data.features[0];
  if (!f) return null;
  return { rings: f.geometry.coordinates.length, outer: f.geometry.coordinates[0].length };
});
check(
  'maska to wielokąt z dziurą w kształcie granicy gminy',
  !!maskData && maskData.rings === 2 && maskData.outer === 5,
  maskData ? `${maskData.rings} pierścienie, prostokąt z ${maskData.outer} wierzchołków` : 'brak maski'
);

// Warstwa gęstości startuje pusta i napełnia się dopiero po przełączeniu.
const densityCount = () =>
  page.evaluate(() => {
    const src = (window.__sources || {}).density;
    return src && src._data && src._data.features ? src._data.features.length : -1;
  });
check('źródło gęstości startuje puste', (await densityCount()) === 0, `${await densityCount()} punktów`);

await page.locator('.layer-dock__btn').nth(1).click();
await page.waitForTimeout(3000);
const dens = await densityCount();
check('przełącznik napełnia warstwę gęstości', dens > 1500, `${dens} punktów`);

const densProps = await page.evaluate(() => {
  const feats = ((window.__sources || {}).density._data || {}).features || [];
  const ws = feats.map((f) => f.properties.w);
  return {
    hasCovered: feats.some((f) => f.properties.covered === true),
    hasUncovered: feats.some((f) => f.properties.covered === false),
    min: Math.min(...ws),
    max: Math.max(...ws),
  };
});
check(
  'każda kropka niesie znormalizowaną gęstość (0–1) i dostęp do AED',
  densProps.hasCovered &&
    densProps.hasUncovered &&
    densProps.min >= 0 &&
    densProps.max > 0.9 &&
    densProps.max <= 1,
  `w: ${densProps.min.toFixed(2)}–${densProps.max.toFixed(2)}`
);

const real = errors.filter((e) => !/mapbox|net::ERR|favicon/i.test(e));
check('brak błędów strony', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
stop();
console.log(`\n${failures ? `${failures} sprawdzeń nie przeszło` : 'wszystkie sprawdzenia zaliczone'}\n`);
process.exit(failures ? 1 : 0);
