/**
 * gate.js – ekran wejścia z hasłem.
 *
 * CO TO JEST, A CZYM NIE JEST
 *
 * To zapora przed przypadkowym wejściem, nie zabezpieczenie. Makieta stoi na
 * GitHub Pages jako statyczne pliki: cała logika jedzie do przeglądarki, więc
 * ktoś, kto zajrzy w źródło, obejdzie ten ekran w minutę. Hasło trzymamy jako
 * skrót SHA-256 z solą, żeby nie leżało w repozytorium otwartym tekstem – ale
 * to utrudnienie, a nie ochrona. Prawdziwa kontrola dostępu wymaga serwera,
 * który sprawdza hasło u siebie i dopiero wtedy wydaje dane.
 *
 * Dlatego za tym ekranem nie ma niczego, czego nie można pokazać klientowi na
 * spotkaniu: dane są demonstracyjne, a projekt i tak żyje w IndexedDB
 * przeglądarki tej jednej osoby.
 */

import { h, mount, clear, icon } from './ui.js';
import { wordmarkSvg } from './logo.js';
import { sha256Hex } from './sha256.js';

/**
 * SHA-256 z „sinecco-aed-planner:" + hasło.
 *
 * Sól nie chroni przed niczym poważnym, ale sprawia, że skrótu nie da się
 * odczytać z pierwszej lepszej tablicy tęczowej dla krótkich haseł.
 */
const HASH = 'be8ec72a5021a378cf724abeee44024b177e488fe9eb7702bb4e81bb5ade93af';
const SALT = 'sinecco-aed-planner:';

/** Klucz zapamiętanego wejścia. Zmiana klucza unieważnia wszystkie sesje. */
const STORAGE_KEY = 'sinecco-aed-gate-v1';

/** Po ilu nieudanych próbach pole na chwilę się blokuje. */
const MAX_TRIES = 5;
const LOCK_MS = 15000;

function remembered() {
  // Prywatne okno albo wyłączone dane witryny potrafią rzucić wyjątkiem
  // na samym dostępie – wtedy po prostu pytamy o hasło.
  try {
    return window.localStorage.getItem(STORAGE_KEY) === HASH;
  } catch {
    return false;
  }
}

function remember() {
  try {
    window.localStorage.setItem(STORAGE_KEY, HASH);
  } catch {
    /* brak pamięci to nie powód, żeby nie wpuścić */
  }
}

/** Czyści zapamiętane wejście – wołane przez przycisk „Zablokuj". */
export function lockAgain() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* jw. */
  }
  window.location.reload();
}

/**
 * Pokazuje ekran wejścia i rozwiązuje obietnicę dopiero po poprawnym haśle.
 * Gdy wejście jest już zapamiętane, wraca natychmiast i nic nie rysuje.
 */
export function requireUnlock(root) {
  if (remembered()) return Promise.resolve();

  return new Promise((resolve) => {
    const input = h('input', {
      class: 'gate__input',
      type: 'password',
      autocomplete: 'current-password',
      placeholder: 'Hasło dostępu',
      'aria-label': 'Hasło dostępu',
    });

    const error = h('p', { class: 'gate__error', role: 'alert', style: { visibility: 'hidden' }, text: '.' });
    const submit = h(
      'button',
      { class: 'btn btn--signal btn--lg btn--bolt gate__submit', type: 'submit' },
      h('span', { text: 'Wejdź' })
    );

    let tries = 0;

    const fail = (message) => {
      error.textContent = message;
      error.style.visibility = 'visible';
      input.value = '';
      input.focus();
    };

    const check = (event) => {
      if (event) event.preventDefault();
      const value = input.value;
      if (!value) {
        fail('Wpisz hasło.');
        return;
      }
      if (sha256Hex(SALT + value) !== HASH) {
        tries += 1;
        if (tries >= MAX_TRIES) {
          // Opóźnienie nie chroni przed niczym po stronie kogoś, kto czyta
          // źródło – jest po to, żeby zniechęcić do zgadywania na oślep.
          submit.disabled = true;
          input.disabled = true;
          fail(`Za dużo prób. Pole odblokuje się za ${Math.round(LOCK_MS / 1000)} s.`);
          setTimeout(() => {
            tries = 0;
            submit.disabled = false;
            input.disabled = false;
            error.style.visibility = 'hidden';
            input.focus();
          }, LOCK_MS);
          return;
        }
        fail(`Hasło nie pasuje. Pozostało prób: ${MAX_TRIES - tries}.`);
        return;
      }
      remember();
      clear(root);
      resolve();
    };

    const form = h(
      'form',
      { class: 'gate__form', onsubmit: check },
      h('label', { class: 'gate__label', text: 'Dostęp do makiety' }),
      h('div', { class: 'gate__row' }, input, submit),
      error
    );

    input.addEventListener('input', () => {
      if (!submit.disabled) error.style.visibility = 'hidden';
    });

    mount(
      root,
      h(
        'div',
        { class: 'gate' },
        h('div', { class: 'gate__photo' }, h('div', { class: 'gate__scrim' })),
        h(
          'div',
          { class: 'gate__body' },
          h('span', { class: 'gate__wordmark', html: wordmarkSvg(34) }),
          h('div', { class: 'gate__eyebrow', text: 'AED Planner · makieta audytu' }),
          h('h1', { class: 'gate__headline', text: 'Bezpieczeństwo zaczyna się od dobrego planu.' }),
          form,
          h(
            'p',
            { class: 'gate__note' },
            icon('info', 14),
            h('span', {
              text:
                'Ekran chroni makietę przed przypadkowym wejściem. Dane w środku są ' +
                'demonstracyjne i żyją wyłącznie w tej przeglądarce.',
            })
          )
        ),
        h('div', { class: 'gate__inset' })
      )
    );

    input.focus();
  });
}
