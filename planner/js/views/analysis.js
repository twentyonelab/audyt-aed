/**
 * views/analysis.js — Krok 2: Analiza dostępności (SPEC §6.3, trasa '#/analysis').
 *
 * Mapa (strefy pokrycia, punkty popytu, etykiety luk, przeciągalne piny
 * propozycji) + panel wskaźników 380 px.
 *
 * Wszystkie liczby pochodzą z model.js — widok nie liczy nic samodzielnie:
 *   • analyze()          — KPI, luki wg dzielnic, status punktów popytu,
 *   • proposeNewPoints() — greedy max coverage dla kandydatów,
 *   • coverageGainFor()  — „+X% pokrycia" pojedynczej propozycji (także na żywo
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
  makePoint,
  nextId,
} from '../state.js';

import {
  analyze,
  proposeNewPoints,
  coverageGainFor,
  completeness,
  pointStatusLevel,
  coverageRadiusM,
  ringCentroid,
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
  disabledControl,
} from '../ui.js';

import { createMap } from '../map.js';

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

/** Presety zewnętrzne — szafka i totem pracują całodobowo (jak w danych demo). */
const OUTDOOR_PRESETS = new Set(['P3', 'P4']);

/** Próg, poniżej którego różnicę KPI uznajemy za brak zmiany. */
const EPS = 0.05;

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (przeżywa przerysowania, nie jest danymi projektu)
 * ------------------------------------------------------------------ */

