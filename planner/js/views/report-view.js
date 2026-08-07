/**
 * views/report-view.js — Krok 5: Raport dla decydenta (SPEC §6.7, trasa '#/report').
 *
 * Trzy kolumny (`.report-layout`): miniatury stron · podgląd A4 · konfiguracja.
 * Treść stron pochodzi w całości z `js/report.js` — ten plik odpowiada wyłącznie
 * za powłokę widoku, interakcję i eksporty.
 *
 * Co tu naprawdę działa:
 *  • klik w miniaturę przewija podgląd do sekcji (a jeśli sekcja jest wyłączona —
 *    najpierw ją włącza, więc żaden przycisk nie jest martwy),
 *  • przewijanie podglądu podświetla właściwą miniaturę,
 *  • checkboxy sekcji zapisują się w `state.ui.reportSections` przez `save()`,
 *  • „GENERUJ PDF — SNAPSHOT" woła `window.print()` (arkusz @media print jest w app.css),
 *  • eksport CSV i GeoJSON są realne; XLSX jest jawnie oznaczony jako poza zakresem.
 *
 * Widok nie tworzy mapy interaktywnej — mapy „jest / będzie" to statyczny SVG
 * z `renderSceneSvg()`, więc nie ma czego zwalniać poza nasłuchem przewijania.
 */

import { state, save, markStepDone, getPreset, districtName } from '../state.js';

import { completeness, expertScore, fmtNum, fmtPct } from '../model.js';

import {
  h,
  mount,
  toast,
  disabledControl,
  download,
  toCsv,
  dotHtml,
  pillHtml,
  statusMeta,
} from '../ui.js';

import { REPORT_SECTIONS, buildReport, enabledSectionIds, isSectionOn } from '../report.js';
import { buildCardPdf, cardPdfFilename } from '../cardpdf.js';
import { zipStore } from '../zip.js';

import { TODAY, OPERATOR } from '../../config.js';

export const meta = {
  step: 5,
  title: 'Raport',
  subtitle: 'dla decydenta',
  layout: 'split',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/**
 * Kolumny CSV. Pierwsze jedenaście jest identyczne jak w eksporcie z kroku 1,
 * dzięki czemu plik z raportu wraca bez zmian przez „IMPORT CSV" w Inwentaryzacji;
 * kolumny audytowe dopisane są na końcu.
 */
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
  'rodzaj',
  'opiekun',
  'rejestracja_112',
  'kompletnosc_pct',
  'rekomendacje',
  'faza',
];

const KIND_LABEL = { existing: 'istniejący', proposed: 'nowy' };

const REASON_OUT_OF_SCOPE = 'poza zakresem iteracji 2';

/** Ile pikseli od górnej krawędzi podglądu uznajemy za „strona aktywna". */
const ACTIVE_PAGE_OFFSET = 60;

/* ------------------------------------------------------------------ *
 * Stan lokalny widoku (nie są to dane projektu — nie trafia do state)
 * ------------------------------------------------------------------ */

/** Metryka dokumentu z panelu konfiguracji. Trzymana lokalnie, żeby pisanie
 *  w polach nie wywoływało save() i nie gubiło fokusu. */
const docMeta = { date: TODAY, contact: OPERATOR };

let activeSectionId = REPORT_SECTIONS[0].id;

/**
 * Dwie sekcje widoku (życzenie klienta): raport ogólny i zgrupowane karty
 * punktów z eksportem do osobnych PDF-ów. Przełączane w sub barze.
 */
let reportTab = 'report'; // 'report' | 'cards'

/** Sekcja, do której trzeba przewinąć po przerysowaniu widoku przez save(). */
let pendingScrollId = null;

/** Uchwyty DOM bieżącego renderu. */
let refs = null;

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy)
 * ------------------------------------------------------------------ */

function plural(n, [one, few, many]) {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const r100 = abs % 100;
  const r10 = abs % 10;
  if (r100 > 10 && r100 < 20) return many;
  return r10 >= 2 && r10 <= 4 ? few : many;
}

