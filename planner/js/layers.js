/**
 * layers.js – przełączniki warstw mapy, w szynie pod ludzikiem.
 *
 * DWA ODCZYTY TYCH SAMYCH LUDZI
 *
 * Mapa dostępności pokazuje mieszkańców na dwa sposoby i to są dwa różne
 * pytania, nie dwa style tej samej warstwy:
 *
 *   • punkty popytu – „ilu ludzi jest poza zasięgiem", kolor niesie czas
 *     dojścia (zielony / żółty / czerwony). To warstwa robocza analizy:
 *     grubsze kropki, każda to kilkuset mieszkańców jednej dzielnicy;
 *
 *   • zagęszczenie ludności – „gdzie ci ludzie w ogóle mieszkają", siatka
 *     drobnych kropek pokrywająca całą gminę. Rozmiar kropki niesie gęstość,
 *     kolor tylko dostęp do AED: zielona ma, grafitowa nie ma.
 *
 * Dlatego to dwa niezależne przełączniki, a nie jeden trójstanowy: bywa, że
 * chce się zobaczyć samą gęstość (gdzie w ogóle warto szukać lokalizacji),
 * bywa, że sam wynik analizy, a czasem oba naraz – siatka gęstości leży pod
 * punktami popytu, więc się nie zasłaniają.
 */

import { h, icon } from './ui.js';

/** Definicje przełączników – kolejność w szynie jest kolejnością tej listy. */
const LAYERS = [
  {
    id: 'demand',
    icon: 'map',
    label: 'Popyt',
    on: 'Punkty popytu są na mapie – kliknij, żeby zgasić',
    off: 'Pokaż punkty popytu (kolor = czas dojścia do AED)',
  },
  {
    id: 'density',
    icon: 'users',
    label: 'Gęstość',
    on: 'Siatka zagęszczenia ludności jest na mapie – kliknij, żeby zgasić',
    off: 'Pokaż zagęszczenie ludności (rozmiar = gęstość, zielony = dostęp do AED)',
  },
];

/**
 * @param {object} opts
 * @param {{demand:boolean, density:boolean}} opts.initial stan wyjściowy
 * @param {Function} opts.onChange wołane po każdym przełączeniu, dostaje stan
 * @returns {{dock:HTMLElement, get:Function, destroy:Function}}
 */
export function createLayerDock({ initial = null, onChange = () => {} } = {}) {
  const state = { demand: true, density: false, ...(initial || {}) };

  const buttons = new Map();

  const paint = () => {
    for (const def of LAYERS) {
      const button = buttons.get(def.id);
      if (!button) continue;
      const isOn = !!state[def.id];
      button.classList.toggle('is-on', isOn);
      button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      button.title = isOn ? def.on : def.off;
    }
  };

  const dock = h('div', {
    class: 'layer-dock',
    role: 'group',
    'aria-label': 'Warstwy mapy',
  });

  for (const def of LAYERS) {
    const button = h(
      'button',
      {
        class: 'layer-dock__btn',
        type: 'button',
        onclick: () => {
          state[def.id] = !state[def.id];
          paint();
          onChange({ ...state });
        },
      },
      icon(def.icon, 17),
      h('span', { class: 'layer-dock__label', text: def.label })
    );
    buttons.set(def.id, button);
    dock.append(button);
  }

  paint();

  return {
    dock,
    get: () => ({ ...state }),
    destroy() {
      dock.remove();
      buttons.clear();
    },
  };
}
