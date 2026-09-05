/**
 * views/dashboard.js – pulpit projektów (SPEC §6.0, trasa '#/').
 *
 * Bez steppera: top bar i sub bar rysuje router, widok wypełnia tylko
 * obszar roboczy. Wszystkie liczby pochodzą z model.js / state.js –
 * nic nie jest wpisane na sztywno w HTML.
 */

import { reachMapSync } from '../reach.js';
import { analyze, completeness, pointStatusLevel, fmtPct, fmtMin, fmtNum, fmtCost } from '../model.js';
import { renderSceneSvg } from '../map.js';
import { state, exportProject, resetToDemo, getPreset } from '../state.js';
import {
  h, el, mount, pillHtml, toast, modal, disabledControl, download, icon,
} from '../ui.js';
import { lockAgain } from '../gate.js';
import { openNewAudit } from '../projects.js';

export const meta = {
  step: null,
  title: 'Pulpit',
  chrome: 'full',
  hideStepper: true,
  layout: 'scroll',
};

/* ------------------------------------------------------------------ *
 * Lokalne stałe i drobne pomocniki (rdzenia nie ruszamy)
 * ------------------------------------------------------------------ */

/** Kroki 0–5 z SPEC §3 – sześć segmentów paska postępu. */
const STEP_COUNT = 6;

const STATUS_META = {
  w_toku: { label: 'W TOKU', variant: 'warn' },
  oferta: { label: 'OFERTA', variant: '' },
  zakonczony: { label: 'ZAKOŃCZONY', variant: 'ok' },
};

const REASON_DEMO_ONLY = 'dane demo tylko dla Tychów';
const REASON_OUT_OF_SCOPE = 'poza zakresem';

/** Polska odmiana liczebnika: [1, 2–4, 5+]. */
function plural(n, forms) {
  const abs = Math.abs(n);
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (abs === 1) return forms[0];
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return forms[1];
  return forms[2];
}

/** Rozmiar pliku – liczby przez fmtNum, żeby separatory były jednolite. */
function fmtBytes(bytes) {
  if (bytes < 1024) return `${fmtNum(bytes)} B`;
  if (bytes < 1024 * 1024) return `${fmtNum(bytes / 1024, 1)} kB`;
  return `${fmtNum(bytes / (1024 * 1024), 2)} MB`;
}

function statusOf(project) {
  return STATUS_META[project.status] || { label: String(project.status || '–').toUpperCase(), variant: '' };
}

/** Analiza stanu obecnego dla aktywnego projektu (SPEC §5). */
function analyzeCurrent() {
  const project = state.project;
  if (!project || !state.demandPoints.length) return null;
  return analyze({
    demandPoints: state.demandPoints,
    points: state.points,
    districts: project.districts || [],
    standardMinutes: project.standardMinutes,
    population: project.population,
    scenario: 'now',
    mode: 'day',
    // Ten sam zasięg co w kroku 2 – pulpit i setup nie mogą pokazywać
    // innego pokrycia niż analiza.
    reach: reachMapSync(state.points),
  });
}

/* ------------------------------------------------------------------ *
 * Nowy audyt
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Kafelek projektu
 * ------------------------------------------------------------------ */

/**
 * Miniatura mapy projektu.
 *
 * Rysujemy ją z tych samych danych co duża mapa, przez renderSceneSvg – więc
 * to nie jest obrazek, tylko realny stan audytu w małej skali. Projekt bez
 * danych dostaje puste pole z nazwą: nie rysujemy granicy gminy, której nie
 * mamy, bo wymyślony obrys wyglądałby jak dane.
 */
function projectThumb(project, isActive) {
  if (!isActive || !state.boundary) {
    return h(
      'div',
      { class: 'project-card__map project-card__map--empty' },
      h('span', { class: 'project-card__mapname', text: project.name.toUpperCase() })
    );
  }

  const points = state.points
    .filter((p) => p.status !== 'rejected')
    .map((p) => ({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      level:
        p.kind === 'proposed'
          ? 'proposed'
          : pointStatusLevel(p, completeness(p, getPreset(p.presetId), state.photos).pct),
    }));

  return h('div', {
    class: 'project-card__map',
    html: renderSceneSvg(
      {
        boundary: state.boundary,
        districts: state.districtsGeo,
        points,
        labels: [{ lat: centroidLat(), lon: centroidLon(), text: project.name.toUpperCase(), kind: 'district' }],
      },
      {
        width: 420,
        height: 190,
        showDemand: false,
        showCoverage: false,
        showDistricts: true,
        showLabels: true,
        markerSize: 13,
      }
    ),
  });
}

