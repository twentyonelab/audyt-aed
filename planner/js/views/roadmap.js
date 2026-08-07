/**
 * views/roadmap.js — Krok 4: Roadmapa (SPEC §6.6, trasa '#/roadmap').
 *
 * Kanban — trzy kolumny faz (+ „Nieprzypisane") z drag & drop między fazami,
 * paskiem mapy w kolorach faz i zatwierdzeniem kroku. (Tryb „Oś czasu" został
 * usunięty na życzenie klienta w iteracji 3.)
 *
 * Wszystkie liczby pochodzą z modelu — widok nie wpisuje żadnej na sztywno:
 *   • roadmapTotals()  — koszty i pozycje w rozbiciu na fazy,
 *   • analyze()        — pokrycie dla trzech scenariuszy (tylko istniejące,
 *                        istniejące + fazy 1–2, istniejące + całość planu),
 *                        czyli wartości kamieni milowych i krzywej,
 *   • points[].gainPct — efekt pojedynczego montażu na pokrycie.
 * Formatowanie wyłącznie przez fmtPct / fmtNum / fmtCost.
 *
 * Pasek mapy korzysta z renderSceneSvg() — to statyczny string SVG, widok NIE
 * tworzy interaktywnej mapy (createMap), więc nie ma czego zwalniać w destroy();
 * sprzątamy tam ResizeObserver paska i ewentualne listenery przeciągania paska
 * Gantta.
 *
 * Każda zmiana danych idzie przez upsertRecommendation() + save() — save()
 * przerysowuje widok, więc sumy, kamienie milowe i krzywa przeliczają się same.
 */

import {
  state,
  save,
  markStepDone,
  getPoint,
  upsertRecommendation,
  removeRecommendation,
} from '../state.js';

import {
  analyze,
  roadmapTotals,
  PHASE_META,
  fmtPct,
  fmtNum,
  fmtCost,
} from '../model.js';

import {
  h,
  mount,
  toast,
  modal,
  pillHtml,
  disabledControl,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
} from '../ui.js';

import { renderSceneSvg } from '../map.js';
import { TODAY } from '../../config.js';

export const meta = {
  step: 4,
  title: 'Roadmapa',
  subtitle: 'kiedy i za ile',
  layout: 'scroll',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

const PHASES = [1, 2, 3];

/** Horyzont osi czasu: 24 miesiące = 8 kwartałów (SPEC §6.6). */
const MONTHS = 24;
const QUARTERS = 8;
const MONTHS_PER_QUARTER = MONTHS / QUARTERS;

/**
 * Poziom pinu na mapie dla danej fazy. Mapowanie jest nieprzypadkowe:
 * map.js rysuje 'ok' kolorem --phase-1, 'warn' kolorem --phase-2, a 'proposed'
 * kolorem --phase-3 — dzięki temu pasek mapy pokazuje realne kolory faz
 * i nie wprowadzamy ani jednego nowego koloru.
 */
const PHASE_LEVEL = { 1: 'ok', 2: 'warn', 3: 'proposed' };

const PHASE_VARIANT = { 1: 'phase1', 2: 'phase2', 3: 'phase3' };

/** Domyślne okno na osi czasu dla pozycji przeniesionej do danej fazy. */
const PHASE_SPAN = {
  1: { start: 1, length: 6 },
  2: { start: 7, length: 12 },
  3: { start: 19, length: 6 },
};

/** Awaryjny koniec fazy, gdy żadna pozycja nie ma jeszcze terminów. */
const PHASE_END_FALLBACK = { 1: 6, 2: 18, 3: 24 };

const OWNERS = [
  { id: 'gmina', label: 'gmina' },
  { id: 'serwis', label: 'serwis' },
  { id: 'wykonawca', label: 'wykonawca' },
];

const MAP_STRIP_HEIGHT = 220;

/** Geometria krzywej pokrycia wewnątrz .gantt__curve (74 px wysokości). */
const CURVE = { height: 74, top: 26, bottom: 14, padPct: 4 };

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (nie są to dane projektu)
 * ------------------------------------------------------------------ */

let resizeObserver = null;
let releasePointer = null;
let draggedRecId = null;

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy)
 * ------------------------------------------------------------------ */

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Faza pozycji jako 1|2|3 albo null (pozycje bez fazy = „Nieprzypisane"). */
function phaseOf(rec) {
  const n = Number(rec.phase);
  return PHASES.includes(n) ? n : null;
}

/** Start i długość paska Gantta, zawsze w pełnych miesiącach z zakresu 1..24. */
function barMonths(rec) {
  const start = clamp(Math.round(Number(rec.startMonth) || 1), 1, MONTHS);
  const raw = Math.round(Number(rec.lengthMonths) || 1);
  return { start, length: clamp(raw, 1, MONTHS - start + 1) };
}

function leftPct(startMonth) {
  return ((startMonth - 1) / MONTHS) * 100;
}

function widthPct(lengthMonths) {
  return (lengthMonths / MONTHS) * 100;
}

function segControl(options, activeValue, onPick) {
  return h(
    'div',
    { class: 'seg' },
    ...options.map((option) =>
      h(
        'button',
        {
          class: `seg__btn${option.value === activeValue ? ' is-on' : ''}`,
          onclick: () => {
            if (option.value === activeValue) return;
            onPick(option.value);
          },
        },
        option.label
      )
    )
  );
}

function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label', text: label }), control);
}