let map = null;
let dragTimer = null;

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
    mount(root, h('div', { class: 'empty-state', text: 'Brak aktywnego projektu — wróć do pulpitu i otwórz audyt.' }));
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

  /* ---------------- Obliczenia (zawsze z model.js) ---------------- */

  /** Dwa przebiegi analyze() — „teraz" i „po planie" — dla podanej listy punktów. */
  const analysesFor = (points) => {
    const base = {
      demandPoints: state.demandPoints,
      points,
      districts,
      standardMinutes,
      population: project.population,
      mode,
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
          toast('Brak wolnych kandydatów — wszyscy są już propozycją albo punktem.');
          return;
        }

        const picks = proposeNewPoints({
          demandPoints: state.demandPoints,
          points: state.points,
          candidates: free,
          standardMinutes,
          count,
          mode,
        });

        if (!picks.length) {
          toast('Żaden z wolnych kandydatów nie poprawia już pokrycia w tym trybie.');
          return;
        }

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

  const panel = h(
    'aside',
    { class: 'panel', style: { width: '380px', flex: '0 0 380px' } },
    h(
      'div',
      { class: 'panel__head' },
      h('h3', { text: 'Wskaźniki — na żywo' }),
      h('span', { html: pillHtml(scenario === 'plan' ? 'PLAN' : 'STAN OBECNY') }),
      h('span', { html: pillHtml(mode === 'night' ? 'NOC' : 'DZIEŃ') })
    ),
    h(
      'div',
      { class: 'panel__body' },
      section('Wskaźniki — teraz → po planie', kpiBox),
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
      h('p', {
        class: 'note',
        text:
          `Model uproszczony (SPEC §5): prędkość marszu ${fmtNum(WALK_SPEED, 0)} m/min, ` +
          `współczynnik drogi ${fmtNum(DETOUR, 2)}, promień strefy ${fmtNum(
            coverageRadiusM(standardMinutes),
            0
          )} m dla standardu ${fmtMin(standardMinutes, 0)} w jedną stronę. ` +
          'Czas liczymy dla świadka, który biegnie po AED i wraca do poszkodowanego. ' +
          'W iteracji 3 zastąpią to izochrony po sieci pieszej — wtedy strefy przestaną być okręgami.',
      })
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
    // w budynku publicznym — nie. Tak samo jest w danych demo.
    point.access.always = OUTDOOR_PRESETS.has(presetId);
    point.phase = OUTDOOR_PRESETS.has(presetId) ? 3 : 2;

    upsertPoint(point);
    state.pendingProposals = state.pendingProposals.filter((p) => p.candidateId !== candidateId);
    await save();
    toast(`Zaakceptowano: ${point.name} → ${point.id}. Punkt jest już w krokach 3 i 4.`);
  };

  const rejectPending = async (candidateId) => {
    const proposal = state.pendingProposals.find((p) => p.candidateId === candidateId);
    if (!proposal) return;
    state.pendingProposals = state.pendingProposals.filter((p) => p.candidateId !== candidateId);
    await save();
    toast(`Odrzucono propozycję: ${proposal.name}.`);
  };

  const setPointStatus = async (pointId, status, message) => {
    const point = getPoint(pointId);
    if (!point) return;
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
            title: 'Akceptuj — punkt trafi do planu, kart i roadmapy',
            'aria-label': 'Akceptuj propozycję',
            onclick: () => acceptPending(item.candidateId),
          },
          '✓'
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--danger',
            title: 'Odrzuć — propozycja znika z listy',
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
            title: 'Akceptuj — punkt wejdzie do scenariusza Plan',
            'aria-label': 'Akceptuj propozycję',
            onclick: () => setPointStatus(item.id, 'accepted', 'Zaakceptowano: %s.'),
          },
          '✓'
        ),
        h(
          'button',
          {
            class: 'btn btn--sm btn--danger',
            title: 'Odrzuć — punkt zostanie oznaczony jako odrzucony',
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
            title: 'Cofnij akceptację — punkt wróci do propozycji',
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
            text: 'Czeka na decyzję — nie jest jeszcze punktem projektu. Pin przeciągasz na mapie.',
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
          text: 'Brak propozycji — użyj przycisku „ZAPROPONUJ NOWE PUNKTY" poniżej.',
        })
      );
      return;
    }

    mount(proposalsBox, ...items.map(proposalCard));
  };

  /**
   * Przemalowanie całego panelu dla podanej (być może tymczasowej) listy punktów.
   * Zwraca analizę bieżącego scenariusza — mapa korzysta z niej przy pierwszym renderze.
   */
  const paintPanel = (points, pending) => {
    const { now, plan } = analysesFor(points);
    const current = scenario === 'plan' ? plan : now;
    paintKpis(now, plan, current);
    paintGaps(current);
    paintProposals(points, pending);
    return current;
  };

  const analysis = paintPanel(state.points, state.pendingProposals);

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(analysis.activeCount)} czynnych AED · pokrycie ${fmtPct(analysis.coveragePct, 0)} · ` +
        `luki w ${fmtNum(analysis.gaps.length)} dzielnicach · promień ${fmtNum(analysis.radiusM, 0)} m`
    );
  }

  /* ---------------- Mapa ---------------- */

  if (map) {
    map.destroy();
    map = null;
  }

  map = createMap(mapEl, { center: project.center || undefined, zoom: project.zoom || undefined });

  mapEl.appendChild(
    h('div', {
      class: 'map-hint',
      text: 'Przeciągnij kwadratowy pin propozycji — wskaźniki liczą się na żywo.',
    })
  );

  mapEl.appendChild(
    h(
      'div',
      { class: 'map-legend' },
      h('b', { text: 'Analiza dostępności' }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('ok')}<span>punkt popytu w zasięgu</span>` }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('warn')}<span>blisko granicy standardu</span>` }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('crit')}<span>poza zasięgiem</span>` }),
      h('div', { class: 'map-legend__row', html: `${dotHtml('proposed')}<span>propozycja (przeciągalna)</span>` }),
      h('div', {
        class: 'note',
        style: { marginTop: '4px' },
        text: `Strefa = ${fmtNum(analysis.radiusM, 0)} m wokół czynnego AED (${fmtMin(standardMinutes, 0)}).`,
      })
    )
  );

  mapEl.appendChild(
    h(
      'div',
      { class: 'map-toolbar' },
      disabledControl(
        h('button', { class: 'btn btn--sm' }, 'IZOCHRONY — SIEĆ PIESZA'),
        'poza zakresem iteracji 2'
      )
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
        name: `${p.name} — propozycja`,
        draggable: true,
      });
    }

    for (const proposal of state.pendingProposals) {
      pins.push({
        id: pendingPinId(proposal),
        lat: proposal.lat,
        lon: proposal.lon,
        level: 'proposed',
        name: `${proposal.name} — propozycja (czeka na decyzję)`,
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

  map.setScene({
    boundary: state.boundary,
    districts: state.districtsGeo,
    showDistricts: true,
    coverage: analysis.activePoints.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      radiusM: analysis.radiusM,
      kind: p.kind === 'proposed' ? 'proposed' : 'existing',
    })),
    showCoverage: true,
    demand: analysis.demandStatus,
    showDemand: true,
    targetMinutes: standardMinutes,
    points: buildPins(),
    labels: buildGapLabels(analysis),
    selectedId: state.ui.selectedPointId,
  });
  map.fit();

  /* ---------------- Interakcje mapy ---------------- */

  map.on('pointclick', (pin) => {
    if (isPendingPin(pin.id)) {
      toast('Propozycja czeka na decyzję — po ✓ dostanie własną kartę punktu.');
      return;
    }
    ctx.navigate(`#/card/${encodeURIComponent(pin.id)}`);
  });

  // Przeciąganie na żywo: liczymy na tymczasowej kopii i przemalowujemy panel.
  // Nic nie trafia do IndexedDB — zapis dopiero w pointdragend.
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

export function destroy() {
  if (dragTimer) {
    clearTimeout(dragTimer);
    dragTimer = null;
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
