/**
 * views/roadmap.js – Krok 4: Roadmapa (SPEC §6.6, trasa '#/roadmap').
 *
 * Kanban – trzy kolumny faz (+ „Nieprzypisane") z drag & drop między fazami,
 * paskiem mapy w kolorach faz i zatwierdzeniem kroku. (Tryb „Oś czasu" został
 * usunięty na życzenie klienta w iteracji 3.)
 *
 * Wszystkie liczby pochodzą z modelu – widok nie wpisuje żadnej na sztywno:
 *   • roadmapTotals()  – koszty i pozycje w rozbiciu na fazy,
 *   • analyze()        – pokrycie dla trzech scenariuszy (tylko istniejące,
 *                        istniejące + fazy 1–2, istniejące + całość planu),
 *                        czyli wartości kamieni milowych i krzywej,
 *   • points[].gainPct – efekt pojedynczego montażu na pokrycie.
 * Formatowanie wyłącznie przez fmtPct / fmtNum / fmtCost.
 *
 * Pasek mapy korzysta z renderSceneSvg() – to statyczny string SVG, widok NIE
 * tworzy interaktywnej mapy (createMap), więc nie ma czego zwalniać w destroy();
 * sprzątamy tam ResizeObserver paska i ewentualne listenery przeciągania paska
 * Gantta.
 *
 * Każda zmiana danych idzie przez upsertRecommendation() + save() – save()
 * przerysowuje widok, więc sumy, kamienie milowe i krzywa przeliczają się same.
 */