/**
 * Which point a roadmap item belongs to. Phase 1 is mostly the same few
 * compliance actions repeated across points, so without this the plan reads as
 * nine identical rows.
 */
function recSource(rec) {
  if (!rec.pointId) return 'zadanie ogólne';
  const point = getPoint(rec.pointId);
  return point ? point.name : rec.pointId;
}

function ownerLabel(id) {
  const owner = OWNERS.find((o) => o.id === id);
  return owner ? owner.label : id || 'nieprzypisany';
}

/** Kolejny identyfikator pozycji dodanej ręcznie: man-001, man-002, … */
function nextManualId() {
  const used = state.recommendations
    .map((r) => /^man-(\d+)$/.exec(r.id || ''))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `man-${String(next).padStart(3, '0')}`;
}

/** Efekt pojedynczej pozycji na pokrycie — bierzemy go z powiązanego punktu. */
function pointGainPct(pointId) {
  if (!pointId) return 0;
  const point = getPoint(pointId);
  const gain = point ? Number(point.gainPct) : NaN;
  return Number.isFinite(gain) ? gain : 0;
}

/** Suma gainPct unikalnych punktów montowanych w danej fazie. */
function phaseGainPct(items) {
  const seen = new Set();
  let sum = 0;
  for (const rec of items) {
    if (!rec.pointId || seen.has(rec.pointId)) continue;
    seen.add(rec.pointId);
    sum += pointGainPct(rec.pointId);
  }
  return sum;
}

/** Ostatni miesiąc, w którym coś się dzieje w danej fazie. */
function phaseEndMonth(items, fallback) {
  let end = 0;
  for (const rec of items) {
    const bar = barMonths(rec);
    end = Math.max(end, bar.start + bar.length - 1);
  }
  return end || fallback;
}

/**
 * Koszt na mieszkańca — fmtCost() zaokrągla do pełnych złotych, a tu potrzebne
 * są grosze (SPEC §6.7: „3,10 zł"), więc liczbę formatuje fmtNum z dwoma
 * miejscami, a „zł" dokładamy jako jednostkę.
 */
function fmtCostPerPerson(value) {
  return `${fmtNum(value, 2)} zł`;
}

