/**
 * router.js – hash routing plus the application shell (top bar, sub bar).
 * Views are plain modules that export `meta` and `render`.
 *
 * v2: nawigacja przeniosła się z bocznej szyny do belki górnej. Design system
 * marki prowadzi krok po kroku numerowanymi zakładkami 01–05 wyśrodkowanymi
 * w belce, a nie pionową listą po lewej – dzięki temu obszar roboczy zaczyna
 * się od lewej krawędzi ekranu i mapa dostaje pełną szerokość.
 *
 * Spec reference: ITERACJA2_SPEC.md §3 (shell), §6 (routes).
 */

import { h, mount, clear, toast } from './ui.js';
import { state, canUndo, undo, undoLabel } from './state.js';
import { OPERATOR } from '../config.js';

/** The five audit steps plus setup (spec §3). */
export const STEPS = [
  // `tab` to skrócona etykieta do belki górnej: sześć pełnych nazw nie mieści
  // się w wyśrodkowanej nawigacji, a numer i tak niesie kolejność kroku.
  { step: 0, route: '#/setup', name: 'Setup projektu', tab: 'Setup', short: 'dane wejściowe' },
  { step: 1, route: '#/inventory', name: 'Inwentaryzacja', tab: 'Inwentaryzacja', short: 'jak jest' },
  { step: 2, route: '#/analysis', name: 'Analiza dostępności', tab: 'Dostępność', short: 'gdzie są luki' },
  { step: 3, route: '#/cards', name: 'Karty punktów', tab: 'Punkty', short: 'co zrobić' },
  { step: 4, route: '#/roadmap', name: 'Roadmapa', tab: 'Roadmapa', short: 'kiedy i za ile' },
  { step: 5, route: '#/report', name: 'Raport', tab: 'Raport', short: 'dla decydenta' },
];

const routes = [];
let current = null;

