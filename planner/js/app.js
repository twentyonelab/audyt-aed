/**
 * app.js — bootstrap: load state, register routes, start the router.
 */

import { initState, state, subscribe } from './state.js';
import { registerRoute, initRouter, render } from './router.js';
import { h, mount, toast } from './ui.js';

registerRoute('#/', () => import('./views/dashboard.js'));
registerRoute('#/setup', () => import('./views/setup.js'));
registerRoute('#/inventory', () => import('./views/inventory.js'));
registerRoute('#/analysis', () => import('./views/analysis.js'));
registerRoute('#/cards', () => import('./views/cards.js'));
registerRoute('#/card/:id', () => import('./views/card.js'));
registerRoute('#/roadmap', () => import('./views/roadmap.js'));
registerRoute('#/report', () => import('./views/report-view.js'));
registerRoute('#/field/:token', () => import('./views/field.js'));

async function boot() {
  const root = document.getElementById('app');
  try {
    await initState();
  } catch (err) {
    console.error(err);
    mount(
      root,
      h('div', { class: 'boot' }, [
        h('h2', { text: 'Nie udało się wczytać danych projektu' }),
        h('p', { class: 'note', text: String(err.message || err) }),
        h('p', {
          class: 'note',
          text: 'Uruchom aplikację przez lokalny serwer, np. python3 -m http.server 8000, a nie z pliku file://',
        }),
      ])
    );
    return;
  }

  // Re-render the current view whenever state changes.
  let queued = false;
  subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      render();
    });
  });

  await initRouter();
  window.__aed = state; // handy during a live demo / debugging
}

window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('mapboxgl')) return;
  console.error(e.error || e.message);
});

boot().catch((err) => {
  console.error(err);
  toast('Błąd startu aplikacji — szczegóły w konsoli.');
});
