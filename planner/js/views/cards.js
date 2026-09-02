/**
 * views/cards.js – Krok 3: Lista kart punktów (SPEC §6.4, trasa '#/cards').
 *
 * Jedna tabela pełnej szerokości ze wszystkimi kartami audytu: kompletność,
 * liczba rekomendacji i status każdego punktu obok siebie. Stąd operator wchodzi
 * w konkretną kartę (`#/card/:id`) – klikiem w wiersz albo przyciskiem OTWÓRZ.
 *
 * Wszystkie liczby pochodzą z modelu (`completeness`) i ze stanu
 * (`recommendationsForPoint`) – w HTML nie ma ani jednej wpisanej na sztywno.
 * Formatowanie wyłącznie przez fmtPct/fmtNum.
 *
 * Filtry przeliczają samo <tbody>, bez przerysowywania widoku – dlatego zmiana
 * filtra zapisuje się przez `save({ silent: true })` (zapis do IndexedDB bez
 * notify, które wywołałoby pełny render i zgubiło pozycję przewijania).
 * Danych projektu ten widok nie zmienia, więc nie ma tu zwykłego `save()`.
 */

import {
  state,
  save,
  getPreset,
  districtName,
  recommendationsForPoint,
} from '../state.js';

import { completeness, expertScore, fmtNum, fmtPct } from '../model.js';

import {
  h,
  mount,
  escapeHtml,
  barHtml,
  pillHtml,
  dotHtml,
  statusMeta,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  toast,
  disabledControl,
  download,
  toCsv,
} from '../ui.js';

import { TODAY } from '../../config.js';

export const meta = {
  step: 3,
  title: 'Karty punktów',
  subtitle: 'co zrobić',
  layout: 'scroll',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/** Kolumny eksportu CSV (wartości surowe – plik ma być czytany maszynowo). */
const CSV_HEADERS = [
  'id',
  'nazwa',
  'preset',
  'dzielnica',
  'kompletnosc_pct',
  'rekomendacje',
  'status',
];

/** Segmented control [Wszystkie | Istniejące | Nowe] – id trafia do state.ui.cardsFilter. */
const KIND_FILTERS = [
  { id: 'all', label: 'Wszystkie', test: () => true },
  { id: 'existing', label: 'Istniejące', test: (row) => row.point.kind === 'existing' },
  { id: 'proposed', label: 'Nowe', test: (row) => row.point.kind === 'proposed' },
];

const KIND_LABEL = { existing: 'istniejący', proposed: 'nowy' };

const SORTS = [
  { id: 'completeness', label: 'Sortuj: kompletność rosnąco' },
  { id: 'recommendations', label: 'Sortuj: rekomendacje malejąco' },
  { id: 'name', label: 'Sortuj: alfabetycznie (A–Z)' },
];

const PRIORITY_ORDER = { high: 3, medium: 2, low: 1 };

/** Progi paska kompletności. Kolor niesie wyłącznie informację o danych. */
const PCT_OK = 100;
const PCT_WARN = 60;

const REASON_FIELD_FORM = 'opcja poza MVP';

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (to nie są dane projektu – nie trafia do state)
 * ------------------------------------------------------------------ */

let presetFilter = 'all';
let districtFilter = 'all';
let onlyGaps = false;
let sortKey = SORTS[0].id;

/** Zaznaczone wiersze; zawsze przycinane do aktualnie widocznych. */
const selected = new Set();

/** Uchwyty DOM potrzebne do przerysowania samego <tbody>. */
let refs = null;

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy – brakujące rzeczy są tutaj)
 * ------------------------------------------------------------------ */

/** Polska odmiana rzeczownika po liczebniku. */
function plural(n, [one, few, many]) {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const rest100 = abs % 100;
  const rest10 = abs % 10;
  if (rest100 > 10 && rest100 < 20) return many;
  return rest10 >= 2 && rest10 <= 4 ? few : many;
}

/** Mianownik: „1 karta · 3 karty · 19 kart". */
const cards = (n) => plural(n, ['karta', 'karty', 'kart']);

/** Biernik po „wyeksportowano": „1 kartę · 3 karty · 19 kart". */
const cardsAcc = (n) => plural(n, ['kartę', 'karty', 'kart']);

function byName(a, b) {
  return String(a.point.name).localeCompare(String(b.point.name), 'pl');
}

