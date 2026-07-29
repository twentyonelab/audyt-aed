/**
 * views/dashboard.js — pulpit projektów (SPEC §6.0, trasa '#/').
 *
 * Bez steppera: top bar i sub bar rysuje router, widok wypełnia tylko
 * obszar roboczy. Wszystkie liczby pochodzą z model.js / state.js —
 * nic nie jest wpisane na sztywno w HTML.
 */

import { analyze, fmtPct, fmtMin, fmtNum, fmtCost } from '../model.js';
import { state, exportProject, resetToDemo } from '../state.js';
import {
  h, el, mount, pillHtml, toast, modal, disabledControl, download,
} from '../ui.js';

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

/** Kroki 0–5 z SPEC §3 — sześć segmentów paska postępu. */
const STEP_COUNT = 6;

const STATUS_META = {
  w_toku: { label: 'W TOKU', variant: 'warn' },
  oferta: { label: 'OFERTA', variant: '' },
  zakonczony: { label: 'ZAKOŃCZONY', variant: 'ok' },
};

const REASON_DEMO_ONLY = 'dane demo tylko dla Tychów (iteracja 2)';
const REASON_OUT_OF_SCOPE = 'poza zakresem iteracji 2';

/** Polska odmiana liczebnika: [1, 2–4, 5+]. */
function plural(n, forms) {
  const abs = Math.abs(n);
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (abs === 1) return forms[0];
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return forms[1];
  return forms[2];
}

/** Rozmiar pliku — liczby przez fmtNum, żeby separatory były jednolite. */
function fmtBytes(bytes) {
  if (bytes < 1024) return `${fmtNum(bytes)} B`;
  if (bytes < 1024 * 1024) return `${fmtNum(bytes / 1024, 1)} kB`;
  return `${fmtNum(bytes / (1024 * 1024), 2)} MB`;
}

function statusOf(project) {
  return STATUS_META[project.status] || { label: String(project.status || '—').toUpperCase(), variant: '' };
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
  });
}

/* ------------------------------------------------------------------ *
 * Nowy audyt
 * ------------------------------------------------------------------ */

async function openNewAudit(navigate) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'np. Brodnica',
    autocomplete: 'off',
  });

  const body = h(
    'div',
    { class: 'stack' },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field__label', text: 'Nazwa gminy' }),
      input
    ),
    h('p', {
      class: 'note',
      text:
        'Iteracja 2 pracuje na jednym zestawie danych demo. Kreator otworzy krok 0 '
        + '(Setup projektu) z danymi Tychów — zakładanie własnych gmin wchodzi w iteracji 3.',
    })
  );

  const confirmed = await modal({
    title: 'Nowy audyt',
    body,
    confirmLabel: 'DALEJ → KROK 0',
    cancelLabel: 'Anuluj',
  });
  if (!confirmed) return;

  const name = input.value.trim();
  toast(
    name
      ? `W iteracji 2 dostępny jest wyłącznie projekt demo Tychy — „${name}” zapiszemy w iteracji 3.`
      : 'W iteracji 2 dostępny jest wyłącznie projekt demo Tychy.'
  );
  navigate('#/setup');
}

/* ------------------------------------------------------------------ *
 * Kafelek projektu
 * ------------------------------------------------------------------ */