function boolToCsv(value) {
  return value === true ? 'tak' : value === false ? 'nie' : '';
}

function field(label, control, hint) {
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    control,
    hint ? h('span', { class: 'field__hint', text: hint }) : null
  );
}

function configCard(title, ...children) {
  return h(
    'div',
    { class: 'card' },
    h('span', { class: 'label-caps', style: { display: 'block', marginBottom: '10px' }, text: title }),
    ...children
  );
}

/** Zapisuje wybór sekcji w kolejności druku (null = wszystkie). */
function setSectionEnabled(id, on) {
  const current = new Set(enabledSectionIds(state));
  if (on) current.add(id);
  else current.delete(id);
  state.ui.reportSections = REPORT_SECTIONS.map((s) => s.id).filter((sid) => current.has(sid));
}

function setSections(ids) {
  state.ui.reportSections = REPORT_SECTIONS.map((s) => s.id).filter((sid) => ids.includes(sid));
}

/* ------------------------------------------------------------------ *
 * Widok
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const project = state.project;

  if (!project) {
    mount(
      root,
      h(
        'div',
        { class: 'empty-state' },
        'Brak aktywnego projektu. ',
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate('#/') }, 'Wróć do pulpitu')
      )
    );
    return;
  }

  // Wejście w widok zalicza krok 5. Zapis „silent", bo zwykły save() przerysowałby
  // widok w trakcie jego budowania; powłoka i tak czyta stepsDone przy renderze.
  if (!(project.stepsDone || []).includes(5)) {
    markStepDone(5);
    await save({ silent: true });
  }

  /* ---------------- dwie sekcje widoku: raport ogólny | karty punktów ---------------- */

  const setTab = (value) => {
    if (reportTab === value) return;
    reportTab = value;
    render(root, ctx);
  };

  const tabSeg = h(
    'div',
    { class: 'seg' },
    h(
      'button',
      { class: `seg__btn${reportTab === 'report' ? ' is-on' : ''}`, onclick: () => setTab('report') },
      'Raport ogólny'
    ),
    h(
      'button',
      { class: `seg__btn${reportTab === 'cards' ? ' is-on' : ''}`, onclick: () => setTab('cards') },
      'Karty punktów (załączniki)'
    )
  );

  if (reportTab === 'cards') {
    renderCardsSection(root, ctx, tabSeg);
    return;
  }

  const report = buildReport(state, docMeta);

  /* ---------------- kolumna 1: miniatury ---------------- */

  const thumbNodes = new Map();

  const thumbs = h(
    'div',
    { class: 'report-thumbs' },
    ...REPORT_SECTIONS.map((section, index) => {
      const on = isSectionOn(state, section.id);
      const node = h(
        'button',
        {
          class: `report-thumb${on && section.id === activeSectionId ? ' is-on' : ''}`,
          dataset: { section: section.id },
          style: on ? null : { opacity: '0.5' },
          title: on
            ? `Przewiń podgląd do sekcji: ${section.title}`
            : 'Sekcja wyłączona — kliknij, aby włączyć ją z powrotem',
          onclick: () => onThumbClick(section.id),
        },
        h('span', { class: 'report-thumb__no', text: `STRONA ${index + 1}` }),
        h('div', { text: section.title }),
        on ? null : h('div', { class: 'note', text: 'wyłączona' })
      );
      thumbNodes.set(section.id, node);
      return node;
    })
  );

  /* ---------------- kolumna 2: podgląd A4 ---------------- */

  const preview = h('div', { class: 'report-preview' });
  const pageNodes = new Map();

  function buildPages(built) {
    pageNodes.clear();
    if (!built.sections.length) {
      mount(
        preview,
        h('div', { class: 'empty-state' }, 'Wszystkie sekcje są wyłączone — włącz przynajmniej jedną w panelu po prawej.')
      );
      return;
    }
    const total = built.sections.length;
    const pages = built.sections.map((section, index) => {
      const page = h(
        'div',
        { class: 'report-page', dataset: { section: section.id } },
        h(
          'div',
          { class: 'report-page__head' },
          h('b', { text: 'SINECCO · AED Planner' }),
          h('span', {
            text: `${project.label || project.name} · ${docMeta.date} · str. ${index + 1}/${total}`,
          })
        ),
        h('div', { html: section.html })
      );
      pageNodes.set(section.id, page);
      return page;
    });
    mount(preview, ...pages);
  }

  buildPages(report);

  /** Przebudowa samego podglądu — po zmianie daty lub kontaktu. */
  function refreshPreview() {
    const offset = preview.scrollTop;
    buildPages(buildReport(state, docMeta));
    preview.scrollTop = offset;
  }

  /* ---------------- interakcja miniatur ---------------- */

  function highlightThumb(id) {
    for (const [sectionId, node] of thumbNodes) {
      node.classList.toggle('is-on', sectionId === id && isSectionOn(state, sectionId));
    }
  }

  function scrollToSection(id) {
    const page = pageNodes.get(id);
    if (!page) return;
    page.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function onThumbClick(id) {
    activeSectionId = id;
    if (!isSectionOn(state, id)) {
      setSectionEnabled(id, true);
      pendingScrollId = id;
      await save(); // przerysowuje widok; przewinięcie dokończy się po renderze
      return;
    }
    highlightThumb(id);
    scrollToSection(id);
  }

  let scrollQueued = false;
  function onPreviewScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (!pageNodes.size) return;
      const box = preview.getBoundingClientRect();
      let current = null;
      for (const [id, node] of pageNodes) {
        if (node.getBoundingClientRect().top - box.top <= ACTIVE_PAGE_OFFSET) current = id;
      }
      if (current && current !== activeSectionId) {
        activeSectionId = current;
        highlightThumb(current);
      }
    });
  }
  preview.addEventListener('scroll', onPreviewScroll);

  /* ---------------- kolumna 3: konfiguracja ---------------- */

  const sectionChecks = REPORT_SECTIONS.map((section, index) =>
    h(
      'label',
      { class: 'checkline' },
      h('input', {
        type: 'checkbox',
        checked: isSectionOn(state, section.id),
        onchange: async (event) => {
          setSectionEnabled(section.id, event.target.checked);
          await save();
        },
      }),
      h('span', { text: `${index + 1}. ${section.title}` })
    )
  );

  const cardSections = configCard(
    'Sekcje raportu',
    h('div', { class: 'stack', style: { gap: '6px' } }, ...sectionChecks),
    h(
      'div',
      { class: 'row row--wrap', style: { marginTop: '12px' } },
      h(
        'button',
        {
          class: 'btn btn--sm',
          onclick: async () => {
            setSections(REPORT_SECTIONS.map((s) => s.id));
            await save();
          },
        },
        'Wszystkie sekcje'
      ),
      h(
        'button',
        {
          class: 'btn btn--sm',
          title: 'Tylko okładka i podsumowanie — wersja na jedną kartkę',
          onclick: async () => {
            setSections(['cover', 'summary']);
            activeSectionId = 'cover';
            await save();
          },
        },
        'Tylko podsumowanie'
      )
    )
  );

  const cardMeta = configCard(
    'Metryka dokumentu',
    h(
      'div',
      { class: 'stack' },
      field(
        'Data raportu',
        h('input', {
          class: 'input',
          type: 'date',
          value: docMeta.date,
          onchange: (event) => {
            docMeta.date = event.target.value || TODAY;
            event.target.value = docMeta.date; // pole nigdy nie zostaje puste
            refreshPreview();
          },
        })
      ),
      field(
        'Kontakt / opracowanie',
        h('input', {
          class: 'input',
          type: 'text',
          value: docMeta.contact,
          placeholder: 'imię i nazwisko · e-mail · telefon',
          onchange: (event) => {
            docMeta.contact = event.target.value.trim() || OPERATOR;
            event.target.value = docMeta.contact;
            refreshPreview();
          },
        }),
        'Trafia na okładkę raportu. Zmiana odświeża podgląd.'
      )
    )
  );

  const cardGenerate = configCard(
    'Generowanie',
    h(
      'button',
      {
        class: 'btn btn--primary btn--block',
        onclick: () => window.print(),
      },
      'GENERUJ PDF — SNAPSHOT'
    ),
    h('p', {
      class: 'note',
      style: { marginTop: '10px' },
      text:
        'Iteracja 2: wydruk przeglądarki z arkuszem @media print (A4, marginesy 14 mm). ' +
        'W oknie druku wybierz „Zapisz jako PDF”. Miniatury, ten panel i powłoka aplikacji ' +
        'nie trafiają na wydruk; każda sekcja zaczyna nową stronę.',
    })
  );

  /* ---------------- eksporty ---------------- */

  function pointRows() {
    return state.points.map((point) => {
      const preset = getPreset(point.presetId);
      const comp = completeness(point, preset, state.photos);
      const recs = state.recommendations.filter((r) => r.pointId === point.id);
      return { point, preset, comp, recs };
    });
  }

  function exportCsv() {
    const rows = pointRows().map(({ point, comp, recs }) => [
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
      KIND_LABEL[point.kind] || point.kind,
      (point.keeper && point.keeper.org) || '',
      boolToCsv(point.dispatcherRegistered),
      comp.required ? fmtNum(comp.pct) : '',
      fmtNum(recs.length),
      point.phase ? fmtNum(point.phase) : '',
    ]);

    download(
      `raport-aed-${project.id}-punkty-${docMeta.date}.csv`,
      toCsv(CSV_HEADERS, rows),
      'text/csv;charset=utf-8'
    );
    toast(`Wyeksportowano ${fmtNum(rows.length)} ${plural(rows.length, ['punkt', 'punkty', 'punktów'])} do CSV.`);
  }

  function exportGeoJson() {
    const features = pointRows()
      .filter(({ point }) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
      .map(({ point, preset, comp, recs }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        properties: {
          id: point.id,
          kind: point.kind,
          status: point.status,
          name: point.name,
          address: point.address || null,
          districtId: point.districtId || null,
          districtName: districtName(point.districtId),
          presetId: point.presetId || null,
          presetName: preset ? preset.name : null,
          presetCost: preset ? preset.cost : null,
          placement: point.placement || null,
          access: point.access || null,
          keeper: point.keeper || null,
          signage: point.signage || null,
          device: point.device || null,
          dispatcherRegistered: point.dispatcherRegistered,
          technical: point.technical || null,
          verification: point.verification || null,
          phase: point.phase ?? null,
          gainPct: Number.isFinite(point.gainPct) ? point.gainPct : null,
          completenessPct: comp.required ? comp.pct : null,
          missingFields: comp.missingFields,
          missingPhotos: comp.missingPhotos,
          recommendations: recs.length,
          notes: point.notes || null,
        },
      }));

    const collection = {
      type: 'FeatureCollection',
      name: `aed-${project.id}`,
      properties: {
        project: project.label || project.name,
        population: project.population,
        standardMinutes: project.standardMinutes,
        exportedAt: docMeta.date,
        source: 'Sinecco AED Planner — iteracja 2',
      },
      features,
    };

    download(
      `raport-aed-${project.id}-punkty-${docMeta.date}.geojson`,
      JSON.stringify(collection, null, 2),
      'application/geo+json'
    );
    toast(`Wyeksportowano ${fmtNum(features.length)} ${plural(features.length, ['obiekt', 'obiekty', 'obiektów'])} do GeoJSON.`);
  }

  const xlsxBtn = disabledControl(
    h('button', { class: 'btn btn--block' }, 'XLSX (arkusz zbiorczy)'),
    REASON_OUT_OF_SCOPE
  );

  const cardExport = configCard(
    'Eksport danych',
    h(
      'div',
      { class: 'stack', style: { gap: '6px' } },
      h('button', { class: 'btn btn--block', onclick: exportCsv }, 'CSV punktów'),
      h('button', { class: 'btn btn--block', onclick: exportGeoJson }, 'GeoJSON punktów'),
      xlsxBtn
    ),
    h('p', {
      class: 'note',
      style: { marginTop: '10px' },
      text: `Kolumny CSV: ${CSV_HEADERS.join('; ')}`,
    })
  );

  /* ---------------- historia wersji ---------------- */

  const enabledCount = enabledSectionIds(state).length;

  const cardHistory = configCard(
    'Historia wersji',
    h(
      'div',
      { class: 'card', style: { background: 'var(--section)' } },
      h(
        'div',
        { class: 'row' },
        h('strong', { text: 'v1 — bieżąca' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', text: docMeta.date })
      ),
      h('div', {
        class: 'note',
        text: `${enabledCount} z ${REPORT_SECTIONS.length} ${plural(enabledCount, [
          'sekcja',
          'sekcje',
          'sekcji',
        ])} · ${docMeta.contact}`,
      })
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '10px' } },
      disabledControl(h('button', { class: 'btn btn--sm' }, 'ARCHIWUM WERSJI'), REASON_OUT_OF_SCOPE)
    ),
    h('p', {
      class: 'note',
      style: { marginTop: '10px' },
      text:
        'W iteracji 2 przechowywana jest jedna wersja robocza — ta, którą właśnie widzisz. ' +
        'Wersjonowanie raportów wchodzi razem z zapisem serwerowym.',
    })
  );

  const config = h(
    'div',
    { class: 'report-config' },
    h('div', { class: 'stack' }, cardSections, cardMeta, cardGenerate, cardExport, cardHistory)
  );

  /* ---------------- złożenie ---------------- */

  // Szerokości kolumn (170 px · 620 px · reszta) pochodzą z `.report-layout`
  // w app.css; tu dokładamy tylko rozciągnięcie w obszarze roboczym layoutu 'split'.
  const layout = h(
    'div',
    { class: 'report-layout', style: { flex: '1', minWidth: '0', padding: '16px' } },
    thumbs,
    preview,
    config
  );

  mount(root, layout);

  /* ---------------- sub bar ---------------- */

  const coverage = report.kpis.find((k) => k.id === 'coverage');
  if (typeof ctx.setMeta === 'function') {
    ctx.setMeta(
      `${fmtNum(enabledCount)} z ${fmtNum(REPORT_SECTIONS.length)} ${plural(enabledCount, [
        'sekcja',
        'sekcje',
        'sekcji',
      ])}` + (coverage ? ` · pokrycie ${coverage.now} → ${coverage.plan}` : '')
    );
  }

  if (ctx.subbar && ctx.subbar.controls) {
    mount(
      ctx.subbar.controls,
      tabSeg,
      h(
        'button',
        { class: 'btn btn--sm btn--primary', onclick: () => window.print() },
        'GENERUJ PDF — SNAPSHOT'
      )
    );
  }

  /* ---------------- przewinięcie po przerysowaniu ---------------- */

  refs = { preview, onPreviewScroll };

  if (pendingScrollId) {
    const target = pendingScrollId;
    pendingScrollId = null;
    requestAnimationFrame(() => {
      highlightThumb(target);
      scrollToSection(target);
    });
  } else {
    highlightThumb(activeSectionId);
  }
}