import {
  state,
  save,
  markStepDone,
  getPoint,
  upsertRecommendation,
  removeRecommendation,
  checkpoint,
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
import { reachMapSync } from '../reach.js';
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
 * kolorem --phase-3 – dzięki temu pasek mapy pokazuje realne kolory faz
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

/** Filtr priorytetu i klucz sortowania – stan widoku, nie dane projektu. */
let prioFilter = 'all';
let sortKey = 'priority';

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

/** Efekt pojedynczej pozycji na pokrycie – bierzemy go z powiązanego punktu. */
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
 * Koszt na mieszkańca – fmtCost() zaokrągla do pełnych złotych, a tu potrzebne
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
  destroy(); // przerysowanie po save() – zwolnij listenery poprzedniego renderu

  const project = state.project;
  if (!project) {
    mount(root, emptyBox('Brak aktywnego projektu – wróć do pulpitu i otwórz audyt.'));
    return;
  }

  // Oś czasu (Gantt) usunięta na życzenie klienta – roadmapa to sam kanban.
  const recommendations = state.recommendations || [];

  if (ctx.subbar && ctx.subbar.controls) {
    mount(ctx.subbar.controls);
  }

  /* ---------------- Obliczenia (zawsze z model.js) ---------------- */

  const { phases, total } = roadmapTotals(recommendations);
  const unassigned = recommendations.filter((rec) => phaseOf(rec) === null);

  /**
   * Filtr i sortowanie działają na tym, co widać w kolumnach – sumy kosztów
   * i KPI zostają liczone z całości, bo plan nie zmienia się od tego, że
   * operator zawęził widok.
   */
  const PRIO_RANK = { high: 0, medium: 1, low: 2 };
  const arrange = (items) => {
    const kept = prioFilter === 'all' ? items : items.filter((r) => r.priority === prioFilter);
    const sorted = [...kept];
    if (sortKey === 'cost') sorted.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    else if (sortKey === 'effect') sorted.sort((a, b) => pointGainPct(b.pointId) - pointGainPct(a.pointId));
    else if (sortKey === 'point') sorted.sort((a, b) => recSource(a).localeCompare(recSource(b), 'pl'));
    else sorted.sort((a, b) => (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3) || (b.cost || 0) - (a.cost || 0));
    return sorted;
  };

  // Ten sam zasięg co w kroku 2 – inaczej roadmapa obiecywałaby pokrycie,
  // którego analiza nie potwierdza.
  const reach = reachMapSync([...state.points, ...(state.candidates || [])]);

  const analysisBase = {
    demandPoints: state.demandPoints,
    districts: project.districts || [],
    standardMinutes: project.standardMinutes,
    population: project.population,
    // Roadmapa raportuje pokrycie dzienne – to ono trafia do kamieni milowych
    // i na okładkę raportu. Tryb nocny zostaje w kroku 2.
    mode: 'day',
    reach,
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

  /**
   * Formularz pozycji roadmapy – jeden dla dodawania i dla edycji, żeby oba
   * okna miały ten sam zestaw pól i tę samą walidację. Zwraca dane albo null,
   * gdy operator zrezygnował lub nie wpisał treści.
   */
  const itemForm = async ({ rec = null, targetPhase = null }) => {
    const editing = !!rec;
    const textInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: 'np. Szkolenie z obsługi AED dla pracowników urzędu',
      value: editing ? rec.text || '' : '',
    });
    const ownerSelect = h(
      'select',
      { class: 'select' },
      ...OWNERS.map((o) =>
        h('option', { value: o.id, ...(editing && rec.owner === o.id ? { selected: 'selected' } : {}) }, o.label)
      )
    );
    const prioSelect = h(
      'select',
      { class: 'select' },
      ...['high', 'medium', 'low'].map((id) =>
        h(
          'option',
          { value: id, ...((editing ? rec.priority : 'medium') === id ? { selected: 'selected' } : {}) },
          PRIORITY_LABEL[id]
        )
      )
    );
    const costInput = h('input', {
      class: 'input num',
      type: 'number',
      min: '0',
      step: '100',
      value: String(editing ? Math.max(0, Math.round(rec.cost || 0)) : 0),
    });

    const phase = editing ? phaseOf(rec) : targetPhase;
    const heading = phase ? `${PHASE_META[phase].label} – ${PHASE_META[phase].title}` : 'Nieprzypisane';

    const confirmed = await modal({
      title: `${editing ? 'Edycja pozycji roadmapy' : 'Nowa pozycja roadmapy'} – ${heading}`,
      body: h(
        'div',
        { class: 'stack' },
        field('Treść pozycji', textInput),
        field('Odpowiedzialny', ownerSelect),
        field('Ważność', prioSelect),
        field('Koszt (zł)', costInput),
        h('p', {
          class: 'note',
          text: editing
            ? rec.auto
              ? 'Pozycja pochodzi z reguły. Zmiany zostają, ale reguła dopisze ją ponownie, ' +
                'jeśli brak w karcie punktu wróci. Fazę zmienia się przeciągnięciem kafelka.'
              : 'Fazę zmienia się przeciągnięciem kafelka między kolumnami – terminy przeliczą się same.'
            : 'Pozycja nie jest powiązana z żadnym punktem AED (pointId: null) – tak zapisujemy ' +
              'zadania organizacyjne: przetargi, dokumentację, szkolenia.',
        })
      ),
      confirmLabel: editing ? 'ZAPISZ ZMIANY' : 'DODAJ POZYCJĘ',
    });
    if (!confirmed) return null;

    const text = textInput.value.trim();
    if (!text) {
      toast(editing ? 'Pozycja bez treści nie zostanie zapisana.' : 'Pozycja bez treści nie zostanie dodana.');
      return null;
    }

    return {
      text,
      owner: ownerSelect.value,
      priority: prioSelect.value,
      cost: Math.max(0, Math.round(Number(costInput.value) || 0)),
    };
  };

  /** „+ pozycja" – nowa rekomendacja bez punktu, w wybranej fazie. */
  const addItem = async (targetPhase) => {
    const data = await itemForm({ targetPhase });
    if (!data) return;

    const span = targetPhase ? PHASE_SPAN[targetPhase] : { start: 1, length: 3 };
    checkpoint('dodanie pozycji roadmapy');
    upsertRecommendation({
      id: nextManualId(),
      pointId: null,
      rule: 'manual',
      ...data,
      phase: targetPhase,
      auto: false,
      done: false,
      startMonth: span.start,
      lengthMonths: span.length,
    });
    await save();
    toast(`Dodano pozycję: „${data.text}".`);
  };

  /** Edycja istniejącej pozycji – tym samym formularzem co przy dodawaniu. */
  const editItem = async (rec) => {
    const data = await itemForm({ rec });
    if (!data) return;
    checkpoint(`edycja pozycji „${rec.text}”`);
    upsertRecommendation({ id: rec.id, ...data });
    await save();
    toast(`Zapisano zmiany w pozycji: „${data.text}".`);
  };

  /** Usunięcie pozycji dodanej ręcznie (pozycji auto nie kasujemy – wracają z reguł). */
  const deleteItem = async (rec) => {
    const confirmed = await modal({
      title: 'Usunąć pozycję roadmapy?',
      body: h(
        'div',
        {},
        h('p', { text: `„${rec.text}" zniknie z planu i z sum kosztów.` }),
        rec.auto
          ? h('p', {
              class: 'note',
              text:
                'To pozycja z reguły – wróci na listę, dopóki brak w karcie punktu, ' +
                'który ją wywołał, nie zostanie uzupełniony albo odhaczony.',
            })
          : null
      ),
      confirmLabel: 'USUŃ',
    });
    if (!confirmed) return;
    checkpoint(`usunięcie pozycji „${rec.text}”`);
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

  /* ---------------- Filtr i sortowanie (uwaga klienta nr 6) ---------------- */

  const prioChip = (id, label) =>
    h(
      'button',
      {
        class: `chip${prioFilter === id ? ' is-on' : ''}`,
        onclick: () => {
          prioFilter = id;
          render(root, ctx);
        },
      },
      `${label} (${fmtNum(id === 'all' ? recommendations.length : recommendations.filter((r) => r.priority === id).length)})`
    );

  const sortSelect = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Sortowanie pozycji',
      style: { width: 'auto', minWidth: '190px' },
      onchange: (e) => {
        sortKey = e.target.value;
        render(root, ctx);
      },
    },
    h('option', { value: 'priority' }, 'Sortuj: ważność'),
    h('option', { value: 'cost' }, 'Sortuj: koszt malejąco'),
    h('option', { value: 'effect' }, 'Sortuj: efekt na pokrycie'),
    h('option', { value: 'point' }, 'Sortuj: punkt (A→Z)')
  );
  sortSelect.value = sortKey;

  const toolbar = h(
    'div',
    { class: 'row row--wrap', style: { marginBottom: '10px' } },
    h('span', {
      class: 'label-caps',
      text: `Plan wdrożenia – ${fmtNum(PHASES.length)} fazy · horyzont ${fmtNum(MONTHS)} mies.`,
    }),
    h(
      'div',
      { class: 'chips', style: { margin: '0' } },
      prioChip('all', 'Wszystkie'),
      prioChip('high', 'Wysoki'),
      prioChip('medium', 'Średni'),
      prioChip('low', 'Niski')
    ),
    sortSelect,
    h('span', { class: 'spacer' }),
    disabledControl(h('button', { class: 'btn btn--sm' }, 'ZALEŻNOŚCI MIĘDZY ZADANIAMI')),
    disabledControl(h('button', { class: 'btn btn--sm' }, 'EKSPORT HARMONOGRAMU (MS PROJECT)'))
  );

  /* ---------------- Legenda: skąd się bierze to, co widać na ekranie ------- */

  const legendItem = (title, body) =>
    h(
      'div',
      {},
      h('div', { style: { fontWeight: '600', fontSize: '12px' }, text: title }),
      h('div', { class: 'note', text: body })
    );

  const legend = h(
    'div',
    { class: 'card', style: { marginBottom: '12px' } },
    h('span', { class: 'label-caps', style: { display: 'block', marginBottom: '8px' }, text: 'Jak czytać ten plan' }),
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px 18px' } },
      legendItem(
        'Skąd biorą się pozycje',
        'Etykieta „z reguły" – pozycja wygenerowana automatycznie z braku stwierdzonego w karcie punktu ' +
          '(np. brak opiekuna, przeterminowany przegląd). „Ręczna" – dopisana przez audytora.'
      ),
      legendItem(
        'Trzy fazy',
        `${PHASE_META[1].title} (${PHASE_META[1].months}) to działania bezkosztowe i porządkowe; ` +
          `${PHASE_META[2].title} (${PHASE_META[2].months}) to nowe urządzenia wewnętrzne; ` +
          `${PHASE_META[3].title} (${PHASE_META[3].months}) to instalacje zewnętrzne wymagające przetargu.`
      ),
      legendItem(
        'Kolory i znaczniki pozycji',
        'Pigułka priorytetu (wysoki/średni/niski) pochodzi z reguły, która pozycję utworzyła. ' +
          'Kwadrat = nowy punkt do montażu, kółko = modernizacja punktu już istniejącego.'
      ),
      legendItem(
        '„+X% pokrycia"',
        'O tyle wzrośnie odsetek mieszkańców mających AED w zasięgu standardu, jeśli ta pozycja zostanie ' +
          'zrealizowana. Liczone tym samym modelem co krok 2 – po realnej sieci pieszej.'
      ),
      legendItem(
        'Koszty',
        'Kwota przy pozycji to koszt jednostkowy presetu (typu instalacji) albo koszt wpisany ręcznie. ' +
          'Suma fazy i suma całości liczą się z tych pozycji – nic nie jest wpisane na sztywno.'
      )
    )
  );

  // Pas KPI roadmapy to limonkowa tafla domykająca nagłówek – jedna nasycona
  // powierzchnia tego ekranu, zgodnie z design systemem marki.
  const kpis = h(
    'div',
    { class: 'kpi-grid kpi-grid--3 kpi-grid--signal', style: { marginBottom: '20px' } },
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
      h('div', { class: 'kpi__value', text: costPerPerson === null ? '–' : fmtCostPerPerson(costPerPerson) }),
      h('div', {
        class: 'kpi__delta',
        text:
          costPerPerson === null
            ? 'Plan nie obejmuje jeszcze nikogo nowego – brak mianownika.'
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
        `Zatwierdzenie zalicza krok 4 w belce i przenosi do raportu. Sumy i terminy ` +
        `pozostają edytowalne – raport czyta je na bieżąco ze stanu projektu.`,
    }),
    h('button', { class: 'btn btn--primary', onclick: approve }, 'ZATWIERDŹ → RAPORT')
  );

  /* ---------------- Zawartość trybu ---------------- */

  const body = recommendations.length
    ? buildKanban({ phases, unassigned, movePhase, addItem, editItem, deleteItem, afterPlan, arrange })
    : emptyBox(
        'Roadmapa jest pusta – rekomendacje powstają w kartach punktów (krok 3), ' +
          'a zadania organizacyjne dodasz przyciskiem „+ pozycja" w kanbanie.'
      );

  mount(root, toolbar, kpis, legend, body, footer);
}