function barVariant(pct) {
  if (pct >= PCT_OK) return 'ok';
  if (pct >= PCT_WARN) return 'warn';
  return 'crit';
}

/** Aktualny wariant segmentu – z odpornością na nieznaną wartość w stanie. */
function kindFilter() {
  const id = state.ui.cardsFilter;
  return KIND_FILTERS.some((f) => f.id === id) ? id : 'all';
}

/**
 * Wiersz tabeli policzony z modelu.
 *
 * Punkt bez presetu nie ma czego mierzyć – `completeness()` zwróciłoby dla
 * pustej listy wymagań 100%, co pokazywałoby niezweryfikowany punkt z OSM jako
 * komplet. Dlatego taki wiersz ma `pct === null` i jest wyłączony ze średniej.
 */
function decorate(point) {
  const preset = getPreset(point.presetId);
  const score = preset ? completeness(point, preset, state.photos) : null;
  const pct = score ? score.pct : null;
  const recs = recommendationsForPoint(point.id);
  const topPriority = recs.reduce(
    (best, rec) => ((PRIORITY_ORDER[rec.priority] || 0) > (PRIORITY_ORDER[best] || 0) ? rec.priority : best),
    null
  );
  return {
    point,
    preset,
    score,
    pct,
    recs,
    topPriority,
    doneCount: recs.filter((rec) => rec.done).length,
    status: statusMeta(point, pct),
    district: districtName(point.districtId),
  };
}

/** „Braki" = niepełna kompletność, brak presetu albo punkt niezweryfikowany. */
function hasGaps(row) {
  return row.pct === null || row.pct < PCT_OK || row.point.status === 'unverified';
}

function sortRows(rows) {
  const list = [...rows];
  if (sortKey === 'recommendations') {
    list.sort((a, b) => b.recs.length - a.recs.length || byName(a, b));
  } else if (sortKey === 'name') {
    list.sort(byName);
  } else {
    list.sort((a, b) => (a.pct === null ? -1 : a.pct) - (b.pct === null ? -1 : b.pct) || byName(a, b));
  }
  return list;
}

function filterRows(rows) {
  const kind = KIND_FILTERS.find((f) => f.id === kindFilter()) || KIND_FILTERS[0];
  return sortRows(
    rows.filter(
      (row) =>
        kind.test(row) &&
        (presetFilter === 'all' || row.point.presetId === presetFilter) &&
        (districtFilter === 'all' || row.point.districtId === districtFilter) &&
        (!onlyGaps || hasGaps(row))
    )
  );
}