/* ------------------------------------------------------------------ *
 * Sekcja druga: karty punktów jako załączniki (osobne PDF-y)
 * ------------------------------------------------------------------ */

function renderCardsSection(root, ctx, tabSeg) {
  const project = state.project;
  // Odrzucone propozycje nie idą do gminy — reszta punktów dostaje kartę.
  const points = state.points.filter((p) => p.status !== 'rejected');

  const downloadOne = async (point) => {
    try {
      download(cardPdfFilename(point), await buildCardPdf(point), 'application/pdf');
      toast(`Pobrano kartę ${point.id}.`);
    } catch (err) {
      console.error(err);
      toast('Nie udało się wygenerować PDF — szczegóły w konsoli.');
    }
  };

  const downloadAll = async () => {
    try {
      toast('Generuję karty… (zdjęcia są konwertowane do JPEG)');
      const files = [];
      for (const point of points) {
        files.push({ name: cardPdfFilename(point), data: await buildCardPdf(point) });
      }
      const archive = zipStore(files, docMeta.date);
      download(`karty-punktow_${project.id}_${docMeta.date}.zip`, archive, 'application/zip');
      toast(`Spakowano ${fmtNum(files.length)} ${plural(files.length, ['kartę', 'karty', 'kart'])} PDF do jednego ZIP.`);
    } catch (err) {
      console.error(err);
      toast('Nie udało się zbudować archiwum — szczegóły w konsoli.');
    }
  };

  const rowFor = (point) => {
    const preset = getPreset(point.presetId);
    const comp = completeness(point, preset, state.photos);
    const status = statusMeta(point, comp.pct);
    const score = expertScore(point);
    return h(
      'tr',
      {},
      h('td', {}, h('div', {
        class: 'row',
        html: `${dotHtml(status.level)}<span class="table__main">${point.name || point.id}</span>`,
      }), h('div', { class: 'table__sub', text: `${point.id} · ${districtName(point.districtId)}` })),
      h('td', { text: preset ? preset.id : '—' }),
      h('td', { class: 'num', text: comp.required ? fmtPct(comp.pct, 0) : '—' }),
      h('td', {}, score
        ? h('span', { class: `score-badge score-badge--${score.verdict.variant}`, text: fmtNum(score.value, 1) })
        : h('span', { class: 'muted', text: '—' })),
      h('td', { html: pillHtml(status.label, status.variant) }),
      h(
        'td',
        { style: { textAlign: 'right' } },
        h('button', { class: 'btn btn--sm', onclick: () => downloadOne(point) }, 'POBIERZ PDF')
      )
    );
  };

  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { text: 'Punkt' }),
        h('th', { style: { width: '90px' }, text: 'Preset' }),
        h('th', { style: { width: '110px' }, text: 'Kompletność' }),
        h('th', { style: { width: '80px' }, text: 'Ocena' }),
        h('th', { style: { width: '150px' }, text: 'Status' }),
        h('th', { style: { width: '130px' } })
      )
    ),
    h('tbody', {}, ...points.map(rowFor))
  );

  const holder = h(
    'div',
    { style: { flex: '1', minWidth: '0', overflowY: 'auto', padding: '16px' } },
    h(
      'div',
      { class: 'card', style: { marginBottom: '14px' } },
      h(
        'div',
        { class: 'row row--wrap' },
        h(
          'div',
          null,
          h('h2', { text: 'Karty punktów — załączniki do raportu' }),
          h('p', {
            class: 'note',
            style: { marginTop: '4px', maxWidth: '640px' },
            text:
              'Każdy punkt ma kartę PDF w zamrożonej konwencji — układ jest stały, więc karta wysłana ' +
              'do gminy wygląda tak samo niezależnie od tego, kto i kiedy ją wygenerował. Raport ogólny ' +
              'opisuje działania zbiorczo, karty są jego załącznikami.',
          })
        ),
        h('span', { class: 'spacer' }),
        h(
          'button',
          { class: 'btn btn--primary', onclick: downloadAll },
          `POBIERZ WSZYSTKIE — ${fmtNum(points.length)} PDF (ZIP)`
        )
      )
    ),
    table
  );

  mount(root, holder);

  if (typeof ctx.setMeta === 'function') {
    ctx.setMeta(`${fmtNum(points.length)} ${plural(points.length, ['karta', 'karty', 'kart'])} · osobny PDF na punkt`);
  }
  if (ctx.subbar && ctx.subbar.controls) {
    mount(ctx.subbar.controls, tabSeg);
  }

  refs = null; // ta sekcja nie ma nasłuchu przewijania podglądu
}

export function destroy() {
  if (refs) refs.preview.removeEventListener('scroll', refs.onPreviewScroll);
  refs = null;
}
