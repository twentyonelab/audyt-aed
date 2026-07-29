/**
 * views/inventory.js — Krok 1: Inwentaryzacja (SPEC §6.2, trasa '#/inventory').
 *
 * Mapa (lewa, ~65%) + panel „Rejestr punktów" (prawa, 480 px).
 * Mapa pokazuje granicę, dzielnice, etykiety dzielnic i piny wszystkich punktów.
 * Stref pokrycia i punktów popytu tu nie ma — to krok 2 (SPEC §6.3).
 *
 * Wszystkie liczby pochodzą z model.js (completeness, pointStatusLevel) i są
 * formatowane wyłącznie przez fmtNum/fmtPct/fmtCost.
 */

import {
  state,
  save,
  getPreset,
  districtName,
  upsertPoint,
  removePoint,
  nextId,
  makePoint,
  districtAt,
  markStepDone,
} from '../state.js';

import {
  completeness,
  pointStatusLevel,
  ringCentroid,
  fmtNum,
  fmtPct,
  fmtCost,
} from '../model.js';

import {
  h,
  mount,
  escapeHtml,
  dotHtml,
  statusMeta,
  toast,
  modal,
  disabledControl,
  download,
  pickFile,
  toCsv,
  parseCsv,
} from '../ui.js';

import { createMap } from '../map.js';
import { TODAY } from '../../config.js';

export const meta = {
  step: 1,
  title: 'Inwentaryzacja',
  subtitle: 'jak jest',
  layout: 'split',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/** Kolumny wymiany CSV (import i eksport używają tego samego kontraktu). */
const CSV_HEADERS = [
  'id',
  'nazwa',
  'adres',
  'dzielnica',
  'preset',
  'lat',
  'lon',
  'dostep247',
  'oznakowanie_dojscia',
  'przeglad',
  'status',
];

const EXISTING_STATUSES = ['unverified', 'verified_ok', 'verified_gaps'];

const FILTERS = [
  { id: 'all', label: 'Wszystkie', test: () => true },
  { id: '247', label: '24/7', test: (row) => row.point.access && row.point.access.always === true },
  { id: 'gaps', label: 'z brakami', test: (row) => row.level === 'warn' },
  { id: 'unverified', label: 'niezweryfikowane', test: (row) => row.point.status === 'unverified' },
];

const REASON_OUT_OF_SCOPE = 'poza zakresem iteracji 2';

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (nie są to dane projektu)
 * ------------------------------------------------------------------ */

let map = null;
let addMode = false;
let movingPointId = null;
let keyHandler = null;
let outsideHandler = null;
let openMenuEl = null;

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy — brakujące rzeczy są tutaj)
 * ------------------------------------------------------------------ */

function field(labelText, ...children) {
  return h('div', { class: 'field' }, h('span', { class: 'field__label', text: labelText }), ...children);
}

/** Polska odmiana rzeczownika po liczebniku. */
function plural(n, [one, few, many]) {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const rest100 = abs % 100;
  const rest10 = abs % 10;
  if (rest100 > 10 && rest100 < 20) return many;
  return rest10 >= 2 && rest10 <= 4 ? few : many;
}

/** '2026-07-12' → '12.07.2026' */
function fmtDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value || '');
}

