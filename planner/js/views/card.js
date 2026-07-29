/**
 * views/card.js — Krok 3: Karta punktu (SPEC §6.5, trasa '#/card/:id').
 *
 * Dwie kolumny: sekcje karty (880 px, przewijalne) + panel boczny (520 px).
 * Osiem sekcji 1–8, każda z paskiem statusu po lewej (.card-section--crit /
 * --warn / bez modyfikatora).
 *
 * Wszystkie liczby pochodzą z model.js — widok niczego nie liczy sam:
 *   • completeness()        — pasek kompletności i braki pól/zdjęć,
 *   • autoRecommendations() — checklist zgodności (sekcja 8),
 *   • coverageRadiusM()     — promień strefy na mini-mapie,
 *   • statusMeta()          — pigułka statusu punktu,
 *   • fmtPct/fmtNum/fmtCost/fmtMin — formatowanie.
 *
 * Zapis: każda zmiana pola trafia od razu do obiektu punktu w state (przez
 * upsertPoint), a save() jest wołany natychmiast dla select/checkbox/radio
 * i z opóźnieniem ~400 ms dla pól tekstowych. save() przerysowuje widok, więc
 * fokus i karetka są odtwarzane po przerysowaniu (patrz rememberFocus/restoreFocus).
 */

import {
  state,
  save,
  getPoint,
  getPreset,
  districtName,
  upsertPoint,
  upsertRecommendation,
  removeRecommendation,
  recommendationsForPoint,
  markStepDone,
} from '../state.js';

import {
  completeness,
  autoRecommendations,
  coverageRadiusM,
  PHASE_META,
  fmtPct,
  fmtMin,
  fmtNum,
  fmtCost,
} from '../model.js';

import {
  h,
  mount,
  toast,
  modal,
  barHtml,
  pillHtml,
  statusMeta,
  disabledControl,
  escapeHtml,
  photoRoleLabel,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
} from '../ui.js';

import { renderSceneSvg } from '../map.js';
import { TODAY } from '../../config.js';

export const meta = {
  step: 3,
  title: 'Karta punktu',
  subtitle: 'specyfikacja',
  layout: 'split',
  chrome: 'full',
};

/* ------------------------------------------------------------------ *
 * Stałe widoku
 * ------------------------------------------------------------------ */

/** Opóźnienie zapisu pól tekstowych (SPEC §6.5 — „debounce ~400 ms"). */
const TEXT_DEBOUNCE_MS = 400;

/** Po tylu ms nie odtwarzamy już fokusu (użytkownik zdążył odejść od pola). */
const FOCUS_TTL_MS = 4000;

const CARD_WIDTH = '880px';
const PANEL_WIDTH = '520px';
const MINI_MAP_H = 200;

/** Domyślne ramy czasowe pozycji wrzucanej do fazy 1 (jak w danych demo). */
const PHASE1_START_MONTH = 1;
const PHASE1_LENGTH_MONTHS = 5;

/** Które sekcje karty nie dotyczą punktu, który jeszcze nie istnieje w terenie. */
const INERT_FOR_PROPOSED = new Set([3, 4, 5, 6]);

/** Pola wymagane presetu → sekcja, która za nie odpowiada. */
const SECTION_PATHS = {
  1: ['name', 'address', 'placement', 'districtId'],
  3: ['access'],
  4: ['keeper'],
  5: ['signage'],
  6: ['device', 'technical'],
  7: ['dispatcherRegistered'],
};

/** Reguła auto-rekomendacji → sekcja, w której widać jej przyczynę. */
const RULE_SECTION = {
  photos: 1,
  access: 3,
  keeper: 4,
  signage_route: 5,
  signage_device: 5,
  inspection: 6,
  dispatcher: 7,
};

/** Etykiety pól wymaganych — używane na liście braków w panelu. */
const FIELD_LABEL = {
  name: 'Nazwa punktu',
  address: 'Adres',
  placement: 'Umiejscowienie',
  districtId: 'Dzielnica',
  access: 'Dostępność',
  'access.always': 'Dostęp całodobowy',
  keeper: 'Opiekun punktu',
  'keeper.org': 'Organizacja opiekuna',
  'signage.atDevice': 'Znak przy urządzeniu',
  'signage.route': 'Oznakowanie dojścia',
  'device.model': 'Model urządzenia',
  'device.inspectionDue': 'Termin przeglądu',
  'device.padsDue': 'Termin elektrod',
  dispatcherRegistered: 'Rejestracja w CPR 112/999',
  'technical.power': 'Zasilanie',
  'technical.distanceToSource': 'Odległość do źródła zasilania',
  'technical.works': 'Zakres robót',
  'technical.connectionCost': 'Koszt przyłącza',
};

const OWNER_OPTIONS = [
  { value: 'gmina', label: 'Gmina' },
  { value: 'serwis', label: 'Serwis' },
  { value: 'wykonawca', label: 'Wykonawca' },
];

const PRIORITY_OPTIONS = ['high', 'medium', 'low'];

const MONTHS_PL = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
];

/* ------------------------------------------------------------------ *
 * Stan lokalny modułu (przeżywa przerysowania widoku)
 * ------------------------------------------------------------------ */

let saveTimer = null;
let focusMemo = null;
let scrollMemo = null;
let photosModulePromise = null;

/**
 * js/photos.js powstaje równolegle. Import jest dynamiczny i buforowany, żeby
 * przy każdym przerysowaniu karty nie dobijać się o plik, którego może nie być.
 * Brak modułu = komunikat w sekcji zdjęć, reszta karty działa normalnie.
 */
function loadPhotosModule() {
  if (!photosModulePromise) {
    photosModulePromise = import('../photos.js').catch(() => null);
  }
  return photosModulePromise;
}