/** Środek granicy – do podpisu na miniaturze. */
function centroidLat() {
  const b = state.boundary;
  if (!b) return 0;
  const ring = b.coordinates ? b.coordinates[0] : [];
  return ring.reduce((a, c) => a + c[1], 0) / (ring.length || 1);
}
function centroidLon() {
  const b = state.boundary;
  if (!b) return 0;
  const ring = b.coordinates ? b.coordinates[0] : [];
  return ring.reduce((a, c) => a + c[0], 0) / (ring.length || 1);
}

/**
 * Średnia kompletność kart w projekcie.
 *
 * To odpowiedź na pytanie „ile z tego audytu jest już zrobione" – liczona
 * z realnych kart, nie z liczby odhaczonych kroków. Projekt bez danych nie
 * dostaje tu liczby, tylko kreskę.
 */
function completenessPct() {
  const points = state.points.filter((p) => p.kind === 'existing' && p.status !== 'rejected');
  if (!points.length) return null;
  const sum = points.reduce((a, p) => a + completeness(p, getPreset(p.presetId), state.photos).pct, 0);
  return sum / points.length;
}

function projectCard(project, analysis, navigate) {
  const isActive = !!(state.project && state.project.id === project.id);
  const stepsDone = new Set(isActive ? state.project.stepsDone || [] : []);
  const status = statusOf(project);
  const done = stepsDone.size;

  /* Kropki kroków połączone linią – ta sama forma co StepProgress. */
  const steps = h(
    'div',
    { class: 'project-card__steps', 'aria-label': `Ukończone kroki: ${done} z ${STEP_COUNT}` },
    ...Array.from({ length: STEP_COUNT }, (_, i) =>
      h('span', {
        class: `project-card__step${stepsDone.has(i) ? ' is-done' : ''}${
          i === done && done > 0 ? ' is-current' : ''
        }`,
        title: `Krok ${i} – ${stepsDone.has(i) ? 'ukończony' : 'nierozpoczęty'}`,
      })
    )
  );

  const comp = isActive ? completenessPct() : null;
  const showKpi = project.available && isActive && analysis;

  const openBtn = h('button', { class: 'btn btn--primary' }, 'OTWÓRZ');
  if (project.available) openBtn.addEventListener('click', () => navigate('#/inventory'));
  else disabledControl(openBtn, REASON_DEMO_ONLY);

  return h(
    'article',
    { class: 'project-card' },
    projectThumb(project, isActive),
    h(
      'div',
      { class: 'project-card__body' },
      h(
        'div',
        { class: 'project-card__head' },
        h('h3', { text: (project.label || project.name).toUpperCase() }),
        el(pillHtml(status.label, status.variant))
      ),
      h(
        'div',
        { class: 'project-card__kpi' },
        comp === null ? '–' : fmtPct(comp),
        h('small', { text: 'kompletności' })
      ),
      h('span', { class: 'label-caps', text: `Krok ${fmtNum(done)} z ${fmtNum(STEP_COUNT)}` }),
      steps,
      h(
        'div',
        { class: 'project-card__stats' },
        showKpi
          ? h('span', {}, h('b', { text: fmtPct(analysis.coveragePct) }), ' pokrycia')
          : h('span', { class: 'muted', text: '– pokrycie' }),
        h('span', { class: 'spacer' }),
        isActive
          ? h('span', {
              class: 'muted',
              text: `${fmtNum(state.points.filter((p) => p.kind === 'existing').length)} punktów AED`,
            })
          : null
      ),
      openBtn
    )
  );
}

function newProjectCard(navigate) {
  return h(
    'button',
    {
      class: 'project-card project-card--new',
      type: 'button',
      onclick: () => openNewAudit(navigate),
    },
    h('span', { style: { fontSize: '20px', fontWeight: '700' }, text: '+' }),
    h('span', { text: 'NOWY AUDYT' }),
    h('span', { class: 'note', text: 'gmina, granica, standard czasu' })
  );
}

