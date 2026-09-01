/**
 * views/setup.js — Krok 0: Setup projektu (SPEC §6.1, trasa '#/setup').
 *
 * Formularz danych wejściowych (560 px) po lewej + podgląd mapy po prawej.
 * Każde pole realnie zapisuje się do `state.project` przez `save()`.
 * Kandydatów tu nie ma — pojawiają się dopiero w kroku 2 (SPEC §6.1).
 */

import {
  state,
  save,
  markStepDone,
  makePoint,
  upsertPoint,
  nextId,
  districtAt,
  getPreset,
  getPoint,
  districtName,
} from '../state.js';

import {
  analyze,
  completeness,
  pointStatusLevel,
  coverageRadiusM,
  ringCentroid,
  fmtNum,
  fmtMin,
} from '../model.js';

import { h, mount, toast, dotHtml, disabledControl, pickFile, parseCsv } from '../ui.js';
import { createMap, bboxOf } from '../map.js';
import { reachMapSync } from '../reach.js';
import { TODAY } from '../../config.js';

export const meta = {
  step: 0,
  title: 'Setup projektu',
  subtitle: 'dane wejściowe',
  layout: 'split',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/** Segmented control „standard czasu dojścia" (SPEC §5 — promień z modelu). */
const STANDARDS = [
  { minutes: 2, label: 'ERC ≤ 2 min' },
  { minutes: 3, label: 'Miejski ≤ 3 min' },
  { minutes: 5, label: 'Podstawowy ≤ 5 min' },
];

const BOUNDARY_FILE = 'boundary-tychy.geojson';
const BOUNDARY_DELAY_MS = 800;

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (przeżywa przerysowanie po save(), nie jest danymi)
 * ------------------------------------------------------------------ */

let map = null;
let boundaryTimer = null;
let boundaryStatus = 'idle'; // 'idle' | 'loading' | 'done'
let districtsInfo = null; // {rows, population, source:'demo'|'csv', fileName}
let importInfo = null; // {count, format}

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy — brakujące rzeczy są tutaj)
 * ------------------------------------------------------------------ */

function field(labelText, ...children) {
  return h('div', { class: 'field' }, h('span', { class: 'field__label', text: labelText }), ...children);
}

function hint(text) {
  return h('span', { class: 'field__hint', text });
}