function emptyBox(text) {
  return h('div', { class: 'empty-state', text });
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  destroy(); // przerysowanie po save() — zwolnij listenery poprzedniego renderu

  const project = state.project;
  if (!project) {
    mount(root, emptyBox('Brak aktywnego projektu — wróć do pulpitu i otwórz audyt.'));
    return;
  }

  // Oś czasu (Gantt) usunięta na życzenie klienta — roadmapa to sam kanban.
  const recommendations = state.recommendations || [];

  if (ctx.subbar && ctx.subbar.controls) {
    mount(ctx.subbar.controls);
  }

  /* ---------------- Obliczenia (zawsze z model.js) ---------------- */

  const { phases, total } = roadmapTotals(recommendations);
  const unassigned = recommendations.filter((rec) => phaseOf(rec) === null);

  const analysisBase = {
    demandPoints: state.demandPoints,
    districts: project.districts || [],
    standardMinutes: project.standardMinutes,
    population: project.population,
    // Roadmapa raportuje pokrycie dzienne — to ono trafia do kamieni milowych
    // i na okładkę raportu. Tryb nocny zostaje w kroku 2.
    mode: 'day',
  };

  /** Scenariusz „plan" ograniczony do faz ≤ maxPhase (istniejące zawsze liczą się). */
  const coverageUpToPhase = (maxPhase) =>
    analyze({
      ...analysisBase,
      points: state.points.filter(
        (p) => p.kind === 'existing' || (Number(p.phase) || Infinity) <= maxPhase
      ),
      scenario: 'plan',
    });

  const nowAnalysis = analyze({ ...analysisBase, points: state.points, scenario: 'now' });
  const afterPhase1 = coverageUpToPhase(1);
  const afterPhase2 = coverageUpToPhase(2);
  const afterPlan = analyze({ ...analysisBase, points: state.points, scenario: 'plan' });

  const coverageDelta = afterPlan.coveragePct - nowAnalysis.coveragePct;
  const peopleGained = afterPlan.coveredPeople - nowAnalysis.coveredPeople;
  const costPerPerson = peopleGained > 0 ? total / peopleGained : null;

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(recommendations.length)} pozycji: ` +
        PHASES.map((n) => `${fmtNum(phases[n].items.length)} w fazie ${fmtNum(n)}`).join(' · ') +
        `${unassigned.length ? ` · ${fmtNum(unassigned.length)} bez fazy` : ''} · ` +
        `suma ${fmtCost(total)}`
    );
  }

  /* ---------------- Akcje na danych ---------------- */

  /** Przeniesienie pozycji do innej fazy (drag & drop w kanbanie). */
  const movePhase = async (recId, targetPhase) => {
    const rec = recommendations.find((r) => r.id === recId);
    if (!rec) return;
    if (phaseOf(rec) === targetPhase) return;

    const patch = { id: rec.id, phase: targetPhase };
    if (targetPhase) {
      // Zachowaj długość zadania, ale wstaw je w okno nowej fazy, żeby oś czasu
      // nie kłóciła się z kanbanem.
      const span = PHASE_SPAN[targetPhase];
      const length = barMonths(rec).length;
      patch.startMonth = span.start;
      patch.lengthMonths = clamp(length, 1, MONTHS - span.start + 1);
    }
    upsertRecommendation(patch);
    await save();
    toast(
      targetPhase
        ? `„${rec.text}" → ${PHASE_META[targetPhase].label} (${PHASE_META[targetPhase].months}).`
        : `„${rec.text}" wróciło do pozycji nieprzypisanych.`
    );
  };

  /** „+ pozycja" — nowa rekomendacja bez punktu, w wybranej fazie. */
  const addItem = async (targetPhase) => {
    const textInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'np. Szkolenie z obsługi AED dla pracowników urzędu',
    });
    const ownerSelect = h(
      'select',
      { class: 'select' },
      ...OWNERS.map((o) => h('option', { value: o.id }, o.label))
    );
    const costInput = h('input', { class: 'input num', type: 'number', min: '0', step: '100', value: '0' });

    const heading = targetPhase
      ? `${PHASE_META[targetPhase].label} — ${PHASE_META[targetPhase].title}`
      : 'Nieprzypisane';

    const confirmed = await modal({
      title: `Nowa pozycja roadmapy — ${heading}`,
      body: h(
        'div',
        { class: 'stack' },
        field('Treść pozycji', textInput),
        field('Odpowiedzialny', ownerSelect),
        field('Koszt (zł)', costInput),
        h('p', {
          class: 'note',
          text:
            'Pozycja nie jest powiązana z żadnym punktem AED (pointId: null) — tak zapisujemy ' +
            'zadania organizacyjne: przetargi, dokumentację, szkolenia.',
        })
      ),
      confirmLabel: 'DODAJ POZYCJĘ',
    });
    if (!confirmed) return;

    const text = textInput.value.trim();
    if (!text) {
      toast('Pozycja bez treści nie zostanie dodana.');
      return;
    }

    const span = targetPhase ? PHASE_SPAN[targetPhase] : { start: 1, length: 3 };
    upsertRecommendation({
      id: nextManualId(),
      pointId: null,
      rule: 'manual',
      text,
      priority: 'medium',
      cost: Math.max(0, Math.round(Number(costInput.value) || 0)),
      owner: ownerSelect.value,
      phase: targetPhase,
      auto: false,
      done: false,
      startMonth: span.start,
      lengthMonths: span.length,
    });
    await save();
    toast(`Dodano pozycję: „${text}".`);
  };

  /** Usunięcie pozycji dodanej ręcznie (pozycji auto nie kasujemy — wracają z reguł). */
  const deleteItem = async (rec) => {
    const confirmed = await modal({
      title: 'Usunąć pozycję roadmapy?',
      body: h('p', { text: `„${rec.text}" zniknie z planu i z sum kosztów.` }),
      confirmLabel: 'USUŃ',
    });
    if (!confirmed) return;
    removeRecommendation(rec.id);
    await save();
    toast('Pozycja usunięta z roadmapy.');
  };

  const approve = async () => {
    markStepDone(4);
    await save();
    ctx.navigate('#/report');
  };

  /* ---------------- Nagłówek: KPI + kontrolki poza zakresem ---------------- */

  const toolbar = h(
    'div',
    { class: 'row row--wrap', style: { marginBottom: '10px' } },
    h('span', {
      class: 'label-caps',
      text: `Plan wdrożenia — ${fmtNum(PHASES.length)} fazy · horyzont ${fmtNum(MONTHS)} mies.`,
    }),
    h('span', { class: 'spacer' }),
    disabledControl(h('button', { class: 'btn btn--sm' }, 'ZALEŻNOŚCI MIĘDZY ZADANIAMI')),
    disabledControl(h('button', { class: 'btn btn--sm' }, 'EKSPORT HARMONOGRAMU (MS PROJECT)'))
  );

  const kpis = h(
    'div',
    { class: 'kpi-grid kpi-grid--3', style: { marginBottom: '14px' } },
    h(
      'div',
      { class: 'kpi' },
      h('div', { class: 'kpi__label', text: 'Suma kosztów całości planu' }),
      h('div', { class: 'kpi__value', text: fmtCost(total) }),
      h('div', {
        class: 'kpi__delta',
        text: PHASES.map((n) => `${PHASE_META[n].label}: ${fmtCost(phases[n].cost)}`).join(' · '),
      })
    ),
    h(
      'div',
      { class: 'kpi' },
      h('div', { class: 'kpi__label', text: 'Koszt na mieszkańca objętego ochroną' }),
      h('div', { class: 'kpi__value', text: costPerPerson === null ? '—' : fmtCostPerPerson(costPerPerson) }),
      h('div', {
        class: 'kpi__delta',
        text:
          costPerPerson === null
            ? 'Plan nie obejmuje jeszcze nikogo nowego — brak mianownika.'
            : `suma planu ÷ przyrost objętej ludności (${fmtNum(peopleGained)} os.)`,
      })
    ),
    h(
      'div',
      { class: 'kpi' },
      h('div', { class: 'kpi__label', text: 'Przyrost pokrycia po planie (dzień)' }),
      h('div', {
        class: 'kpi__value',
        text: `${coverageDelta >= 0 ? '+' : '−'}${fmtNum(Math.abs(coverageDelta), 1)} pkt proc.`,
      }),
      h('div', {
        class: `kpi__delta${coverageDelta > 0.05 ? ' is-up' : coverageDelta < -0.05 ? ' is-down' : ''}`,
        text: `teraz ${fmtPct(nowAnalysis.coveragePct, 0)} → po planie ${fmtPct(afterPlan.coveragePct, 0)}`,
      })
    )
  );

  /* ---------------- Stopka wspólna dla obu trybów ---------------- */

  const footer = h(
    'div',
    { class: 'row row--wrap', style: { marginTop: '14px' } },
    h('p', {
      class: 'note',
      style: { flex: '1', minWidth: '260px', margin: '0' },
      text:
        `Zatwierdzenie zalicza krok 4 w stepperze i przenosi do raportu. Sumy i terminy ` +
        `pozostają edytowalne — raport czyta je na bieżąco ze stanu projektu.`,
    }),
    h('button', { class: 'btn btn--primary', onclick: approve }, 'ZATWIERDŹ → RAPORT')
  );

  /* ---------------- Zawartość trybu ---------------- */

  const body = recommendations.length
    ? buildKanban({ phases, unassigned, movePhase, addItem, deleteItem, afterPlan })
    : emptyBox(
        'Roadmapa jest pusta — rekomendacje powstają w kartach punktów (krok 3), ' +
          'a zadania organizacyjne dodasz przyciskiem „+ pozycja" w kanbanie.'
      );

  mount(root, toolbar, kpis, body, footer);
}

