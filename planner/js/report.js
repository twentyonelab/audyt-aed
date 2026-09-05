/**
 * report.js – treść raportu dla decydenta (SPEC §6.7).
 *
 * Ten moduł buduje wyłącznie **treść**: osiem sekcji jako gotowe fragmenty HTML
 * plus pięć wskaźników KPI. Nie dotyka DOM widoku, nie tworzy mapy
 * interaktywnej, nie zapisuje stanu – dzięki temu tę samą treść da się w
 * iteracji 3 wyrenderować po stronie serwera do PDF-a bez żadnej zmiany.
 *
 * Warstwa widoku (`views/report-view.js`) opakowuje każdą sekcję w `.report-page`
 * z nagłówkiem brandingu i steruje tym, które sekcje są włączone.
 *
 * Zasady, których ten plik pilnuje:
 *  • wszystkie liczby pochodzą z `analyze()` i `roadmapTotals()` – w HTML nie ma
 *    ani jednej wpisanej na sztywno,
 *  • formatowanie wyłącznie przez fmtPct / fmtMin / fmtNum / fmtCost,
 *  • mapy „jest / będzie" rysuje `renderSceneSvg()` – statyczny SVG, który działa
 *    także bez tokenu Mapboxa i bez problemu wchodzi do druku,
 *  • kolor pojawia się tylko tam, gdzie niesie informację o danych
 *    (status punktu, faza, kierunek zmiany wskaźnika).
 */

import {
  analyze,
  completeness,
  pointStatusLevel,
  roadmapTotals,
  PHASE_META,
  coverageRadiusM,
  WALK_SPEED,
  DETOUR,
  fmtPct,
  fmtMin,
  fmtNum,
  fmtCost,
} from './model.js';

import { renderSceneSvg } from './map.js';
import { reachMapSync } from './reach.js';

import {
  escapeHtml,
  barHtml,
  pillHtml,
  dotHtml,
  statusMeta,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
} from './ui.js';

import { TODAY, OPERATOR } from '../config.js';

/* ------------------------------------------------------------------ *
 * Stałe modułu
 * ------------------------------------------------------------------ */

/** Osiem sekcji raportu w kolejności druku (SPEC §6.7). */
export const REPORT_SECTIONS = [
  { id: 'cover', title: 'Okładka' },
  { id: 'summary', title: 'Podsumowanie dla decydenta' },
  { id: 'current', title: 'Stan obecny' },
  { id: 'analysis', title: 'Analiza' },
  { id: 'recommendations', title: 'Rekomendacje' },
  { id: 'roadmap', title: 'Roadmapa' },
  { id: 'method', title: 'Metodyka' },
  { id: 'cards', title: 'Karty (załącznik)' },
];

/**
 * Zdanie kontekstowe wymagane przez SPEC §6.7 – jedyny fragment raportu, który
 * jest tekstem stałym, bo to cytat z materiałów merytorycznych, nie liczba
 * z modelu.
 */
export const CONTEXT_SENTENCE =
  'Karetka dojeżdża średnio w 8–15 min. Defibrylacja w 3–5 min daje 50–70% ' +
  'przeżywalności – każda minuta zwłoki to −10%.';

const OWNER_LABEL = { gmina: 'gmina', serwis: 'serwis', wykonawca: 'wykonawca' };

const KIND_LABEL = { existing: 'istniejący', proposed: 'nowy' };

/** Rozmiar mapy w raporcie – proporcja kolumny `.report-map` (SVG i tak skaluje się do 100%). */
const MAP_W = 300;
const MAP_H = 220;

const TODAY_MONTH = String(TODAY).slice(0, 7);

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy – czego brakuje, jest tutaj)
 * ------------------------------------------------------------------ */

const esc = escapeHtml;

/** Polska odmiana rzeczownika po liczebniku. */
function plural(n, [one, few, many]) {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const r100 = abs % 100;
  const r10 = abs % 10;
  if (r100 > 10 && r100 < 20) return many;
  return r10 >= 2 && r10 <= 4 ? few : many;
}

/**
 * Tabela raportu. Komórki przekazujemy jako **gotowy HTML** – każdy wywołujący
 * sam decyduje, co escape'uje (teksty z danych zawsze przez `esc()`).
 */