const PL_MAP = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL_MAP[c] || c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function toInt(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function toFloat(value) {
  const num = parseFloat(String(value || '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(num) ? num : NaN;
}

function sumPopulation(districts) {
  return (districts || []).reduce((sum, d) => sum + (Number(d.population) || 0), 0);
}

/** „Tychy" → „TYCHY — Audyt 2026" (zachowuje istniejący dopisek etykiety). */
function deriveLabel(name, previousLabel) {
  const suffix =
    previousLabel && previousLabel.includes('—')
      ? previousLabel.split('—').slice(1).join('—').trim()
      : `Audyt ${String(TODAY).slice(0, 4)}`;
  const base = String(name || '').trim() || 'Projekt';
  return `${base.toUpperCase()} — ${suffix}`;
}

/* ------------------------------------------------------------------ *
 * Parsowanie plików
 * ------------------------------------------------------------------ */

/** CSV dzielnic: kolumny id;nazwa;ludnosc. */
function parseDistrictsCsv(text) {
  const out = [];
  for (const row of parseCsv(text)) {
    const name = pick(row, ['nazwa', 'name', 'dzielnica']);
    const population = toInt(pick(row, ['ludnosc', 'ludność', 'population', 'mieszkancy', 'mieszkańcy']));
    const id = slug(pick(row, ['id']) || name);
    if (!id || (!name && !population)) continue;
    out.push({ id, name: name || id, population });
  }
  return out;
}

/** CSV punktów: nazwa;adres;lat;lon;preset. */
function parsePointsCsv(text) {
  const out = [];
  for (const row of parseCsv(text)) {
    const lat = toFloat(pick(row, ['lat', 'latitude', 'szerokosc', 'szerokość', 'y']));
    const lon = toFloat(pick(row, ['lon', 'lng', 'longitude', 'dlugosc', 'długość', 'x']));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name: pick(row, ['nazwa', 'name', 'punkt', 'obiekt']),
      address: pick(row, ['adres', 'address', 'ulica']),
      presetId: pick(row, ['preset', 'presetid', 'preset_id']).toUpperCase(),
      lat,
      lon,
    });
  }
  return out;
}

/** GeoJSON punktów: FeatureCollection / Feature / geometry Point. */
function parsePointsGeoJson(text) {
  const data = JSON.parse(text);
  const features =
    data.type === 'FeatureCollection'
      ? data.features || []
      : data.type === 'Feature'
      ? [data]
      : [{ type: 'Feature', properties: {}, geometry: data }];

  const out = [];
  for (const feature of features) {
    const geometry = feature && feature.geometry;
    if (!geometry || geometry.type !== 'Point') continue;
    const [lon, lat] = geometry.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const props = feature.properties || {};
    out.push({
      name: props.name || props.nazwa || props.title || '',
      address: props.address || props.adres || props['addr:street'] || '',
      presetId: String(props.preset || props.presetId || '').toUpperCase(),
      lat,
      lon,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const project = state.project;
  if (!project) {
    mount(root, h('div', { class: 'empty-state', text: 'Brak aktywnego projektu — wróć do pulpitu i otwórz audyt.' }));
    return;
  }

  const districts = project.districts || [];
  const radiusM = coverageRadiusM(project.standardMinutes);
  const analysis = analyze({
    demandPoints: state.demandPoints,
    points: state.points,
    districts,
    standardMinutes: project.standardMinutes,
    population: project.population,
    scenario: 'now',
    mode: 'day',
    // Ten sam zasięg co w kroku 2 — pulpit i setup nie mogą pokazywać
    // innego pokrycia niż analiza.
    reach: reachMapSync(state.points),
  });

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(analysis.activeCount)} AED · standard ${fmtMin(project.standardMinutes, 0)} · promień ${fmtNum(
        analysis.radiusM,
        0
      )} m`
    );
  }

  /* ---------------- 1. Nazwa gminy ---------------- */

  const labelHint = hint(`Etykieta projektu: ${project.label || deriveLabel(project.name, project.label)}`);
  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: project.name || '',
    placeholder: 'np. Tychy',
    oninput: (e) => {
      project.name = e.target.value;
      project.label = deriveLabel(project.name, project.label);
      labelHint.textContent = `Etykieta projektu: ${project.label}`;
    },
    onchange: async () => {
      await save();
      toast('Zapisano nazwę gminy.');
    },
  });
  const nameField = field('Nazwa gminy', nameInput, labelHint);

  /* ---------------- 2. Granica gminy ---------------- */

  const boundaryStatusEl = h('div', { class: 'field__hint' });
  const boundaryBtn = h('button', { class: 'btn' }, 'Pobierz z rejestru PRG ⟳');

  const paintBoundaryStatus = () => {
    if (boundaryStatus === 'loading') {
      boundaryStatusEl.textContent = 'Pobieranie granicy z rejestru PRG…';
      return;
    }
    if (boundaryStatus === 'done') {
      const [w, s, e, n] = bboxOf(state.boundary);
      boundaryStatusEl.textContent =
        `✓ Wczytano granicę gminy z pliku ${BOUNDARY_FILE} (dane realne, PRG). ` +
        `Zakres: ${fmtNum(w, 3)}–${fmtNum(e, 3)} E · ${fmtNum(s, 3)}–${fmtNum(n, 3)} N.`;
      return;
    }
    boundaryStatusEl.textContent = state.boundary
      ? `Granica jest wczytana wstępnie (${BOUNDARY_FILE}) — potwierdź pobraniem z rejestru.`
      : 'Brak granicy gminy.';
  };

  boundaryBtn.addEventListener('click', () => {
    if (boundaryStatus === 'loading') return;
    boundaryStatus = 'loading';
    boundaryBtn.setAttribute('disabled', '');
    boundaryBtn.classList.add('is-disabled');
    paintBoundaryStatus();

    clearTimeout(boundaryTimer);
    boundaryTimer = setTimeout(() => {
      boundaryTimer = null;
      boundaryStatus = 'done';
      boundaryBtn.removeAttribute('disabled');
      boundaryBtn.classList.remove('is-disabled');
      paintBoundaryStatus();
      refreshMapPreview();
      toast('Granica gminy potwierdzona.');
    }, BOUNDARY_DELAY_MS);
  });

  paintBoundaryStatus();
  if (boundaryStatus === 'loading') {
    boundaryBtn.setAttribute('disabled', '');
    boundaryBtn.classList.add('is-disabled');
  }

  const boundaryField = field(
    'Granica gminy',
    h('div', { class: 'field__row' }, boundaryBtn),
    boundaryStatusEl
  );

  /* ---------------- 3. Ludność i dzielnice (CSV + drop) ---------------- */

  const dropZone = h(
    'div',
    {
      style: {
        border: '1px dashed var(--line)',
        borderRadius: '2px',
        background: 'var(--section)',
        padding: '14px',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--ink-2)',
      },
      text: 'Przeciągnij tu plik CSV (id;nazwa;ludnosc) albo wybierz go poniżej.',
    }
  );

  const districtsSummary = hint(
    `Wczytane: ${fmtNum(districts.length)} dzielnic · ${fmtNum(sumPopulation(districts))} mieszkańców` +
      (districtsInfo
        ? ` · źródło: ${districtsInfo.source === 'csv' ? `CSV ${districtsInfo.fileName}` : 'zestaw przykładowy'} (${fmtNum(
            districtsInfo.rows
          )} wierszy)`
        : '')
  );

  const applyDistricts = async (rows, source, fileName = '') => {
    if (!rows.length) {
      toast('W pliku nie znaleziono wierszy z kolumnami id;nazwa;ludnosc.');
      return;
    }
    project.districts = rows;
    project.population = sumPopulation(rows);
    districtsInfo = { rows: rows.length, population: project.population, source, fileName };
    await save();
    toast(`Wczytano ${fmtNum(rows.length)} dzielnic · ${fmtNum(project.population)} mieszkańców.`);
  };

  const readDistrictsFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      await applyDistricts(parseDistrictsCsv(text), 'csv', file.name);
    } catch (err) {
      console.error(err);
      toast('Nie udało się odczytać pliku CSV.');
    }
  };

  const districtsField = field(
    'Ludność i dzielnice',
    dropZone,
    h(
      'div',
      { class: 'field__row' },
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const file = await pickFile('.csv,text/csv');
            await readDistrictsFile(file);
          },
        },
        'Wybierz plik CSV…'
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            // Demo: zestaw dzielnic jest już w projekcie — potwierdzamy go i przeliczamy ludność.
            await applyDistricts(
              (project.districts || []).map((d) => ({ ...d })),
              'demo'
            );
          },
        },
        'Wczytaj przykładowe'
      )
    ),
    districtsSummary,
    hint('Geometria dzielnic pochodzi z districts-tychy.geojson — CSV aktualizuje nazwy i ludność.')
  );

  const stopDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  districtsField.addEventListener('dragover', (e) => {
    stopDrag(e);
    dropZone.style.borderColor = 'var(--bar)';
    dropZone.style.background = 'var(--panel)';
  });
  districtsField.addEventListener('dragleave', (e) => {
    stopDrag(e);
    dropZone.style.borderColor = 'var(--line)';
    dropZone.style.background = 'var(--section)';
  });
  districtsField.addEventListener('drop', async (e) => {
    stopDrag(e);
    dropZone.style.borderColor = 'var(--line)';
    dropZone.style.background = 'var(--section)';
    const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
    await readDistrictsFile(file);
  });

  /* ---------------- 4. Standard czasu dojścia ---------------- */

  const seg = h(
    'div',
    { class: 'seg' },
    ...STANDARDS.map((option) =>
      h(
        'button',
        {
          class: `seg__btn${project.standardMinutes === option.minutes ? ' is-on' : ''}`,
          onclick: async () => {
            if (project.standardMinutes === option.minutes) return;
            project.standardMinutes = option.minutes;
            await save();
            toast(`Standard ${option.label} · promień ${fmtNum(coverageRadiusM(option.minutes), 0)} m.`);
          },
        },
        option.label
      )
    )
  );

  const standardField = field(
    'Standard czasu dojścia',
    h(
      'div',
      { class: 'field__row' },
      seg,
      h('span', { class: 'muted num', text: `promień strefy: ${fmtNum(radiusM, 0)} m` })
    ),
    hint(
      `Świadek biegnie po AED i wraca — ${fmtMin(project.standardMinutes, 0)} liczymy w jedną stronę ` +
        `(100 m/min, korekta trasy 1,35).`
    )
  );

  /* ---------------- 5. Import punktów AED ---------------- */

  const addImportedPoints = async (items, format) => {
    let added = 0;
    for (const item of items) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      const presetId = getPreset(item.presetId) ? item.presetId : 'P1';
      const point = makePoint({
        id: nextId('AED'),
        name: item.name || `AED z importu (${format})`,
        lat: item.lat,
        lon: item.lon,
        presetId,
        districtId: districtAt(item.lat, item.lon),
        kind: 'existing',
      });
      point.address = item.address || '';
      point.verification = { date: null, by: null, source: 'import' };
      upsertPoint(point);
      added += 1;
    }

    if (!added) {
      toast('Nie znaleziono poprawnych punktów (wymagane lat i lon).');
      return;
    }
    importInfo = { count: added, format };
    await save();
    toast(`Zaimportowano ${fmtNum(added)} punktów AED (${format}).`);
  };

  const importCsvBtn = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        const file = await pickFile('.csv,text/csv');
        if (!file) return;
        try {
          await addImportedPoints(parsePointsCsv(await file.text()), 'CSV');
        } catch (err) {
          console.error(err);
          toast('Nie udało się odczytać pliku CSV.');
        }
      },
    },
    'CSV'
  );

  const importGeoJsonBtn = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        const file = await pickFile('.geojson,.json,application/geo+json,application/json');
        if (!file) return;
        try {
          await addImportedPoints(parsePointsGeoJson(await file.text()), 'GeoJSON');
        } catch (err) {
          console.error(err);
          toast('Plik nie jest poprawnym GeoJSON-em.');
        }
      },
    },
    'GeoJSON'
  );

  const importOsmBtn = disabledControl(
    h('button', { class: 'btn' }, 'OSM (Overpass)'),
    'poza zakresem iteracji 2'
  );

  const importField = field(
    'Import punktów AED',
    h('div', { class: 'field__row' }, importCsvBtn, importGeoJsonBtn, importOsmBtn),
    hint('CSV: nazwa;adres;lat;lon;preset · GeoJSON: FeatureCollection z geometriami Point.'),
    importInfo
      ? hint(`✓ Ostatni import: ${fmtNum(importInfo.count)} punktów (${importInfo.format}).`)
      : hint(`W projekcie jest teraz ${fmtNum(analysis.activeCount)} punktów AED.`)
  );

  /* ---------------- CTA ---------------- */

  const cta = h(
    'button',
    {
      class: 'btn btn--primary btn--block',
      onclick: async () => {
        markStepDone(0);
        await save();
        ctx.navigate('#/inventory');
      },
    },
    'UTWÓRZ PROJEKT → KROK 1'
  );

  /* ---------------- Kolumna formularza ---------------- */

  const formColumn = h(
    'div',
    {
      class: 'form-col',
      style: {
        overflowY: 'auto',
        padding: '20px',
        background: 'var(--white)',
        borderRight: '1px solid var(--line)',
      },
    },
    h(
      'div',
      { class: 'form' },
      nameField,
      boundaryField,
      districtsField,
      standardField,
      importField,
      h('div', { class: 'divider' }),
      cta,
      h('p', {
        class: 'note',
        text:
          'Dane wejściowe są zapisywane od razu — krok 1 pracuje już na nich. ' +
          'Pobieranie z PRG/GUS/OSM po sieci to iteracja 3; tutaj dane pochodzą z plików projektu.',
      })
    )
  );

  /* ---------------- Kolumna mapy + podsumowanie ---------------- */

  const mapEl = h('div', { class: 'map-wrap' });

  const summary = h(
    'div',
    {
      style: {
        borderTop: '1px solid var(--line)',
        background: 'var(--white)',
        padding: '12px 16px',
      },
    },
    h('span', { class: 'label-caps', text: 'Podsumowanie danych' }),
    h('div', {
      class: 'num',
      style: { fontSize: '17px', fontWeight: '700', marginTop: '4px' },
      text: `${fmtNum(analysis.activeCount)} AED · ${fmtNum(districts.length)} dzielnic · ${fmtNum(
        project.population || 0
      )} mieszkańców`,
    }),
    h('div', {
      class: 'note',
      text: `Standard ${fmtMin(project.standardMinutes, 0)} · promień strefy ${fmtNum(
        analysis.radiusM,
        0
      )} m · ${fmtNum(state.demandPoints.length)} punktów popytu w modelu.`,
    })
  );

  const mapColumn = h(
    'div',
    { style: { flex: '1', display: 'flex', flexDirection: 'column', minWidth: '0' } },
    mapEl,
    summary
  );

  mount(root, formColumn, mapColumn);

  /* ---------------- Mapa (granica, dzielnice, piny istniejące) ---------------- */

  if (map) {
    map.destroy();
    map = null;
  }

  map = createMap(mapEl, {
    center: project.center || undefined,
    zoom: project.zoom || undefined,
  });

  map.on('pointclick', (pin) => {
    const point = getPoint(pin.id);
    if (!point) return;
    toast(`${point.name} · ${districtName(point.districtId)}`);
  });

  mapEl.appendChild(
    h(
      'div',
      { class: 'map-legend' },
      h('b', { text: 'Punkty AED' }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('ok')}<span>komplet danych</span>` }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('warn')}<span>braki w karcie</span>` }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('crit')}<span>niezweryfikowany</span>` })
    )
  );

  refreshMapPreview();
}

