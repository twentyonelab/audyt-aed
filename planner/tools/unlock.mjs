/**
 * unlock.mjs – wspólne odblokowanie ekranu wejścia dla testów.
 *
 * Testy sprawdzają widoki, nie bramkę, więc wpuszczamy je od razu: ten sam
 * wpis w localStorage, który zapisuje ekran wejścia po poprawnym haśle.
 * Samą bramkę – formularz, złe hasło, blokadę po pięciu próbach – sprawdza
 * osobno tools/gate.mjs, przez realne wpisanie hasła.
 */

/** Klucz i wartość muszą się zgadzać z js/gate.js. */
export const GATE_KEY = 'sinecco-aed-gate-v1';
export const GATE_HASH = 'be8ec72a5021a378cf724abeee44024b177e488fe9eb7702bb4e81bb5ade93af';

/** Hasło dostępu – tylko dla testu samej bramki. */
export const GATE_PASSWORD = 'AedSnc2026!';

/** Sadza wpis przed wczytaniem strony, więc bramka w ogóle się nie pokazuje. */
export async function unlock(page) {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* prywatne okno – wtedy test i tak zobaczy bramkę i to zgłosi */
      }
    },
    [GATE_KEY, GATE_HASH]
  );
}