/* ------------------------------------------------------------------ *
 * Ostatnie raporty – realne pakiety danych z exportProject()
 * ------------------------------------------------------------------ */

function reportPackages() {
  const base = exportProject();
  const slug = (state.project && state.project.id) || 'projekt';
  const label = (state.project && state.project.label) || 'Projekt';

  const packages = [
    {
      name: `${label} – pakiet raportu (komplet danych)`,
      file: `sinecco-aed-${slug}-raport.json`,
      payload: base,
    },
    {
      name: `${label} – załącznik: rejestr punktów`,
      file: `sinecco-aed-${slug}-punkty.json`,
      payload: { ...base, recommendations: [], candidates: [] },
    },
    {
      name: `${label} – załącznik: rekomendacje i roadmapa`,
      file: `sinecco-aed-${slug}-rekomendacje.json`,
      payload: { ...base, points: [], candidates: [], photos: [] },
    },
  ];

  return packages.map((pkg) => {
    const json = JSON.stringify(pkg.payload, null, 2);
    return {
      ...pkg,
      json,
      date: base.exportedAt,
      bytes: new Blob([json], { type: 'application/json' }).size,
    };
  });
}

function reportRow(pkg) {
  const btn = h(
    'button',
    {
      class: 'btn btn--sm',
      onclick: () => {
        download(pkg.file, pkg.json, 'application/json');
        toast(`Pobrano „${pkg.file}”.`);
      },
    },
    'POBIERZ'
  );

  return h(
    'div',
    { class: 'list-row', style: { cursor: 'default' } },
    h(
      'div',
      { class: 'list-row__body' },
      h('div', { class: 'list-row__title', text: pkg.name }),
      h('div', { class: 'list-row__meta', text: `${pkg.date} · ${fmtBytes(pkg.bytes)} · JSON` })
    ),
    btn
  );
}

/* ------------------------------------------------------------------ *
 * Biblioteka presetów
 * ------------------------------------------------------------------ */

function presetCard(preset) {
  const fields = (preset.requiredFields || []).length;
  const photos = (preset.requiredPhotos || []).length;
  return h(
    'div',
    { class: 'preset-card' },
    h('div', { class: 'preset-card__id', text: preset.id }),
    h('div', { text: preset.name }),
    h('div', { class: 'preset-card__cost', text: fmtCost(preset.cost) }),
    h('div', {
      class: 'note',
      text:
        `${fmtNum(fields)} ${plural(fields, ['pole wymagane', 'pola wymagane', 'pól wymaganych'])}`
        + ` · ${fmtNum(photos)} ${plural(photos, ['zdjęcie', 'zdjęcia', 'zdjęć'])}`,
    })
  );
}

/* ------------------------------------------------------------------ *
 * Stopka – przywracanie danych demo (realne działanie)
 * ------------------------------------------------------------------ */