/* ------------------------------------------------------------------ *
 * Tryb KANBAN
 * ------------------------------------------------------------------ */

function buildKanban({ phases, unassigned, movePhase, addItem, editItem, deleteItem, afterPlan, arrange }) {
  const columns = [
    ...PHASES.map((n) => ({
      phase: n,
      title: `${PHASE_META[n].label} – ${PHASE_META[n].title}`,
      months: PHASE_META[n].months,
      items: arrange(phases[n].items),
      totalItems: phases[n].items.length,
      cost: phases[n].cost,
    })),
    {
      phase: null,
      title: 'Nieprzypisane',
      months: 'bez terminu – przeciągnij do fazy',
      items: arrange(unassigned),
      totalItems: unassigned.length,
      cost: unassigned.reduce((sum, rec) => sum + (rec.cost || 0), 0),
    },
  ];

  const board = h('div', {
    class: 'kanban',
    // Czwarta kolumna „Nieprzypisane" jest poza siatką 3-kolumnową z app.css –
    // rozszerzamy ją lokalnie, bez dopisywania klas do arkusza rdzenia.
    style: { gridTemplateColumns: `repeat(${columns.length}, 1fr)` },
  });

  for (const column of columns) {
    board.appendChild(kanbanColumn(column, { movePhase, addItem, editItem, deleteItem }));
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
    for (const rec of column.items) body.appendChild(kanbanCard(rec, actions));
  } else {
    body.appendChild(
      h('div', {
        class: 'empty-state',
        style: { padding: '18px 8px' },
        text: column.totalItems
          ? `Filtr ukrył wszystkie ${fmtNum(column.totalItems)} pozycji tej fazy.`
          : 'Pusto – przeciągnij tu pozycję.',
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
            // Przy aktywnym filtrze pokazujemy oba liczniki, żeby nikt nie
            // wziął zawężonego widoku za rzeczywistą zawartość fazy.
            column.totalItems !== column.items.length
              ? `${fmtNum(column.items.length)} z ${fmtNum(column.totalItems)} poz.`
              : `${fmtNum(column.items.length)} poz.`,
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

/** Czy pozycja dotyczy montażu nowego AED, czy poprawy punktu, który już stoi. */
function recKind(rec) {
  const point = rec.pointId ? getPoint(rec.pointId) : null;
  return point && point.kind === 'proposed' ? 'new' : 'update';
}

function kanbanCard(rec, actions) {
  const gain = pointGainPct(rec.pointId);

  const card = h(
    'div',
    {
      class: 'kanban__card',
      draggable: 'true',
      title: 'Przeciągnij na inną fazę – sumy i terminy przeliczą się same',
    },
    h('span', { class: 'kanban__grip', html: '⋮⋮', 'aria-hidden': 'true' }),
    h(
      'div',
      { style: { flex: '1', minWidth: '0' } },
      h(
        'div',
        { class: 'row' },
        h('span', {
          class: `rec-kind rec-kind--${recKind(rec)}`,
          title: recKind(rec) === 'new' ? 'Nowy punkt do montażu' : 'Modernizacja punktu istniejącego',
          'aria-hidden': 'true',
        }),
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
    h(
      'div',
      { class: 'kanban__actions' },
      // Edycja tym samym formularzem co „+ pozycja": treść, odpowiedzialny,
      // ważność, koszt. Dotyczy też pozycji z reguł – audytor doprecyzowuje
      // treść i kwotę, których reguła nie zna.
      h(
        'button',
        {
          class: 'btn btn--sm btn--ghost',
          title: 'Edytuj pozycję',
          'aria-label': 'Edytuj pozycję',
          onclick: (e) => {
            e.stopPropagation();
            actions.editItem(rec);
          },
        },
        '✎'
      ),
      h(
        'button',
        {
          class: 'btn btn--sm btn--ghost btn--danger',
          // Także pozycje z reguł: audytor bywa mądrzejszy od reguły i musi móc
          // zdjąć z planu coś, czego gmina nie zrobi. Okno potwierdzenia mówi,
          // że pozycja z reguły wróci, dopóki brak w karcie nie zostanie usunięty.
          title: rec.auto ? 'Usuń pozycję z planu' : 'Usuń pozycję dodaną ręcznie',
          'aria-label': 'Usuń pozycję',
          onclick: (e) => {
            e.stopPropagation();
            actions.deleteItem(rec);
          },
        },
        '✕'
      )
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
      h('span', { html: pillHtml(`${PHASE_META[n].label} – ${PHASE_META[n].title}`, PHASE_VARIANT[n]) })
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
