/**
 * ui.js – small DOM helpers shared by every view.
 *
 * Deliberately tiny: no framework, no virtual DOM. Views build markup with
 * `h()` or template strings and mount it with `mount()`.
 */

import { iconSvg } from './icons.js';

/* ------------------------------------------------------------------ *
 * DOM construction
 * ------------------------------------------------------------------ */

/** Hyperscript: h('div', {class:'x', onclick:fn}, child, 'text') */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/* ------------------------------------------------------------------ *
 * Ikony
 * ------------------------------------------------------------------ */

/**
 * Ikona z zestawu marki jako element.
 *
 * Kontur dziedziczy currentColor, więc kolor ustawia rodzic – dokładnie tak
 * jak w prototypie. Nieznana nazwa daje pusty span zamiast wyjątku: brak
 * ikony nie może wywrócić widoku.
 */
export function icon(name, size = 16, props = {}) {
  return h('span', {
    ...props,
    class: `icon${props.class ? ` ${props.class}` : ''}`,
    style: { width: `${size}px`, height: `${size}px`, ...(props.style || {}) },
    html: iconSvg(name, size),
    'aria-hidden': 'true',
  });
}

/** Ta sama ikona jako łańcuch HTML – do miejsc, które składają szablony. */
export function iconHtml(name, size = 16) {
  return `<span class="icon" style="width:${size}px;height:${size}px">${iconSvg(name, size)}</span>`;
}

/** Parse an HTML string into a single element. */
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/** Parse an HTML string into a DocumentFragment (many roots allowed). */
export function frag(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(root, ...children) {
  clear(root);
  appendAll(root, children);
  return root;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ *
 * Small presentational fragments (kept here so every view renders the
 * same shapes)
 * ------------------------------------------------------------------ */

export function barHtml(pct, variant = '') {
  const width = Math.max(0, Math.min(100, pct || 0));
  const cls = variant ? ` bar__fill--${variant}` : '';
  return `<div class="bar"><div class="bar__fill${cls}" style="width:${width}%"></div></div>`;
}

export function pillHtml(text, variant = '') {
  return `<span class="pill${variant ? ` pill--${variant}` : ''}">${escapeHtml(text)}</span>`;
}

export function dotHtml(level) {
  return `<span class="dot dot--${level}"></span>`;
}

/** Map an audit status to {level, label} used for dots and pills. */
export function statusMeta(point, completenessPct = null) {
  if (point.kind === 'proposed') {
    if (point.status === 'accepted') return { level: 'proposed', label: 'ZAAKCEPTOWANY', variant: 'phase3' };
    if (point.status === 'rejected') return { level: 'crit', label: 'ODRZUCONY', variant: 'crit' };
    return { level: 'proposed', label: 'PROPOZYCJA', variant: 'phase3' };
  }
  if (point.status === 'unverified') return { level: 'crit', label: 'NIEZWERYFIKOWANY', variant: 'crit' };
  if (completenessPct !== null && completenessPct >= 100) return { level: 'ok', label: 'ZWERYFIKOWANY', variant: 'ok' };
  if (point.status === 'verified_ok') return { level: 'ok', label: 'ZWERYFIKOWANY', variant: 'ok' };
  return { level: 'warn', label: 'BRAKI', variant: 'warn' };
}

export const PRIORITY_LABEL = { high: 'wysoki', medium: 'średni', low: 'niski' };
export const PRIORITY_VARIANT = { high: 'crit', medium: 'warn', low: '' };

export const PHOTO_ROLES = [
  { id: 'device', label: 'Urządzenie' },
  { id: 'signage_device', label: 'Oznakowanie przy AED' },
  { id: 'signage_route', label: 'Oznakowanie dojścia' },
  { id: 'mounting_spot', label: 'Miejsce montażu' },
  { id: 'power', label: 'Zasilanie' },
  { id: 'context', label: 'Otoczenie' },
];

export function photoRoleLabel(id) {
  return (PHOTO_ROLES.find((r) => r.id === id) || { label: id }).label;
}

/* ------------------------------------------------------------------ *
 * Feedback
 * ------------------------------------------------------------------ */

let toastTimer = null;

export function toast(message, ms = 2600) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const node = h('div', { class: 'toast', text: message });
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), ms);
}