/** '2027-05' → '05.2027' */
function fmtYearMonth(value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[2]}.${m[1]}` : String(value || '');
}

function isOverdueMonth(yearMonth) {
  if (!yearMonth) return false;
  return String(yearMonth).slice(0, 7) < String(TODAY).slice(0, 7);
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function toFloat(value) {
  const num = parseFloat(String(value || '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(num) ? num : NaN;
}

/** 'tak' | 'nie' | '' → true | false | null */
function parseBool(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (['tak', 'yes', 'true', '1', 'y', 't'].includes(s)) return true;
  if (['nie', 'no', 'false', '0', 'n'].includes(s)) return false;
  return null;
}

function boolToCsv(value) {
  return value === true ? 'tak' : value === false ? 'nie' : '';
}

/** Poziom znacznika stanu w mini-karcie: 'ok' | 'warn' | 'crit' | 'none'. */
function flagLevel(value, { falseLevel = 'warn' } = {}) {
  if (value === true) return 'ok';
  if (value === false) return falseLevel;
  return 'none';
}

/** Dzielnica z kolumny CSV (po id albo nazwie), w ostateczności z geometrii. */
function resolveDistrict(value, lat, lon) {
  const s = String(value || '').trim().toLowerCase();
  if (s) {
    const list = (state.project && state.project.districts) || [];
    const found =
      list.find((d) => String(d.id).toLowerCase() === s) ||
      list.find((d) => String(d.name).toLowerCase() === s);
    if (found) return found.id;
  }
  return districtAt(lat, lon);
}

/* ------------------------------------------------------------------ *
 * Menu wiersza „⋯"
 * ------------------------------------------------------------------ */

function closeRowMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
  if (outsideHandler) {
    document.removeEventListener('mousedown', outsideHandler, true);
    outsideHandler = null;
  }
}

function openRowMenu(anchor, items) {
  closeRowMenu();
  const menu = h(
    'div',
    {
      class: 'card',
      style: {
        position: 'absolute',
        right: '0',
        top: 'calc(100% + 4px)',
        zIndex: '20',
        padding: '4px',
        minWidth: '176px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
    },
    ...items
  );
  anchor.appendChild(menu);
  openMenuEl = menu;
  outsideHandler = (e) => {
    if (!anchor.contains(e.target)) closeRowMenu();
  };
  document.addEventListener('mousedown', outsideHandler, true);
}

function menuItem(label, onclick, { danger = false } = {}) {
  return h(
    'button',
    {
      class: `btn btn--sm btn--ghost${danger ? ' btn--danger' : ''}`,
      style: { justifyContent: 'flex-start', width: '100%' },
      onclick,
    },
    label
  );
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  cleanup();

  const project = state.project;
  if (!project) {
    mount(root, h('div', { class: 'empty-state', text: 'Brak aktywnego projektu — wróć do pulpitu i otwórz audyt.' }));
    return;
  }

  /* ---------------- dane wiersza rejestru (liczby z modelu) ---------------- */

  const decorate = (point) => {
    const preset = getPreset(point.presetId);
    const pct = completeness(point, preset, state.photos).pct;
    return { point, preset, pct, level: pointStatusLevel(point, pct), status: statusMeta(point, pct) };
  };

  const registry = state.points
    .filter((p) => p.kind === 'existing')
    .map(decorate)
    .sort((a, b) => String(a.point.name).localeCompare(String(b.point.name), 'pl'));

  const proposedRows = state.points.filter((p) => p.kind === 'proposed' && p.status !== 'rejected').map(decorate);

  // Counter reports the AUDIT status (was the point verified in the field),
  // which is a different question from the pin colour — that one follows card
  // completeness (SPEC §5). Both are specified, so both are shown.
  const counts = {
    total: registry.length,
    ok: registry.filter((r) => r.point.status === 'verified_ok').length,
    warn: registry.filter((r) => r.point.status === 'verified_gaps').length,
    crit: registry.filter((r) => r.point.status === 'unverified').length,
  };

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(counts.total)} ${plural(counts.total, ['punkt', 'punkty', 'punktów'])}: ` +
        `${fmtNum(counts.ok)} ✓ · ${fmtNum(counts.warn)} ! · ${fmtNum(counts.crit)} ?`
    );
  }

  /* ---------------- szkielet: mapa + panel ---------------- */

  const mapEl = h('div', { class: 'map-wrap' });
  const panelBody = h('div', { class: 'panel__body' });

  const panel = h(
    'aside',
    { class: 'panel panel--side' },
    h(
      'div',
      { class: 'panel__head' },
      h('h3', { text: 'Rejestr punktów' }),
      h('span', {
        class: 'label-caps num',
        text: `${fmtNum(counts.total)} ${plural(counts.total, ['pozycja', 'pozycje', 'pozycji'])}`,
      })
    ),
    panelBody,
    h('div', { class: 'panel__foot' }, importBtn(), exportBtn())
  );

  mount(root, mapEl, panel);

  /* ---------------- mapa ---------------- */

  map = createMap(mapEl, { center: project.center || undefined, zoom: project.zoom || undefined });

  const hint = h('div', {
    class: 'map-hint',
    style: { display: 'none' },
    text: 'Kliknij na mapie, aby dodać punkt · Esc anuluje',
  });

  const addBtn = h('button', { class: 'btn btn--sm' }, '+ DODAJ PUNKT');
  const fitBtn = h('button', { class: 'btn btn--sm', onclick: () => map && map.fit() }, 'DOPASUJ WIDOK');

  mapEl.appendChild(h('div', { class: 'map-toolbar' }, addBtn, fitBtn));
  mapEl.appendChild(hint);
  mapEl.appendChild(legend(proposedRows.length));

  /* Klik w puste miejsce mapy proponuje dodanie punktu — bez wcześniejszego
     uzbrajania trybu. Pasek jest odrzucalny, więc przypadkowy klik nic nie psuje. */
  const clickPrompt = h('div', {
    class: 'card',
    style: {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: '16px',
      zIndex: '8',
      display: 'none',
      padding: '8px 10px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
    },
  });
  mapEl.appendChild(clickPrompt);

  const hideClickPrompt = () => {
    clickPrompt.style.display = 'none';
    mount(clickPrompt);
  };

  /* mini-karta punktu — własny popup w rogu kontenera mapy */
  const popup = h('div', {
    class: 'card map-popup',
    style: {
      position: 'absolute',
      right: '12px',
      top: '104px',
      zIndex: '7',
      width: '268px',
      display: 'none',
    },
  });
  mapEl.appendChild(popup);

  const hidePopup = () => {
    popup.style.display = 'none';
    mount(popup);
  };

  const showPopup = (row) => {
    const { point, preset, pct } = row;
    const access = point.access || {};
    const signage = point.signage || {};
    const device = point.device || {};

    const accessText =
      access.always === true
        ? 'Dostępny całodobowo (24/7)'
        : access.always === false
        ? `Dostępny w godzinach${access.hours ? `: ${access.hours}` : ''}`
        : 'Dostępność 24/7 — brak danych';

    const routeText =
      signage.route === true
        ? 'Dojście oznakowane (ILCOR)'
        : signage.route === false
        ? 'Dojście nieoznakowane'
        : 'Oznakowanie dojścia — brak danych';

    const overdue = isOverdueMonth(device.inspectionDue);
    const inspectionText = !device.inspectionDue
      ? 'Przegląd — brak daty'
      : overdue
      ? `Przegląd przeterminowany (${fmtYearMonth(device.inspectionDue)})`
      : `Przegląd ważny do ${fmtYearMonth(device.inspectionDue)}`;

    mount(
      popup,
      h(
        'div',
        { class: 'row', style: { alignItems: 'flex-start' } },
        h('h4', { style: { flex: '1' }, text: point.name }),
        h('button', { class: 'btn btn--sm btn--ghost', title: 'Zamknij mini-kartę', onclick: hidePopup }, '✕')
      ),
      h(
        'div',
        { class: 'map-popup__meta' },
        h('div', { text: `${point.address || 'brak adresu'} · ${districtName(point.districtId)}` }),
        h('div', {
          text: `${
            preset ? `${preset.id} — ${preset.name} · ${fmtCost(preset.cost)}` : 'brak presetu'
          } · karta ${fmtPct(pct)}`,
        })
      ),
      h(
        'div',
        { class: 'map-popup__flags' },
        h('div', {
          class: 'map-popup__flag',
          html: `${dotHtml(flagLevel(access.always))}<span>${escapeHtml(accessText)}</span>`,
        }),
        h('div', {
          class: 'map-popup__flag',
          html: `${dotHtml(flagLevel(signage.route))}<span>${escapeHtml(routeText)}</span>`,
        }),
        h('div', {
          class: 'map-popup__flag',
          html: `${dotHtml(
            !device.inspectionDue ? 'none' : overdue ? 'crit' : 'ok'
          )}<span>${escapeHtml(inspectionText)}</span>`,
        })
      ),
      h(
        'div',
        { class: 'row', style: { gap: '6px' } },
        h(
          'button',
          {
            class: 'btn btn--sm',
            style: { flex: '1' },
            title: 'Włącz przeciąganie tego pinu po mapie',
            onclick: () => startMoving(point),
          },
          '✥ PRZESUŃ'
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--primary',
            style: { flex: '1' },
            onclick: () => ctx.navigate(`#/card/${point.id}`),
          },
          'KARTA →'
        )
      )
    );
    popup.style.display = '';
  };

  /* ---------------- tryb dodawania punktu ---------------- */

  const paintAddMode = () => {
    hint.style.display = addMode ? '' : 'none';
    addBtn.className = addMode ? 'btn btn--sm btn--primary' : 'btn btn--sm';
    addBtn.textContent = addMode ? '✕ ANULUJ DODAWANIE' : '+ DODAJ PUNKT';
    if (map) map.setAddMode(addMode);
  };

  const exitAddMode = () => {
    if (!addMode) return;
    addMode = false;
    paintAddMode();
  };

  addBtn.addEventListener('click', () => {
    addMode = !addMode;
    paintAddMode();
    if (addMode) hidePopup();
  });

  keyHandler = (e) => {
    if (e.key !== 'Escape') return;
    if (movingPointId) {
      stopMoving();
      toast('Przesuwanie punktu anulowane.');
      return;
    }
    if (clickPrompt.style.display !== 'none') {
      hideClickPrompt();
      return;
    }
    if (addMode) {
      exitAddMode();
      toast('Tryb dodawania punktu wyłączony.');
      return;
    }
    if (popup.style.display !== 'none') hidePopup();
  };
  document.addEventListener('keydown', keyHandler);

  /* ---------------- zdarzenia mapy ---------------- */

  map.on('pointclick', (pin) => {
    const row = [...registry, ...proposedRows].find((r) => r.point.id === pin.id);
    if (!row) return;
    selectPoint(row, { fly: false });
  });

  map.on('mapclick', async ({ lat, lon, addMode: fromMap }) => {
    if (addMode || fromMap) {
      exitAddMode();
      hideClickPrompt();
      await promptNewPoint(lat, lon);
      return;
    }
    if (movingPointId) return; // trwa przesuwanie — klik nie dodaje punktu
    showClickPrompt(lat, lon);
  });

  /** Pasek „dodaj punkt tutaj" po kliknięciu w puste miejsce mapy. */
  function showClickPrompt(lat, lon) {
    hidePopup();
    mount(
      clickPrompt,
      h(
        'div',
        { class: 'row', style: { gap: '10px' } },
        h('span', {
          class: 'num',
          style: { fontSize: '12px' },
          text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        }),
        h(
          'button',
          {
            class: 'btn btn--sm btn--primary',
            onclick: async () => {
              hideClickPrompt();
              await promptNewPoint(lat, lon);
            },
          },
          '+ Dodaj punkt tutaj'
        ),
        h('button', { class: 'btn btn--sm btn--ghost', title: 'Zamknij', onclick: hideClickPrompt }, '✕')
      )
    );
    clickPrompt.style.display = '';
  }

  /* ---------------- przesuwanie istniejącego punktu ---------------- */

  /** Uzbraja przeciąganie dla jednego punktu — reszta pinów zostaje nieruchoma. */
  function startMoving(point) {
    movingPointId = point.id;
    hidePopup();
    hideClickPrompt();
    exitAddMode();
    hint.textContent = `Przeciągnij pin „${point.name}" w nowe miejsce · Esc anuluje`;
    hint.style.display = '';
    repaintPins();
  }

  function stopMoving() {
    if (!movingPointId) return;
    movingPointId = null;
    hint.textContent = 'Kliknij na mapie, aby dodać punkt · Esc anuluje';
    hint.style.display = 'none';
    repaintPins();
  }

  map.on('pointdragend', async ({ id, lat, lon }) => {
    const point = state.points.find((p) => p.id === id);
    if (!point) return;
    point.lat = Math.round(lat * 1e6) / 1e6;
    point.lon = Math.round(lon * 1e6) / 1e6;
    const district = districtAt(point.lat, point.lon);
    const movedOut = district !== point.districtId;
    point.districtId = district;
    upsertPoint(point);
    movingPointId = null;
    toast(
      movedOut
        ? `Przesunięto „${point.name}" — nowa dzielnica: ${districtName(district)}.`
        : `Przesunięto „${point.name}".`
    );
    await save();
  });

  /* ---------------- zaznaczenie punktu ---------------- */

  function selectPoint(row, { fly = true } = {}) {
    state.ui.selectedPointId = row.point.id;
    if (map) {
      map.setScene({ selectedId: row.point.id });
      if (fly) map.flyTo(row.point.lat, row.point.lon);
    }
    showPopup(row);
    paintRows();
    // zaznaczenie to stan interfejsu — zapisujemy je bez przerysowania widoku
    save({ silent: true });
  }

  /* ---------------- panel: chipy filtrów + lista ---------------- */

  const filterOf = () => {
    const value = state.ui.inventoryFilter || 'all';
    if (String(value).startsWith('district:')) return { kind: 'district', districtId: String(value).slice(9) };
    const found = FILTERS.find((f) => f.id === value);
    return { kind: found ? found.id : 'all' };
  };

  const setFilter = (value) => {
    state.ui.inventoryFilter = value;
    refreshPanel();
    // filtr to stan interfejsu — zapis bez przerysowania (mapa zostaje na miejscu)
    save({ silent: true });
  };

  const visibleRows = () => {
    const current = filterOf();
    if (current.kind === 'district') return registry.filter((r) => r.point.districtId === current.districtId);
    const found = FILTERS.find((f) => f.id === current.kind) || FILTERS[0];
    return registry.filter(found.test);
  };

  function chipsEl() {
    const current = filterOf();
    const districts = (project.districts || []).filter((d) =>
      registry.some((r) => r.point.districtId === d.id)
    );

    const select = h(
      'select',
      {
        class: 'select',
        style: { width: 'auto', padding: '3px 8px', fontSize: '12px' },
        onchange: (e) => setFilter(e.target.value ? `district:${e.target.value}` : 'all'),
      },
      h('option', { value: '' }, 'dzielnica…'),
      ...districts.map((d) => {
        const n = registry.filter((r) => r.point.districtId === d.id).length;
        return h('option', { value: d.id }, `${d.name} (${fmtNum(n)})`);
      })
    );
    select.value = current.kind === 'district' ? current.districtId : '';

    return h(
      'div',
      { class: 'chips', style: { marginBottom: '10px' } },
      ...FILTERS.map((f) => {
        const n = registry.filter(f.test).length;
        return h(
          'button',
          {
            class: `chip${current.kind === f.id ? ' is-on' : ''}`,
            onclick: () => setFilter(f.id),
          },
          `${f.label} (${fmtNum(n)})`
        );
      }),
      select
    );
  }

  function rowEl(row) {
    const { point, preset, pct, level, status } = row;
    const selected = state.ui.selectedPointId === point.id;

    const menuAnchor = h('div', { style: { position: 'relative', flex: 'none' } });
    const menuBtn = h(
      'button',
      {
        class: 'btn btn--sm btn--ghost',
        title: 'Akcje punktu',
        onclick: (e) => {
          e.stopPropagation();
          if (openMenuEl && menuAnchor.contains(openMenuEl)) {
            closeRowMenu();
            return;
          }
          openRowMenu(menuAnchor, [
            menuItem('Otwórz kartę', () => {
              closeRowMenu();
              ctx.navigate(`#/card/${point.id}`);
            }),
            disabledControl(
              h('button', { class: 'btn btn--sm btn--ghost', style: { justifyContent: 'flex-start', width: '100%' } }, 'Duplikuj'),
              REASON_OUT_OF_SCOPE
            ),
            menuItem(
              'Usuń punkt',
              async () => {
                closeRowMenu();
                await confirmRemove(row);
              },
              { danger: true }
            ),
          ]);
        },
      },
      '⋯'
    );
    menuAnchor.appendChild(menuBtn);

    const verifiedAt = point.verification && point.verification.date;
    let verificationLine;
    if (verifiedAt) {
      verificationLine = h('div', {
        class: 'list-row__meta num',
        text: `zweryfikowano ${fmtDate(verifiedAt)}${
          point.verification.by ? ` · ${point.verification.by}` : ''
        } · karta ${fmtPct(pct)}`,
      });
    } else if (point.status === 'unverified') {
      verificationLine = h('div', {
        class: 'list-row__meta',
        html: `<span class="is-crit">${escapeHtml(status.label)}</span> · karta ${escapeHtml(fmtPct(pct))}`,
      });
    } else {
      verificationLine = h('div', {
        class: 'list-row__meta',
        text: `brak daty weryfikacji · karta ${fmtPct(pct)}`,
      });
    }

    const node = h(
      'div',
      {
        class: 'list-row',
        style: selected ? { background: 'var(--panel)' } : null,
        onclick: () => selectPoint(row),
      },
      h('span', { style: { marginTop: '5px', flex: 'none' }, html: dotHtml(level) }),
      h(
        'div',
        { class: 'list-row__body' },
        h('div', { class: 'list-row__title', text: point.name }),
        h('div', {
          class: 'list-row__meta',
          text: `${point.presetId || 'bez presetu'} · ${districtName(point.districtId)} · ${
            point.address || 'brak adresu'
          }`,
        }),
        verificationLine
      ),
      menuAnchor
    );
    return node;
  }

  const listEl = h('div');

  function paintRows() {
    const rows = visibleRows();
    if (!rows.length) {
      mount(
        listEl,
        h('div', {
          class: 'empty-state',
          text: 'Żaden punkt nie pasuje do wybranego filtra. Zmień filtr albo dodaj punkt na mapie.',
        })
      );
      return;
    }
    mount(listEl, ...rows.map(rowEl));
  }

  function refreshPanel() {
    closeRowMenu();
    paintRows();
    mount(
      panelBody,
      chipsEl(),
      listEl,
      h('p', {
        class: 'note',
        style: { marginTop: '12px' },
        text:
          'Kropka pokazuje stan karty liczony z presetu: zielona — komplet danych i zdjęć, ' +
          'żółta — braki, czerwona — punkt niezweryfikowany. Kliknięcie wiersza centruje mapę.',
      })
    );
  }

  refreshPanel();

  /* ---------------- scena mapy ---------------- */

  /** Piny sceny. Przeciągalny jest wyłącznie punkt uzbrojony przez „Przesuń punkt". */
  function buildPins() {
    return [...registry, ...proposedRows].map((r) => ({
      id: r.point.id,
      lat: r.point.lat,
      lon: r.point.lon,
      level: r.level,
      name: r.point.name,
      draggable: r.point.id === movingPointId,
    }));
  }

  /** Przerysowuje same piny — bez odtwarzania całej sceny i bez utraty kadru. */
  function repaintPins() {
    if (map) map.setScene({ points: buildPins() });
  }

  const pins = buildPins();

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
    targetMinutes: project.standardMinutes,
    points: pins,
    labels,
    selectedId: state.ui.selectedPointId,
  });
  map.fit();
  paintAddMode();

  const selectedRow = [...registry, ...proposedRows].find((r) => r.point.id === state.ui.selectedPointId);
  if (selectedRow) showPopup(selectedRow);

  /* ---------------- dodanie punktu ---------------- */

  async function promptNewPoint(lat, lon) {
    const districtId = districtAt(lat, lon);
    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'np. Szkoła Podstawowa nr 1 — hol główny',
    });
    const presetSelect = h(
      'select',
      { class: 'select' },
      ...state.presets.map((p) => h('option', { value: p.id }, `${p.id} — ${p.name} · ${fmtCost(p.cost)}`))
    );
    const addressInput = h('input', { class: 'input', type: 'text', placeholder: 'np. ul. Szkolna 3' });

    const body = h(
      'div',
      { class: 'form', style: { maxWidth: 'none' } },
      field('Nazwa punktu', nameInput),
      field('Preset', presetSelect),
      field('Adres', addressInput),
      h('p', {
        class: 'note',
        text:
          `Współrzędne: ${fmtNum(lat, 5)} N · ${fmtNum(lon, 5)} E · dzielnica: ${districtName(districtId)}. ` +
          'Punkt trafi do rejestru ze statusem NIEZWERYFIKOWANY — resztę danych uzupełnisz w karcie (krok 3).',
      })
    );

    const confirmed = await modal({
      title: 'Nowy punkt AED',
      body,
      confirmLabel: 'DODAJ DO REJESTRU',
      cancelLabel: 'Anuluj',
    });

    if (!confirmed) {
      toast('Dodawanie punktu anulowane.');
      return;
    }

    const point = makePoint({
      id: nextId('AED'),
      name: nameInput.value.trim() || 'Nowy punkt AED',
      lat,
      lon,
      presetId: presetSelect.value || 'P1',
      districtId,
      kind: 'existing',
    });
    point.address = addressInput.value.trim();
    point.status = 'unverified';
    point.verification = { date: null, by: null, source: 'operator' };

    upsertPoint(point);
    state.ui.selectedPointId = point.id;
    markStepDone(1);
    await save();
    toast(`Dodano punkt ${point.id} — ${point.name}.`);
  }

  /* ---------------- usunięcie punktu ---------------- */

  async function confirmRemove(row) {
    const { point } = row;
    const confirmed = await modal({
      title: 'Usunąć punkt z rejestru?',
      body:
        `<p>${escapeHtml(point.name)} (${escapeHtml(point.id)}), ${escapeHtml(districtName(point.districtId))}.</p>` +
        '<p class="note">Razem z punktem znikną jego rekomendacje i zdjęcia. Operacji nie można cofnąć.</p>',
      confirmLabel: 'USUŃ PUNKT',
      cancelLabel: 'Anuluj',
    });
    if (!confirmed) return;

    removePoint(point.id);
    if (state.ui.selectedPointId === point.id) state.ui.selectedPointId = null;
    await save();
    toast(`Usunięto punkt ${point.id}.`);
  }

  /* ---------------- CSV: eksport ---------------- */

  function exportBtn() {
    return h(
      'button',
      {
        class: 'btn btn--block',
        onclick: () => {
          const rows = registry.map(({ point }) => [
            point.id,
            point.name,
            point.address || '',
            districtName(point.districtId),
            point.presetId || '',
            Number.isFinite(point.lat) ? fmtNum(point.lat, 6) : '',
            Number.isFinite(point.lon) ? fmtNum(point.lon, 6) : '',
            boolToCsv(point.access ? point.access.always : null),
            boolToCsv(point.signage ? point.signage.route : null),
            (point.device && point.device.inspectionDue) || '',
            point.status,
          ]);
          download(
            `punkty-aed-${project.id}-${TODAY}.csv`,
            toCsv(CSV_HEADERS, rows),
            'text/csv;charset=utf-8'
          );
          toast(`Wyeksportowano ${fmtNum(rows.length)} ${plural(rows.length, ['punkt', 'punkty', 'punktów'])} do CSV.`);
        },
      },
      'EKSPORT CSV'
    );
  }

  /* ---------------- CSV: import ---------------- */

  function exportedColumnsNote() {
    return CSV_HEADERS.join(';');
  }

  function importBtn() {
    return h(
      'button',
      {
        class: 'btn btn--block',
        title: `Kolumny: ${exportedColumnsNote()}`,
        onclick: async () => {
          const file = await pickFile('.csv,text/csv');
          if (!file) return;
          try {
            const result = applyCsv(parseCsv(await file.text()));
            if (!result.added && !result.updated) {
              toast('Nie znaleziono wierszy z poprawnymi kolumnami lat i lon.');
              return;
            }
            markStepDone(1);
            await save();
            toast(
              `Import CSV: ${fmtNum(result.added)} nowych · ${fmtNum(result.updated)} zaktualizowanych` +
                (result.skipped ? ` · ${fmtNum(result.skipped)} pominiętych` : '')
            );
          } catch (err) {
            console.error(err);
            toast('Nie udało się odczytać pliku CSV.');
          }
        },
      },
      'IMPORT CSV'
    );
  }

  /** Wgranie wierszy CSV do state.points (aktualizacja po id albo nowy punkt). */
  function applyCsv(rows) {
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const lat = toFloat(pick(row, ['lat', 'latitude', 'szerokosc', 'szerokość', 'y']));
      const lon = toFloat(pick(row, ['lon', 'lng', 'longitude', 'dlugosc', 'długość', 'x']));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipped += 1;
        continue;
      }

      const id = pick(row, ['id']);
      const name = pick(row, ['nazwa', 'name', 'punkt', 'obiekt']);
      const address = pick(row, ['adres', 'address', 'ulica']);
      const presetRaw = pick(row, ['preset', 'presetid', 'preset_id']).toUpperCase();
      const presetId = getPreset(presetRaw) ? presetRaw : 'P1';
      const districtId = resolveDistrict(pick(row, ['dzielnica', 'district', 'districtid']), lat, lon);
      const always = parseBool(pick(row, ['dostep247', 'dostęp247', 'access247', '24/7']));
      const route = parseBool(pick(row, ['oznakowanie_dojscia', 'oznakowanie_dojścia', 'signage_route']));
      const inspection = pick(row, ['przeglad', 'przegląd', 'inspectiondue', 'przeglad_do']);
      const statusRaw = pick(row, ['status']).toLowerCase();
      const status = EXISTING_STATUSES.includes(statusRaw) ? statusRaw : null;

      const existing = id ? state.points.find((p) => p.id === id) : null;

      if (existing) {
        existing.name = name || existing.name;
        existing.address = address || existing.address;
        existing.districtId = districtId || existing.districtId;
        existing.presetId = presetId;
        existing.lat = lat;
        existing.lon = lon;
        // pusta komórka nie kasuje danych, które punkt już ma
        const prevAccess = existing.access || {};
        const prevSignage = existing.signage || {};
        const prevDevice = existing.device || {};
        existing.access = { ...prevAccess, always: always === null ? prevAccess.always ?? null : always };
        existing.signage = { ...prevSignage, route: route === null ? prevSignage.route ?? null : route };
        existing.device = { ...prevDevice, inspectionDue: inspection || prevDevice.inspectionDue || null };
        if (status) existing.status = status;
        upsertPoint(existing);
        updated += 1;
        continue;
      }

      const point = makePoint({
        id: id && !state.points.some((p) => p.id === id) ? id : nextId('AED'),
        name: name || 'Punkt AED z importu',
        lat,
        lon,
        presetId,
        districtId,
        kind: 'existing',
      });
      point.address = address;
      point.access = { ...point.access, always };
      point.signage = { ...point.signage, route };
      point.device = { ...point.device, inspectionDue: inspection || null };
      point.status = status || 'unverified';
      point.verification = { date: null, by: null, source: 'import' };
      upsertPoint(point);
      added += 1;
    }

    return { added, updated, skipped };
  }
}

/* ------------------------------------------------------------------ *
 * Legenda mapy — trzy statusy punktu (SPEC §6.2)
 * ------------------------------------------------------------------ */

function legend(proposedCount) {
  const node = h(
    'div',
    { class: 'map-legend' },
    h('b', { text: 'Status punktu' }),
    h('div', { class: 'map-legend__row', html: `${dotHtml('ok')}<span>zweryfikowany, komplet danych</span>` }),
    h('div', { class: 'map-legend__row', html: `${dotHtml('warn')}<span>braki w karcie</span>` }),
    h('div', { class: 'map-legend__row', html: `${dotHtml('crit')}<span>niezweryfikowany</span>` })
  );
  if (proposedCount > 0) {
    node.appendChild(
      h('div', {
        class: 'note',
        style: { marginTop: '4px' },
        text: `kwadraty — ${fmtNum(proposedCount)} propozycji z kroku 2`,
      })
    );
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Sprzątanie
 * ------------------------------------------------------------------ */

function cleanup() {
  closeRowMenu();
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  addMode = false;
  movingPointId = null;
  if (map) {
    try {
      map.destroy();
    } catch (err) {
      console.warn('map.destroy() failed', err);
    }
    map = null;
  }
}

export function destroy() {
  cleanup();
}
