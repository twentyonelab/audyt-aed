/**
 * field.js — Formularz terenowy (SPEC §6.8, trasa '#/field/:token').
 *
 * Widok mobilny bez steppera i bez nawigacji: osoba w terenie dostaje wąską
 * kolumnę (.field-form, maks. 420 px) z dużymi polami dotykowymi i jednym
 * przyciskiem WYŚLIJ. Po wysłaniu dane trafiają do punktu w state z
 * `verification.source = 'formularz_terenowy'`, a widok pokazuje ekran
 * podziękowania z podsumowaniem i linkiem do karty punktu.
 *
 * Wszystkie liczby pochodzą z model.js — widok niczego nie liczy sam:
 *   • completeness()        — pasek kompletności i wybór statusu po wysłaniu,
 *   • autoRecommendations() — licznik rekomendacji na ekranie podziękowania,
 *   • distanceM/walkTimeMin — porównanie odczytu GPS z lokalizacją w karcie,
 *   • fmtPct/fmtNum/fmtMin  — formatowanie.
 *
 * Zapis: pola formularza trafiają najpierw do lokalnego szkicu (moduł
 * przechowuje go między przerysowaniami, bo photos.js woła save() po wgraniu
 * zdjęcia), a do punktu dopiero po kliknięciu WYŚLIJ — wtedy leci save().
 */

import {
  state,
  save,
  getPoint,
  getPreset,
  districtName,
  photosForPoint,
  upsertPoint,
} from '../state.js';

import {
  completeness,
  autoRecommendations,
  distanceM,
  walkTimeMin,
  fmtPct,
  fmtNum,
  fmtMin,
} from '../model.js';

import {
  h,
  el,
  mount,
  toast,
  barHtml,
  pillHtml,
  statusMeta,
  disabledControl,
} from '../ui.js';

import { TODAY } from '../../config.js';

export const meta = {
  step: null,
  title: 'Formularz terenowy',
  chrome: 'none',
  layout: 'scroll',
  showTopbar: false,
};

/** Sloty, których formularz terenowy wymaga niezależnie od presetu (§6.8). */
const FIELD_PHOTO_ROLES = [
  { id: 'device', label: 'Urządzenie' },
  { id: 'signage_route', label: 'Oznakowanie dojścia' },
];

const OUT_OF_SCOPE = 'poza zakresem iteracji 2';

/* ------------------------------------------------------------------ *
 * Szkic formularza — przeżywa przerysowanie widoku
 * ------------------------------------------------------------------ */

/**
 * save() (np. z photos.js po wgraniu zdjęcia) przerysowuje cały widok, więc
 * wpisane, a jeszcze niewysłane odpowiedzi trzymamy poza drzewem DOM.
 */
let session = null;

function newSession(point) {
  const access = point.access || {};
  const signage = point.signage || {};
  const device = point.device || {};
  return {
    pointId: point.id,
    values: {
      always: access.always === true,
      hours: access.hours || '',
      weekend: access.weekend || '',
      barriers: access.barriers || '',
      atDevice: signage.atDevice ?? null,
      route: signage.route ?? null,
      model: device.model || '',
      inspectionDue: device.inspectionDue || '',
      notes: '',
      applyGps: false,
    },
    /** Nazwy plików wybranych w trybie awaryjnym (bez photos.js). */
    photoNames: { device: '', signage_route: '' },
    gps: null,
    submitted: false,
    summary: [],
  };
}

/* ------------------------------------------------------------------ *
 * Styl lokalny — tylko wymiary dotykowe, żadnych nowych kolorów
 * ------------------------------------------------------------------ */

const STYLE_ID = 'field-form-style';

