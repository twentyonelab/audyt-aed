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

/** Mapbox style. A muted light style keeps the data, not the basemap, in front. */
export const MAP_STYLE = 'mapbox://styles/mapbox/light-v11';

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
