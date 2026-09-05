/**
 * views/analysis.js – Krok 2: Analiza dostępności (SPEC §6.3, trasa '#/analysis').
 *
 * Mapa (strefy pokrycia, punkty popytu, etykiety luk, przeciągalne piny
 * propozycji) + panel wskaźników 380 px.
 *
 * Wszystkie liczby pochodzą z model.js – widok nie liczy nic samodzielnie:
 *   • analyze()          – KPI, luki wg dzielnic, status punktów popytu,
 *   • proposeNewPoints() – greedy max coverage dla kandydatów,
 *   • coverageGainFor()  – „+X% pokrycia" pojedynczej propozycji (także na żywo
 *                          w trakcie przeciągania pinu).
 *
 * Scenariusz i tryb (dzień/noc) siedzą w state.ui i są zapisywane przez save(),
 * więc przełączniki realnie przeliczają zarówno mapę, jak i panel.
 */

import {
  state,
  save,
  markStepDone,
  getPoint,
  getPreset,
  districtName,
  districtAt,
  upsertPoint,
  removePoint,
  makePoint,
  nextId,
  checkpoint,
} from '../state.js';

import {
  analyze,
  proposeNewPoints,
  coverageGainFor,
  completeness,
  pointStatusLevel,
  coverageRadiusM,
  ringCentroid,
  trimRouteToReach,
  fmtPct,
  fmtMin,
  fmtNum,
  fmtCost,
  WALK_SPEED,
  DETOUR,
} from '../model.js';

import {
  h,
  mount,
  toast,
  barHtml,
  pillHtml,
  dotHtml,
  statusMeta,
  mapLegend,
  basemapThemeSwitch,
  modal,
} from '../ui.js';

import { createMap, circlePolygon } from '../map.js';
import { reachMapFor, contoursFor, routesFor, fetchRoutes, reachCoverageOf } from '../reach.js';
import { createWalker } from '../walker.js';

export const meta = {
  step: 2,
  title: 'Analiza dostępności',
  subtitle: 'gdzie są luki',
  layout: 'split',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/** Throttling przeliczania KPI w trakcie przeciągania pinu (SPEC §5). */
const DRAG_THROTTLE_MS = 100;

/** Prefiks identyfikatora pinu propozycji, która nie jest jeszcze punktem. */
const PENDING_PREFIX = 'pending:';

/** Ile dzielnic dostaje etykietę „LUKA: …" na mapie. */
const GAP_LABELS_ON_MAP = 3;

/** Presety zewnętrzne – szafka i totem pracują całodobowo (jak w danych demo). */
const OUTDOOR_PRESETS = new Set(['P3', 'P4']);

/** Próg, poniżej którego różnicę KPI uznajemy za brak zmiany. */
const EPS = 0.05;

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (przeżywa przerysowania, nie jest danymi projektu)
 * ------------------------------------------------------------------ */

let map = null;
let dragTimer = null;
/** Ludzik świadka – żyje tyle, co widok, i sam sprząta po sobie. */
let walker = null;
/** Gdzie stał przed przerysowaniem. Bez tego znikałby przy każdym zapisie. */
let walkerAt = null;
/** Ostatni kadr mapy – odtwarzany przy każdym przerysowaniu widoku. */
let savedCamera = null;
/** Punkt, którego zasięg i trasy dojścia są pokazane; przeżywa przerysowania. */
let selectedReachId = null;

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy)
 * ------------------------------------------------------------------ */