const STYLE_CSS = `
.field-form__head { margin-bottom: 14px; }
.field-form__head h2 { font-size: 18px; }
.field-form .card-section__body { gap: 14px; }
.field-form .input, .field-form .textarea { padding: 11px 10px; font-size: 15px; }
.field-form .textarea { min-height: 96px; }
.field-form .btn { padding: 11px 14px; font-size: 14px; }
.field-form .btn--sm { padding: 5px 10px; font-size: 12px; }
.field-form .photo-slots { gap: 10px; }
.field-form .checkline--big { padding: 11px 10px; border: 1px solid var(--line); border-radius: 2px; font-size: 14px; }
.field-form .checkline input { width: 17px; height: 17px; }
.field-form__radios { gap: 8px; }
.field-form__radio { flex: 1 1 0; justify-content: center; border: 1px solid var(--line); border-radius: 2px; padding: 11px 4px; cursor: pointer; }
.field-form__file { width: 100%; border: 1px dashed var(--line); border-radius: 2px; padding: 12px 10px; background: var(--section); font-size: 12.5px; }
.field-form__gps { border: 1px solid var(--line); border-radius: 2px; padding: 10px; background: var(--section); }
.field-form__kv { display: flex; gap: 10px; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.field-form__kv:last-child { border-bottom: 0; }
.field-form__kv b { font-weight: 600; text-align: right; }
.field-form__submit { margin-top: 18px; }
.field-form__foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = STYLE_CSS;
  document.head.appendChild(node);
}

function removeStyle() {
  const node = document.getElementById(STYLE_ID);
  if (node) node.remove();
}

/* ------------------------------------------------------------------ *
 * Rozwiązanie tokenu → punkt
 * ------------------------------------------------------------------ */

/**
 * Token to w iteracji 2 po prostu identyfikator punktu ('AED-003'). Gdy nie
 * pasuje do niczego, bierzemy pierwszy punkt niezweryfikowany i mówimy
 * wprost, że to tryb demonstracyjny.
 */
function resolveTarget(token) {
  const raw = (token || '').trim();
  const direct =
    (raw && getPoint(raw)) ||
    (raw && state.points.find((p) => p.id.toLowerCase() === raw.toLowerCase())) ||
    null;
  if (direct) return { point: direct, demoMode: false, reason: '' };

  const fallback =
    state.points.find((p) => p.kind !== 'proposed' && p.status === 'unverified') ||
    state.points.find((p) => p.status === 'unverified') ||
    state.points.find((p) => p.kind !== 'proposed') ||
    state.points[0] ||
    null;

  const reason = raw
    ? `Token „${raw}” nie pasuje do żadnego punktu w tym projekcie.`
    : 'Formularz otwarto bez tokenu punktu.';
  return { point: fallback, demoMode: true, reason };
}

/* ------------------------------------------------------------------ *
 * Drobne pomocniki widoku
 * ------------------------------------------------------------------ */

function yesNoLabel(value) {
  if (value === true) return 'tak';
  if (value === false) return 'nie';
  return 'nie wiem';
}

function orDash(value) {
  const text = (value || '').trim();
  return text || '—';
}

function section(number, title, missing, ...body) {
  return h(
    'div',
    { class: `card-section${missing ? ' card-section--warn' : ''}` },
    h(
      'div',
      { class: 'card-section__head' },
      h('span', { class: 'card-section__num', text: String(number) }),
      h('h3', { text: title }),
      missing ? el(pillHtml('DO UZUPEŁNIENIA', 'warn')) : null
    ),
    h('div', { class: 'card-section__body' }, ...body)
  );
}

function textField(label, value, onInput, opts = {}) {
  const input = h('input', {
    class: 'input',
    type: opts.type || 'text',
    value: value || '',
    placeholder: opts.placeholder || null,
    inputmode: opts.inputmode || null,
    oninput: (e) => onInput(e.target.value),
  });
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    input,
    opts.hint ? h('span', { class: 'field__hint', text: opts.hint }) : null
  );
}

/** Zestaw radio tak / nie / nie wiem → true | false | null. */
function triRadio(label, name, current, onPick) {
  const options = [
    { value: true, text: 'tak' },
    { value: false, text: 'nie' },
    { value: null, text: 'nie wiem' },
  ];
  const normalized = current ?? null;
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    h(
      'div',
      { class: 'radio-row field-form__radios' },
      ...options.map((option) =>
        h(
          'label',
          { class: 'checkline field-form__radio' },
          h('input', {
            type: 'radio',
            name,
            checked: normalized === option.value ? true : null,
            onchange: () => onPick(option.value),
          }),
          h('span', { text: option.text })
        )
      )
    )
  );
}

function kv(label, value) {
  return h(
    'div',
    { class: 'field-form__kv' },
    h('span', { class: 'muted', text: label }),
    h('b', { text: value })
  );
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

export async function render(root, ctx) {
  ensureStyle();

  const { point, demoMode, reason } = resolveTarget(ctx.params && ctx.params.token);

  if (!point) {
    mount(
      root,
      h(
        'div',
        { class: 'field-form' },
        h('div', {
          class: 'empty-state',
          text: 'W projekcie nie ma żadnego punktu — formularz terenowy nie ma czego dotyczyć.',
        })
      )
    );
    return;
  }

  if (!session || session.pointId !== point.id) session = newSession(point);

  const preset = getPreset(point.presetId);
  const shell = h('div', { class: 'field-form' });
  mount(root, shell);

  if (session.submitted) {
    renderThanks(shell, point, preset, ctx);
    return;
  }

  await renderForm(shell, point, preset, demoMode, reason);
}

async function renderForm(shell, point, preset, demoMode, reason) {
  const values = session.values;
  const rerender = () => {
    // Odświeżenie samego formularza (pasków „do uzupełnienia”) bez save() —
    // dane jeszcze nie trafiły do punktu, więc nie ma czego zapisywać.
    renderForm(shell, getPoint(point.id) || point, preset, demoMode, reason);
  };

  /* --- nagłówek ---------------------------------------------------- */

  const head = h(
    'div',
    { class: 'field-form__head' },
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'label-caps', text: 'Sinecco · AED Planner' }),
      h('span', { class: 'spacer' }),
      disabledControl(
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Skanuj kod QR'),
        OUT_OF_SCOPE
      )
    ),
    h('h2', { text: point.name || point.id }),
    h('div', {
      class: 'muted',
      text: [orDash(point.address), districtName(point.districtId)]
        .filter((part) => part && part !== '—')
        .join(' · '),
    }),
    h('div', {
      class: 'note',
      text: `Formularz dla osoby w terenie · punkt ${point.id}${
        preset ? ` · preset ${preset.id}` : ''
      }`,
    })
  );

  const demoNote = demoMode
    ? h(
        'div',
        { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'label-caps', text: 'Tryb demonstracyjny' }),
        h('div', {
          class: 'note',
          text: `${reason} Formularz otwarto na punkcie „${
            point.name || point.id
          }” (pierwszy niezweryfikowany), żeby dało się przejść całą ścieżkę.`,
        })
      )
    : null;

  /* --- 1. zdjęcia --------------------------------------------------- */

  const existingRoles = new Set(photosForPoint(point.id).map((photo) => photo.role));
  const photosMissing = FIELD_PHOTO_ROLES.some(
    (role) => !existingRoles.has(role.id) && !session.photoNames[role.id]
  );

  const photoBody = h('div', { class: 'stack' });
  const photoSection = section(1, 'Zdjęcia', photosMissing, photoBody);

  /* --- 2. godziny dostępu ------------------------------------------- */

  const accessMissing = !values.always && !values.hours.trim();
  const accessSection = section(
    2,
    'Godziny dostępu',
    accessMissing,
    h(
      'label',
      { class: 'checkline checkline--big' },
      h('input', {
        type: 'checkbox',
        checked: values.always ? true : null,
        onchange: (e) => {
          values.always = e.target.checked;
          rerender();
        },
      }),
      h('span', { text: 'Punkt dostępny całodobowo (24/7)' })
    ),
    textField('Godziny dostępu', values.hours, (v) => {
      values.hours = v;
    }, {
      placeholder: 'np. pn–pt 8:00–16:00',
      hint: values.always
        ? 'Przy dostępie całodobowym możesz zostawić puste — wpiszemy „całodobowo (24/7)”.'
        : 'Wpisz godziny, w których da się wejść po AED.',
    }),
    textField('Weekend', values.weekend, (v) => {
      values.weekend = v;
    }, { placeholder: 'np. sob. 9:00–14:00, nd. zamknięte' }),
    textField('Utrudnienia w dojściu', values.barriers, (v) => {
      values.barriers = v;
    }, { placeholder: 'np. domofon po 15:00, brama zamykana' })
  );

  /* --- 3. oznakowanie ----------------------------------------------- */

  const signageMissing = values.atDevice === null || values.route === null;
  const signageSection = section(
    3,
    'Oznakowanie',
    signageMissing,
    triRadio(
      'Znak ILCOR przy urządzeniu',
      `field-signage-device-${point.id}`,
      values.atDevice,
      (v) => {
        values.atDevice = v;
        rerender();
      }
    ),
    triRadio(
      'Oznakowanie dojścia od ulicy',
      `field-signage-route-${point.id}`,
      values.route,
      (v) => {
        values.route = v;
        rerender();
      }
    )
  );

  /* --- 4. urządzenie ------------------------------------------------ */

  const deviceMissing = !values.model.trim() || !values.inspectionDue;
  const deviceSection = section(
    4,
    'Urządzenie',
    deviceMissing,
    textField('Model urządzenia', values.model, (v) => {
      values.model = v;
    }, { placeholder: 'np. Philips HS1' }),
    textField('Termin przeglądu', values.inspectionDue, (v) => {
      values.inspectionDue = v;
    }, { type: 'month', hint: 'Miesiąc i rok z naklejki serwisowej.' })
  );

  /* --- 5. GPS -------------------------------------------------------- */

  const gpsOut = h('div', { class: 'field-form__gps' });
  const gpsButton = h(
    'button',
    { class: 'btn btn--block', type: 'button' },
    'Pobierz lokalizację'
  );

  const paintGps = () => {
    const reading = session.gps;
    if (!reading) {
      mount(
        gpsOut,
        h('div', {
          class: 'note',
          text: 'Brak odczytu. Kliknij „Pobierz lokalizację”, stojąc przy urządzeniu.',
        })
      );
      return;
    }

    const distance = distanceM(reading, { lat: point.lat, lon: point.lon });
    const rows = [
      kv('Szerokość', fmtNum(reading.lat, 5)),
      kv('Długość', fmtNum(reading.lon, 5)),
      reading.accuracy
        ? kv('Dokładność', `± ${fmtNum(reading.accuracy)} m`)
        : null,
      kv(
        'Źródło odczytu',
        reading.source === 'device' ? 'GPS urządzenia' : 'współrzędne z karty punktu'
      ),
      kv(
        'Od lokalizacji w karcie',
        `${fmtNum(distance)} m · ${fmtMin(walkTimeMin(distance))}`
      ),
    ].filter(Boolean);

    const children = [...rows];

    if (reading.source === 'device') {
      children.push(
        h(
          'label',
          { class: 'checkline', style: { marginTop: '8px' } },
          h('input', {
            type: 'checkbox',
            checked: session.values.applyGps ? true : null,
            onchange: (e) => {
              session.values.applyGps = e.target.checked;
            },
          }),
          h('span', { text: 'Zapisz ten odczyt jako współrzędne punktu' })
        )
      );
    } else {
      children.push(
        h('div', {
          class: 'note',
          style: { marginTop: '8px' },
          text: reading.message || 'Użyto współrzędnych zapisanych w karcie punktu.',
        })
      );
    }

    mount(gpsOut, ...children);
  };

  gpsButton.addEventListener('click', () => {
    const finish = () => {
      if (!gpsButton.isConnected) return;
      gpsButton.disabled = false;
      gpsButton.textContent = 'Pobierz lokalizację ponownie';
    };

    const fallback = (message) => {
      session.gps = {
        lat: point.lat,
        lon: point.lon,
        accuracy: null,
        source: 'fallback',
        message,
      };
      session.values.applyGps = false;
      paintGps();
      finish();
      toast(message);
    };

    if (!navigator.geolocation) {
      fallback('Przeglądarka nie udostępnia lokalizacji — użyto współrzędnych z karty punktu.');
      return;
    }

    gpsButton.disabled = true;
    gpsButton.textContent = 'Pobieranie…';

    navigator.geolocation.getCurrentPosition(
      (position) => {
        session.gps = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy || null,
          source: 'device',
          message: '',
        };
        session.values.applyGps = true;
        paintGps();
        finish();
        toast('Odczytano lokalizację z GPS urządzenia.');
      },
      (error) => {
        const reasons = {
          1: 'brak zgody na dostęp do lokalizacji',
          2: 'lokalizacja niedostępna',
          3: 'przekroczono czas oczekiwania',
        };
        const why = reasons[error && error.code] || 'nieznany błąd';
        fallback(`Nie udało się pobrać lokalizacji (${why}) — użyto współrzędnych z karty punktu.`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  const gpsSection = section(
    5,
    'Lokalizacja GPS',
    false,
    gpsButton,
    gpsOut,
    h('div', {
      class: 'note',
      text: 'Odczyt służy do sprawdzenia, czy pin na mapie stoi we właściwym miejscu.',
    })
  );

  /* --- 6. uwagi ------------------------------------------------------ */

  const notesSection = section(
    6,
    'Uwagi',
    false,
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field__label', text: 'Uwagi z wizyty' }),
      h('textarea', {
        class: 'textarea',
        placeholder: 'Co rzuciło się w oczy? Kto opiekuje się urządzeniem? Co blokuje dojście?',
        oninput: (e) => {
          values.notes = e.target.value;
        },
      }, values.notes || '')
    )
  );

  /* --- wysyłka ------------------------------------------------------- */

  const submitButton = h(
    'button',
    {
      class: 'btn btn--primary btn--block field-form__submit',
      type: 'button',
      onclick: () => submitForm(point.id),
    },
    'WYŚLIJ'
  );

  const foot = h(
    'div',
    { class: 'field-form__foot' },
    disabledControl(
      h('button', { class: 'btn btn--block', type: 'button' }, 'Wyślij link do tego formularza'),
      OUT_OF_SCOPE
    ),
    h('div', {
      class: 'note',
      text:
        'W iteracji 2 formularz działa lokalnie: dane trafiają wprost do karty punktu w tej ' +
        'przeglądarce. Nie ma jeszcze realnego linku wysyłanego SMS-em ani mailem, tokenów ' +
        'jednorazowych ani wysyłki na serwer — to iteracja 3.',
    })
  );

  mount(
    shell,
    head,
    demoNote,
    photoSection,
    accessSection,
    signageSection,
    deviceSection,
    gpsSection,
    notesSection,
    submitButton,
    foot
  );

  paintGps();
  await mountPhotos(photoBody, point, preset);
}

/* ------------------------------------------------------------------ *
 * Zdjęcia — photos.js, a gdy go nie ma, zwykłe pole pliku
 * ------------------------------------------------------------------ */

async function mountPhotos(container, point, preset) {
  let photosModule = null;
  try {
    photosModule = await import('../photos.js');
  } catch (err) {
    photosModule = null;
  }

  const renderPhotoSlots =
    photosModule && typeof photosModule.renderPhotoSlots === 'function'
      ? photosModule.renderPhotoSlots
      : null;

  if (renderPhotoSlots) {
    const slots = h('div');
    // Wymuszamy dwa sloty wymagane przez formularz terenowy niezależnie od
    // tego, czego wymaga preset punktu.
    // `id` musi być ustawione — photos.js pokazuje je w podsumowaniu slotów,
    // a punkty niezweryfikowane nie mają jeszcze presetu.
    const fieldPreset = {
      ...(preset || {}),
      id: (preset && preset.id) || 'formularza terenowego',
      requiredPhotos: FIELD_PHOTO_ROLES.map((role) => role.id),
    };
    try {
      renderPhotoSlots(slots, point, fieldPreset);
    } catch (err) {
      console.warn('renderPhotoSlots() nie zadziałał', err);
      mountPhotoFallback(container, point);
      return;
    }
    mount(
      container,
      h('div', {
        class: 'note',
        text: `Wymagane: ${FIELD_PHOTO_ROLES.map((role) => role.label).join(
          ' i '
        )}. Dotknij slotu, aby zrobić lub wybrać zdjęcie.`,
      }),
      slots
    );
    return;
  }

  mountPhotoFallback(container, point);
}

function mountPhotoFallback(container, point) {
  const chosen = h('div', { class: 'note' });

  const paintChosen = () => {
    const picked = FIELD_PHOTO_ROLES.filter((role) => session.photoNames[role.id]);
    chosen.textContent = picked.length
      ? `Wybrano ${fmtNum(picked.length)} z ${fmtNum(FIELD_PHOTO_ROLES.length)}: ${picked
          .map((role) => `${role.label} — ${session.photoNames[role.id]}`)
          .join(' · ')}`
      : 'Nie wybrano jeszcze żadnego pliku.';
  };

  const inputs = FIELD_PHOTO_ROLES.map((role) =>
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field__label', text: role.label }),
      h('input', {
        class: 'field-form__file',
        type: 'file',
        accept: 'image/*',
        capture: 'environment',
        onchange: (e) => {
          const file = e.target.files && e.target.files[0];
          session.photoNames[role.id] = file ? file.name : '';
          paintChosen();
        },
      })
    )
  );

  paintChosen();

  mount(
    container,
    ...inputs,
    chosen,
    h('div', {
      class: 'note',
      text:
        'Moduł zdjęć nie jest dostępny w tej przeglądarce — pliki nie zostaną tu przetworzone. ' +
        'Zdjęcia zostaną dołączone do karty po stronie operatora.',
    })
  );
}

/* ------------------------------------------------------------------ *
 * Wysłanie formularza
 * ------------------------------------------------------------------ */

async function submitForm(pointId) {
  const point = getPoint(pointId);
  if (!point) {
    toast('Punkt zniknął ze stanu — odśwież widok.');
    return;
  }

  const values = session.values;
  const hours = values.always
    ? values.hours.trim() || 'całodobowo (24/7)'
    : values.hours.trim();
  const weekend = values.always
    ? values.weekend.trim() || 'całodobowo (24/7)'
    : values.weekend.trim();

  const next = {
    ...point,
    access: {
      ...(point.access || {}),
      always: values.always,
      hours,
      weekend,
      barriers: values.barriers.trim(),
    },
    signage: {
      ...(point.signage || {}),
      atDevice: values.atDevice,
      route: values.route,
    },
    device: {
      ...(point.device || {}),
      model: values.model.trim() || null,
      inspectionDue: values.inspectionDue || null,
    },
    verification: { date: TODAY, by: 'teren', source: 'formularz_terenowy' },
  };

  const note = values.notes.trim();
  if (note) {
    next.notes = [point.notes, `[${TODAY}] teren: ${note}`].filter(Boolean).join('\n');
  }

  const gpsApplied = Boolean(session.gps && session.gps.source === 'device' && values.applyGps);
  if (gpsApplied) {
    next.lat = session.gps.lat;
    next.lon = session.gps.lon;
  }

  const preset = getPreset(next.presetId);
  const done = completeness(next, preset, state.photos);
  next.status = preset && done.pct >= 100 ? 'verified_ok' : 'verified_gaps';

  const photoCount = photosForPoint(next.id).length;
  const localPhotos = FIELD_PHOTO_ROLES.filter((role) => session.photoNames[role.id]);

  session.summary = [
    ['Dostępność', values.always ? 'całodobowo (24/7)' : 'w wyznaczonych godzinach'],
    ['Godziny', orDash(hours)],
    ['Weekend', orDash(weekend)],
    ['Utrudnienia', orDash(values.barriers)],
    ['Znak przy urządzeniu', yesNoLabel(values.atDevice)],
    ['Oznakowanie dojścia', yesNoLabel(values.route)],
    ['Model urządzenia', orDash(values.model)],
    ['Termin przeglądu', orDash(values.inspectionDue)],
    [
      'Lokalizacja GPS',
      session.gps
        ? `${fmtNum(session.gps.lat, 5)}, ${fmtNum(session.gps.lon, 5)}${
            gpsApplied ? ' — zapisana w karcie' : ' — tylko odczyt'
          }`
        : 'nie pobrano',
    ],
    [
      'Zdjęcia',
      photoCount
        ? `${fmtNum(photoCount)} w karcie punktu`
        : localPhotos.length
        ? `${fmtNum(localPhotos.length)} wskazane lokalnie (bez przesłania)`
        : 'brak',
    ],
    ['Uwagi', orDash(values.notes)],
  ];

  upsertPoint(next);
  session.submitted = true;
  await save();
  toast('Formularz przesłany do karty punktu.');
}

/* ------------------------------------------------------------------ *
 * Ekran podziękowania
 * ------------------------------------------------------------------ */

function renderThanks(shell, point, preset, ctx) {
  const done = completeness(point, preset, state.photos);
  // Bez presetu completeness() nie ma czego liczyć (0 pól wymaganych → 100%),
  // więc nie pokazujemy paska, żeby nie kłamać liczbą.
  const hasPreset = Boolean(preset);
  const status = statusMeta(point, hasPreset ? done.pct : null);
  const recs = autoRecommendations(point, preset, state.photos);
  const variant = done.pct >= 100 ? 'ok' : done.pct >= 50 ? 'warn' : 'crit';

  const head = h(
    'div',
    { class: 'field-form__head' },
    h('span', { class: 'label-caps', text: 'Sinecco · AED Planner' }),
    h('h2', { text: 'Dziękujemy — dane zostały przesłane' }),
    h('div', {
      class: 'muted',
      text: `${point.name || point.id} · ${orDash(point.address)}`,
    }),
    h('div', {
      class: 'note',
      text: `Zapisano ${TODAY} · źródło: formularz terenowy · osoba: teren`,
    })
  );

  const statusCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, el(pillHtml(status.label, status.variant))),
    h('div', {
      class: 'label-caps',
      style: { marginTop: '10px' },
      text: 'Kompletność karty',
    }),
    hasPreset ? el(barHtml(done.pct, variant)) : null,
    h('div', {
      class: 'note',
      text: hasPreset
        ? `${fmtPct(done.pct)} · pola i zdjęcia: ${fmtNum(done.filled)}/${fmtNum(done.required)}`
        : 'Punkt nie ma jeszcze presetu — kompletność policzy się po jego wybraniu w karcie punktu.',
    }),
    h('div', {
      class: 'note',
      text: `Model wygenerował ${fmtNum(recs.length)} rekomendacji dla tego punktu.`,
    })
  );

  const summary = h(
    'div',
    { class: 'card', style: { marginTop: '10px' } },
    h('div', { class: 'label-caps', text: 'Co zostało przesłane' }),
    ...session.summary.map(([label, value]) => kv(label, value))
  );

  const backLink = h(
    'a',
    {
      class: 'btn btn--primary btn--block field-form__submit',
      href: `#/card/${encodeURIComponent(point.id)}`,
    },
    'Wróć do karty punktu →'
  );

  const again = h(
    'button',
    {
      class: 'btn btn--block',
      type: 'button',
      onclick: async () => {
        session = newSession(getPoint(point.id) || point);
        await ctx.navigate(`#/field/${encodeURIComponent(point.id)}`);
      },
    },
    'Wypełnij formularz ponownie'
  );

  const foot = h(
    'div',
    { class: 'field-form__foot' },
    again,
    h('div', {
      class: 'note',
      text:
        'W iteracji 2 formularz działa lokalnie: dane trafiają wprost do karty punktu w tej ' +
        'przeglądarce. Nie ma jeszcze realnego linku wysyłanego SMS-em ani mailem, tokenów ' +
        'jednorazowych ani wysyłki na serwer — to iteracja 3.',
    })
  );

  mount(shell, head, statusCard, summary, backLink, foot);
}

/* ------------------------------------------------------------------ *
 * Sprzątanie
 * ------------------------------------------------------------------ */

export function destroy() {
  removeStyle();
}