/* ------------------------------------------------------------------ *
 * Pomocniki lokalne (rdzenia nie ruszamy)
 * ------------------------------------------------------------------ */

function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Zapis w głąb obiektu punktu; brakujące gałęzie są dotwarzane. */
function writePath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/** Puste pole trzymamy jako null — tak samo traktuje je completeness(). */
function normalizeText(raw) {
  return raw === '' ? null : raw;
}

function fieldId(key) {
  return `card-f-${String(key).replace(/[^\w-]/g, '-')}`;
}

/** '2026-03' → 'marzec 2026'; puste → '—'. */
function monthLabel(value) {
  if (!value) return '—';
  const [year, month] = String(value).slice(0, 7).split('-');
  const index = Number(month) - 1;
  if (!year || Number.isNaN(index) || !MONTHS_PL[index]) return String(value);
  return `${MONTHS_PL[index]} ${year}`;
}

/** Czy termin (YYYY-MM) minął względem TODAY z config.js. */
function isOverdueMonth(value) {
  if (!value) return false;
  return String(value).slice(0, 7) < String(TODAY).slice(0, 7);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, TEXT_DEBOUNCE_MS);
}

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await save();
}

/**
 * save() przerysowuje cały widok, więc przed zapisem zapamiętujemy, gdzie stał
 * kursor, a po przerysowaniu wracamy w to samo miejsce.
 */
function rememberFocus(node, pointId) {
  let start = null;
  let end = null;
  try {
    start = node.selectionStart;
    end = node.selectionEnd;
  } catch (err) {
    // input[type=month|number] nie wspiera zaznaczenia — to nie jest błąd
    start = null;
    end = null;
  }
  focusMemo = { pointId, key: node.dataset ? node.dataset.fkey : null, start, end, at: Date.now() };
}

/** To samo dla przewinięcia kolumny sekcji — inaczej zapis odrzucałby na górę karty. */
function rememberScroll(node, pointId) {
  scrollMemo = { pointId, top: node.scrollTop };
}

function restoreScroll(node, pointId) {
  if (!scrollMemo || scrollMemo.pointId !== pointId) return;
  node.scrollTop = scrollMemo.top;
}

function restoreFocus(root, pointId) {
  const memo = focusMemo;
  focusMemo = null;
  if (!memo || !memo.key || memo.pointId !== pointId) return;
  if (Date.now() - memo.at > FOCUS_TTL_MS) return;
  const node = root.querySelector(`[data-fkey="${memo.key}"]`);
  if (!node) return;
  node.focus();
  if (memo.start !== null && typeof node.setSelectionRange === 'function') {
    try {
      node.setSelectionRange(memo.start, memo.end);
    } catch (err) {
      /* pole bez zaznaczenia — wystarczy sam fokus */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Klocki formularza
 * ------------------------------------------------------------------ */

function field(label, control, hint, forId) {
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: forId || null, text: label }),
    control,
    hint ? h('span', { class: 'field__hint', text: hint }) : null
  );
}

/**
 * Pole tekstowe / textarea / input[type=month] podpięte do ścieżki w punkcie.
 * Zmiana leci od razu do state, save() jest opóźniony (SPEC §6.5).
 */
function textField({
  point,
  path,
  label,
  hint,
  type = 'text',
  placeholder = '',
  textarea = false,
  disabled = false,
  readonly = false,
  display = null,
}) {
  const id = fieldId(path);
  const raw = readPath(point, path);
  const value = display !== null ? display : raw == null ? '' : String(raw);

  const props = {
    class: textarea ? 'textarea' : 'input',
    id,
    dataset: { fkey: path },
    placeholder: placeholder || null,
    disabled: disabled || null,
    readonly: readonly || null,
  };

  const control = textarea
    ? h('textarea', props, value)
    : h('input', { ...props, type, value });

  if (!disabled && !readonly) {
    control.addEventListener('input', (event) => {
      rememberFocus(event.target, point.id);
      writePath(point, path, normalizeText(event.target.value));
      upsertPoint(point);
      scheduleSave();
    });
  }

  return field(label, control, hint, id);
}

/** Select podpięty do ścieżki w punkcie — zapis natychmiastowy. */
function selectField({ point, path, label, hint, options, disabled = false, onPick = null }) {
  const id = fieldId(path);
  const value = readPath(point, path);
  const control = h(
    'select',
    { class: 'select', id, dataset: { fkey: path }, disabled: disabled || null },
    ...options.map((option) =>
      h('option', { value: option.value, selected: String(option.value) === String(value ?? '') }, option.label)
    )
  );

  if (!disabled) {
    control.addEventListener('change', async (event) => {
      rememberFocus(event.target, point.id);
      const picked = event.target.value === '' ? null : event.target.value;
      if (onPick) onPick(picked);
      else writePath(point, path, picked);
      upsertPoint(point);
      await saveNow();
    });
  }

  return field(label, control, hint, id);
}

/** Trzy stany: tak / nie / brak danych (null). Zapis natychmiastowy. */
function triStateField({ point, path, label, hint, disabled = false }) {
  const value = readPath(point, path) ?? null;
  const name = `card-${path.replace(/\./g, '-')}`;
  const options = [
    { v: true, l: 'tak' },
    { v: false, l: 'nie' },
    { v: null, l: 'brak danych' },
  ];

  const row = h(
    'div',
    { class: 'radio-row' },
    ...options.map((option) => {
      const id = `${name}-${String(option.v)}`;
      const input = h('input', {
        type: 'radio',
        name,
        id,
        dataset: { fkey: `${path}:${String(option.v)}` },
        checked: value === option.v,
        disabled: disabled || null,
      });
      if (!disabled) {
        input.addEventListener('change', async () => {
          rememberFocus(input, point.id);
          writePath(point, path, option.v);
          upsertPoint(point);
          await saveNow();
        });
      }
      return h('label', { class: 'checkline', for: id }, input, h('span', { text: option.l }));
    })
  );

  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    row,
    hint ? h('span', { class: 'field__hint', text: hint }) : null
  );
}

