/**
 * config.js – deployment configuration for the Sinecco AED Planner makieta.
 *
 * Put your own Mapbox public token in MAPBOX_TOKEN. Without it the app still
 * runs: the map falls back to a schematic vector rendering of the same data,
 * and a notice explains what to do.
 */

/**
 * Public Mapbox token, resolved in this order:
 *   1. ?mbtoken=pk... in the page URL   – lets one link carry the token
 *   2. window.MAPBOX_TOKEN               – set by a host page or a deploy step
 *   3. the placeholder below             – falls back to the schematic map
 *
 * Kept out of the repository on purpose. A pk.* token is public by design once
 * embedded in a page; the real protection is a URL restriction in the Mapbox
 * account (Account → Tokens → URL restrictions).
 */
function resolveMapboxToken() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('mbtoken');
    if (fromUrl && fromUrl.startsWith('pk.')) return fromUrl;
  } catch {
    /* no URL access – fall through */
  }
  if (typeof window !== 'undefined' && typeof window.MAPBOX_TOKEN === 'string') {
    return window.MAPBOX_TOKEN;
  }
  return 'MAPBOX_TOKEN';
}

export const MAPBOX_TOKEN = resolveMapboxToken();

/**
 * Styl mapy: Mapbox Standard.
 *
 * Standard to styl trójwymiarowy – niesie bryły budynków, drzewa i punkty
 * charakterystyczne, a jego wygląd ustawia się nie przez podmianę warstw,
 * tylko przez konfigurację importu `basemap` (patrz MAP_CONFIG). Poprzedni
 * `light-v11` był płaski i nie dało się w nim rozdzielić podpisów miejsc
 * od podpisów dróg.
 */
export const MAP_STYLE = 'mapbox://styles/mapbox/standard';

/** Klucz, pod którym styl Standard trzyma swoje ustawienia. */
export const MAP_IMPORT_ID = 'basemap';

/**
 * Ustawienia podkładu.
 *
 * `monochrome` to chłodno-ciepłe szarości bez zieleni i błękitów – w tym
 * systemie podkład ma być tłem, a nie treścią: kolor należy do znaczników
 * AED i do obrysów zasięgu, nie do mapy.
 *
 * Podpisy dróg i punktów usługowych są zdjęte. Ta mapa odpowiada na pytanie
 * „gdzie NIE zdąży dobiec świadek", a nie „którędy dojechać"; nazwy sklepów
 * i numery dróg zabierałyby uwagę czternastu punktom, które są tu treścią.
 */
export const MAP_CONFIG = {
  lightPreset: 'day',
  theme: 'monochrome',
  show3dObjects: true,
  showPlaceLabels: true,
  showPointOfInterestLabels: false,
  showRoadLabels: false,
};

/**
 * Sposoby kolorowania podkładu – przełącznik siedzi w pasku nad mapą.
 *
 * Dwie pozycje, nie trzy. Pełna paleta Mapboxa (`default`) była za mocna:
 * zieleń parków i błękit wody biły się o uwagę ze znacznikami AED i obrysami
 * zasięgu, czyli z treścią. „Kolorowy" to teraz `faded` – barwy są, ale
 * przygaszone na tyle, że zostają tłem.
 */
export const MAP_THEMES = [
  { id: 'monochrome', label: 'Szarości', hint: 'Chłodno-ciepłe szarości – domyślny' },
  { id: 'faded', label: 'Kolorowy', hint: 'Przygaszone barwy podkładu' },
];

/** Źródło rzeźby terenu – identyfikator i adres z dokumentacji Mapboxa. */
export const MAP_DEM = {
  id: 'mapbox-dem',
  url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
  tileSize: 512,
  maxzoom: 14,
  exaggeration: 1.4,
};

/** Pochylenie kamery. Bez niego „3D" jest tylko nazwą. */
export const MAP_PITCH = 52;

/** Pochylenie i przybliżenie po wybraniu punktu – tak blisko, jak ma to sens. */
export const MAP_PITCH_CLOSE = 62;
export const MAP_ZOOM_CLOSE = 17.5;

/** Fallback view when a project carries no saved camera position. */
export const MAP_DEFAULT = { center: [19.0, 50.118], zoom: 11.6 };

/** Which demo project is seeded on first run. */
export const DEMO_PROJECT_FILE = 'data/demo-tychy.json';

/** IndexedDB database name and version. */
export const DB_NAME = 'sinecco-aed-planner';
export const DB_VERSION = 1;

/** Photo pipeline limits (spec §7). */
export const PHOTO_MAX_EDGE = 1600;
export const PHOTO_THUMB_EDGE = 300;
export const PHOTO_QUALITY = 0.8;

/** Reference "today" – fixed so the makieta shows stable overdue states. */
export const TODAY = '2026-07-29';

/** Operator shown in the top bar. */
export const OPERATOR = 'Operator: K. Bogomaz';