/**
 * Simple modal. `body` may be an element or HTML string.
 * Resolves with true (confirm) or false (cancel/backdrop).
 */
export function modal({ title, body, confirmLabel = 'OK', cancelLabel = 'Anuluj', hideCancel = false }) {
  return new Promise((resolve) => {
    const content = typeof body === 'string' ? frag(body) : body;
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };

    const box = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal__head', text: title }),
      h('div', { class: 'modal__body' }, content),
      h(
        'div',
        { class: 'modal__foot' },
        hideCancel ? null : h('button', { class: 'btn', onclick: () => close(false) }, cancelLabel),
        h('button', { class: 'btn btn--primary', onclick: () => close(true) }, confirmLabel)
      )
    );

    const backdrop = h(
      'div',
      {
        class: 'modal-backdrop',
        onclick: (e) => {
          if (e.target === backdrop) close(false);
        },
      },
      box
    );

    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    const firstInput = box.querySelector('input, select, textarea');
    if (firstInput) firstInput.focus();
  });
}

/** Oznacza kontrolkę jako poza zakresem zamiast zostawiać ją martwą. */
export function disabledControl(node, reason = 'poza zakresem') {
  node.classList.add('is-disabled');
  node.setAttribute('disabled', '');
  node.setAttribute('data-tip', reason);
  return node;
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Serialise rows to a semicolon CSV with a UTF-8 BOM (Excel-friendly). */
export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))];
  return `﻿${lines.join('\r\n')}`;
}

export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '').trim();
  const sep = clean.includes(';') ? ';' : ',';
  const rows = clean.split(/\r?\n/).map((line) => line.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')));
  const head = rows.shift().map((hh) => hh.toLowerCase());
  return rows
    .filter((r) => r.length && r.some(Boolean))
    .map((r) => Object.fromEntries(head.map((key, i) => [key, r[i] ?? ''])));
}

/**
 * Legenda mapy jako przycisk u dołu, rozwijający się w górę.
 *
 * Wcześniej legenda była stale rozłożona i przy analizie dublowała blok
 * „jak czytać" w panelu – te same treści w dwóch miejscach. Teraz jest jedna,
 * schowana pod przyciskiem, w tym samym rogu w każdym widoku z mapą.
 *
 * @param {string} title etykieta na przycisku i nagłówek rozwinięcia
 * @param {Array<Node>} children treść legendy
 * @param {boolean} open czy rozwinięta na starcie
 */
/**
 * Przełącznik sposobu kolorowania podkładu.
 *
 * Trafia do paska nad mapą i istnieje tylko wtedy, gdy renderer ma czym
 * przełączać – render zapasowy zwraca pustą listę motywów i wtedy nie ma
 * czego pokazywać. Podmiana idzie przez konfigurację stylu, więc kadr,
 * warstwy i znaczniki zostają na miejscu.
 */
export function basemapThemeSwitch(map) {
  const themes = (map && map.basemapThemes) || [];
  if (!themes.length) return null;
  const current = map.getBasemapTheme();

  const seg = h('div', { class: 'seg seg--sm', role: 'group', 'aria-label': 'Wygląd podkładu' });
  for (const t of themes) {
    const btn = h(
      'button',
      {
        class: `seg__btn${t.id === current ? ' is-on' : ''}`,
        title: t.hint,
        onclick: () => {
          map.setBasemapTheme(t.id);
          for (const other of seg.children) other.className = 'seg__btn';
          btn.className = 'seg__btn is-on';
        },
      },
      t.label
    );
    seg.appendChild(btn);
  }
  return seg;
}

export function mapLegend(title, children, { open = false } = {}) {
  const body = h('div', { class: 'map-legend map-legend--pop' }, h('b', { text: title }), ...children.filter(Boolean));
  body.hidden = !open;

  const toggle = h(
    'button',
    {
      class: 'btn btn--sm map-legend__toggle',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => {
        const next = body.hidden;
        body.hidden = !next;
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        toggle.textContent = next ? `${title.toUpperCase()} ✕` : `${title.toUpperCase()} ▲`;
      },
    },
    open ? `${title.toUpperCase()} ✕` : `${title.toUpperCase()} ▲`
  );

  return h('div', { class: 'map-legend-wrap' }, body, toggle);
}