/** Checkbox z trzecim stanem „brak danych" pokazywanym jako indeterminate. */
function checkboxField({ point, path, label, hint, disabled = false }) {
  const value = readPath(point, path) ?? null;
  const id = fieldId(path);
  const input = h('input', {
    type: 'checkbox',
    id,
    dataset: { fkey: path },
    checked: value === true,
    disabled: disabled || null,
  });
  if (value === null) input.indeterminate = true;

  if (!disabled) {
    input.addEventListener('change', async () => {
      rememberFocus(input, point.id);
      writePath(point, path, input.checked);
      upsertPoint(point);
      await saveNow();
    });
  }

  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'checkline', for: id }, input, h('span', { text: label })),
    hint ? h('span', { class: 'field__hint', text: hint }) : null
  );
}

/* ------------------------------------------------------------------ *
 * Sekcja karty
 * ------------------------------------------------------------------ */

const SECTION_PILL = {
  crit: { text: 'BRAK KRYTYCZNY', variant: 'crit' },
  warn: { text: 'BRAKI', variant: 'warn' },
  '': { text: 'KOMPLET', variant: 'ok' },
};

function cardSection({ num, title, level = '', pills = [], children }) {
  const badge = SECTION_PILL[level] || SECTION_PILL[''];
  return h(
    'section',
    { class: `card-section${level ? ` card-section--${level}` : ''}` },
    h(
      'div',
      { class: 'card-section__head' },
      h('span', { class: 'card-section__num', text: String(num) }),
      h('h3', { text: title }),
      ...pills.map((p) => h('span', { html: pillHtml(p.text, p.variant) })),
      h('span', { html: pillHtml(badge.text, badge.variant) })
    ),
    h('div', { class: 'card-section__body' }, ...children.filter(Boolean))
  );
}

function twoCols(...children) {
  return h('div', { class: 'card-section__body--cols', style: { display: 'grid', gap: '12px' } }, ...children.filter(Boolean));
}

function note(text) {
  return h('p', { class: 'note', style: { margin: '0' }, text });
}

/* ------------------------------------------------------------------ *
 * Rekomendacje — scalenie auto + zapisanych
 * ------------------------------------------------------------------ */

/** Kopia rekomendacji bez pól pomocniczych widoku. */
function cleanRec(rec) {
  const { persisted, stale, ...rest } = rec;
  return rest;
}

/**
 * autoRecommendations() + pozycje już zapisane w state, scalone po id.
 * Z zapisanej wersji zachowujemy `done`, `phase` i ramy czasowe roadmapy.
 * Pozycje auto, których reguła już nie obowiązuje, zostają na liście
 * oznaczone jako nieaktualne — nie kasujemy ich za plecami operatora.
 */
function mergeRecommendations(point, preset) {
  const stored = recommendationsForPoint(point.id);
  const byId = new Map(stored.map((r) => [r.id, r]));
  const autos = autoRecommendations(point, preset, state.photos);
  const autoIds = new Set(autos.map((r) => r.id));

  const merged = autos.map((auto) => {
    const prev = byId.get(auto.id);
    if (!prev) return { ...auto, persisted: false, stale: false };
    return {
      ...auto,
      done: prev.done === true,
      phase: prev.phase ?? null,
      startMonth: prev.startMonth,
      lengthMonths: prev.lengthMonths,
      persisted: true,
      stale: false,
    };
  });

  for (const rec of stored) {
    if (autoIds.has(rec.id)) continue;
    merged.push({ ...rec, persisted: true, stale: rec.auto === true });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return merged.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
  });
}

/** Dopisuje do state pozycje automatyczne, których jeszcze tam nie ma. */
function persistAutoRecommendations(merged) {
  let added = 0;
  for (const rec of merged) {
    if (rec.persisted || rec.stale) continue;
    upsertRecommendation(cleanRec(rec));
    added += 1;
  }
  return added;
}

