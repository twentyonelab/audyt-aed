/**
 * router.js — hash routing plus the application shell (top bar, sub bar,
 * stepper). Views are plain modules that export `meta` and `render`.
 *
 * Spec reference: ITERACJA2_SPEC.md §3 (shell), §6 (routes).
 */

import { h, mount, clear, toast } from './ui.js';
import { state, canUndo, undo, undoLabel } from './state.js';
import { OPERATOR } from '../config.js';

/** The five audit steps plus setup (spec §3). */
export const STEPS = [
  { step: 0, route: '#/setup', name: 'Setup projektu', short: 'dane wejściowe' },
  { step: 1, route: '#/inventory', name: 'Inwentaryzacja', short: 'jak jest' },
  { step: 2, route: '#/analysis', name: 'Analiza dostępności', short: 'gdzie są luki' },
  { step: 3, route: '#/cards', name: 'Karty punktów', short: 'co zrobić' },
  { step: 4, route: '#/roadmap', name: 'Roadmapa', short: 'kiedy i za ile' },
  { step: 5, route: '#/report', name: 'Raport', short: 'dla decydenta' },
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
      class: 'btn btn--sm btn--ghost topbar__undo',
      disabled: enabled ? null : '',
      onclick: undoLast,
      title: enabled ? `Cofnij: ${undoLabel()} (Ctrl+Z)` : 'Nie ma czego cofnąć',
    },
    '↩ Cofnij'
  );
}

function topbar() {
  const project = state.project;
  return h(
    'header',
    { class: 'topbar' },
    h(
      'button',
      { class: 'topbar__brand', onclick: () => navigate('#/'), title: 'Wróć do pulpitu' },
      h('span', {
        class: 'topbar__mark',
        html: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 2 5 14h6l-1 8 9-12h-6z" fill="#4CAF7D"/></svg>',
      }),
      h('span', { html: '<b>SINECCO</b> · AED Planner' })
    ),
    undoButton(),
    project
      ? h('span', {
          class: 'topbar__project',
          html: `Projekt: <strong>${project.label || project.name}</strong>`,
        })
      : null,
    h('span', { class: 'topbar__spacer' }),
    h('span', { class: 'topbar__project', text: OPERATOR }),
    h(
      'div',
      { class: 'topbar__actions' },
      h(
        'button',
        {
          class: 'btn btn--sm btn--primary',
          onclick: () => navigate('#/report'),
          title: 'Przejdź do raportu i wygeneruj PDF',
        },
        'PDF'
      )
    )
  );
}

function stepper(activeStep) {
  const done = new Set(state.project?.stepsDone || []);
  return h(
    'nav',
    { class: 'stepper', 'aria-label': 'Kroki audytu' },
    ...STEPS.map((s) =>
      h(
        'button',
        {
          class: `stepper__item${s.step === activeStep ? ' is-active' : ''}${
            done.has(s.step) && s.step !== activeStep ? ' is-done' : ''
          }`,
          onclick: () => navigate(s.route),
        },
        h('span', { class: 'stepper__circle', text: done.has(s.step) && s.step !== activeStep ? '✓' : String(s.step) }),
        h('span', { class: 'stepper__label', html: `${s.name}<small>${s.short}</small>` })
      )
    ),
    h('div', { class: 'stepper__sep' }),
    h(
      'button',
      { class: 'stepper__item', onclick: () => navigate('#/') },
      h('span', { class: 'stepper__circle', text: '⌂' }),
      h('span', { class: 'stepper__label', html: 'Pulpit<small>wszystkie projekty</small>' })
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
      html: `${stepLabel}${meta.title || ''}${meta.subtitle ? ` <em>— „${meta.subtitle}”</em>` : ''}`,
    }),
    subbarMeta,
    h('span', { class: 'subbar__spacer' }),
    subbarControls
  );

  clear(root);
  root.appendChild(topbar());
  root.appendChild(subbar);
  root.appendChild(
    h('div', { class: 'layout' }, meta.hideStepper ? null : stepper(meta.step), workspace)
  );

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
    toast('Widok nie wczytał się poprawnie — szczegóły w konsoli.');
  }
}

function topbarIf(meta) {
  return meta.showTopbar === false ? h('div') : topbar();
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
