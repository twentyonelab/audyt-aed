/**
 * walker.js – ludzik świadka na mapie analizy dostępności.
 *
 * Po co: wszystkie liczby w tym kroku są zbiorcze – „51% mieszkańców w zasięgu
 * 5 minut". To dobra miara dla decydenta, ale nie odpowiada na pytanie, które
 * zadaje sobie każdy patrzący na mapę: „a gdybym stał TUTAJ?". Ludzik odpowiada
 * na nie jednym przeciągnięciem: staje w wybranym miejscu, znajduje najbliższe
 * czynne AED i rysuje realną drogę do niego, barwioną czasem dojścia.
 *
 * Wzorzec interakcji jest zapożyczony z Google Maps (pegman): figurka mieszka
 * w doku przy krawędzi mapy, chwyta się ją i upuszcza na mapie. Trzymamy się
 * tego, bo to jedyny gest w tej aplikacji, którego nikt nie musi się uczyć.
 */

import { h, icon, iconHtml } from './ui.js';
import { distanceM, walkTimeMin, fmtNum, fmtMin } from './model.js';
import { fetchWalk } from './reach.js';

/**
 * Progi barwy, liczone jako stosunek czasu dojścia do standardu.
 *
 * Barwy są z palety statusów design systemu, a nie z gradientu wymyślonego
 * na potrzeby tej jednej kontrolki: ten sam zielony, żółty i czerwony niosą
 * w całej aplikacji to samo znaczenie.
 */
const BANDS = [
  { max: 0.6, color: '#0b7030', label: 'zdąży z zapasem', tone: 'ok' },
  { max: 1.0, color: '#167734', label: 'zdąży w standardzie', tone: 'ok' },
  { max: 1.4, color: '#fecd14', label: 'na granicy standardu', tone: 'warn' },
  { max: 2.0, color: '#f98326', label: 'nie zdąży', tone: 'warn' },
  { max: Infinity, color: '#d40b07', label: 'daleko poza zasięgiem', tone: 'crit' },
];

function bandFor(minutes, standardMinutes) {
  const ratio = standardMinutes > 0 ? minutes / standardMinutes : Infinity;
  return BANDS.find((b) => ratio <= b.max) || BANDS[BANDS.length - 1];
}

/**
 * Najbliższe czynne AED w linii prostej.
 *
 * Dlaczego w linii prostej, skoro cała aplikacja liczy po sieci pieszej:
 * żeby wybrać CEL, wystarczy przybliżenie – a policzenie realnej trasy do
 * każdego z czternastu punktów oznaczałoby czternaście zapytań na każde
 * upuszczenie ludzika. Realna trasa liczy się potem, do tego jednego celu,
 * i to ona podaje czas.
 */
function nearestPoint(lat, lon, points) {
  let best = null;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const d = distanceM({ lat, lon }, p);
    if (!best || d < best.distanceM) best = { point: p, distanceM: d };
  }
  return best;
}

/**
 * Ludzik na mapie widoku analizy.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.mapEl        kontener mapy (dok siada na jego krawędzi)
 * @param {object} opts.map               renderer – potrzebny do przeliczeń ekran/współrzędne
 * @param {Function} opts.activePoints    () => lista czynnych AED
 * @param {number} opts.standardMinutes   standard czasu dojścia
 * @param {Function} opts.onChange        wołane po każdej zmianie stanu (przerysowanie sceny)
 */