/* ------------------------------------------------------------------ *
 * Tryb KANBAN
 * ------------------------------------------------------------------ */

function buildKanban({ phases, unassigned, movePhase, addItem, deleteItem, afterPlan }) {
  const columns = [
    ...PHASES.map((n) => ({
      phase: n,
      title: `${PHASE_META[n].label} — ${PHASE_META[n].title}`,
      months: PHASE_META[n].months,
      items: phases[n].items,
      cost: phases[n].cost,
    })),
    {
      phase: null,
      title: 'Nieprzypisane',
      months: 'bez terminu — przeciągnij do fazy',
      items: unassigned,
      cost: unassigned.reduce((sum, rec) => sum + (rec.cost || 0), 0),
    },
  ];

  const board = h('div', {
    class: 'kanban',
    // Czwarta kolumna „Nieprzypisane" jest poza siatką 3-kolumnową z app.css —
    // rozszerzamy ją lokalnie, bez dopisywania klas do arkusza rdzenia.
    style: { gridTemplateColumns: `repeat(${columns.length}, 1fr)` },
  });

  for (const column of columns) {
    board.appendChild(kanbanColumn(column, { movePhase, addItem, deleteItem }));
  }

  return h('div', {}, board, mapStrip(afterPlan));
}

function kanbanColumn(column, actions) {
  const gain = phaseGainPct(column.items);

  const body = h('div', { class: 'kanban__body' });
  let enterDepth = 0;

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    enterDepth += 1;
    body.classList.add('is-dropzone');
  });
  body.addEventListener('dragleave', () => {
    enterDepth = Math.max(0, enterDepth - 1);
    if (!enterDepth) body.classList.remove('is-dropzone');
  });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    enterDepth = 0;
    body.classList.remove('is-dropzone');
    const id = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || draggedRecId;
    draggedRecId = null;
    if (id) actions.movePhase(id, column.phase);
  });

  if (column.items.length) {
    for (const rec of column.items) body.appendChild(kanbanCard(rec, actions.deleteItem));
  } else {
    body.appendChild(
      h('div', {
        class: 'empty-state',
        style: { padding: '18px 8px' },
        text: 'Pusto — przeciągnij tu pozycję.',
      })
    );
  }

  body.appendChild(
    h(
      'button',
      {
        class: 'btn btn--sm btn--block',
        style: { marginTop: 'auto' },
        title: 'Dodaj pozycję niezwiązaną z konkretnym punktem AED',
        onclick: () => actions.addItem(column.phase),
      },
      '+ pozycja'
    )
  );

  return h(
    'div',
    { class: 'kanban__col' },
    h('div', { class: `kanban__stripe${column.phase ? ` kanban__stripe--${column.phase}` : ''}` }),
    h(
      'div',
      { class: 'kanban__head' },
      h(
        'div',
        { class: 'row' },
        h('h3', { style: { flex: '1' }, text: column.title }),
        h('span', {
          html: pillHtml(
            `${fmtNum(column.items.length)} poz.`,
            column.phase ? PHASE_VARIANT[column.phase] : ''
          ),
        })
      ),
      h('div', { class: 'muted', text: column.months }),
      h(
        'div',
        { class: 'row', style: { marginTop: '4px' } },
        h('span', { class: 'num', style: { fontWeight: '700' }, text: fmtCost(column.cost) }),
        h('span', { class: 'spacer' }),
        gain > 0
          ? h('span', { class: 'kanban__effect num', text: `+${fmtPct(gain, 1)} pokrycia` })
          : h('span', { class: 'muted', style: { fontSize: '11px' }, text: 'bez nowych lokalizacji' })
      )
    ),
    body
  );
}