/** Podgląd: granica + dzielnice + piny istniejących punktów (bez stref i popytu). */
function refreshMapPreview() {
  if (!map || !state.project) return;

  const pins = state.points
    .filter((p) => p.kind === 'existing' && p.status !== 'rejected')
    .map((p) => {
      const pct = completeness(p, getPreset(p.presetId), state.photos).pct;
      return {
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        level: pointStatusLevel(p, pct),
        name: p.name,
        draggable: false,
      };
    });

  const labels = ((state.districtsGeo && state.districtsGeo.features) || []).map((feature) => {
    const centre = ringCentroid(feature.geometry.coordinates[0]);
    return { lat: centre.lat, lon: centre.lon, text: feature.properties.name, kind: 'district' };
  });

  map.setScene({
    boundary: state.boundary,
    districts: state.districtsGeo,
    showDistricts: true,
    coverage: [],
    showCoverage: false,
    demand: [],
    showDemand: false,
    targetMinutes: state.project.standardMinutes,
    points: pins,
    labels,
    selectedId: null,
  });
  map.fit();
}

export function destroy() {
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
    if (boundaryStatus === 'loading') boundaryStatus = 'idle';
  }
  if (map) {
    try {
      map.destroy();
    } catch (err) {
      console.warn('map.destroy() failed', err);
    }
    map = null;
  }
}