export function createWalker({ mapEl, map, activePoints, standardMinutes, onChange, initialAt = null }) {
  /** Bieżący stan: null = ludzik siedzi w doku. */
  let placed = null;
  /** Numer upuszczenia – ubija wyniki zapytań, które wróciły po kolejnym ruchu. */
  let dropId = 0;

  const dock = h(
    'button',
    {
      class: 'walker-dock',
      type: 'button',
      title: 'Przeciągnij ludzika na mapę, żeby sprawdzić drogę do najbliższego AED',
      'aria-label': 'Ludzik: przeciągnij na mapę',
    },
    icon('user', 20),
    h('span', { class: 'walker-dock__hint', text: 'Przeciągnij\nna mapę' })
  );

  const card = h('div', { class: 'walker-card', style: { display: 'none' } });

  /* ---------------- stan i liczenie ---------------- */

  const clear = () => {
    dropId += 1;
    placed = null;
    dock.classList.remove('is-out');
    card.style.display = 'none';
    onChange();
  };

  /** Dane do sceny mapy – albo null, gdy ludzik jest w doku. */
  const scene = () =>
    placed
      ? {
          lat: placed.lat,
          lon: placed.lon,
          line: placed.line,
          color: placed.band ? placed.band.color : '#908f8f',
          title: placed.target ? `Świadek → ${placed.target.name}` : 'Świadek',
        }
      : null;

  const paintCard = () => {
    if (!placed) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    card.className = `walker-card walker-card--${placed.band ? placed.band.tone : ''}`;
    card.innerHTML = '';

    const close = h(
      'button',
      {
        class: 'btn btn--sm btn--ghost walker-card__close',
        title: 'Zdejmij ludzika z mapy (Esc)',
        'aria-label': 'Zdejmij ludzika z mapy',
        onclick: clear,
      },
      icon('x', 14)
    );

    if (!placed.target) {
      card.append(
        h(
          'div',
          { class: 'row', style: { alignItems: 'flex-start' } },
          h('span', { class: 'label-caps', style: { flex: '1' }, text: 'Świadek' }),
          close
        ),
        h('p', { class: 'note', text: 'W tym scenariuszu nie ma ani jednego czynnego AED.' })
      );
      return;
    }

    const b = placed.band;
    card.append(
      h(
        'div',
        { class: 'row', style: { alignItems: 'flex-start' } },
        h('span', { class: 'label-caps', style: { flex: '1' }, text: 'Świadek stąd biegnie po AED' }),
        close
      ),
      h('div', {
        class: 'walker-card__time num',
        style: { color: b.color },
        text: fmtMin(placed.minutes, 1),
      }),
      h('div', { class: 'walker-card__verdict', style: { color: b.color }, text: b.label }),
      h('div', {
        class: 'note',
        html:
          `${iconHtml('map-pin', 12)} <b>${placed.target.name}</b> · ` +
          `${fmtNum(placed.distanceM, 0)} m drogi`,
      }),
      h('p', {
        class: 'note',
        // Trzy stany, trzy różne zdania. Nigdy „ładowanie" bez liczby:
        // przybliżenie jest gotowe od razu, więc pokazujemy je i mówimy,
        // że trasa się jeszcze uściśla.
        text: placed.pending
          ? `Przybliżenie w linii prostej. Uściślam trasę po chodnikach… ` +
            `Standard: ${fmtMin(standardMinutes, 0)} w jedną stronę.`
          : placed.network
            ? `Trasa po realnych chodnikach i ulicach. Standard: ${fmtMin(standardMinutes, 0)} w jedną stronę.`
            : `Przybliżenie w linii prostej z korektą trasy – Mapbox nie odpowiedział. ` +
              `Standard: ${fmtMin(standardMinutes, 0)} w jedną stronę.`,
      })
    );
  };

  /** Liczy drogę do najbliższego AED i odświeża widok. */
  const resolve = async (lat, lon) => {
    const mine = ++dropId;
    const points = activePoints();
    const near = nearestPoint(lat, lon, points);

    if (!near) {
      placed = { lat, lon, target: null, pending: false };
      paintCard();
      onChange();
      return;
    }

    // Najpierw przybliżenie, żeby ludzik od razu miał barwę i liczbę.
    const roughMin = walkTimeMin(near.distanceM);
    placed = {
      lat,
      lon,
      target: near.point,
      distanceM: Math.round(near.distanceM),
      minutes: roughMin,
      band: bandFor(roughMin, standardMinutes),
      line: [
        [lon, lat],
        [near.point.lon, near.point.lat],
      ],
      network: false,
      pending: true,
    };
    paintCard();
    onChange();

    const walk = await fetchWalk(lat, lon, near.point.lat, near.point.lon);
    // Ludzik mógł w międzyczasie zostać przesunięty albo zdjęty.
    if (mine !== dropId) return;

    if (walk) {
      placed = {
        ...placed,
        line: walk.line,
        distanceM: walk.distanceM,
        minutes: walk.minutes,
        band: bandFor(walk.minutes, standardMinutes),
        network: true,
        pending: false,
      };
    } else {
      placed = { ...placed, pending: false };
    }
    paintCard();
    onChange();
  };

  /* ---------------- przeciąganie ---------------- */

  /**
   * Duch ciągnięty za kursorem.
   *
   * Osobny element w <body>, a nie przesuwany dok: dzięki temu figurka może
   * wyjść poza mapę bez przycinania i nie wpływa na układ. Lekkie kołysanie
   * (klasa .walker-ghost) to ten sam sygnał co u pegmana w Google Maps –
   * mówi „trzymam to", zanim jeszcze cokolwiek się wydarzy.
   */
  let ghost = null;
  let dragging = false;

  const moveGhost = (x, y) => {
    if (ghost) {
      ghost.style.left = `${x}px`;
      ghost.style.top = `${y}px`;
    }
  };

  const overMap = (x, y) => {
    const r = mapEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('is-walker-dragging');
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    mapEl.classList.remove('is-walker-target');

    const x = ev.clientX;
    const y = ev.clientY;
    if (!overMap(x, y)) {
      // Upuszczony poza mapą wraca do doku – to najprostszy sposób, żeby go
      // zdjąć, i działa też, gdy ktoś nie zauważył krzyżyka na karcie.
      clear();
      return;
    }
    const r = mapEl.getBoundingClientRect();
    const at = map.screenToLatLon(x - r.left, y - r.top);
    if (!at) return;
    dock.classList.add('is-out');
    resolve(at.lat, at.lon);
  };

  const onMove = (ev) => {
    if (!dragging) return;
    moveGhost(ev.clientX, ev.clientY);
    mapEl.classList.toggle('is-walker-target', overMap(ev.clientX, ev.clientY));
  };

  const startDrag = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    ghost = h('div', { class: 'walker-ghost', html: iconHtml('user', 22) });
    document.body.appendChild(ghost);
    moveGhost(ev.clientX, ev.clientY);
    document.body.classList.add('is-walker-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  };

  dock.addEventListener('pointerdown', startDrag);

  // Klawiatura: bez myszy ludzik ląduje na środku kadru, a stamtąd i tak
  // można go przeciągnąć. Lepsze to niż kontrolka dostępna tylko myszą.
  dock.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    const r = mapEl.getBoundingClientRect();
    const at = map.screenToLatLon(r.width / 2, r.height / 2);
    if (!at) return;
    dock.classList.add('is-out');
    resolve(at.lat, at.lon);
  });

  const onKey = (ev) => {
    if (ev.key === 'Escape' && placed) clear();
  };
  document.addEventListener('keydown', onKey);

  // Widok analizy przerysowuje się po każdej zmianie stanu (przesunięcie pinu,
  // przełącznik scenariusza). Ludzik ma to przetrwać, więc po odtworzeniu
  // wraca w to samo miejsce i przelicza drogę od nowa – dane mogły się zmienić.
  if (initialAt) {
    dock.classList.add('is-out');
    resolve(initialAt.lat, initialAt.lon);
  }

  return {
    dock,
    card,
    scene,
    clear,
    isPlaced: () => !!placed,
    /** Miejsce, w którym stoi ludzik – do przeniesienia przez przerysowanie. */
    getPlace: () => (placed ? { lat: placed.lat, lon: placed.lon } : null),
    destroy() {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      if (ghost) ghost.remove();
      document.body.classList.remove('is-walker-dragging');
    },
  };
}