async function confirmResetToDemo() {
  const body = h(
    'div',
    { class: 'stack' },
    h('p', {
      text:
        'Wszystkie zmiany zapisane w przeglądarce (punkty, karty, zdjęcia, rekomendacje) '
        + 'zostaną usunięte i zastąpione oryginalnymi danymi demo Tychów.',
    }),
    h('p', { class: 'note', text: 'Operacji nie da się cofnąć. Wcześniej możesz pobrać pakiet danych z sekcji „Ostatnie raporty”.' })
  );

  const confirmed = await modal({
    title: 'Przywrócić dane demo?',
    body,
    confirmLabel: 'PRZYWRÓĆ',
    cancelLabel: 'Anuluj',
  });
  if (!confirmed) return;

  await resetToDemo();
  toast('Przywrócono dane demo Tychów.');
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const navigate = ctx.navigate;
  const analysis = analyzeCurrent();
  const projects = state.projects || [];
  const availableCount = projects.filter((p) => p.available).length;

  // Podpasek zostaje pusty: liczba projektów jest widoczna wprost w kafelkach.

  /* --- sekcja: projekty ------------------------------------------- */

  const projectsSection = h(
    'section',
    { class: 'dash__section', style: { marginTop: '0' } },
    h(
      'div',
      { class: 'row' },
      h('h2', { text: 'Projekty' }),
    ),
    h('p', { class: 'note', text: 'Kluczowy wskaźnik to pokrycie stanu obecnego liczone modelem dojścia pieszego (SPEC §5).' }),
    h(
      'div',
      { class: 'dash__grid', style: { marginTop: '10px' } },
      ...projects.map((project) => projectCard(project, analysis, navigate)),
      newProjectCard(navigate)
    )
  );

  /* --- sekcja: ostatnie raporty ----------------------------------- */

  const historyBtn = disabledControl(
    h('button', { class: 'btn btn--sm' }, 'Historia wersji'),
    REASON_OUT_OF_SCOPE
  );

  const reportsSection = h(
    'section',
    { class: 'dash__section' },
    h(
      'div',
      { class: 'row' },
      h('h2', { text: 'Ostatnie raporty' }),
      h('span', { class: 'spacer' }),
      historyBtn
    ),
    h('p', {
      class: 'note',
      text: 'Iteracja 2 wydaje raport jako pakiet danych JSON generowany z bieżącego stanu projektu. '
        + 'PDF powstaje w kroku 5 (Raport) przez wydruk podglądu.',
    }),
    h('div', { class: 'card', style: { marginTop: '10px', padding: '4px 16px' } }, ...reportPackages().map(reportRow))
  );

  /* --- sekcja: biblioteka presetów -------------------------------- */

  const editPresetsBtn = disabledControl(
    h('button', { class: 'btn btn--sm' }, 'Edytuj presety'),
    REASON_OUT_OF_SCOPE
  );

  const presets = state.presets || [];
  const presetsSection = h(
    'section',
    { class: 'dash__section' },
    h(
      'div',
      { class: 'row' },
      h('h2', { text: 'Biblioteka presetów' }),
      h('span', { class: 'spacer' }),
      editPresetsBtn
    ),
    h('p', {
      class: 'note',
      text: 'Preset określa koszt wdrożenia oraz zestaw pól i zdjęć wymaganych do 100% kompletności karty.',
    }),
    presets.length
      ? h('div', { class: 'preset-grid', style: { marginTop: '10px' } }, ...presets.map(presetCard))
      : h('div', { class: 'empty-state', text: 'Nie wczytano presetów.' })
  );

  /* --- stopka ------------------------------------------------------ */

  const footerSection = h(
    'section',
    { class: 'dash__section' },
    h('div', { class: 'divider' }),
    h(
      'div',
      { class: 'row row--wrap' },
      // Objaśnienie o IndexedDB zdjęte – to szczegół implementacji, a nie
      // informacja dla osoby, która przyszła zrobić audyt. Same przyciski
      // niosą, co robią.
      h('span', { class: 'spacer' }),
      // Zamknięcie sesji pokazu: kasuje zapamiętane wejście i wraca na ekran
      // z hasłem. Stoi obok resetu danych, bo to ta sama półka – sprzątanie
      // po spotkaniu, a nie codzienna praca.
      h(
        'button',
        {
          class: 'btn',
          title: 'Wyloguj z makiety – następne wejście znów poprosi o hasło',
          onclick: lockAgain,
        },
        icon('shield-check', 14),
        'Zablokuj makietę'
      ),
      h('button', { class: 'btn btn--danger', onclick: confirmResetToDemo }, 'Przywróć dane demo')
    )
  );

  /* --- pasmo otwierające: fotografia i zaproszenie do nowego audytu --- */

  // HeroBanner z design systemu: zdjęcie z ciemnym scrimem po lewej, drugie
  // zdjęcie w kolumnie 470 px po prawej, nagłówek 64 px na scrimie. To jedyne
  // miejsce w aplikacji, gdzie fotografia niesie treść, a nie dekoruje.
  const hero = h(
    'div',
    { class: 'hero' },
    h('div', { class: 'hero__photo' }, h('div', { class: 'hero__scrim' })),
    h(
      'div',
      { class: 'hero__body' },
      h('div', { class: 'hero__eyebrow', text: 'Sinecco · AED Planner' }),
      h('h1', { class: 'hero__headline', text: 'Bezpieczeństwo zaczyna się od dobrego planu.' }),
      h(
        'button',
        { class: 'btn btn--signal btn--lg btn--bolt', onclick: () => openNewAudit(navigate) },
        h('span', { text: 'Nowy audyt' })
      )
    ),
    h('div', { class: 'hero__inset' })
  );

  mount(
    root,
    hero,
    h('div', { class: 'dash' }, projectsSection, reportsSection, presetsSection, footerSection)
  );
}
