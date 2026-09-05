/**
 * projects.js – wybór projektu i zakładanie nowego.
 *
 * Osobny moduł, bo te dwie czynności są dostępne z dwóch miejsc: z kafelków
 * na pulpicie i z rozwijanej listy przy logotypie. Trzymanie ich w widoku
 * pulpitu zmuszałoby belkę do importowania całego widoku.
 */

import { state } from './state.js';
import { h, modal, toast } from './ui.js';

/**
 * Który projekt niesie realne dane.
 *
 * W makiecie jest jeden zestaw demonstracyjny – Tychy. Pozostałe pozycje są
 * na liście po to, żeby było widać, że narzędzie prowadzi portfel audytów,
 * a nie jedną gminę. Klik w nie mówi wprost, że danych jeszcze nie ma,
 * zamiast otwierać pusty projekt.
 */
export function projectHasData(project) {
  return !!(project && project.available);
}

/** Okno zakładania audytu. Wspólne dla pulpitu i listy w belce. */
export async function openNewAudit(navigate) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'np. Brodnica',
    autocomplete: 'off',
  });

  const body = h(
    'div',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'Nazwa gminy' }), input),
    h('p', {
      class: 'note',
      text:
        'Makieta pracuje na jednym zestawie danych demonstracyjnych. Kreator otworzy krok 0 ' +
        '(Setup projektu) z danymi Tychów – zakładanie własnych gmin wchodzi w etapie 1.',
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
      ? `W makiecie dostępny jest wyłącznie projekt demo Tychy – „${name}” zapiszemy w etapie 1.`
      : 'W makiecie dostępny jest wyłącznie projekt demo Tychy.'
  );
  navigate('#/setup');
}

/**
 * Przejście do projektu z listy.
 *
 * Projekt bez danych nie otwiera pustego widoku – mówi, czego brakuje.
 * To ta sama zasada co przy wyłączonych kontrolkach: żadnego martwego kliku.
 */
export function openProject(project, navigate) {
  if (!projectHasData(project)) {
    toast(`${project.name}: brak danych źródłowych w tej makiecie – zostaje ${projectLabel(currentProject())}.`);
    return;
  }
  navigate('#/inventory');
}

export function currentProject() {
  return state.project || (state.projects || []).find(projectHasData) || null;
}

export function projectLabel(project) {
  return project ? project.label || project.name : 'bez projektu';
}