function tableHtml(headers, rows, align = []) {
  if (!rows.length) return '<p class="note">Brak danych do zestawienia.</p>';
  const cls = (i) => (align[i] === 'r' ? ' class="table__num"' : '');
  const head = headers.map((label, i) => `<th${cls(i)}>${esc(label)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((cell, i) => `<td${cls(i)}>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Dwukolumnowa metryka „etykieta → wartość" (okładka, wskaźniki wyjściowe). */
function factsHtml(pairs) {
  return tableHtml(
    ['Pozycja', 'Wartość'],
    pairs.map(([label, value]) => [`<span class="muted">${esc(label)}</span>`, `<strong>${value}</strong>`]),
    ['', 'r']
  );
}

function presetById(state, id) {
  return (state.presets || []).find((p) => p.id === id) || null;
}

function districtNameOf(state, id) {
  const list = (state.project && state.project.districts) || [];
  const found = list.find((d) => d.id === id);
  return found ? found.name : '–';
}

/** Udział procentowy elementów spełniających warunek. */
function share(list, test) {
  if (!list.length) return 0;
  return (100 * list.filter(test).length) / list.length;
}

const is247 = (p) => !!(p.access && p.access.always === true);

const hasKeeper = (p) => !!(p.keeper && p.keeper.org && String(p.keeper.org).trim());

/** Przegląd ważny = data przeglądu (RRRR-MM) nie jest wcześniejsza niż bieżący miesiąc. */
function inspectionValid(p) {
  const due = p.device && p.device.inspectionDue ? String(p.device.inspectionDue).slice(0, 7) : null;
  return !!due && due >= TODAY_MONTH;
}

/** Czy dla punktu zaplanowano (przypisano do fazy) zalecenie danej reguły. */
function plannedRule(state, pointId, rule) {
  return (state.recommendations || []).some((r) => r.pointId === pointId && r.rule === rule && r.phase);
}

/** Ład punktu dziś: jest opiekun i ważny przegląd. */
const governanceNow = (p) => hasKeeper(p) && inspectionValid(p);

/**
 * Ład punktu po wykonaniu roadmapy: braki domknięte przez zadanie przypisane
 * do fazy. Punkty nowe liczymy jako spełnione – ich wdrożenie obejmuje
 * z definicji nowe urządzenie i wskazanie opiekuna (pozycja „install" w fazie).
 */
function governancePlan(state, p) {
  if (p.kind === 'proposed') return true;
  const keeperOk = hasKeeper(p) || plannedRule(state, p.id, 'keeper');
  const inspectionOk = inspectionValid(p) || plannedRule(state, p.id, 'inspection');
  return keeperOk && inspectionOk;
}

/* ------------------------------------------------------------------ *
 * Kontekst obliczeniowy – jedno miejsce, w którym wołamy model
 * ------------------------------------------------------------------ */

/**
 * Liczy wszystko, czego potrzebują sekcje i KPI: trzy przebiegi `analyze()`
 * (dziś / po planie / noc) oraz sumy roadmapy. Wołane raz na budowę raportu.
 */
function buildContext(state, options = {}) {
  const project = state.project || {};
  const standardMinutes = project.standardMinutes || 2;

  const base = {
    demandPoints: state.demandPoints || [],
    points: state.points || [],
    districts: project.districts || [],
    standardMinutes,
    population: project.population || 0,
  };

  const reach = reachMapSync([...state.points, ...(state.candidates || [])]);
  const now = analyze({ ...base, reach, scenario: 'now', mode: 'day' });
  const plan = analyze({ ...base, reach, scenario: 'plan', mode: 'day' });
  const night = analyze({ ...base, reach, scenario: 'now', mode: 'night' });
  const totals = roadmapTotals(state.recommendations || []);

  // Wiersze inwentarza – kompletność i status liczone raz, używane w kilku sekcjach.
  const rows = (state.points || []).map((point) => {
    const preset = presetById(state, point.presetId);
    const comp = completeness(point, preset, state.photos || []);
    return {
      point,
      preset,
      completeness: comp,
      level: pointStatusLevel(point, comp.pct),
      status: statusMeta(point, point.kind === 'proposed' ? null : comp.pct),
    };
  });

  const levelOf = (point) => {
    const row = rows.find((r) => r.point.id === point.id);
    return row ? row.level : pointStatusLevel(point, 0);
  };

  return {
    state,
    project,
    standardMinutes,
    radiusM: now.radiusM,
    now,
    plan,
    night,
    totals,
    rows,
    levelOf,
    date: options.date || project.updatedAt || TODAY,
    contact: options.contact || OPERATOR,
  };
}

/* ------------------------------------------------------------------ *
 * KPI raportu (SPEC §6.7 – pięć wskaźników)
 * ------------------------------------------------------------------ */

function deltaPp(value) {
  if (Math.abs(value) < 0.05) return 'bez zmiany';
  return `${value > 0 ? '+' : '−'}${fmtNum(Math.abs(value), 0)} pp`;
}

function direction(value, higherIsBetter = true) {
  if (Math.abs(value) < 0.05) return 'flat';
  return value > 0 === higherIsBetter ? 'up' : 'down';
}

function kpisFrom(ctx) {
  const { state, now, plan, totals, standardMinutes } = ctx;

  const coverageDelta = plan.coveragePct - now.coveragePct;
  const per10kDelta = plan.aedPer10k - now.aedPer10k;

  // analyze() liczy udział 24/7 po punktach istniejących; dla scenariusza
  // „po planie" ten sam udział liczymy po zbiorze aktywnych punktów planu,
  // który analyze() zwraca w activePoints (istniejące + zaakceptowane nowe).
  const always247Now = now.always247Pct;
  const always247Plan = share(plan.activePoints, is247);

  const governanceNowPct = share(now.activePoints, governanceNow);
  const governancePlanPct = share(plan.activePoints, (p) => governancePlan(state, p));

  const gainedPeople = Math.max(0, plan.coveredPeople - now.coveredPeople);
  const perPerson = gainedPeople ? totals.total / gainedPeople : 0;

  return [
    {
      id: 'coverage',
      label: `Pokrycie ≤ ${fmtMin(standardMinutes, 0)} (dojście w jedną stronę)`,
      now: fmtPct(now.coveragePct, 0),
      plan: fmtPct(plan.coveragePct, 0),
      delta: deltaPp(coverageDelta),
      direction: direction(coverageDelta),
      nowValue: now.coveragePct,
      planValue: plan.coveragePct,
    },
    {
      id: 'per10k',
      label: 'AED na 10 tys. mieszkańców',
      now: fmtNum(now.aedPer10k, 1),
      plan: fmtNum(plan.aedPer10k, 1),
      delta:
        Math.abs(per10kDelta) < 0.05
          ? 'bez zmiany'
          : `${per10kDelta > 0 ? '+' : '−'}${fmtNum(Math.abs(per10kDelta), 1)}`,
      direction: direction(per10kDelta),
      nowValue: now.aedPer10k,
      planValue: plan.aedPer10k,
    },
    {
      id: 'always247',
      label: 'Punkty dostępne całodobowo (24/7)',
      now: fmtPct(always247Now, 0),
      plan: fmtPct(always247Plan, 0),
      delta: deltaPp(always247Plan - always247Now),
      direction: direction(always247Plan - always247Now),
      nowValue: always247Now,
      planValue: always247Plan,
    },
    {
      id: 'governance',
      label: 'Punkty z opiekunem i ważnym przeglądem',
      now: fmtPct(governanceNowPct, 0),
      plan: fmtPct(governancePlanPct, 0),
      delta: deltaPp(governancePlanPct - governanceNowPct),
      direction: direction(governancePlanPct - governanceNowPct),
      nowValue: governanceNowPct,
      planValue: governancePlanPct,
    },
    {
      id: 'costPerPerson',
      label: 'Koszt planu na mieszkańca objętego ochroną',
      now: '–',
      // fmtCost zaokrągla do pełnych złotych, co skasowałoby wskaźnik rzędu
      // kilku złotych – dlatego kwota jednostkowa idzie przez fmtNum z groszami.
      plan: gainedPeople ? `${fmtNum(perPerson, 2)} zł` : '–',
      delta: gainedPeople
        ? `${fmtCost(totals.total)} / ${fmtNum(gainedPeople)} ${plural(gainedPeople, ['osoba', 'osoby', 'osób'])}`
        : 'plan nie zwiększa liczby objętych osób',
      direction: 'flat',
      nowValue: 0,
      planValue: perPerson,
    },
  ];
}

/**
 * Pięć KPI raportu (SPEC §6.7), każdy w formacie
 * `{label, now, plan, delta}` (+ `id`, `direction`, wartości surowe).
 */
export function reportKpis(state) {
  return kpisFrom(buildContext(state));
}

/* ------------------------------------------------------------------ *
 * Mapy „jest / będzie" – statyczny SVG z map.js
 * ------------------------------------------------------------------ */

function sceneFor(ctx, analysis) {
  return {
    boundary: ctx.state.boundary,
    districts: ctx.state.districtsGeo,
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
    targetMinutes: ctx.standardMinutes,
    points: analysis.activePoints.map((p) => ({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      name: p.name,
      level: ctx.levelOf(p),
    })),
    labels: [],
  };
}

function mapHtml(ctx, analysis, caption) {
  const svg = renderSceneSvg(sceneFor(ctx, analysis), {
    width: MAP_W,
    height: MAP_H,
    showDemand: true,
    showCoverage: true,
    showDistricts: true,
    pad: 8,
  });
  // Podpis po SVG, żeby leżał na nim (`.report-map__cap` jest pozycjonowany absolutnie).
  return `<div class="report-map">${svg}<span class="report-map__cap">${esc(caption)}</span></div>`;
}

function kpiStripHtml(kpis) {
  const cells = kpis
    .map(
      (k) => `<div class="report-kpi">
        <div class="report-kpi__v">${esc(k.now)}<span class="kpi__arrow"> → </span>${esc(k.plan)}</div>
        <div class="report-kpi__l">${esc(k.label)}</div>
        <div class="kpi__delta${k.direction === 'up' ? ' is-up' : k.direction === 'down' ? ' is-down' : ''}">${esc(
          k.delta
        )}</div>
      </div>`
    )
    .join('');
  return `<div class="report-kpis">${cells}</div>`;
}

/* ------------------------------------------------------------------ *
 * Sekcje
 * ------------------------------------------------------------------ */

function sectionCover(ctx) {
  const { project, now, standardMinutes } = ctx;
  const existing = ctx.rows.filter((r) => r.point.kind === 'existing').length;
  const proposed = ctx.rows.filter((r) => r.point.kind === 'proposed').length;
  const districts = (project.districts || []).length;

  return `
    <div class="label-caps">Sinecco · AED Planner</div>
    <h2>${esc(project.label || project.name || 'Projekt')}</h2>
    <p class="muted">Audyt dostępności i plan rozwoju sieci defibrylatorów AED</p>
    <div class="divider"></div>
    ${factsHtml([
      ['Gmina', esc(project.name || '–')],
      ['Liczba mieszkańców', `${fmtNum(project.population || 0)}`],
      ['Jednostki pomocnicze (dzielnice)', fmtNum(districts)],
      ['Punkty AED w inwentarzu', fmtNum(existing)],
      ['Punkty planowane', fmtNum(proposed)],
      ['Standard czasu dojścia', `${fmtMin(standardMinutes, 0)} w jedną stronę`],
      ['Promień strefy pokrycia', `${fmtNum(now.radiusM)} m`],
      ['Pokrycie w stanie obecnym', fmtPct(now.coveragePct, 0)],
      ['Data raportu', esc(ctx.date)],
      ['Opracowanie', esc(ctx.contact)],
    ])}
    <div class="divider"></div>
    <p class="note">
      Dokument roboczy iteracji 2 – makieta klikalna. Liczby pochodzą z modelu
      uproszczonego (SPEC §5) i z danych wprowadzonych w krokach 0–4;
      przed publikacją wymagają potwierdzenia w terenie.
    </p>`;
}

function sectionSummary(ctx, kpis) {
  const { now, plan, totals, standardMinutes } = ctx;
  const gained = Math.max(0, plan.coveredPeople - now.coveredPeople);
  const newPoints = ctx.rows.filter((r) => r.point.kind === 'proposed').length;
  const tasks = (ctx.state.recommendations || []).filter((r) => r.phase).length;

  return `
    <h2>Podsumowanie dla decydenta – na jednej kartce</h2>
    <p>
      Sieć AED w gminie ${esc(ctx.project.name || '–')} obejmuje dziś
      <strong>${fmtPct(now.coveragePct, 0)}</strong> mieszkańców w standardzie
      dojścia <strong>${fmtMin(standardMinutes, 0)}</strong> w jedną stronę.
      Po wykonaniu planu będzie to <strong>${fmtPct(plan.coveragePct, 0)}</strong>, czyli
      <strong>${fmtNum(gained)}</strong> ${plural(gained, ['osoba', 'osoby', 'osób'])} więcej
      w zasięgu defibrylatora. Mediana czasu dojścia spada z
      <strong>${fmtMin(now.medianMin)}</strong> do <strong>${fmtMin(plan.medianMin)}</strong>.
    </p>
    ${kpiStripHtml(kpis)}
    <div class="report-maps">
      ${mapHtml(ctx, now, 'Jest – stan obecny')}
      ${mapHtml(ctx, plan, 'Będzie – po planie')}
    </div>
    <p class="note">
      Zielone punkty to mieszkańcy w zasięgu, czerwone – poza zasięgiem.
      Okręgi to strefy pokrycia (ciemniejsze: punkty planowane).
    </p>
    <div class="report-quote">„${esc(CONTEXT_SENTENCE)}”</div>
    <p>
      Plan to <strong>${fmtNum(tasks)}</strong> ${plural(tasks, ['zadanie', 'zadania', 'zadań'])}
      w trzech fazach i <strong>${fmtNum(newPoints)}</strong>
      ${plural(newPoints, ['nowy punkt', 'nowe punkty', 'nowych punktów'])};
      łączny koszt <strong>${fmtCost(totals.total)}</strong>
      (faza 1: ${fmtCost(totals.phases[1].cost)} · faza 2: ${fmtCost(totals.phases[2].cost)} ·
      faza 3: ${fmtCost(totals.phases[3].cost)}).
    </p>`;
}

function sectionCurrent(ctx) {
  const { now, night, rows } = ctx;
  const byLevel = (level) => rows.filter((r) => r.point.kind === 'existing' && r.level === level).length;
  const existing = rows.filter((r) => r.point.kind === 'existing');

  const inventoryRows = [
    ['ok', 'Zweryfikowane, karta kompletna'],
    ['warn', 'Zweryfikowane, karta z brakami'],
    ['crit', 'Niezweryfikowane – wymagają wizyty'],
  ].map(([level, label]) => {
    const count = byLevel(level);
    return [
      `${dotHtml(level)} ${esc(label)}`,
      fmtNum(count),
      fmtPct(existing.length ? (100 * count) / existing.length : 0, 0),
    ];
  });
  inventoryRows.push([
    `${dotHtml('proposed')} Punkty planowane (zaakceptowane propozycje)`,
    fmtNum(rows.filter((r) => r.point.kind === 'proposed').length),
    '–',
  ]);

  const avgCompleteness = existing.length
    ? existing.reduce((sum, r) => sum + (r.completeness.required ? r.completeness.pct : 0), 0) / existing.length
    : 0;

  return `
    <h2>Stan obecny</h2>
    <p>
      Inwentarz obejmuje <strong>${fmtNum(existing.length)}</strong>
      ${plural(existing.length, ['punkt', 'punkty', 'punktów'])} istniejących.
      W scenariuszu dziennym w obliczeniach pokrycia bierze udział
      <strong>${fmtNum(now.activeCount)}</strong> z nich; w scenariuszu nocnym tylko
      <strong>${fmtNum(night.activeCount)}</strong> (dostępne całodobowo).
    </p>

    <h3>Struktura inwentarza</h3>
    ${tableHtml(['Kategoria', 'Liczba', 'Udział'], inventoryRows, ['', 'r', 'r'])}

    <h3>Wskaźniki wyjściowe</h3>
    ${factsHtml([
      [`Pokrycie ≤ ${fmtMin(ctx.standardMinutes, 0)} – dzień`, fmtPct(now.coveragePct, 0)],
      [`Pokrycie ≤ ${fmtMin(ctx.standardMinutes, 0)} – noc (tylko 24/7)`, fmtPct(night.coveragePct, 0)],
      ['Mediana czasu dojścia', fmtMin(now.medianMin)],
      ['Średni czas dojścia (ważony ludnością)', fmtMin(now.meanMin)],
      ['Mieszkańcy w zasięgu', `${fmtNum(now.coveredPeople)} z ${fmtNum(now.totalPeople)}`],
      ['AED na 10 tys. mieszkańców', fmtNum(now.aedPer10k, 1)],
      ['Punkty dostępne 24/7', fmtPct(now.always247Pct, 0)],
      ['Średnia kompletność kart', fmtPct(avgCompleteness, 0)],
    ])}
    <p class="note">
      Pokrycie nocne liczone jest wyłącznie po punktach z całodobowym dostępem –
      to najczęstsza przyczyna różnicy między deklarowaną a realną dostępnością sieci.
    </p>`;
}

function sectionAnalysis(ctx) {
  const { now, plan } = ctx;
  const demandCount = (ctx.state.demandPoints || []).length;
  /** Dzielnica „w głębokiej luce" = ponad połowa mieszkańców poza zasięgiem. */
  const deepGaps = (analysis) => analysis.gaps.filter((g) => g.uncoveredPct > 50).length;

  const gapRows = now.gaps.map((g) => [
    esc(g.name),
    fmtNum(g.uncoveredPeople),
    `${fmtPct(g.uncoveredPct, 0)}<div style="width:120px;margin-top:4px">${barHtml(
      g.uncoveredPct,
      g.uncoveredPct >= 50 ? 'crit' : 'warn'
    )}</div>`,
    fmtMin(g.maxMin),
  ]);

  const proposedRows = ctx.rows
    .filter((r) => r.point.kind === 'proposed')
    .map((r) => [
      esc(r.point.name),
      `${esc(r.point.presetId || '–')}${r.preset ? ` <span class="muted">${esc(r.preset.name)}</span>` : ''}`,
      esc(districtNameOf(ctx.state, r.point.districtId)),
      Number.isFinite(r.point.gainPct) ? `+${fmtPct(r.point.gainPct, 1)}` : '–',
      r.preset ? fmtCost(r.preset.cost) : '–',
    ]);

  const totalGain = ctx.rows
    .filter((r) => r.point.kind === 'proposed')
    .reduce((sum, r) => sum + (r.point.gainWeight || 0), 0);

  return `
    <h2>Analiza dostępności</h2>
    <p>
      Model rozkłada mieszkańców na <strong>${fmtNum(demandCount)}</strong>
      ${plural(demandCount, ['punkt popytu', 'punkty popytu', 'punktów popytu'])}
      i dla każdego liczy czas dojścia do najbliższego AED.
      Punkt jest pokryty, gdy mieści się w promieniu <strong>${fmtNum(ctx.radiusM)} m</strong>
      (${fmtMin(ctx.standardMinutes, 0)} w jedną stronę).
    </p>

    <h3>Luki wg dzielnic – stan obecny</h3>
    ${tableHtml(
      ['Dzielnica', 'Osoby poza zasięgiem', 'Udział poza zasięgiem', 'Maks. czas dojścia'],
      gapRows,
      ['', 'r', 'r', 'r']
    )}

    <h3>Punkty planowane (wybór optymalizatora)</h3>
    ${tableHtml(
      ['Lokalizacja', 'Preset', 'Dzielnica', 'Przyrost pokrycia', 'Koszt jednostkowy'],
      proposedRows,
      ['', '', '', 'r', 'r']
    )}
    <p class="note">
      Dobór lokalizacji: algorytm zachłanny maksymalnego pokrycia – w każdej turze
      wybierany jest kandydat domykający najwięcej niepokrytej ludności.
      Łączny przyrost: <strong>${fmtNum(totalGain)}</strong>
      ${plural(totalGain, ['osoba', 'osoby', 'osób'])} w zasięgu.
    </p>

    <h3>Porównanie scenariuszy</h3>
    ${tableHtml(
      ['Wskaźnik', 'Stan obecny', 'Po planie'],
      [
        ['Pokrycie', fmtPct(now.coveragePct, 0), fmtPct(plan.coveragePct, 0)],
        ['Mediana dojścia', fmtMin(now.medianMin), fmtMin(plan.medianMin)],
        ['Średni czas dojścia', fmtMin(now.meanMin), fmtMin(plan.meanMin)],
        ['Punkty czynne', fmtNum(now.activeCount), fmtNum(plan.activeCount)],
        ['AED / 10 tys.', fmtNum(now.aedPer10k, 1), fmtNum(plan.aedPer10k, 1)],
        ['Dzielnice z luką', fmtNum(now.gaps.length), fmtNum(plan.gaps.length)],
        [
          'Dzielnice z ponad połową mieszkańców poza zasięgiem',
          fmtNum(deepGaps(now)),
          fmtNum(deepGaps(plan)),
        ],
      ].map(([label, a, b]) => [esc(label), a, b]),
      ['', 'r', 'r']
    )}`;
}

function sectionRecommendations(ctx) {
  const recs = ctx.state.recommendations || [];
  const pointName = (id) => {
    const row = ctx.rows.find((r) => r.point.id === id);
    return row ? row.point.name : '–';
  };

  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...recs].sort(
    (a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3) || (a.phase || 9) - (b.phase || 9)
  );

  const rows = sorted.map((r) => [
    esc(r.text),
    r.pointId ? `${esc(r.pointId)} <span class="muted">${esc(pointName(r.pointId))}</span>` : '<span class="muted">zadanie ogólne</span>',
    pillHtml(PRIORITY_LABEL[r.priority] || r.priority || '–', PRIORITY_VARIANT[r.priority] || ''),
    esc(OWNER_LABEL[r.owner] || r.owner || '–'),
    r.phase ? pillHtml(PHASE_META[r.phase].label, `phase${r.phase}`) : '<span class="muted">nieprzypisane</span>',
    fmtCost(r.cost || 0),
  ]);

  const byPriority = ['high', 'medium', 'low'].map((p) => {
    const list = recs.filter((r) => r.priority === p);
    return [
      pillHtml(PRIORITY_LABEL[p], PRIORITY_VARIANT[p]),
      fmtNum(list.length),
      fmtCost(list.reduce((s, r) => s + (r.cost || 0), 0)),
    ];
  });

  const done = recs.filter((r) => r.done).length;

  return `
    <h2>Rekomendacje</h2>
    <p>
      Lista powstaje automatycznie z reguł audytu (SPEC §5) po każdym zapisie karty
      punktu i jest uzupełniana ręcznie przez operatora. Łącznie
      <strong>${fmtNum(recs.length)}</strong> ${plural(recs.length, ['pozycja', 'pozycje', 'pozycji'])},
      z czego wykonanych: <strong>${fmtNum(done)}</strong>.
    </p>

    <h3>Zestawienie wg priorytetu</h3>
    ${tableHtml(['Priorytet', 'Pozycji', 'Koszt'], byPriority, ['', 'r', 'r'])}

    <h3>Pełna lista</h3>
    ${tableHtml(
      ['Zalecenie', 'Punkt', 'Priorytet', 'Odpowiedzialny', 'Faza', 'Koszt'],
      rows,
      ['', '', '', '', '', 'r']
    )}
    <p class="note">Koszt łączny pozycji przypisanych do faz: <strong>${fmtCost(ctx.totals.total)}</strong>.</p>`;
}

function sectionRoadmap(ctx) {
  const { totals } = ctx;
  const pointName = (id) => {
    const row = ctx.rows.find((r) => r.point.id === id);
    return row ? row.point.name : null;
  };

  const phaseBlocks = [1, 2, 3]
    .map((phase) => {
      const meta = PHASE_META[phase];
      const bucket = totals.phases[phase];
      const rows = bucket.items.map((r) => [
        esc(r.text),
        r.pointId ? esc(pointName(r.pointId) || r.pointId) : '<span class="muted">zadanie ogólne</span>',
        esc(OWNER_LABEL[r.owner] || r.owner || '–'),
        Number.isFinite(r.startMonth) ? `${fmtNum(r.startMonth)}–${fmtNum(r.startMonth + (r.lengthMonths || 1) - 1)}` : '–',
        fmtCost(r.cost || 0),
      ]);
      return `
        <h3>${esc(meta.label)} – ${esc(meta.title)}
          <span class="muted">· ${esc(meta.months)} · ${fmtCost(bucket.cost)} ·
          ${fmtNum(bucket.items.length)} ${plural(bucket.items.length, ['pozycja', 'pozycje', 'pozycji'])}</span>
        </h3>
        ${tableHtml(['Zadanie', 'Punkt', 'Odpowiedzialny', 'Miesiące', 'Koszt'], rows, ['', '', '', 'r', 'r'])}`;
    })
    .join('');

  const unassigned = (ctx.state.recommendations || []).filter((r) => !r.phase).length;

  return `
    <h2>Roadmapa wdrożenia</h2>
    <p>
      Plan podzielony na trzy fazy. Faza 1 domyka zgodność na istniejącej sieci
      (opiekunowie, rejestracja u dyspozytora, przeglądy, oznakowanie) i jest
      najtańsza; fazy 2 i 3 dogęszczają sieć nowymi punktami.
    </p>
    ${tableHtml(
      ['Faza', 'Zakres', 'Okres', 'Pozycji', 'Koszt'],
      [1, 2, 3].map((phase) => [
        pillHtml(PHASE_META[phase].label, `phase${phase}`),
        esc(PHASE_META[phase].title),
        esc(PHASE_META[phase].months),
        fmtNum(totals.phases[phase].items.length),
        fmtCost(totals.phases[phase].cost),
      ]),
      ['', '', '', 'r', 'r']
    )}
    <p><strong>Razem: ${fmtCost(totals.total)}</strong>${
      unassigned ? ` <span class="muted">· poza harmonogramem: ${fmtNum(unassigned)}</span>` : ''
    }</p>
    ${phaseBlocks}
    <p class="note">
      Terminy wyznaczają zadania proceduralne (zamówienie sprzętu, dokumentacja
      i uzgodnienia, przetarg), a nie sam montaż – dlatego są ujęte w harmonogramie
      jako osobne pozycje.
    </p>`;
}

function sectionMethod(ctx) {
  const demand = (ctx.state.demandPoints || []).length;

  return `
    <h2>Metodyka</h2>

    <h3>Czas dojścia i promień strefy</h3>
    <p>
      Liczymy czas świadka biegnącego po AED <em>i z powrotem</em> do poszkodowanego,
      dlatego standard wyrażony jest „w jedną stronę”. Prędkość marszu przyjęto na
      <strong>${fmtNum(WALK_SPEED)} m/min</strong>, a współczynnik wydłużenia trasy
      po ulicach (odejście od linii prostej) na <strong>${fmtNum(DETOUR, 2)}</strong>.
    </p>
    ${factsHtml([
      ['Standard czasu dojścia', `${fmtMin(ctx.standardMinutes, 0)} w jedną stronę`],
      ['Promień strefy pokrycia', `${fmtNum(coverageRadiusM(ctx.standardMinutes))} m`],
      ['Punkty popytu w modelu', fmtNum(demand)],
      ['Ludność objęta modelem', fmtNum(ctx.now.totalPeople)],
      ['Punkty czynne – dzień', fmtNum(ctx.now.activeCount)],
      ['Punkty czynne – noc (24/7)', fmtNum(ctx.night.activeCount)],
    ])}

    <h3>Punkty popytu</h3>
    <p>
      Ludność każdej dzielnicy rozkładana jest deterministycznie wewnątrz jej
      wielokąta (rozkład spiralny, złoty kąt, zagęszczenie ku środkowi zabudowy).
      Te same dane zawsze dają ten sam wynik, więc raporty są porównywalne między wersjami.
    </p>

    <h3>Dobór nowych lokalizacji</h3>
    <p>
      Algorytm zachłanny maksymalnego pokrycia na zbiorze kandydatów (obiekty
      publiczne). W każdej turze wybierany jest kandydat domykający największą
      wagę niepokrytej ludności; jego zasięg jest oznaczany jako pokryty i procedura
      się powtarza.
    </p>

    <h3>Kompletność karty i rekomendacje</h3>
    <p>
      Kompletność = (wypełnione pola wymagane presetu + wgrane wymagane zdjęcia)
      ÷ wszystkie wymagane. Braki uruchamiają deterministyczne reguły audytu,
      które tworzą rekomendacje z priorytetem, kosztem i odpowiedzialnym.
    </p>

    <h3>Ograniczenia tej wersji</h3>
    <ul class="note">
      <li>Czasy dojścia z modelu uproszczonego, nie z izochron po sieci pieszej.</li>
      <li>Granice i dane ludnościowe poglądowe – bez pobierania z PRG/GUS/OSM.</li>
      <li>Raport generowany jako wydruk przeglądarki (snapshot), nie PDF serwerowy.</li>
      <li>Dane trzymane lokalnie w przeglądarce (IndexedDB), bez kont użytkowników.</li>
    </ul>`;
}

function sectionCards(ctx) {
  const rows = ctx.rows.map((r) => {
    const c = r.completeness;
    const pctCell = c.required
      ? `${fmtPct(c.pct, 0)}<div style="width:90px;margin-top:4px">${barHtml(
          c.pct,
          c.pct >= 100 ? 'ok' : c.pct >= 60 ? 'warn' : 'crit'
        )}</div>`
      : '<span class="muted">brak presetu</span>';
    const recCount = (ctx.state.recommendations || []).filter((x) => x.pointId === r.point.id).length;

    return [
      `${dotHtml(r.level)} ${esc(r.point.id)} <span class="muted">${esc(KIND_LABEL[r.point.kind] || r.point.kind)}</span>`,
      `<span class="table__main">${esc(r.point.name)}</span><div class="table__sub">${esc(
        r.point.address || '–'
      )}</div>`,
      esc(districtNameOf(ctx.state, r.point.districtId)),
      esc(r.point.presetId || '–'),
      pctCell,
      fmtNum(recCount),
      pillHtml(r.status.label, r.status.variant),
    ];
  });

  return `
    <h2>Karty punktów – załącznik</h2>
    <p class="note">
      Zestawienie skrócone. Pełne karty (dostępność, opiekun, oznakowanie,
      urządzenie, rejestracja u dyspozytora, dokumentacja fotograficzna) są
      dostępne w kroku 3 aplikacji i w eksporcie CSV.
    </p>
    ${tableHtml(
      ['ID', 'Punkt', 'Dzielnica', 'Preset', 'Kompletność', 'Rekom.', 'Status'],
      rows,
      ['', '', '', '', 'r', 'r', '']
    )}`;
}

const BUILDERS = {
  cover: (ctx) => sectionCover(ctx),
  summary: (ctx, kpis) => sectionSummary(ctx, kpis),
  current: (ctx) => sectionCurrent(ctx),
  analysis: (ctx) => sectionAnalysis(ctx),
  recommendations: (ctx) => sectionRecommendations(ctx),
  roadmap: (ctx) => sectionRoadmap(ctx),
  method: (ctx) => sectionMethod(ctx),
  cards: (ctx) => sectionCards(ctx),
};

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/** Które sekcje są włączone: `state.ui.reportSections === null` znaczy wszystkie. */
export function enabledSectionIds(state) {
  const chosen = state.ui && state.ui.reportSections;
  if (!Array.isArray(chosen)) return REPORT_SECTIONS.map((s) => s.id);
  return REPORT_SECTIONS.map((s) => s.id).filter((id) => chosen.includes(id));
}

export function isSectionOn(state, id) {
  return enabledSectionIds(state).includes(id);
}

/**
 * Buduje treść raportu.
 *
 * @param {object} state pełny obiekt stanu aplikacji
 * @param {object} [options] `{date, contact}` – metryka dokumentu z panelu konfiguracji
 * @returns {{sections: Array<{id,title,html}>, kpis: Array}}
 */
export function buildReport(state, options = {}) {
  const ctx = buildContext(state, options);
  const kpis = kpisFrom(ctx);
  const enabled = enabledSectionIds(state);

  const sections = REPORT_SECTIONS.filter((s) => enabled.includes(s.id)).map((s) => ({
    id: s.id,
    title: s.title,
    html: BUILDERS[s.id](ctx, kpis),
  }));

  return { sections, kpis };
}