function kanbanCard(rec, onDelete) {
  const gain = pointGainPct(rec.pointId);

  const card = h(
    'div',
    {
      class: 'kanban__card',
      draggable: 'true',
      title: 'Przeciągnij na inną fazę — sumy i terminy przeliczą się same',
    },
    h('span', { class: 'kanban__grip', html: '⋮⋮', 'aria-hidden': 'true' }),
    h(
      'div',
      { style: { flex: '1', minWidth: '0' } },
      h(
        'div',
        { class: 'row' },
        h('h4', { style: { flex: '1' }, text: rec.text }),
        h('span', {
          html: pillHtml(PRIORITY_LABEL[rec.priority] || 'priorytet ?', PRIORITY_VARIANT[rec.priority] || ''),
        })
      ),
      h('div', {
        class: 'kanban__meta num',
        text: `${recSource(rec)} · ${ownerLabel(rec.owner)} · ${fmtCost(rec.cost)}`,
      }),
      gain > 0 ? h('div', { class: 'kanban__effect num', text: `+${fmtPct(gain, 1)} pokrycia` }) : null
    ),
    rec.auto
      ? null
      : h(
          'button',
          {
            class: 'btn btn--sm btn--ghost btn--danger',
            title: 'Usuń pozycję dodaną ręcznie',
            'aria-label': 'Usuń pozycję',
            onclick: (e) => {
              e.stopPropagation();
              onDelete(rec);
            },
          },
          '✕'
        )
  );

  card.addEventListener('dragstart', (e) => {
    draggedRecId = rec.id;
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', rec.id);
      e.dataTransfer.effectAllowed = 'move';
    }
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
    draggedRecId = null;
  });

  return card;
}