function projectCard(project, analysis, navigate) {
  const isActive = !!(state.project && state.project.id === project.id);
  const stepsDone = new Set(isActive ? state.project.stepsDone || [] : []);
  const status = statusOf(project);

  /* pasek kroków 0–5 */
  const steps = h(
    'div',
    { class: 'project-card__steps', 'aria-label': `Ukończone kroki: ${stepsDone.size} z ${STEP_COUNT}` },
    ...Array.from({ length: STEP_COUNT }, (_, i) =>
      h('span', {
        class: `project-card__step${stepsDone.has(i) ? ' is-done' : ''}`,
        title: `Krok ${i} — ${stepsDone.has(i) ? 'ukończony' : 'nierozpoczęty'}`,
      })
    )
  );

  /* wiersz meta — realne liczby z danych projektu */
  let metaText;
  if (isActive) {
    const existing = state.points.filter((p) => p.kind === 'existing').length;
    const districts = (state.project.districts || []).length;
    metaText =
      `${fmtNum(existing)} ${plural(existing, ['punkt AED', 'punkty AED', 'punktów AED'])}`
      + ` · ${fmtNum(districts)} ${plural(districts, ['dzielnica', 'dzielnice', 'dzielnic'])}`
      + ` · ${fmtNum(state.project.population)} mieszk.`;
  } else {
    metaText = 'brak danych źródłowych w tej iteracji';
  }

  /* kluczowy wskaźnik */
  const showKpi = project.available && isActive && analysis;
  const kpi = showKpi
    ? h(
        'div',
        { class: 'project-card__kpi' },
        fmtPct(analysis.coveragePct),
        h('small', { text: `pokrycia ≤ ${fmtMin(state.project.standardMinutes, 0)}` })
      )
    : h(
        'div',
        { class: 'project-card__kpi' },
        '—',
        h('small', { text: 'wskaźnik policzymy po wczytaniu danych' })
      );

  /* akcje */
  const openBtn = h('button', { class: 'btn btn--sm btn--primary' }, 'OTWÓRZ');
  if (project.available) {
    openBtn.addEventListener('click', () => navigate('#/inventory'));
  } else {
    disabledControl(openBtn, REASON_DEMO_ONLY);
  }

  const duplicateBtn = disabledControl(
    h('button', { class: 'btn btn--sm btn--ghost' }, 'Duplikuj'),
    project.available ? REASON_OUT_OF_SCOPE : REASON_DEMO_ONLY
  );
  const archiveBtn = disabledControl(
    h('button', { class: 'btn btn--sm btn--ghost' }, 'Archiwizuj'),
    project.available ? REASON_OUT_OF_SCOPE : REASON_DEMO_ONLY
  );

  return h(
    'article',
    { class: 'project-card' },
    h(
      'div',
      { class: 'project-card__head' },
      h('h3', { text: project.name }),
      el(pillHtml(status.label, status.variant))
    ),
    h('div', { class: 'note', text: metaText }),
    h(
      'div',
      { class: 'stack', style: { gap: '4px' } },
      steps,
      h('span', {
        class: 'label-caps',
        text: `Kroki 0–5 · ${fmtNum(stepsDone.size)} z ${fmtNum(STEP_COUNT)}`,
      })
    ),
    kpi,
    h('div', { class: 'project-card__foot' }, openBtn, h('span', { class: 'spacer' }), duplicateBtn, archiveBtn)
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
 * Ostatnie raporty — realne pakiety danych z exportProject()
 * ------------------------------------------------------------------ */

function reportPackages() {
  const base = exportProject();
  const slug = (state.project && state.project.id) || 'projekt';
  const label = (state.project && state.project.label) || 'Projekt';

  const packages = [
    {
      name: `${label} — pakiet raportu (komplet danych)`,
      file: `sinecco-aed-${slug}-raport.json`,
      payload: base,
    },
    {
      name: `${label} — załącznik: rejestr punktów`,
      file: `sinecco-aed-${slug}-punkty.json`,
      payload: { ...base, recommendations: [], candidates: [] },
    },
    {
      name: `${label} — załącznik: rekomendacje i roadmapa`,
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
 * Stopka — przywracanie danych demo (realne działanie)
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

  if (ctx.setMeta) {
    ctx.setMeta(
      `${fmtNum(projects.length)} ${plural(projects.length, ['projekt', 'projekty', 'projektów'])}`
      + ` · ${fmtNum(availableCount)} z danymi demo`
    );
  }

  /* --- sekcja: projekty ------------------------------------------- */

  const newAuditBtn = h(
    'button',
    { class: 'btn btn--primary', onclick: () => openNewAudit(navigate) },
    '+ NOWY AUDYT'
  );

  const projectsSection = h(
    'section',
    { class: 'dash__section', style: { marginTop: '0' } },
    h(
      'div',
      { class: 'row' },
      h('h2', { text: 'Projekty' }),
      h('span', { class: 'spacer' }),
      newAuditBtn
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
      h(
        'div',
        { class: 'stack', style: { gap: '2px' } },
        h('span', { class: 'label-caps', text: 'Dane robocze' }),
        h('span', {
          class: 'note',
          text: 'Stan projektu trzymamy w IndexedDB przeglądarki. Reset przywraca oryginalny zestaw demo.',
        })
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--danger', onclick: confirmResetToDemo }, 'Przywróć dane demo')
    )
  );

  mount(root, h('div', { class: 'dash' }, projectsSection, reportsSection, presetsSection, footerSection));
}