async function addManualRecommendation(point) {
  const textEl = h('textarea', { class: 'textarea', placeholder: 'Co dokładnie trzeba zrobić w tym punkcie?' });
  const priorityEl = h(
    'select',
    { class: 'select' },
    ...PRIORITY_OPTIONS.map((p) => h('option', { value: p, selected: p === 'medium' }, PRIORITY_LABEL[p]))
  );
  const costEl = h('input', { class: 'input', type: 'number', min: '0', step: '100', value: '0' });
  const ownerEl = h(
    'select',
    { class: 'select' },
    ...OWNER_OPTIONS.map((o) => h('option', { value: o.value }, o.label))
  );

  const body = h(
    'div',
    { class: 'stack' },
    field('Treść pozycji', textEl),
    field('Priorytet', priorityEl),
    field('Koszt (zł)', costEl, 'Wpisz 0, jeśli pozycja nie generuje kosztu.'),
    field('Odpowiedzialny', ownerEl)
  );

  const confirmed = await modal({
    title: 'Nowa pozycja checklisty',
    body,
    confirmLabel: 'Dodaj pozycję',
  });
  if (!confirmed) return;

  const text = textEl.value.trim();
  if (!text) {
    toast('Pozycja bez treści nie została dodana.');
    return;
  }

  upsertRecommendation({
    id: `man-${point.id}-${Date.now().toString(36)}`,
    pointId: point.id,
    text,
    priority: priorityEl.value,
    cost: Number(costEl.value) || 0,
    owner: ownerEl.value,
    phase: null,
    auto: false,
    done: false,
  });
  await saveNow();
  toast('Dodano pozycję do checklisty punktu.');
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const project = state.project;
  const point = getPoint(ctx.params && ctx.params.id);

  if (!project || !point) {
    mount(
      root,
      h(
        'div',
        { style: { padding: '20px', width: '100%' } },
        h(
          'div',
          { class: 'empty-state' },
          h('p', { text: `Nie znaleziono punktu o identyfikatorze „${(ctx.params && ctx.params.id) || '—'}".` }),
          h('p', { class: 'note', text: 'Punkt mógł zostać usunięty albo link jest nieaktualny.' }),
          h(
            'button',
            { class: 'btn btn--primary', style: { marginTop: '10px' }, onclick: () => ctx.navigate('#/cards') },
            '← WRÓĆ DO LISTY KART'
          )
        )
      )
    );
    return;
  }

  if (!(project.stepsDone || []).includes(3)) {
    markStepDone(3);
    await save({ silent: true });
  }

  /* ---------------- Moduł zdjęć (budowany równolegle) ---------------- */

  const photosApi = await loadPhotosModule();

  /* ---------------- Dane wyliczone (zawsze z model.js) ---------------- */

  const preset = getPreset(point.presetId);
  const comp = completeness(point, preset, state.photos);
  const status = statusMeta(point, comp.pct);
  const isProposed = point.kind === 'proposed';
  const standardMinutes = project.standardMinutes;
  const radiusM = coverageRadiusM(standardMinutes);
  const merged = mergeRecommendations(point, preset);
  const openRecs = merged.filter((r) => !r.done);
  const pointPhotos = state.photos.filter((ph) => ph.pointId === point.id);

  state.ui.selectedPointId = point.id;

  /* ---------------- Poziom paska statusu sekcji ---------------- */

  const openRuleSections = new Set(
    openRecs.filter((r) => r.rule && RULE_SECTION[r.rule]).map((r) => RULE_SECTION[r.rule])
  );

  const missesRequired = (num) => {
    const prefixes = SECTION_PATHS[num] || [];
    return comp.missingFields.some((path) =>
      prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))
    );
  };

  // Miękkie braki: pola nieobowiązkowe dla presetu i terminy po dacie TODAY.
  const softGap = {
    1: !point.address || !point.placement || !point.districtId || comp.missingPhotos.length > 0,
    3: (point.access?.always ?? null) === null || !point.access?.hours || !point.access?.weekend,
    4: !point.keeper?.person || !point.keeper?.contact,
    5: (point.signage?.atDevice ?? null) === null || (point.signage?.route ?? null) === null,
    6:
      !point.device?.padsDue ||
      isOverdueMonth(point.device?.inspectionDue) ||
      isOverdueMonth(point.device?.padsDue),
    7: point.dispatcherRegistered !== true,
  };

  const levelOf = (num) => {
    if (isProposed && INERT_FOR_PROPOSED.has(num)) return '';
    if (missesRequired(num)) return 'crit';
    if (openRuleSections.has(num) || softGap[num]) return 'warn';
    return '';
  };

  /* ---------------- Sub bar ---------------- */

  if (ctx.setMeta) {
    ctx.setMeta(
      `${point.id} · kompletność ${fmtPct(comp.pct, 0)} · ` +
        `rekomendacje otwarte: ${fmtNum(openRecs.length)} z ${fmtNum(merged.length)}`
    );
  }

  if (ctx.subbar && ctx.subbar.controls) {
    const order = state.points.map((p) => p.id);
    const index = order.indexOf(point.id);
    const goto = (offset) => {
      const target = order[index + offset];
      if (target) ctx.navigate(`#/card/${encodeURIComponent(target)}`);
    };

    const prevBtn = h('button', { class: 'btn btn--sm', onclick: () => goto(-1) }, '← Poprzedni');
    const nextBtn = h('button', { class: 'btn btn--sm', onclick: () => goto(1) }, 'Następny →');
    if (index <= 0) {
      prevBtn.setAttribute('disabled', '');
      prevBtn.setAttribute('data-tip', 'to pierwszy punkt na liście');
    }
    if (index < 0 || index >= order.length - 1) {
      nextBtn.setAttribute('disabled', '');
      nextBtn.setAttribute('data-tip', 'to ostatni punkt na liście');
    }

    mount(
      ctx.subbar.controls,
      prevBtn,
      nextBtn,
      h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate('#/cards') }, 'LISTA KART')
    );
  }

  /* ================================================================ *
   * SEKCJA 1 — Identyfikacja
   * ================================================================ */

  const photoBox = h('div', { class: 'stack' });

  const paintPhotoFallback = (reason) => {
    const missingRoles = comp.missingPhotos.map(photoRoleLabel);
    mount(
      photoBox,
      h('div', { class: 'note', text: reason }),
      preset && (preset.requiredPhotos || []).length
        ? h('div', {
            class: 'note',
            text:
              `Preset ${preset.id} wymaga zdjęć: ${(preset.requiredPhotos || []).map(photoRoleLabel).join(', ')}. ` +
              `Wgranych przy tym punkcie: ${fmtNum(pointPhotos.length)}.`,
          })
        : null,
      missingRoles.length
        ? h('div', { class: 'note', text: `Brakuje: ${missingRoles.join(', ')} — kompletność karty jest o to obniżona.` })
        : null
    );
  };

  if (photosApi && typeof photosApi.renderPhotoSlots === 'function') {
    try {
      photosApi.renderPhotoSlots(photoBox, point, preset, {
        onChange: async () => {
          await saveNow();
        },
      });
    } catch (err) {
      console.warn('renderPhotoSlots() nie powiodło się', err);
      paintPhotoFallback('Moduł zdjęć niedostępny');
    }
  } else {
    paintPhotoFallback('Moduł zdjęć niedostępny');
  }

  const districtOptions = [
    { value: '', label: '— nie przypisano —' },
    ...(project.districts || []).map((d) => ({ value: d.id, label: d.name })),
  ];

  const section1 = cardSection({
    num: 1,
    title: 'Identyfikacja',
    level: levelOf(1),
    children: [
      textField({ point, path: 'name', label: 'Nazwa punktu', placeholder: 'np. SP nr 7 — hol główny' }),
      twoCols(
        textField({ point, path: 'address', label: 'Adres', placeholder: 'ul. Szkolna 3' }),
        selectField({ point, path: 'districtId', label: 'Dzielnica', options: districtOptions })
      ),
      twoCols(
        textField({
          point,
          path: 'lat',
          label: 'Szerokość geogr.',
          readonly: true,
          display: fmtNum(point.lat, 6),
          hint: 'tylko odczyt',
        }),
        textField({
          point,
          path: 'lon',
          label: 'Długość geogr.',
          readonly: true,
          display: fmtNum(point.lon, 6),
          hint: 'tylko odczyt',
        })
      ),
      textField({
        point,
        path: 'placement',
        label: 'Umiejscowienie',
        textarea: true,
        placeholder: 'np. hol główny, przy portierni, na wysokości 1,4 m',
      }),
      h('div', { class: 'divider' }),
      h('span', { class: 'label-caps', text: 'Galeria zdjęć — dowody audytu (SPEC §7)' }),
      photoBox,
    ],
  });

  /* ================================================================ *
   * SEKCJA 2 — Preset
   * ================================================================ */

  const presetOptions = state.presets.map((p) => ({
    value: p.id,
    label: `${p.id} — ${p.name} · ${fmtCost(p.cost)}`,
  }));

  const requirementRow = (label, ok) =>
    h(
      'div',
      { class: 'row', style: { fontSize: '12px' } },
      h('span', { html: pillHtml(ok ? 'jest' : 'brak', ok ? 'ok' : 'warn') }),
      h('span', { text: label })
    );

  const section2 = cardSection({
    num: 2,
    title: 'Preset punktu',
    level: preset ? '' : 'crit',
    pills: preset ? [{ text: fmtCost(preset.cost), variant: '' }] : [],
    children: [
      selectField({
        point,
        path: 'presetId',
        label: 'Preset',
        options: presetOptions,
        hint: 'Preset decyduje o tym, które pola i zdjęcia są wymagane oraz o koszcie jednostkowym.',
      }),
      preset
        ? h(
            'div',
            { class: 'stack' },
            h('span', { class: 'label-caps', text: `Pola wymagane (${fmtNum((preset.requiredFields || []).length)})` }),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } },
              ...(preset.requiredFields || []).map((path) =>
                requirementRow(FIELD_LABEL[path] || path, !comp.missingFields.includes(path))
              )
            ),
            h('span', {
              class: 'label-caps',
              style: { marginTop: '6px' },
              text: `Zdjęcia wymagane (${fmtNum((preset.requiredPhotos || []).length)})`,
            }),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } },
              ...(preset.requiredPhotos || []).map((role) =>
                requirementRow(photoRoleLabel(role), !comp.missingPhotos.includes(role))
              )
            ),
            note(`Koszt jednostkowy presetu: ${fmtCost(preset.cost)} — trafia do wyceny roadmapy.`)
          )
        : note('Punkt nie ma przypisanego presetu — bez niego nie da się policzyć kompletności ani kosztu.'),
    ],
  });

  /* ================================================================ *
   * SEKCJE 3–6 — dane terenowe (dla propozycji wyszarzone)
   * ================================================================ */

  const inert = isProposed;
  const inertPills = inert ? [{ text: 'PO MONTAŻU', variant: 'phase3' }] : [];
  const inertNote = inert
    ? note('Punkt jest jeszcze propozycją — te dane uzupełnia się po montażu urządzenia. Wytyczne wdrożeniowe znajdziesz w sekcji 7.')
    : null;

  const section3 = cardSection({
    num: 3,
    title: 'Dostępność',
    level: levelOf(3),
    pills: inertPills,
    children: [
      inertNote,
      checkboxField({
        point,
        path: 'access.always',
        label: 'Dostępny całodobowo (24/7)',
        hint: 'Tylko punkty 24/7 liczą się w trybie nocnym analizy pokrycia.',
        disabled: inert,
      }),
      twoCols(
        textField({
          point,
          path: 'access.hours',
          label: 'Godziny dostępu',
          placeholder: 'pn–pt 8:00–16:00',
          disabled: inert,
        }),
        textField({ point, path: 'access.weekend', label: 'Weekend', placeholder: 'zamknięte', disabled: inert })
      ),
      textField({
        point,
        path: 'access.barriers',
        label: 'Bariery dostępu',
        textarea: true,
        placeholder: 'np. domofon po 15:00, wejście przez portiernię',
        disabled: inert,
      }),
    ],
  });

  const section4 = cardSection({
    num: 4,
    title: 'Opiekun punktu',
    level: levelOf(4),
    pills: inertPills,
    children: [
      inertNote,
      textField({
        point,
        path: 'keeper.org',
        label: 'Organizacja',
        placeholder: 'np. MOSiR Tychy',
        disabled: inert,
        hint: 'Brak organizacji uruchamia rekomendację o priorytecie wysokim.',
      }),
      twoCols(
        textField({ point, path: 'keeper.person', label: 'Osoba', placeholder: 'imię i nazwisko', disabled: inert }),
        textField({ point, path: 'keeper.contact', label: 'Kontakt', placeholder: 'tel. / e-mail', disabled: inert })
      ),
    ],
  });

  const section5 = cardSection({
    num: 5,
    title: 'Oznakowanie',
    level: levelOf(5),
    pills: inertPills,
    children: [
      inertNote,
      triStateField({
        point,
        path: 'signage.atDevice',
        label: 'Znak ILCOR przy urządzeniu',
        hint: 'Tabliczka bezpośrednio przy AED.',
        disabled: inert,
      }),
      triStateField({
        point,
        path: 'signage.route',
        label: 'Oznakowanie dojścia od ulicy',
        hint: 'Strzałki kierunkowe prowadzące od wejścia lub chodnika.',
        disabled: inert,
      }),
    ],
  });

  const inspectionOverdue = isOverdueMonth(point.device?.inspectionDue);
  const padsOverdue = isOverdueMonth(point.device?.padsDue);

  const section6 = cardSection({
    num: 6,
    title: 'Urządzenie',
    level: levelOf(6),
    pills: [
      ...inertPills,
      ...(!inert && (inspectionOverdue || padsOverdue) ? [{ text: 'PO TERMINIE', variant: 'crit' }] : []),
    ],
    children: [
      inertNote,
      textField({ point, path: 'device.model', label: 'Model urządzenia', placeholder: 'np. Zoll AED Plus', disabled: inert }),
      twoCols(
        textField({
          point,
          path: 'device.inspectionDue',
          label: 'Termin przeglądu',
          type: 'month',
          disabled: inert,
          hint: `w danych: ${monthLabel(point.device?.inspectionDue)}`,
        }),
        textField({
          point,
          path: 'device.padsDue',
          label: 'Termin elektrod',
          type: 'month',
          disabled: inert,
          hint: `w danych: ${monthLabel(point.device?.padsDue)}`,
        })
      ),
      !inert && inspectionOverdue
        ? note(
            `Termin przeglądu (${monthLabel(point.device.inspectionDue)}) minął względem daty odniesienia ${monthLabel(TODAY)} — ` +
              'sekcja 8 pokazuje rekomendację przeglądu z priorytetem wysokim.'
          )
        : null,
      !inert && padsOverdue
        ? note(`Termin elektrod (${monthLabel(point.device.padsDue)}) minął — elektrody po dacie ważności nie gwarantują defibrylacji.`)
        : null,
    ],
  });

  /* ================================================================ *
   * SEKCJA 7 — rejestracja w CPR / wytyczne montażu
   * ================================================================ */

  const section7 = isProposed
    ? cardSection({
        num: 7,
        title: `Wytyczne montażu — preset ${preset ? preset.id : '—'}`,
        level: preset && (preset.checklist || []).length ? '' : 'warn',
        pills: [{ text: 'SPECYFIKACJA WDROŻENIOWA', variant: 'phase3' }],
        children: [
          note('Punkt proponowany — poniżej lista warunków, które muszą być spełnione przy montażu. Pochodzi z presetu.'),
          preset && (preset.checklist || []).length
            ? h(
                'ul',
                { style: { margin: '0', paddingLeft: '18px' } },
                ...(preset.checklist || []).map((item) => h('li', { style: { fontSize: '12.5px' }, text: item }))
              )
            : note('Preset nie zawiera listy wytycznych montażowych.'),
          preset
            ? note(
                `Koszt jednostkowy ${fmtCost(preset.cost)} · zdjęcia wymagane po montażu: ` +
                  `${(preset.requiredPhotos || []).map(photoRoleLabel).join(', ') || 'brak'}.`
              )
            : null,
          note('Rejestrację urządzenia u dyspozytora CPR 112/999 zgłasza się po odbiorze montażu — pole pojawi się tutaj po zmianie punktu na istniejący.'),
        ],
      })
    : cardSection({
        num: 7,
        title: 'Rejestracja w systemie CPR 112/999',
        level: levelOf(7),
        children: [
          triStateField({
            point,
            path: 'dispatcherRegistered',
            label: 'AED zgłoszone dyspozytorowi medycznemu',
          }),
          note(
            'Dyspozytor CPR może wskazać świadkowi najbliższe AED tylko wtedy, gdy urządzenie jest w jego bazie. ' +
              'Punkt niezgłoszony nie działa w łańcuchu przeżycia — fizycznie istnieje, ale nie zostanie użyty w wezwaniu. ' +
              'Zgłoszenie jest bezkosztowe, dlatego reguła nadaje mu priorytet wysoki.'
          ),
        ],
      });

  /* ================================================================ *
   * SEKCJA 8 — checklist zgodności i rekomendacje
   * ================================================================ */

  const openCost = openRecs.reduce((sum, r) => sum + (r.cost || 0), 0);
  const inRoadmap = merged.filter((r) => r.phase).length;
  const highOpen = openRecs.some((r) => r.priority === 'high');

  const recRow = (rec) => {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: rec.done === true,
      dataset: { fkey: `rec:${rec.id}` },
      title: rec.done ? 'Odznacz jako niezrobione' : 'Oznacz jako zrobione',
    });
    checkbox.addEventListener('change', async () => {
      rememberFocus(checkbox, point.id);
      upsertRecommendation({ ...cleanRec(rec), done: checkbox.checked });
      await saveNow();
    });

    const removable = rec.auto !== true || rec.stale;
    const removeBtn = removable
      ? h(
          'button',
          {
            class: 'btn btn--sm btn--danger',
            title: rec.stale ? 'Usuń nieaktualną pozycję automatyczną' : 'Usuń pozycję ręczną',
            onclick: async () => {
              const ok = await modal({
                title: 'Usunąć pozycję?',
                body: `<p class="note">${escapeHtml(rec.text)}</p><p class="note">Pozycja zniknie także z roadmapy.</p>`,
                confirmLabel: 'Usuń',
              });
              if (!ok) return;
              removeRecommendation(rec.id);
              await saveNow();
              toast('Pozycja usunięta.');
            },
          },
          'usuń'
        )
      : null;

    return h(
      'div',
      { class: 'list-row', style: { cursor: 'default' } },
      h('label', { class: 'checkline', style: { paddingTop: '1px' } }, checkbox),
      h(
        'div',
        { class: 'list-row__body' },
        h('div', {
          class: 'list-row__title',
          style: rec.done ? { textDecoration: 'line-through', color: 'var(--ink-2)' } : {},
          text: rec.text,
        }),
        h(
          'div',
          { class: 'row row--wrap', style: { marginTop: '4px' } },
          h('span', { html: pillHtml(PRIORITY_LABEL[rec.priority] || rec.priority, PRIORITY_VARIANT[rec.priority] || '') }),
          h('span', { class: 'list-row__meta num', text: fmtCost(rec.cost || 0) }),
          h('span', { class: 'list-row__meta', text: `odp.: ${rec.owner || '—'}` }),
          h('span', { class: 'list-row__meta', text: rec.auto ? 'z reguły' : 'ręczna' }),
          rec.phase && PHASE_META[rec.phase]
            ? h('span', { html: pillHtml(PHASE_META[rec.phase].label, `phase${rec.phase}`) })
            : null,
          !rec.persisted ? h('span', { html: pillHtml('NIEZAPISANA', 'warn') }) : null,
          rec.stale ? h('span', { html: pillHtml('REGUŁA NIEAKTUALNA', '') }) : null
        )
      ),
      removeBtn
    );
  };

  const section8 = cardSection({
    num: 8,
    title: 'Checklist zgodności i rekomendacje',
    level: openRecs.length === 0 ? '' : highOpen ? 'crit' : 'warn',
    children: [
      merged.length
        ? h('div', { class: 'stack', style: { gap: '0' } }, ...merged.map(recRow))
        : h('div', { class: 'empty-state', text: 'Brak rekomendacji — punkt spełnia wszystkie reguły automatyczne.' }),
      h(
        'div',
        { class: 'row row--wrap', style: { marginTop: '6px' } },
        h('span', {
          class: 'note',
          text:
            `Otwarte: ${fmtNum(openRecs.length)} z ${fmtNum(merged.length)} · ` +
            `koszt otwartych ${fmtCost(openCost)} · w roadmapie: ${fmtNum(inRoadmap)}`,
        }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn--sm', onclick: () => addManualRecommendation(point) }, '+ dodaj pozycję')
      ),
      note('Pozycje „z reguły" wylicza model po każdej zmianie karty. Zapis karty utrwala je w projekcie, dzięki czemu trafiają do roadmapy i raportu.'),
    ],
  });

  /* ================================================================ *
   * Lewa kolumna
   * ================================================================ */

  const header = h(
    'div',
    { style: { marginBottom: '14px' } },
    h(
      'div',
      { class: 'row row--wrap' },
      h('h2', { text: point.name || 'Punkt bez nazwy' }),
      h('span', { html: pillHtml(status.label, status.variant) }),
      // statusMeta() dla propozycji mówi już „PROPOZYCJA"; przy statusie
      // „ZAAKCEPTOWANY" dopowiadamy, że to wciąż punkt jeszcze niezamontowany.
      isProposed && point.status !== 'proposed'
        ? h('span', { html: pillHtml('PUNKT PROPONOWANY', 'phase3') })
        : null
    ),
    h('div', {
      class: 'muted',
      style: { fontSize: '12px', marginTop: '2px' },
      text:
        `${point.id} · ${isProposed ? 'specyfikacja wdrożeniowa' : 'specyfikacja'} · ` +
        `${districtName(point.districtId)} · preset ${preset ? preset.id : '—'}`,
    })
  );

  const column = h(
    'div',
    {
      class: 'card-column',
      style: {
        width: CARD_WIDTH,
        flex: `0 0 ${CARD_WIDTH}`,
        maxWidth: '100%',
        overflowY: 'auto',
        padding: '20px',
      },
    },
    header,
    section1,
    section2,
    section3,
    section4,
    section5,
    section6,
    section7,
    section8
  );

  column.addEventListener('scroll', () => rememberScroll(column, point.id), { passive: true });

  /* ================================================================ *
   * Panel boczny
   * ================================================================ */

  const scene = {
    boundary: state.boundary,
    districts: state.districtsGeo,
    showDistricts: true,
    coverage: [{ lat: point.lat, lon: point.lon, radiusM, kind: isProposed ? 'proposed' : 'existing' }],
    showCoverage: true,
    targetMinutes: standardMinutes,
    points: [{ id: point.id, lat: point.lat, lon: point.lon, level: status.level, name: point.name }],
  };

  const mapBox = h('div', {
    class: 'map-wrap',
    style: { height: `${MINI_MAP_H}px`, flex: `0 0 ${MINI_MAP_H}px`, border: '1px solid var(--line)' },
    html: renderSceneSvg(scene, {
      width: 480,
      height: MINI_MAP_H,
      showDemand: false,
      showCoverage: true,
      showLabels: false,
    }),
  });
  const mapSvg = mapBox.querySelector('svg');
  if (mapSvg) {
    mapSvg.style.width = '100%';
    mapSvg.style.height = '100%';
    mapSvg.style.display = 'block';
  }

  const moveBtn = h(
    'button',
    {
      class: 'btn btn--sm btn--block',
      onclick: async () => {
        const go = await modal({
          title: 'Przesuwanie punktu',
          body:
            '<p class="note">Współrzędne zmienia się przeciągnięciem pinu na mapie w kroku 2 (Analiza dostępności) — ' +
            'tam KPI przeliczają się na żywo w trakcie przeciągania.</p>' +
            `<p class="note">${
              isProposed
                ? 'Ten punkt jest propozycją, więc jego pin jest przeciągalny.'
                : 'Piny punktów istniejących są zablokowane — ich położenie pochodzi z inwentaryzacji (krok 1).'
            }</p>`,
          confirmLabel: 'Przejdź do kroku 2',
          cancelLabel: 'Zostań w karcie',
        });
        if (go) ctx.navigate('#/analysis');
      },
    },
    'Przesuń punkt'
  );

  const barVariant = comp.pct >= 100 ? 'ok' : comp.pct >= 60 ? 'warn' : 'crit';

  const missingList = [
    ...comp.missingFields.map((path) => FIELD_LABEL[path] || path),
    ...comp.missingPhotos.map((role) => `zdjęcie: ${photoRoleLabel(role)}`),
  ];

  const saveBtn = h(
    'button',
    {
      class: 'btn btn--primary btn--block',
      onclick: async () => {
        const added = persistAutoRecommendations(merged);
        await saveNow();
        toast(
          added
            ? `Zapisano kartę · utrwalono ${fmtNum(added)} poz. z reguł automatycznych.`
            : 'Zapisano kartę punktu.'
        );
      },
    },
    'ZAPISZ'
  );

  const roadmapBtn = h(
    'button',
    {
      class: 'btn btn--block',
      onclick: async () => {
        const items = merged.filter((rec) => !rec.done && !rec.phase);
        if (!items.length) {
          toast('Brak nieprzypisanych rekomendacji — wszystkie są już w roadmapie albo odhaczone.');
          return;
        }
        let cost = 0;
        for (const rec of items) {
          cost += rec.cost || 0;
          upsertRecommendation({
            ...cleanRec(rec),
            phase: 1,
            startMonth: rec.startMonth ?? PHASE1_START_MONTH,
            lengthMonths: rec.lengthMonths ?? PHASE1_LENGTH_MONTHS,
          });
        }
        await saveNow();
        toast(
          `${fmtNum(items.length)} poz. → ${PHASE_META[1].label} „${PHASE_META[1].title}" · ${fmtCost(cost)}.`
        );
        ctx.navigate('#/roadmap');
      },
    },
    'DODAJ REKOM. → ROADMAPA'
  );

  const fieldFormBtn = disabledControl(
    h('button', { class: 'btn btn--block' }, 'WYŚLIJ FORMULARZ TERENOWY'),
    'poza zakresem iteracji 2'
  );

  const panel = h(
    'aside',
    { class: 'panel', style: { width: PANEL_WIDTH, flex: `0 0 ${PANEL_WIDTH}` } },
    h(
      'div',
      { class: 'panel__head' },
      h('h3', { text: `Punkt ${point.id}` }),
      h('span', { html: pillHtml(status.label, status.variant) })
    ),
    h(
      'div',
      { class: 'panel__body' },
      h(
        'div',
        { class: 'panel__section' },
        h('span', { class: 'label-caps', text: 'Położenie' }),
        mapBox,
        h('div', {
          class: 'note',
          style: { marginTop: '6px' },
          text:
            `Strefa ${fmtNum(radiusM, 0)} m = standard ${fmtMin(standardMinutes, 0)} w jedną stronę · ` +
            `${fmtNum(point.lat, 6)}, ${fmtNum(point.lon, 6)}`,
        }),
        h('div', { style: { marginTop: '8px' } }, moveBtn),
        h('div', {
          class: 'note',
          style: { marginTop: '4px' },
          text: 'Przeciąganie pinu żyje w kroku 2 — Analiza dostępności.',
        }),
        h(
          'button',
          { class: 'btn btn--sm btn--ghost', onclick: () => ctx.navigate('#/analysis') },
          '→ Krok 2 · Analiza dostępności'
        )
      ),
      h(
        'div',
        { class: 'panel__section' },
        h('span', { class: 'label-caps', text: 'Kompletność karty' }),
        h('div', { html: barHtml(comp.pct, barVariant) }),
        h('div', {
          class: 'num',
          style: { marginTop: '6px', fontWeight: '600' },
          text: `${fmtPct(comp.pct, 0)} · pola obowiązkowe: ${fmtNum(comp.filled)}/${fmtNum(comp.required)}`,
        }),
        h('div', {
          class: 'note',
          text:
            `W tym zdjęcia: ${fmtNum((preset?.requiredPhotos || []).length - comp.missingPhotos.length)}/` +
            `${fmtNum((preset?.requiredPhotos || []).length)} · status: ${status.label.toLowerCase()}`,
        }),
        missingList.length
          ? h(
              'ul',
              { style: { margin: '8px 0 0', paddingLeft: '18px' } },
              ...missingList.map((label) => h('li', { class: 'note', text: label }))
            )
          : note('Komplet danych wymaganych przez preset.')
      ),
      h(
        'div',
        { class: 'panel__section' },
        h('span', { class: 'label-caps', text: 'Rekomendacje punktu' }),
        h('div', {
          class: 'num',
          style: { fontWeight: '600' },
          text: `${fmtNum(openRecs.length)} otwartych · ${fmtCost(openCost)}`,
        }),
        note(
          `Przypisanych do faz roadmapy: ${fmtNum(inRoadmap)} z ${fmtNum(merged.length)}. ` +
            'Przycisk poniżej wrzuca nieprzypisane pozycje do fazy 1.'
        )
      )
    ),
    h(
      'div',
      { class: 'panel__foot', style: { flexDirection: 'column', gap: '8px' } },
      saveBtn,
      roadmapBtn,
      fieldFormBtn
    )
  );

  mount(root, column, h('div', { class: 'spacer' }), panel);

  restoreScroll(column, point.id);
  restoreFocus(root, point.id);
}

/* ------------------------------------------------------------------ *
 * Sprzątanie
 * ------------------------------------------------------------------ */

export function destroy() {
  // Widok nie tworzy interaktywnej mapy (mini-mapa to statyczny SVG
  // z renderSceneSvg), więc nie ma czego zwalniać po stronie map.js.
  // Zaległy zapis pól tekstowych domykamy po cichu, żeby zmiana widoku
  // nie zgubiła ostatnich znaków — dane są już w state, brakuje tylko IndexedDB.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    save({ silent: true }).catch(() => {});
  }
}