/**
 * Pasek mapy pod kolumnami: punkty pokolorowane fazą, istniejąca sieć jako
 * strefy pokrycia. Renderowany przez renderSceneSvg() i przemalowywany przy
 * zmianie szerokości, żeby SVG nie był rozciągany.
 */
function mapStrip(afterPlan) {
  /** Faza punktu = jego własna faza (propozycje) albo najwcześniejsza faza jego zadań. */
  const phaseByPoint = new Map();
  for (const point of state.points) {
    const own = Number(point.phase);
    if (PHASES.includes(own)) phaseByPoint.set(point.id, own);
  }
  for (const rec of state.recommendations || []) {
    const phase = phaseOf(rec);
    if (!phase || !rec.pointId) continue;
    const current = phaseByPoint.get(rec.pointId);
    if (current === undefined || phase < current) phaseByPoint.set(rec.pointId, phase);
  }

  const pins = [];
  for (const point of state.points) {
    if (point.status === 'rejected') continue;
    const phase = phaseByPoint.get(point.id);
    if (!phase) continue;
    pins.push({
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      level: PHASE_LEVEL[phase],
      name: point.name,
    });
  }

  const scene = {
    boundary: state.boundary,
    districts: state.districtsGeo,
    showDistricts: true,
    coverage: afterPlan.activePoints.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      radiusM: afterPlan.radiusM,
      kind: p.kind === 'proposed' ? 'proposed' : 'existing',
    })),
    showCoverage: true,
    targetMinutes: state.project.standardMinutes,
    points: pins,
  };

  const holder = h('div', {
    class: 'card',
    style: {
      padding: '0',
      height: `${MAP_STRIP_HEIGHT}px`,
      overflow: 'hidden',
      marginTop: '12px',
    },
  });

  const paint = () => {
    const width = Math.max(320, Math.round(holder.clientWidth || 900));
    holder.innerHTML = renderSceneSvg(scene, {
      width,
      height: MAP_STRIP_HEIGHT,
      showDemand: false,
      showCoverage: true,
      showLabels: false,
    });
    const svg = holder.querySelector('svg');
    if (svg) {
      svg.style.width = '100%';
      svg.style.height = '100%';
      svg.style.display = 'block';
    }
  };

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(paint);
    resizeObserver.observe(holder);
  }
  paint();

  const legend = h(
    'div',
    { class: 'row row--wrap', style: { marginTop: '8px' } },
    ...PHASES.map((n) =>
      h('span', { html: pillHtml(`${PHASE_META[n].label} — ${PHASE_META[n].title}`, PHASE_VARIANT[n]) })
    ),
    h('span', { class: 'spacer' }),
    h('span', {
      class: 'note',
      text: `${fmtNum(pins.length)} punktów objętych planem · strefy pokrycia = sieć po wdrożeniu.`,
    })
  );

  return h('div', {}, holder, legend);
}

/* ------------------------------------------------------------------ *
 * Sprzątanie
 * ------------------------------------------------------------------ */

export function destroy() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (releasePointer) {
    releasePointer();
    releasePointer = null;
  }
  draggedRecId = null;
}