function labelledSelect(ariaLabel, options, value, onPick) {
  const node = h(
    'select',
    {
      class: 'select',
      'aria-label': ariaLabel,
      style: { width: 'auto', minWidth: '150px' },
      onchange: (e) => onPick(e.target.value),
    },
    ...options.map((opt) => h('option', { value: opt.value }, opt.label))
  );
  node.value = value;
  return node;
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  refs = null;

  const project = state.project;
  if (!project) {
    mount(
      root,
      h('div', { class: 'empty-state', text: 'Brak aktywnego projektu – wróć do pulpitu i otwórz audyt.' })
    );
    return;
  }

  const allRows = state.points.map(decorate);

  if (!allRows.length) {
    mount(
      root,
      h(
        'div',
        { class: 'empty-state' },
        h('p', { text: 'Rejestr punktów jest pusty – nie ma jeszcze żadnej karty do uzupełnienia.' }),
        h('button', { class: 'btn', onclick: () => ctx.navigate('#/inventory') }, 'PRZEJDŹ DO INWENTARYZACJI')
      )
    );
    return;
  }

  const openCard = (id) => ctx.navigate(`#/card/${encodeURIComponent(id)}`);

  // Filtry przeżywają zmianę trasy, więc po podmianie danych (import, reset do
  // demo) mogą wskazywać nieistniejący preset lub dzielnicę – normalizujemy je,
  // żeby lista nigdy nie wyszła pusta bez widocznej przyczyny.
  if (presetFilter !== 'all' && !state.presets.some((p) => p.id === presetFilter)) presetFilter = 'all';
  if (districtFilter !== 'all' && !(project.districts || []).some((d) => d.id === districtFilter)) {
    districtFilter = 'all';
  }
  if (!SORTS.some((s) => s.id === sortKey)) sortKey = SORTS[0].id;

  /* ---------------- pasek filtrów ---------------- */

  const segButtons = KIND_FILTERS.map((f) =>
    h(
      'button',
      {
        class: `seg__btn${f.id === kindFilter() ? ' is-on' : ''}`,
        dataset: { kind: f.id },
        onclick: () => void applyKind(f.id),
      },
      f.label
    )
  );

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Zakres listy kart' }, ...segButtons);

  async function applyKind(id) {
    state.ui.cardsFilter = id;
    for (const btn of segButtons) btn.classList.toggle('is-on', btn.dataset.kind === id);
    redrawBody();
    await save({ silent: true });
  }

  const presetSelect = labelledSelect(
    'Filtr: preset',
    [
      { value: 'all', label: 'Preset: wszystkie' },
      ...state.presets.map((p) => ({ value: p.id, label: `${p.id} · ${p.name}` })),
    ],
    presetFilter,
    (value) => {
      presetFilter = value;
      redrawBody();
    }
  );

  const districtSelect = labelledSelect(
    'Filtr: dzielnica',
    [
      { value: 'all', label: 'Dzielnica: wszystkie' },
      ...(project.districts || []).map((d) => ({ value: d.id, label: d.name })),
    ],
    districtFilter,
    (value) => {
      districtFilter = value;
      redrawBody();
    }
  );

  const gapsInput = h('input', {
    type: 'checkbox',
    onchange: (e) => {
      onlyGaps = e.target.checked;
      redrawBody();
    },
  });
  gapsInput.checked = onlyGaps;

  const sortSelect = labelledSelect(
    'Sortowanie listy',
    SORTS.map((s) => ({ value: s.id, label: s.label })),
    sortKey,
    (value) => {
      sortKey = value;
      redrawBody();
    }
  );

  const resetBtn = h(
    'button',
    {
      class: 'btn btn--sm btn--ghost',
      title: 'Przywróć wszystkie filtry i sortowanie',
      onclick: () => void resetFilters(),
    },
    'Wyczyść filtry'
  );

  async function resetFilters() {
    presetFilter = 'all';
    districtFilter = 'all';
    onlyGaps = false;
    sortKey = SORTS[0].id;
    presetSelect.value = 'all';
    districtSelect.value = 'all';
    gapsInput.checked = false;
    sortSelect.value = sortKey;
    await applyKind('all');
  }

  const filterBar = h(
    'div',
    { class: 'row row--wrap', style: { marginBottom: '12px' } },
    seg,
    presetSelect,
    districtSelect,
    h('label', { class: 'checkline' }, gapsInput, h('span', { text: 'tylko z brakami' })),
    sortSelect,
    h('span', { class: 'spacer' }),
    resetBtn
  );

  /* ---------------- tabela ---------------- */

  const headSelect = h('input', {
    type: 'checkbox',
    'aria-label': 'Zaznacz wszystkie widoczne wiersze',
    title: 'Zaznacz wszystkie widoczne wiersze',
    onchange: (e) => setAllSelected(e.target.checked),
  });

  const tbody = h('tbody');

  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { style: { width: '34px' } }, headSelect),
        h('th', { text: 'Punkt' }),
        h('th', { style: { width: '190px' }, text: 'Preset' }),
        h('th', { style: { width: '176px' }, text: 'Kompletność' }),
        h('th', { style: { width: '150px' }, text: 'Rekomendacje' }),
        h('th', { style: { width: '76px' }, text: 'Ocena', title: 'Ocena ekspercka lokalizacji (sekcja 9 karty)' }),
        h('th', { style: { width: '150px' }, text: 'Status' }),
        h('th', { style: { width: '104px' } })
      )
    ),
    tbody
  );

  const tableWrap = h(
    'div',
    {
      style: {
        background: 'var(--white)',
        border: '1px solid var(--line)',
        borderRadius: '2px',
      },
    },
    table
  );

  /* ---------------- pasek akcji zbiorczych (przyklejony) ---------------- */

  const bulkSelect = h('input', {
    type: 'checkbox',
    onchange: (e) => setAllSelected(e.target.checked),
  });

  const counter = h('span', { class: 'muted num' });

  const exportBtn = h(
    'button',
    { class: 'btn', onclick: () => exportCsv() },
    'EKSPORT CSV'
  );

  const fieldFormBtn = disabledControl(
    h('button', { class: 'btn' }, 'WYŚLIJ FORMULARZ TERENOWY'),
    REASON_FIELD_FORM
  );

  const bulkBar = h(
    'div',
    {
      class: 'row',
      style: {
        position: 'sticky',
        bottom: '20px',
        zIndex: '6',
        margin: '12px -20px -20px',
        padding: '10px 20px',
        background: 'var(--white)',
        borderTop: '1px solid var(--line)',
      },
    },
    h('label', { class: 'checkline' }, bulkSelect, h('span', { text: 'zaznacz wszystkie' })),
    counter,
    h('span', { class: 'spacer' }),
    exportBtn,
    fieldFormBtn
  );

  /** Uchwyty tego przebiegu renderowania – domknięcie, nie zmienna globalna. */
  const view = { visible: [] };
  refs = view;

  mount(root, filterBar, tableWrap, bulkBar);
  redrawBody();

  /* ---------------- rysowanie <tbody> ---------------- */

  function redrawBody() {
    const visible = filterRows(allRows);
    view.visible = visible;

    // zaznaczenie dotyczy tylko widocznych wierszy – zmiana filtra je przycina
    const visibleIds = new Set(visible.map((row) => row.point.id));
    for (const id of [...selected]) if (!visibleIds.has(id)) selected.delete(id);

    if (!visible.length) {
      mount(
        tbody,
        h(
          'tr',
          {},
          h(
            'td',
            { colspan: '7' },
            h('div', {
              class: 'empty-state',
              text: 'Żadna karta nie pasuje do filtrów. Zmień zakres albo wyczyść filtry.',
            })
          )
        )
      );
    } else {
      mount(tbody, ...visible.map(rowNode));
    }

    updateBulk();
    updateSubbarMeta(visible);
  }

  function rowNode(row) {
    const { point } = row;

    const check = h('input', {
      type: 'checkbox',
      'aria-label': `Zaznacz kartę ${point.name}`,
      onchange: (e) => toggleSelected(point.id, e.target.checked),
    });
    check.checked = selected.has(point.id);

    const subParts = [KIND_LABEL[point.kind] || point.kind];
    if (point.address) subParts.push(point.address);
    if (point.districtId) subParts.push(row.district);

    const openBtn = h(
      'button',
      {
        class: 'btn btn--sm',
        onclick: (e) => {
          e.stopPropagation();
          openCard(point.id);
        },
      },
      'OTWÓRZ'
    );

    return h(
      'tr',
      {
        class: selected.has(point.id) ? 'is-selected' : '',
        style: { cursor: 'pointer' },
        dataset: { pointId: point.id },
        title: `Otwórz kartę ${point.id}`,
        onclick: () => openCard(point.id),
      },
      h('td', { onclick: (e) => e.stopPropagation() }, check),
      h(
        'td',
        {},
        h('div', {
          class: 'row',
          html: `${dotHtml(row.status.level)}<span class="table__main">${escapeHtml(point.name)}</span>`,
        }),
        h('div', { class: 'table__sub', text: subParts.join(' · ') })
      ),
      row.preset
        ? h(
            'td',
            {},
            h('div', { text: row.preset.name }),
            h('div', { class: 'table__sub', text: row.preset.id })
          )
        : h('td', { class: 'muted', text: '–' }),
      completenessCell(row),
      recommendationsCell(row),
      expertCell(row),
      h('td', { html: pillHtml(row.status.label, row.status.variant) }),
      h('td', { style: { textAlign: 'right' } }, openBtn)
    );
  }

  function expertCell(row) {
    const score = expertScore(row.point);
    if (!score) return h('td', { class: 'muted', title: 'lokalizacja nieoceniona', text: '–' });
    return h('td', {}, h('span', {
      class: `score-badge score-badge--${score.verdict.variant}`,
      title: score.verdict.label,
      text: fmtNum(score.value, 1),
    }));
  }

  function completenessCell(row) {
    if (row.pct === null) {
      return h(
        'td',
        {},
        h('div', { class: 'muted', text: '–' }),
        h('div', { class: 'table__sub', text: 'brak presetu – nie ma czego mierzyć' })
      );
    }
    return h(
      'td',
      {},
      h('div', { style: { marginBottom: '4px' }, html: barHtml(row.pct, barVariant(row.pct)) }),
      h('div', {
        class: 'table__sub num',
        text: `${fmtPct(row.pct)} · ${fmtNum(row.score.filled)}/${fmtNum(row.score.required)}`,
      })
    );
  }

  function recommendationsCell(row) {
    if (!row.recs.length) return h('td', { class: 'muted', text: '–' });
    return h(
      'td',
      {},
      h('div', {
        class: 'row',
        html:
          `<span class="num table__main">${escapeHtml(fmtNum(row.recs.length))}</span>` +
          pillHtml(PRIORITY_LABEL[row.topPriority] || row.topPriority, PRIORITY_VARIANT[row.topPriority] || ''),
      }),
      row.doneCount
        ? h('div', {
            class: 'table__sub',
            text: `${fmtNum(row.doneCount)} już ${plural(row.doneCount, ['zrobiona', 'zrobione', 'zrobionych'])}`,
          })
        : null
    );
  }

  /* ---------------- zaznaczanie ---------------- */

  function toggleSelected(id, on) {
    if (on) selected.add(id);
    else selected.delete(id);
    const tr = tbody.querySelector(`tr[data-point-id="${CSS.escape(id)}"]`);
    if (tr) tr.classList.toggle('is-selected', on);
    updateBulk();
  }

  function setAllSelected(on) {
    for (const row of view.visible) {
      if (on) selected.add(row.point.id);
      else selected.delete(row.point.id);
    }
    for (const tr of tbody.querySelectorAll('tr[data-point-id]')) tr.classList.toggle('is-selected', on);
    for (const input of tbody.querySelectorAll('tr[data-point-id] input[type="checkbox"]')) input.checked = on;
    updateBulk();
  }

  function updateBulk() {
    const total = view.visible.length;
    const count = view.visible.filter((row) => selected.has(row.point.id)).length;

    for (const box of [headSelect, bulkSelect]) {
      box.checked = total > 0 && count === total;
      box.indeterminate = count > 0 && count < total;
      box.disabled = total === 0;
    }

    // po przyimku „z" rzeczownik zawsze w dopełniaczu: „1 z 2 kart"
    counter.textContent = count
      ? `Zaznaczono: ${fmtNum(count)} z ${fmtNum(total)} kart`
      : `Zaznaczono: 0 · eksport obejmie wszystkie widoczne (${fmtNum(total)} ${cards(total)})`;

    exportBtn.disabled = total === 0;
    exportBtn.classList.toggle('is-disabled', total === 0);
    exportBtn.title = total
      ? 'Eksportuje zaznaczone wiersze, a bez zaznaczenia – wszystkie widoczne'
      : 'Brak wierszy do eksportu przy tych filtrach';
  }

  /* ---------------- sub bar ---------------- */

  function updateSubbarMeta(visible) {
    if (!ctx.setMeta) return;
    const measured = visible.filter((row) => row.pct !== null);
    const avg = measured.length ? measured.reduce((sum, row) => sum + row.pct, 0) / measured.length : 0;
    const scope =
      visible.length === allRows.length
        ? `${fmtNum(visible.length)} ${cards(visible.length)}`
        : `${fmtNum(visible.length)} z ${fmtNum(allRows.length)} kart`;
    ctx.setMeta(`${scope} · średnia kompletność ${fmtPct(avg)}`);
  }

  /* ---------------- eksport CSV ---------------- */

  function exportCsv() {
    const chosen = view.visible.filter((row) => selected.has(row.point.id));
    const rows = chosen.length ? chosen : view.visible;
    if (!rows.length) {
      toast('Nie ma czego eksportować – żadna karta nie pasuje do filtrów.');
      return;
    }

    const body = rows.map((row) => [
      row.point.id,
      row.point.name,
      row.preset ? row.preset.name : '',
      row.point.districtId ? row.district : '',
      row.pct === null ? '' : row.pct,
      row.recs.length,
      row.status.label,
    ]);

    download(
      `karty-punktow-${state.project.id}-${TODAY}.csv`,
      toCsv(CSV_HEADERS, body),
      'text/csv;charset=utf-8'
    );

    toast(
      `Wyeksportowano ${fmtNum(rows.length)} ${cardsAcc(rows.length)} do CSV ` +
        `(${chosen.length ? 'zaznaczone' : 'wszystkie widoczne'}).`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Sprzątanie
 * ------------------------------------------------------------------ */

export function destroy() {
  // Mapy tu nie ma; zwalniamy tylko uchwyty DOM, żeby nie trzymać oderwanych
  // węzłów. Zaznaczenie zostaje – powrót z karty punktu zastaje tę samą listę.
  refs = null;
}