function section(title, ...children) {
  return h('div', { class: 'panel__section' }, h('span', { class: 'label-caps', text: title }), ...children);
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

function pendingPinId(proposal) {
  return `${PENDING_PREFIX}${proposal.candidateId}`;
}

function isPendingPin(id) {
  return typeof id === 'string' && id.startsWith(PENDING_PREFIX);
}

/** Kolor paska luki niesie informację o skali braku, nie o interfejsie. */
function gapVariant(uncoveredPct) {
  if (uncoveredPct >= 50) return 'crit';
  if (uncoveredPct >= 20) return 'warn';
  return '';
}

/**
 * Definicje czterech kafelków KPI. `read` bierze wynik analyze(), `fmt`
 * formatuje wartość, `diff` formatuje wartość bezwzględną różnicy.
 */
function kpiDefs(standardMinutes) {
  return [
    {
      label: `Pokrycie ≤ ${fmtMin(standardMinutes, 0)}`,
      read: (a) => a.coveragePct,
      fmt: (v) => fmtPct(v, 0),
      diff: (d) => `${fmtNum(d, 1)} pkt proc.`,
      better: 'up',
    },
    {
      label: 'AED / 10 tys. mieszkańców',
      read: (a) => a.aedPer10k,
      fmt: (v) => fmtNum(v, 1),
      diff: (d) => `${fmtNum(d, 1)} AED/10 tys.`,
      better: 'up',
    },
    {
      label: 'Punkty dostępne 24/7',
      read: (a) => a.always247Pct,
      fmt: (v) => fmtPct(v, 0),
      diff: (d) => `${fmtNum(d, 1)} pkt proc.`,
      better: 'up',
    },
    {
      label: 'Mediana czasu dojścia',
      read: (a) => a.medianMin,
      fmt: (v) => fmtMin(v, 1),
      diff: (d) => fmtMin(d, 1),
      better: 'down',
    },
  ];
}

/** „teraz → po planie" + klasa is-up/is-down zależnie od kierunku poprawy. */
function kpiDelta(def, nowValue, planValue) {
  const head = `teraz ${def.fmt(nowValue)} → plan ${def.fmt(planValue)}`;
  if (!Number.isFinite(nowValue) || !Number.isFinite(planValue)) {
    return { html: `${head}<br>brak danych do porównania`, cls: '' };
  }
  const d = planValue - nowValue;
  const flat = Math.abs(d) <= EPS;
  const improved = !flat && (def.better === 'up' ? d > 0 : d < 0);
  const worse = !flat && (def.better === 'up' ? d < 0 : d > 0);
  const change = flat ? 'bez zmiany' : `${d > 0 ? '+' : '−'}${def.diff(Math.abs(d))}`;
  return {
    html: `${head}<br>${change}`,
    cls: improved ? ' is-up' : worse ? ' is-down' : '',
  };
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const project = state.project;
  if (!project) {
    mount(root, h('div', { class: 'empty-state', text: 'Brak aktywnego projektu – wróć do pulpitu i otwórz audyt.' }));
    return;
  }

  // Wejście w widok zalicza krok 2. Zapis „silent", bo zwykły save() przerysowałby
  // widok w trakcie jego budowania; powłoka i tak czyta stepsDone przy renderze powłoki.
  if (!(project.stepsDone || []).includes(2)) {
    markStepDone(2);
    await save({ silent: true });
  }

  if (!Array.isArray(state.pendingProposals)) state.pendingProposals = [];

  const scenario = state.ui.scenario === 'plan' ? 'plan' : 'now';
  const mode = state.ui.mode === 'night' ? 'night' : 'day';
  const standardMinutes = project.standardMinutes;
  const districts = project.districts || [];
  const defs = kpiDefs(standardMinutes);

  /* ---------------- Zasięgi dojścia po sieci pieszej ---------------- */

  // Izochrony dla wszystkiego, co może być czynnym AED albo kandydatem
  // optymalizatora. Punkty spoza cache są dopytywane w Mapboksie; te, dla
  // których się nie uda, model policzy okręgiem i widok o tym powie.
  const reach = await reachMapFor(
    [...state.points, ...(state.candidates || []), ...state.pendingProposals],
    // Widok rysuje się od razu z tego, co jest w cache; brakujące izochrony
    // dochodzą w tle i wtedy proszą o przerysowanie.
    { onLater: () => render(root, ctx) }
  );

  /* ---------------- Obliczenia (zawsze z model.js) ---------------- */

  /** Dwa przebiegi analyze() – „teraz" i „po planie" – dla podanej listy punktów. */
  const analysesFor = (points) => {
    const base = {
      demandPoints: state.demandPoints,
      points,
      districts,
      standardMinutes,
      population: project.population,
      mode,
      reach,
    };
    return {
      now: analyze({ ...base, scenario: 'now' }),
      plan: analyze({ ...base, scenario: 'plan' }),
    };
  };

  const gainFor = (site, points, excludeId = null) =>
    coverageGainFor(site, {
      demandPoints: state.demandPoints,
      points,
      standardMinutes,
      mode,
      excludeId,
      reach,
    });

  /* ---------------- Sub bar: dwa przełączniki ---------------- */

  if (ctx.subbar && ctx.subbar.controls) {
    mount(
      ctx.subbar.controls,
      segControl(
        [
          { value: 'now', label: 'Stan obecny' },
          { value: 'plan', label: 'Plan' },
        ],
        scenario,
        async (value) => {
          state.ui.scenario = value;
          await save();
        }
      ),
      segControl(
        [
          { value: 'day', label: 'Dzień' },
          { value: 'night', label: 'Noc (24/7)' },
        ],
        mode,
        async (value) => {
          state.ui.mode = value;
          await save();
        }
      )
    );
  }

  /* ---------------- Szkielet: mapa + panel ---------------- */

  const mapEl = h('div', { class: 'map-wrap' });

  const kpiBox = h('div', { class: 'kpi-grid' });
  const gapsBox = h('div');
  const proposalsBox = h('div');

  const countInput = h('input', {
    class: 'input num',
    type: 'number',
    min: '1',
    max: '8',
    step: '1',
    value: String(Math.max(1, Math.min(8, Number(state.ui.proposeCount) || 2))),
    title: 'Ile punktów ma wybrać optymalizator',
    style: { width: '68px', flex: '0 0 68px' },
    // Bez save() przy każdym znaku: przerysowanie zabrałoby focus (i zjadło klik
    // w przycisk obok). Wartość trafia do IndexedDB przy najbliższym save().
    oninput: (e) => {
      const value = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 1));
      state.ui.proposeCount = value;
    },
  });

  const proposeBtn = h(
    'button',
    {
      class: 'btn btn--primary',
      style: { flex: '1' },
      onclick: async () => {
        const count = Math.max(1, Math.min(8, Number(state.ui.proposeCount) || 2));
        const takenByPending = new Set(state.pendingProposals.map((p) => p.candidateId));
        // proposeNewPoints() sam pomija kandydatów użytych w state.points;
        // tu dokładamy tych, którzy czekają już w pendingProposals.
        const free = (state.candidates || []).filter((c) => !takenByPending.has(c.id));

        if (!free.length) {
          toast('Brak wolnych kandydatów – wszyscy są już propozycją albo punktem.');
          return;
        }

        const picks = proposeNewPoints({
          demandPoints: state.demandPoints,
          points: state.points,
          candidates: free,
          standardMinutes,
          count,
          mode,
          reach,
        });

        if (!picks.length) {
          toast('Żaden z wolnych kandydatów nie poprawia już pokrycia w tym trybie.');
          return;
        }

        checkpoint('wygenerowanie propozycji');
        state.pendingProposals = [...state.pendingProposals, ...picks];
        await save();
        toast(
          `Nowe propozycje: ${fmtNum(picks.length)} · łączny zysk ${fmtPct(
            picks.reduce((sum, p) => sum + p.gainPct, 0),
            1
          )} pokrycia.`
        );
      },
    },
    'ZAPROPONUJ NOWE PUNKTY'
  );

  /* ---------------- „Jak czytać tę mapę" (uwaga klienta nr 5) ---------------- */

  const legendRow = (dot, label, why) =>
    h(
      'div',
      { style: { marginBottom: '5px' } },
      h('div', { class: 'row', style: { gap: '6px' }, html: `${dot}<b style="font-size:12px">${label}</b>` }),
      h('div', { class: 'note', style: { marginLeft: '14px' }, text: why })
    );

  /**
   * Usunięcie rekomendacji z mapy. Propozycja czekająca na decyzję wypada
   * z kolejki, rekomendacja już dołożona do projektu – z listy punktów.
   * Obie operacje odwraca „Cofnij" w pasku górnym.
   */
  const deleteProposal = async (sel) => {
    if (!sel || sel.kind !== 'proposed') return;
    const name = sel.site.name || sel.site.id;
    const ok = await modal({
      title: 'Usunąć rekomendację?',
      body: h(
        'div',
        {},
        h('p', { text: `„${name}" zniknie z mapy, a pokrycie przeliczy się bez niej.` }),
        h('p', { class: 'note', text: 'Pomyłkę odwraca „Cofnij" w pasku górnym.' })
      ),
      confirmLabel: 'USUŃ',
    });
    if (!ok) return;

    checkpoint(`usunięcie rekomendacji „${name}”`);
    if (sel.pending) {
      state.pendingProposals = state.pendingProposals.filter((pr) => pendingPinId(pr) !== sel.pinId);
    } else {
      removePoint(sel.site.id);
    }
    selectedReachId = null;
    if (state.ui.selectedPointId === sel.pinId) state.ui.selectedPointId = null;
    await save();
    toast(`Rekomendacja „${name}" usunięta.`);
  };

  /** Aktywna karta punktu – to samo miejsce co w inwentaryzacji: pod belką panelu. */
  const selectedBox = h('div', { class: 'panel__selected', style: { display: 'none' } });

  const paintSelected = () => {
    const hide = () => {
      selectedBox.style.display = 'none';
      selectedBox.className = 'panel__selected';
      mount(selectedBox);
    };
    const sel = findSelected();
    if (!sel) return hide();

    const { site, kind, pending } = sel;
    const routes = routeLinesFor(sel);
    const hasReach = !!(contoursFor(site.lat, site.lon) || {})[standardMinutes];
    const longest = routes.reduce((best, r) => (r.distanceM > (best?.distanceM || 0) ? r : best), null);
    const proposal = kind === 'proposed';

    // Zysk liczony na żywo tym samym coverageGainFor(), którego używa
    // optymalizator – a nie wartością zapamiętaną przy dodaniu punktu.
    const gain = proposal ? gainFor(site, state.points, pending ? null : site.id) : null;

    selectedBox.style.display = '';
    selectedBox.className = `panel__selected${proposal ? ' panel__selected--proposed' : ''}`;

    mount(
      selectedBox,
      h(
        'div',
        { class: 'row', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { style: { flex: '1', minWidth: '0' } },
          h('span', { class: 'label-caps', text: proposal ? 'Aktywna rekomendacja' : 'Aktywny punkt' }),
          h('div', { style: { fontWeight: '600', fontSize: '13px' }, text: site.name || site.id })
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--ghost',
            title: 'Zamknij kartę i odkliknij punkt',
            onclick: () => {
              selectedReachId = null;
              paintScene();
              paintSelected();
            },
          },
          '✕'
        )
      ),
      gain
        ? h('div', {
            class: 'num',
            style: { fontWeight: '700', fontSize: '15px', marginTop: '4px', color: 'var(--phase-3)' },
            text: `+${fmtPct(gain.gainPct, 1)} pokrycia · ${fmtNum(gain.gainWeight)} os. więcej w zasięgu`,
          })
        : null,
      h('p', {
        class: 'note',
        text: hasReach
          ? routes.length
            ? `${fmtNum(routes.length)} tras dojścia po realnych chodnikach i ulicach, każda przycięta do ` +
              `${fmtMin(standardMinutes, 0)} marszu i do obrysu; najdłuższa ma ${fmtNum(longest.distanceM, 0)} m.`
            : 'Zasięg policzony po sieci pieszej. Trasy dojścia dociągam z Mapboksa…'
          : 'Zasięg tego punktu nie przyszedł jeszcze z sieci – pokazany obszar jest przybliżeniem kołowym.',
      }),
      h(
        'div',
        { class: 'row', style: { gap: '6px' } },
        pending
          ? h('span', { html: pillHtml('CZEKA NA DECYZJĘ', 'warn') })
          : h(
              'button',
              {
                class: 'btn btn--sm btn--primary',
                onclick: () => ctx.navigate(`#/card/${encodeURIComponent(site.id)}`),
              },
              'OTWÓRZ KARTĘ'
            ),
        // Rekomendację można zdjąć z mapy od razu z karty – bez wchodzenia
        // w pełny widok punktu. Punktów istniejących ten przycisk nie dotyczy:
        // inwentaryzacja jest zapisem stanu faktycznego, nie planu.
        proposal
          ? h(
              'button',
              {
                class: 'btn btn--sm btn--ghost btn--danger',
                title: 'Usuń tę rekomendację z mapy',
                onclick: () => deleteProposal(sel),
              },
              'USUŃ PUNKT'
            )
          : null
      )
    );

    // Brakujące trasy dociągamy w tle – karta odświeży się sama.
    ensureRoutes(sel);
  };

  /* ---------------- Metodyka (adaptuje się do źródła zasięgu) ---------------- */

  const methodBox = h('p', { class: 'note' });

  const paintMethod = (current) => {
    const stats = current.reachStats || { network: 0, total: 0 };
    methodBox.textContent =
      current.reachMode === 'radius'
        ? `Model przybliżony: prędkość marszu ${fmtNum(WALK_SPEED, 0)} m/min, współczynnik obejścia ` +
          `${fmtNum(DETOUR, 2)}, promień ${fmtNum(coverageRadiusM(standardMinutes), 0)} m. ` +
          'Nie udało się pobrać zasięgów po sieci pieszej – liczymy okręgami.'
        : `Zasięg liczony po realnej sieci pieszej (izochrony ${fmtMin(standardMinutes, 0)} marszu): ` +
          `${fmtNum(stats.network)} z ${fmtNum(stats.total)} czynnych AED ma obrys z sieci` +
          (current.reachMode === 'mixed' ? ', pozostałe liczone są okręgiem.' : '. ') +
          'Tory, rzeka czy ogrodzenie potrafią odciąć teren, który w linii prostej wygląda na bliski – ' +
          'dlatego obrysy nie są kołami.';
  };

  const panel = h(
    'aside',
    { class: 'panel panel--metrics' },
    h(
      'div',
      { class: 'panel__head' },
      h('h3', { text: 'Wskaźniki – na żywo' }),
      h('span', { html: pillHtml(scenario === 'plan' ? 'PLAN' : 'STAN OBECNY') }),
      h('span', { html: pillHtml(mode === 'night' ? 'NOC' : 'DZIEŃ') })
    ),
    selectedBox,
    h(
      'div',
      { class: 'panel__body' },
      section('Wskaźniki – teraz → po planie', kpiBox),
      section('Luki wg dzielnic', gapsBox),
      section('Propozycje nowych punktów', proposalsBox),
      section(
        'Optymalizator pokrycia',
        h('div', { class: 'row' }, countInput, proposeBtn),
        h('p', {
          class: 'note',
          text:
            'Greedy max coverage: dla każdego kandydata liczony jest zysk z jeszcze ' +
            'niepokrytych punktów popytu, wybierany najlepszy, potem powtórka. ' +
            'Propozycje czekają na akceptację i nie wchodzą do planu przed ✓.',
        })
      ),
      h('div', { class: 'divider' }),
      methodBox
    )
  );

  mount(root, mapEl, panel);

  /* ---------------- Malowanie panelu ---------------- */

  const paintKpis = (nowAnalysis, planAnalysis, currentAnalysis) => {
    mount(
      kpiBox,
      ...defs.map((def) => {
        const delta = kpiDelta(def, def.read(nowAnalysis), def.read(planAnalysis));
        return h(
          'div',
          { class: 'kpi' },
          h('div', { class: 'kpi__label', text: def.label }),
          h('div', { class: 'kpi__value', text: def.fmt(def.read(currentAnalysis)) }),
          h('div', { class: `kpi__delta${delta.cls}`, html: delta.html })
        );
      })
    );
  };

  const paintGaps = (currentAnalysis) => {
    const gaps = currentAnalysis.gaps;
    if (!gaps.length) {
      mount(
        gapsBox,
        h('div', {
          class: 'empty-state',
          text: 'Brak dzielnic z ludnością poza zasięgiem w tym scenariuszu.',
        })
      );
      return;
    }

    const uncoveredTotal = gaps.reduce((sum, g) => sum + g.uncoveredPeople, 0);
    mount(
      gapsBox,
      h('div', {
        class: 'note num',
        style: { marginBottom: '6px' },
        text: `${fmtNum(gaps.length)} dzielnic z luką · razem ${fmtNum(uncoveredTotal)} os. poza zasięgiem.`,
      }),
      ...gaps.map((gap, index) =>
        h(
          'div',
          { style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
          h(
            'div',
            { class: 'row' },
            h('span', { style: { fontWeight: '500' }, text: gap.name }),
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted num', text: fmtPct(gap.uncoveredPct, 0) })
          ),
          h('div', {
            class: 'muted num',
            style: { fontSize: '11.5px' },
            text:
              `${fmtNum(gap.uncoveredPeople)} os. poza · max ${fmtMin(gap.maxMin, 1)}` +
              (index < GAP_LABELS_ON_MAP ? ' · etykieta na mapie' : ''),
          }),
          h('div', { style: { marginTop: '5px' }, html: barHtml(gap.uncoveredPct, gapVariant(gap.uncoveredPct)) })
        )
      )
    );
  };

  /* ---------------- Akcje na propozycjach ---------------- */

  const acceptPending = async (candidateId) => {
    const proposal = state.pendingProposals.find((p) => p.candidateId === candidateId);
    if (!proposal) return;

    const presetId = getPreset(proposal.presetId) ? proposal.presetId : 'P1';
    const point = makePoint({
      id: nextId('NEW'),
      name: proposal.name,
      lat: proposal.lat,
      lon: proposal.lon,
      presetId,
      districtId: proposal.districtId || districtAt(proposal.lat, proposal.lon),
      kind: 'proposed',
    });
    point.status = 'accepted';
    point.candidateId = proposal.candidateId;
    point.gainPct = proposal.gainPct;
    point.gainWeight = proposal.gainWeight;
    // Szafka na elewacji i totem są z definicji dostępne całodobowo, punkt
    // w budynku publicznym – nie. Tak samo jest w danych demo.
    point.access.always = OUTDOOR_PRESETS.has(presetId);
    point.phase = OUTDOOR_PRESETS.has(presetId) ? 3 : 2;

    checkpoint(`akceptację propozycji „${proposal.name}”`);
    upsertPoint(point);
    state.pendingProposals = state.pendingProposals.filter((p) => p.candidateId !== candidateId);
    await save();
    toast(`Zaakceptowano: ${point.name} → ${point.id}. Punkt jest już w krokach 3 i 4.`);
  };

  const rejectPending = async (candidateId) => {
    const proposal = state.pendingProposals.find((p) => p.candidateId === candidateId);
    if (!proposal) return;
    checkpoint(`odrzucenie propozycji „${proposal.name}”`);
    state.pendingProposals = state.pendingProposals.filter((p) => p.candidateId !== candidateId);
    await save();
    toast(`Odrzucono propozycję: ${proposal.name}.`);
  };

  const setPointStatus = async (pointId, status, message) => {
    const point = getPoint(pointId);
    if (!point) return;
    checkpoint(`zmianę statusu „${point.name}”`);
    point.status = status;
    upsertPoint(point);
    await save();
    toast(message.replace('%s', point.name));
  };

  /* ---------------- Karty propozycji ---------------- */

  const proposalCard = (item) => {
    const preset = getPreset(item.presetId);
    const gain = item.gain;
    const buttons = [];

    if (item.type === 'pending') {
      buttons.push(
        h(
          'button',
          {
            class: 'btn btn--sm',
            title: 'Akceptuj – punkt trafi do planu, kart i roadmapy',
            'aria-label': 'Akceptuj propozycję',
            onclick: () => acceptPending(item.candidateId),
          },
          '✓'
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--danger',
            title: 'Odrzuć – propozycja znika z listy',
            'aria-label': 'Odrzuć propozycję',
            onclick: () => rejectPending(item.candidateId),
          },
          '✕'
        )
      );
    } else if (item.status === 'proposed') {
      buttons.push(
        h(
          'button',
          {
            class: 'btn btn--sm',
            title: 'Akceptuj – punkt wejdzie do scenariusza Plan',
            'aria-label': 'Akceptuj propozycję',
            onclick: () => setPointStatus(item.id, 'accepted', 'Zaakceptowano: %s.'),
          },
          '✓'
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--danger',
            title: 'Odrzuć – punkt zostanie oznaczony jako odrzucony',
            'aria-label': 'Odrzuć propozycję',
            onclick: () => setPointStatus(item.id, 'rejected', 'Odrzucono: %s.'),
          },
          '✕'
        )
      );
    } else if (item.status === 'accepted') {
      buttons.push(
        h(
          'button',
          {
            class: 'btn btn--sm',
            title: 'Cofnij akceptację – punkt wróci do propozycji',
            onclick: () => setPointStatus(item.id, 'proposed', 'Cofnięto akceptację: %s.'),
          },
          'Cofnij'
        )
      );
    } else {
      buttons.push(
        h(
          'button',
          {
            class: 'btn btn--sm',
            title: 'Przywróć propozycję do rozpatrzenia',
            onclick: () => setPointStatus(item.id, 'proposed', 'Przywrócono propozycję: %s.'),
          },
          'Przywróć'
        )
      );
    }

    return h(
      'div',
      { class: 'card', style: { marginBottom: '8px' } },
      h(
        'div',
        { class: 'row' },
        h('span', { html: dotHtml('proposed') }),
        h('span', { style: { fontWeight: '500' }, text: item.name }),
        h('span', { class: 'spacer' }),
        h('span', { html: pillHtml(item.statusLabel, item.statusVariant) })
      ),
      h('div', {
        class: 'muted',
        style: { fontSize: '11.5px', marginTop: '3px' },
        text:
          `${preset ? `${preset.id} · ${preset.name} · ${fmtCost(preset.cost)}` : 'brak presetu'} · ` +
          `${districtName(item.districtId)}`,
      }),
      h(
        'div',
        { class: 'row', style: { marginTop: '8px' } },
        h('span', {
          class: 'num',
          style: { fontWeight: '600' },
          text: `+${fmtPct(gain.gainPct, 1)} pokrycia`,
        }),
        h('span', { class: 'muted num', style: { fontSize: '11.5px' }, text: `(${fmtNum(gain.gainWeight)} os.)` }),
        h('span', { class: 'spacer' }),
        ...buttons
      ),
      item.type === 'pending'
        ? h('div', {
            class: 'note',
            style: { marginTop: '6px' },
            text: 'Czeka na decyzję – nie jest jeszcze punktem projektu. Pin przeciągasz na mapie.',
          })
        : null
    );
  };

  const paintProposals = (points, pending) => {
    const items = [];

    for (const proposal of pending) {
      const meta0 = statusMeta({ kind: 'proposed', status: 'proposed' });
      items.push({
        type: 'pending',
        candidateId: proposal.candidateId,
        name: proposal.name,
        presetId: proposal.presetId,
        districtId: proposal.districtId,
        statusLabel: meta0.label,
        statusVariant: meta0.variant,
        gain: gainFor({ lat: proposal.lat, lon: proposal.lon }, points),
      });
    }

    const order = { proposed: 0, accepted: 1, rejected: 2 };
    const proposedPoints = points
      .filter((p) => p.kind === 'proposed' && order[p.status] !== undefined)
      .sort((a, b) => order[a.status] - order[b.status]);

    for (const point of proposedPoints) {
      const meta0 = statusMeta(point);
      items.push({
        type: 'point',
        id: point.id,
        status: point.status,
        name: point.name,
        presetId: point.presetId,
        districtId: point.districtId,
        statusLabel: meta0.label,
        statusVariant: meta0.variant,
        // Zysk liczony na żywo: ile ten punkt dokłada ponad resztę planu.
        gain: gainFor({ lat: point.lat, lon: point.lon }, points, point.id),
      });
    }

    if (!items.length) {
      mount(
        proposalsBox,
        h('div', {
          class: 'empty-state',
          text: 'Brak propozycji – użyj przycisku „ZAPROPONUJ NOWE PUNKTY" poniżej.',
        })
      );
      return;
    }

    mount(proposalsBox, ...items.map(proposalCard));
  };

  /**
   * Przemalowanie całego panelu dla podanej (być może tymczasowej) listy punktów.
   * Zwraca analizę bieżącego scenariusza – mapa korzysta z niej przy pierwszym renderze.
   */
  const paintPanel = (points, pending) => {
    const { now, plan } = analysesFor(points);
    const current = scenario === 'plan' ? plan : now;
    paintKpis(now, plan, current);
    paintGaps(current);
    paintProposals(points, pending);
    paintMethod(current);
    return current;
  };

  const analysis = paintPanel(state.points, state.pendingProposals);

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(analysis.activeCount)} czynnych AED · pokrycie ${fmtPct(analysis.coveragePct, 0)} · ` +
        `luki w ${fmtNum(analysis.gaps.length)} dzielnicach · ` +
        (analysis.reachMode === 'radius' ? 'zasięg przybliżony okręgiem' : 'zasięg po sieci pieszej')
    );
  }

  /* ---------------- Mapa ---------------- */

  releaseMap();

  map = createMap(mapEl, { center: project.center || undefined, zoom: project.zoom || undefined });

  mapEl.appendChild(
    h('div', {
      class: 'map-hint',
      text: 'Kliknij w mapę, aby dodać rekomendację · przeciągnij kwadratowy pin, aby ją przesunąć.',
    })
  );

  mapEl.appendChild(
    mapLegend('Legenda', [
      h('p', {
        class: 'note',
        style: { marginTop: '2px' },
        text:
          `Pytanie tej mapy: gdzie mieszkaniec NIE zdąży dobiec do AED w ${fmtMin(standardMinutes, 0)} i wrócić. ` +
          'Każda kropka to skupisko ludności, obrys to realny zasięg jednego AED.',
      }),
      legendRow(dotHtml('ok'), 'zielona kropka', 'w zasięgu – ktoś zdąży przynieść AED na czas'),
      legendRow(dotHtml('warn'), 'żółta kropka', 'na granicy standardu'),
      legendRow(dotHtml('crit'), 'czerwona kropka', 'poza zasięgiem – nie obsługuje ich żadne AED'),
      legendRow(dotHtml('square'), 'limonkowy kwadrat', 'propozycja – przeciągnij, licznik przeliczy się na żywo'),
      legendRow(
        '<svg width="14" height="8" aria-hidden="true"><line x1="0" y1="4" x2="14" y2="4" ' +
          'stroke="#4caf7d" stroke-width="1.6" stroke-opacity="0.5" stroke-dasharray="4 3"/></svg>',
        'przerywane linie',
        'trasy dojścia do wybranego punktu – kreski biegną od granicy zasięgu do pinu, ' +
          `każda trasa to ${fmtMin(standardMinutes, 0)} marszu (ciemnozielone dla propozycji)`
      ),
      h('p', {
        class: 'note',
        text:
          analysis.reachMode === 'radius'
            ? `Kryterium: ${fmtNum(analysis.radiusM, 0)} m w linii prostej – przybliżenie, brak danych o sieci pieszej.`
            : `Kryterium: ${fmtMin(standardMinutes, 0)} marszu po realnych chodnikach i ulicach. Obrys to izochrona, nie okrąg.`,
      }),
      h('p', {
        class: 'note',
        text:
          'Klik w pin – także w limonkową propozycję – pokazuje jej obrys, trasy dojścia i zysk pokrycia ' +
          'w karcie w panelu obok; drugi klik otwiera pełną kartę punktu.',
      }),
    ])
  );

  const reachStats = reachCoverageOf(analysis.activePoints || [], reach);

  mapEl.appendChild(
    h(
      'div',
      { class: 'map-toolbar' },
      h('span', {
        class: `pill ${reachStats.radius ? 'pill--warn' : 'pill--ok'}`,
        title:
          'Obrys zasięgu pochodzi z izochron Mapboksa liczonych po sieci pieszej OSM. ' +
          'Punkty bez izochrony liczone są zapasowo okręgiem.',
        text: reachStats.radius
          ? `ZASIĘG PO SIECI PIESZEJ – ${fmtNum(reachStats.network)}/${fmtNum(reachStats.total)} AED`
          : 'ZASIĘG PO REALNEJ SIECI PIESZEJ',
      }),
      basemapThemeSwitch(map)
    )
  );

  /** Piny: istniejące (statyczne) + propozycje (przeciągalne). */
  const buildPins = () => {
    const pins = state.points
      .filter((p) => p.kind === 'existing' && p.status !== 'rejected')
      .map((p) => ({
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        level: pointStatusLevel(p, completeness(p, getPreset(p.presetId), state.photos).pct),
        name: p.name,
        draggable: false,
      }));

    for (const p of state.points) {
      if (p.kind !== 'proposed' || p.status === 'rejected') continue;
      pins.push({
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        level: 'proposed',
        name: `${p.name} – propozycja`,
        draggable: true,
      });
    }

    for (const proposal of state.pendingProposals) {
      pins.push({
        id: pendingPinId(proposal),
        lat: proposal.lat,
        lon: proposal.lon,
        level: 'proposed',
        name: `${proposal.name} – propozycja (czeka na decyzję)`,
        draggable: true,
      });
    }

    return pins;
  };

  /** Etykiety „LUKA: …" w centroidach trzech najgorszych dzielnic. */
  const buildGapLabels = (currentAnalysis) => {
    const features = (state.districtsGeo && state.districtsGeo.features) || [];
    return currentAnalysis.gaps
      .slice(0, GAP_LABELS_ON_MAP)
      .map((gap) => {
        const feature = features.find((f) => f.properties.id === gap.districtId);
        if (!feature) return null;
        const centre = ringCentroid(feature.geometry.coordinates[0]);
        return { lat: centre.lat, lon: centre.lon, text: `LUKA: ${gap.name}`, kind: 'gap' };
      })
      .filter(Boolean);
  };

  /**
   * Obrysy realnego zasięgu dojścia dla czynnych AED bieżącego scenariusza.
   * Wybrany punkt dostaje mocniejszy obrys – reszta zostaje tłem.
   */
  /**
   * Wybrany punkt: szukamy w punktach projektu, a potem w propozycjach
   * czekających na decyzję. Świeżo dołożona rekomendacja nie jest jeszcze
   * „czynnym AED", a operator i tak chce zobaczyć jej zasięg i zysk.
   */
  const findSelected = () => {
    if (!selectedReachId) return null;
    const point = state.points.find((p) => p.id === selectedReachId);
    if (point) {
      return {
        site: point,
        kind: point.kind === 'proposed' ? 'proposed' : 'existing',
        pending: false,
        pinId: point.id,
      };
    }
    // Propozycja czekająca na decyzję nie ma jeszcze id punktu – na mapie
    // identyfikuje ją id pinu, więc to ono jest tu kluczem.
    const proposal = state.pendingProposals.find((pr) => pendingPinId(pr) === selectedReachId);
    if (proposal) return { site: proposal, kind: 'proposed', pending: true, pinId: selectedReachId };
    return null;
  };

  /**
   * Lokalizacje, którym rysujemy obrys zasięgu: czynne AED scenariusza oraz
   * KAŻDA rekomendacja – także ta, która w bieżącym scenariuszu nie liczy się
   * jeszcze do pokrycia. Bez tego pin rekomendacji wisiał na mapie bez obrysu
   * i nie było widać, jaki obszar miałby obsłużyć.
   */
  const shapeSites = () => {
    const list = [];
    const seen = new Set();
    const add = (site, kind, pinId) => {
      if (seen.has(pinId)) return;
      seen.add(pinId);
      list.push({ site, kind, pinId });
    };

    for (const p of analysis.activePoints || []) {
      add(p, p.kind === 'proposed' ? 'proposed' : 'existing', p.id);
    }
    for (const p of state.points) {
      if (p.kind !== 'proposed' || p.status === 'rejected') continue;
      add(p, 'proposed', p.id);
    }
    for (const proposal of state.pendingProposals) {
      add(proposal, 'proposed', pendingPinId(proposal));
    }

    const sel = findSelected();
    if (sel) add(sel.site, sel.kind, sel.pinId);
    return list;
  };

  const buildReachShapes = () =>
    shapeSites()
      .map(({ site: p, kind, pinId }) => {
        const contours = contoursFor(p.lat, p.lon);
        const ring = (contours && contours[standardMinutes]) ||
          // Bez izochrony rysujemy okrąg, którym model i tak ten punkt liczy –
          // lepiej pokazać przybliżenie z adnotacją niż pustą mapę.
          circlePolygon(p.lat, p.lon, analysis.radiusM).coordinates[0];
        return { id: pinId, kind, ring, emphasis: pinId === selectedReachId };
      })
      .filter(Boolean);

  /** Trasy dojścia wybranego punktu – w kolorze jego obrysu. */
  /**
   * Trasy dojścia wybranego punktu, gotowe do narysowania.
   *
   * Każda trasa jest przycięta do obrysu standardu i do jego budżetu czasu
   * (patrz trimRouteToReach) – dlatego nigdy nie wystaje poza zielone czy
   * pole zasięgu i zawsze odpowiada temu samemu czasowi dojścia.
   * Kolejność współrzędnych odwracamy: Directions liczy od pinu na zewnątrz,
   * a animacja płynie w kierunku rysowania – po odwróceniu kreski biegną
   * od granicy DO pinu, jak człowiek biegnący po AED.
   */
  const routeLinesFor = (sel) => {
    if (!sel) return [];
    const routes = routesFor(sel.site.lat, sel.site.lon) || [];
    const ring = (contoursFor(sel.site.lat, sel.site.lon) || {})[standardMinutes] || null;
    return routes
      .map((r) => {
        const cut = trimRouteToReach(r.line, ring, {
          maxMinutes: standardMinutes,
          distanceM: r.distanceM,
          durationMin: r.durationMin,
        });
        return cut.line.length >= 2
          ? { line: cut.line.slice().reverse(), kind: sel.kind, distanceM: cut.distanceM, minutes: cut.minutes }
          : null;
      })
      .filter(Boolean);
  };

  const buildRouteLines = () => routeLinesFor(findSelected());

  /**
   * Trasy dla punktu spoza cache (np. świeżo dołożonej rekomendacji)
   * dociągamy z Mapboksa po kliknięciu i wtedy przemalowujemy mapę.
   */
  const ensureRoutes = async (sel) => {
    if (!sel || routesFor(sel.site.lat, sel.site.lon)) return;
    const contours = contoursFor(sel.site.lat, sel.site.lon);
    const ring = contours && contours[standardMinutes];
    if (!ring) return;
    const got = await fetchRoutes(sel.site.lat, sel.site.lon, ring);
    if (got.length && selectedReachId === sel.pinId) {
      paintScene();
      paintSelected();
    }
  };

  const paintScene = () => {
    map.setScene({
      boundary: state.boundary,
      districts: state.districtsGeo,
      // Obrysy dzielnic wyłączone: nakładały się na punkty popytu i utrudniały
      // czytanie kolorów. Nazwy dzielnic zostają w panelu luk.
      showDistricts: false,
      // Zamiast okręgów – realne izochrony po sieci pieszej (patrz reach.js).
      coverage: [],
      showCoverage: false,
      reach: buildReachShapes(),
      showReach: true,
      routes: buildRouteLines(),
      showRoutes: true,
      demand: analysis.demandStatus,
      showDemand: true,
      targetMinutes: standardMinutes,
      points: buildPins(),
      labels: buildGapLabels(analysis),
      selectedId: state.ui.selectedPointId,
      walker: walker ? walker.scene() : null,
    });
  };

  // Ludzik świadka: dok przy lewej krawędzi mapy, karta z wynikiem pod nim.
  // Powołujemy go po zbudowaniu mapy, bo potrzebuje przeliczeń ekran/współrzędne.
  if (walker) {
    walkerAt = walker.getPlace();
    walker.destroy();
  }
  walker = createWalker({
    mapEl,
    map,
    activePoints: () => analysis.activePoints || [],
    standardMinutes,
    initialAt: walkerAt,
    onChange: () => {
      walkerAt = walker.getPlace();
      paintScene();
    },
  });
  mapEl.appendChild(walker.dock);
  mapEl.appendChild(walker.card);

  paintScene();
  paintSelected();
  // Widok przerysowuje się po każdej zmianie danych (przesunięcie pinu, nowa
  // rekomendacja). Kadr wraca taki, jaki był – bez odjeżdżania do całego miasta.
  if (savedCamera && typeof map.setCamera === 'function') map.setCamera(savedCamera);
  else map.fit();

  /* ---------------- Interakcje mapy ---------------- */

  // Klik w pin nie przerzuca już od razu do karty: najpierw pokazuje, SKĄD
  // bierze się zasięg tego AED – obrys na mocno i trasy dojścia, które go
  // narysowały. Do karty prowadzi przycisk w panelu i drugi klik w ten sam pin.
  map.on('pointclick', (pin) => {
    // Propozycja czekająca na decyzję zachowuje się tak samo jak punkt
    // istniejący: pokazuje swój obrys, trasy dojścia i zysk pokrycia.
    // Karty punktu jeszcze nie ma, więc drugi klik jej nie otwiera.
    if (selectedReachId === pin.id) {
      if (isPendingPin(pin.id)) {
        toast('Propozycja czeka na decyzję – po ✓ dostanie własną kartę punktu.');
        return;
      }
      ctx.navigate(`#/card/${encodeURIComponent(pin.id)}`);
      return;
    }
    selectedReachId = pin.id;
    // Kamera schodzi niżej i mocniej się pochyla, żeby było widać bryły wokół
    // punktu. Na renderze zapasowym to pusta operacja.
    if (typeof map.flyToPoint === 'function') map.flyToPoint(pin.lat, pin.lon);
    paintScene();
    paintSelected();
  });

  // Klik w puste miejsce mapy dokłada rekomendację (limonkowy kwadrat) – to
  // najszybsza odpowiedź na pytanie „a gdyby AED stanęło tutaj?". Zysk liczy
  // ten sam coverageGainFor(), którego używa optymalizator, więc nowa
  // rekomendacja jest porównywalna z propozycjami wygenerowanymi automatycznie.
  // Pomyłkę odwraca „Cofnij" w pasku górnym.
  map.on('mapclick', async ({ lat, lon }) => {
    const districtId = districtAt(lat, lon);
    if (!districtId) {
      toast('Kliknięcie poza granicą miasta – rekomendacji nie dodano.');
      return;
    }

    const presetId = 'P1';
    const point = makePoint({
      id: nextId('NEW'),
      name: `Rekomendacja – ${districtName(districtId)}`,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      presetId,
      districtId,
      kind: 'proposed',
    });
    const gain = gainFor({ lat: point.lat, lon: point.lon }, state.points);
    point.gainPct = gain.gainPct;
    point.gainWeight = gain.gainWeight;
    point.access.always = OUTDOOR_PRESETS.has(presetId);
    point.phase = OUTDOOR_PRESETS.has(presetId) ? 3 : 2;

    checkpoint('dodanie rekomendacji na mapie');
    upsertPoint(point);
    // Nowy punkt od razu staje się aktywny: operator widzi jego obrys zasięgu,
    // trasy dojścia i wpływ na pokrycie bez dodatkowego kliknięcia.
    // Izochrona dla świeżej lokalizacji dochodzi z Mapboksa w tle – do tego
    // czasu obrys jest kołowy, a karta mówi o tym wprost.
    selectedReachId = point.id;
    await save();
    toast(`Rekomendacja ${point.id} · +${fmtPct(gain.gainPct, 1)} pokrycia. Zaakceptuj ją albo cofnij.`);
  });

  // Przeciąganie na żywo: liczymy na tymczasowej kopii i przemalowujemy panel.
  // Nic nie trafia do IndexedDB – zapis dopiero w pointdragend.
  let lastDrag = null;
  map.on('pointdrag', (pin) => {
    lastDrag = pin;
    if (dragTimer) return;
    dragTimer = setTimeout(() => {
      dragTimer = null;
      const moved = lastDrag;
      lastDrag = null;
      if (!moved) return;
      const points = state.points.map((p) =>
        p.id === moved.id ? { ...p, lat: moved.lat, lon: moved.lon } : p
      );
      const pending = state.pendingProposals.map((p) =>
        pendingPinId(p) === moved.id ? { ...p, lat: moved.lat, lon: moved.lon } : p
      );
      paintPanel(points, pending);
    }, DRAG_THROTTLE_MS);
  });

  map.on('pointdragend', async (pin) => {
    if (dragTimer) {
      clearTimeout(dragTimer);
      dragTimer = null;
    }
    lastDrag = null;

    if (isPendingPin(pin.id)) {
      const proposal = state.pendingProposals.find((p) => pendingPinId(p) === pin.id);
      if (!proposal) return;
      checkpoint(`przesunięcie propozycji „${proposal.name}”`);
      proposal.lat = pin.lat;
      proposal.lon = pin.lon;
      proposal.districtId = districtAt(pin.lat, pin.lon) || proposal.districtId;
      const gain = gainFor({ lat: proposal.lat, lon: proposal.lon }, state.points);
      proposal.gainPct = gain.gainPct;
      proposal.gainWeight = gain.gainWeight;
      await save();
      toast(`${proposal.name}: +${fmtPct(gain.gainPct, 1)} pokrycia w nowym miejscu.`);
      return;
    }

    const point = getPoint(pin.id);
    if (!point) return;
    checkpoint(`przesunięcie punktu „${point.name}”`);
    point.lat = pin.lat;
    point.lon = pin.lon;
    point.districtId = districtAt(pin.lat, pin.lon) || point.districtId;
    if (point.kind === 'proposed') {
      const gain = gainFor({ lat: point.lat, lon: point.lon }, state.points, point.id);
      point.gainPct = gain.gainPct;
      point.gainWeight = gain.gainWeight;
    }
    upsertPoint(point);
    await save();
    toast(`Przesunięto: ${point.name} · ${districtName(point.districtId)}.`);
  });
}

/** Zdejmuje mapę, zapamiętując wcześniej kadr. */
function releaseMap() {
  if (!map) return;
  try {
    if (typeof map.getCamera === 'function') savedCamera = map.getCamera();
  } catch (err) {
    console.warn('map.getCamera() failed', err);
  }
  try {
    map.destroy();
  } catch (err) {
    console.warn('map.destroy() failed', err);
  }
  map = null;
}

export function destroy() {
  if (dragTimer) {
    clearTimeout(dragTimer);
    dragTimer = null;
  }
  if (walker) {
    walker.destroy();
    walker = null;
  }
  // Wyjście z widoku kasuje ludzika – wracając, zaczyna się od czystej mapy.
  walkerAt = null;
  releaseMap();
}