export function registerRoute(pattern, loader) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`
  );
  routes.push({ pattern, regex, keys, loader });
}

function match(hash) {
  for (const route of routes) {
    const m = route.regex.exec(hash);
    if (m) {
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { route, params };
    }
  }
  return null;
}

export function navigate(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

/** Roll back the last checkpointed action and tell the operator what went back. */
export async function undoLast() {
  if (!canUndo()) {
    toast('Nie ma czego cofnąć.');
    return;
  }
  const label = await undo();
  toast(`Cofnięto: ${label}`);
}

function undoButton() {
  const enabled = canUndo();
  return h(
    'button',
    {
      class: 'btn btn--sm topbar__undo',
      disabled: enabled ? null : '',
      onclick: undoLast,
      title: enabled ? `Cofnij: ${undoLabel()} (Ctrl+Z)` : 'Nie ma czego cofnąć',
    },
    '↩ Cofnij'
  );
}

/** Znak marki – błyskawica z księgi Sinecco, w kolorze dziedziczonym z CSS. */
const MARK_SVG =
  '<svg viewBox="0 0 296.533 400" aria-hidden="true"><path fill="currentColor" ' +
  'd="M83.035 218.064L0 218.064L92.348 0L222.031 0L83.035 218.064ZM157.537 400L74.502 400' +
  'L166.763 181.936L296.533 181.936L157.537 400Z"/></svg>';

/**
 * Belka górna wg design systemu: znak i wordmark, kreska, nazwa projektu,
 * wyśrodkowane numerowane zakładki 01–05 i limonkowy przycisk menu po prawej.
 * Zakładka aktywna dostaje bladolimonkowe tło na pełną wysokość belki.
 */
function topbar(activeStep) {
  const project = state.project;
  const done = new Set(state.project?.stepsDone || []);

  const tabs = STEPS.map((s, i) =>
    h(
      'button',
      {
        class: `topbar__tab${s.step === activeStep ? ' is-on' : ''}${
          done.has(s.step) && s.step !== activeStep ? ' is-done' : ''
        }`,
        onclick: () => navigate(s.route),
        title: `${s.name} – ${s.short}`,
      },
      h('span', { class: 'topbar__tab-no', text: String(i + 1).padStart(2, '0') }),
      h('span', { text: s.tab || s.name })
    )
  );

  return h(
    'header',
    { class: 'topbar' },
    h(
      'button',
      { class: 'topbar__brand', onclick: () => navigate('#/'), title: 'Wróć do pulpitu' },
      h('span', { class: 'topbar__mark', html: MARK_SVG }),
      h('span', { class: 'topbar__wordmark', text: 'sinecco' })
    ),
    project ? h('span', { class: 'topbar__rule' }) : null,
    project
      ? h(
          'span',
          { class: 'topbar__project' },
          h('small', { text: 'Projekt' }),
          h('strong', { text: project.label || project.name })
        )
      : null,
    h('nav', { class: 'topbar__nav', 'aria-label': 'Kroki audytu' }, ...tabs),
    h(
      'div',
      { class: 'topbar__actions' },
      h('span', { class: 'topbar__tag', html: `<b>Audyt</b> · ${OPERATOR}` }),
      undoButton(),
      h(
        'button',
        {
          class: 'icon-btn icon-btn--signal',
          onclick: () => navigate('#/report'),
          title: 'Przejdź do raportu i wygeneruj PDF',
          'aria-label': 'Raport i PDF',
        },
        '⌸'
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

export async function render() {
  const root = document.getElementById('app');
  const hash = window.location.hash || '#/';
  const found = match(hash);

  if (!found) {
    navigate('#/');
    return;
  }

  if (current && typeof current.destroy === 'function') {
    try {
      current.destroy();
    } catch (err) {
      console.warn('destroy() failed', err);
    }
  }

  let view;
  try {
    view = await found.route.loader();
  } catch (err) {
    console.error(err);
    mount(root, h('div', { class: 'boot', text: `Nie udało się wczytać widoku: ${err.message}` }));
    return;
  }
  current = view;

  const meta = view.meta || {};

  // Chrome-less views (dashboard, field form) render straight into the root.
  if (meta.chrome === 'none') {
    clear(root);
    const holder = h('div', { class: meta.layout === 'scroll' ? 'workspace workspace--scroll' : 'workspace' });
    root.appendChild(topbarIf(meta));
    root.appendChild(holder);
    await view.render(holder, { params: found.params, navigate, subbar: null });
    return;
  }

  const subbarMeta = h('span', { class: 'subbar__meta' });
  const subbarControls = h('div', { class: 'subbar__controls' });
  const workspace = h('div', {
    class: meta.layout === 'scroll' ? 'workspace workspace--scroll' : 'workspace',
  });

  const stepLabel = meta.step !== undefined && meta.step !== null ? `Krok ${meta.step} z 5 · ` : '';
  const subbar = h(
    'div',
    { class: 'subbar' },
    h('span', {
      class: 'subbar__title',
      html: `${stepLabel}${meta.title || ''}${meta.subtitle ? ` <em>– „${meta.subtitle}”</em>` : ''}`,
    }),
    subbarMeta,
    h('span', { class: 'subbar__spacer' }),
    subbarControls
  );

  clear(root);
  root.appendChild(topbar(meta.step));
  root.appendChild(subbar);
  root.appendChild(h('div', { class: 'layout' }, workspace));

  try {
    await view.render(workspace, {
      params: found.params,
      navigate,
      subbar: { meta: subbarMeta, controls: subbarControls },
      setMeta: (html) => {
        subbarMeta.innerHTML = html;
      },
    });
  } catch (err) {
    console.error(err);
    mount(workspace, h('div', { class: 'boot', text: `Błąd widoku: ${err.message}` }));
    toast('Widok nie wczytał się poprawnie – szczegóły w konsoli.');
  }
}

function topbarIf(meta) {
  return meta.showTopbar === false ? h('div') : topbar(meta.step);
}

export function initRouter() {
  window.addEventListener('hashchange', render);
  window.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z' || ev.shiftKey) return;
    // Inside a field, Ctrl+Z belongs to the browser's own text undo.
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
    undoLast();
  });
  return render();
}

export function currentHash() {
  return window.location.hash || '#/';
}
