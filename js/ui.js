/**
 * ui.js — gemensamma UI-byggstenar: DOM-hjälpare, ikoner, format,
 * toasts, dialoger, menyer, banners och zoomgester.
 *
 * Allt är vanilla JS. Dialoger använder <dialog> + showModal(), vilket ger
 * fokusfälla och Esc-stängning från webbläsaren.
 */

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Skapa ett element. props: class, style (objekt), dataset, on* (lyssnare),
 * html (innerHTML, bara för betrodda strängar), övrigt blir attribut.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export const mq = {
  narrow: () => matchMedia('(max-width: 699px)').matches,
  coarse: () => matchMedia('(pointer: coarse)').matches,
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
};

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function anyDialogOpen() {
  return !!document.querySelector('dialog[open], .menu');
}

/** Läs upp text för skärmläsare (artigt). */
export function announce(text) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

/* ------------------------------------------------------------------ */
/* Ikoner (inline SVG, 24×24, linjestil)                               */
/* ------------------------------------------------------------------ */

const P = {
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  skip: '<path d="m6 6 6 6-6 6"/><path d="m13 6 6 6-6 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.6 3.6"/><path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  move: '<path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  marquee: '<path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M11 4h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 11v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M13 20h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M4 13v-2"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  squarePlus: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 16h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  merge: '<path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6"/><path d="M18 3v6a6 6 0 0 1-6 6"/>',
  split: '<path d="M3 12h18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

/** Returnerar ett <svg>-element. label ger aria-label, annars aria-hidden. */
export function icon(name, { size = 20, label = null, cls = '' } = {}) {
  const t = document.createElement('template');
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  t.innerHTML =
    `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ` +
    `focusable="false" ${a11y}>${P[name] || ''}</svg>`;
  return t.content.firstChild;
}

/** Appens symbol: orange rundad kvadrat med en vit bock som delvis bildar en cirkel. */
export function logo(size = 28) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="15" class="logo-bg"/>
    <path d="M45.4 26.8A17 17 0 1 1 37.2 18.6M22.5 34.5 29.5 41.5 50 17" class="logo-mark"/>
  </svg>`;
  return t.content.firstChild;
}

/** Symbol + ordmärket "Tentaplugget". */
export function brand(size = 32) {
  return h('span', { class: 'brand' }, logo(size), h('span', { class: 'brand-name' }, 'Tentaplugget'));
}

/**
 * Stor progressring med count-up. Returnerar { el, set(pct, label) }.
 * Animeras från föregående värde (eller 0) till nytt; respekterar
 * prefers-reduced-motion.
 */
export function progressRing({ size = 200, stroke = 14, label = 'Progress' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ring-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"/>
    <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
  const svg = t.content.firstChild;
  const fill = svg.querySelector('.ring-fill');
  const num = h('span', { class: 'ring-num' }, '0 %');
  const sub = h('span', { class: 'ring-sub' });
  const el = h(
    'div',
    { class: 'ring', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-live': 'polite' },
    svg,
    h('span', { class: 'ring-center' }, num, sub),
  );
  let shown = 0;
  let raf = 0;
  return {
    el,
    /** Visa ett värde direkt, utan animation (t.ex. det som visades förra gången). */
    jump(pct) {
      shown = pct;
      fill.style.strokeDashoffset = String(c * (1 - pct / 100));
      num.textContent = `${Math.round(pct)} %`;
    },
    set(pct, subText = '', valueText = '') {
      cancelAnimationFrame(raf);
      el.setAttribute('aria-valuenow', String(pct));
      if (valueText) el.setAttribute('aria-valuetext', valueText);
      sub.textContent = subText;
      const draw = (v) => {
        fill.style.strokeDashoffset = String(c * (1 - v / 100));
        num.textContent = `${Math.round(v)} %`;
      };
      const from = shown;
      shown = pct;
      if (mq.reducedMotion() || from === pct) {
        draw(pct);
        return;
      }
      const start = performance.now();
      const dur = 900;
      const step = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        draw(from + (pct - from) * e);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    },
  };
}

/**
 * Steg-indikator ("Läser tentan → Hittar uppgifter → …"). Ikon + text, så
 * att färg aldrig bär status ensam.
 * @param {Array<{id:string,label:string}>} steps
 * @param {string|null} currentId aktuellt steg ("done" = allt klart)
 */
export function stepper(steps, currentId, { label = 'Förlopp' } = {}) {
  const idx = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const allDone = currentId === steps[steps.length - 1].id;
  return h(
    'ol',
    { class: 'stepper', 'aria-label': label },
    steps.map((s, i) => {
      const state = allDone || i < idx ? 'done' : i === idx ? 'active' : 'todo';
      return h(
        'li',
        { class: `stepper-item is-${state}`, 'aria-current': state === 'active' ? 'step' : null },
        icon(state === 'done' ? 'check' : state === 'active' ? 'spinner' : 'dot', {
          size: 16,
          cls: state === 'active' ? 'spin' : '',
        }),
        h('span', null, s.label),
        state === 'done' ? h('span', { class: 'visually-hidden' }, ' (klart)') : null,
      );
    }),
  );
}

/**
 * Bricka ("Säker", "Behöver koll", "Klar", "Svår", "Premium"). Alltid ikon +
 * text när den bär status, så att färg aldrig är ensam bärare.
 * @param {'neutral'|'ok'|'warn'|'hard'|'premium'|'error'} tone
 */
export function badge(text, { tone = 'neutral', iconName = null } = {}) {
  return h('span', { class: `badge badge--${tone}` }, iconName ? icon(iconName, { size: 14 }) : null, h('span', null, text));
}

/**
 * Tomvy: ikon, rubrik, förklaring och handlingar.
 * actions: [{label, variant, onClick, iconName}]
 */
export function emptyState({ iconName = 'info', title, text, actions = [], tone = 'neutral', headingLevel = 'h1' }) {
  return h(
    'div',
    { class: 'view view-empty' },
    h(
      'div',
      { class: `empty-state empty-state--${tone}` },
      h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 28 })),
      h(headingLevel, { tabindex: '-1' }, title),
      text ? (Array.isArray(text) ? text.map((t) => h('p', null, t)) : h('p', null, text)) : null,
      actions.length
        ? h(
            'div',
            { class: 'empty-actions' },
            actions.map((a) =>
              h('button', { type: 'button', class: `btn btn-${a.variant || 'secondary'}`, onclick: a.onClick }, a.iconName ? icon(a.iconName, { size: 18 }) : null, a.label),
            ),
          )
        : null,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Format (svenska)                                                    */
/* ------------------------------------------------------------------ */

const nf = new Intl.NumberFormat('sv-SE');
const nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
const dtf = new Intl.DateTimeFormat('sv-SE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const fmtNum = (n) => nf.format(n);
export const fmtDate = (iso) => (iso ? df.format(new Date(iso)) : '');
export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : '');

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024 * 1024) return `${nf.format(Math.max(1, Math.round(bytes / 1024)))} kB`;
  if (bytes < 1024 ** 3) return `${nf1.format(bytes / 1024 ** 2)} MB`;
  return `${nf1.format(bytes / 1024 ** 3)} GB`;
}

export function daysSince(iso, now = new Date()) {
  if (!iso) return Infinity;
  const a = new Date(iso);
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - start) / 86_400_000);
}

export function relativeDays(iso) {
  const d = daysSince(iso);
  if (d === Infinity) return 'aldrig';
  if (d <= 0) return 'idag';
  if (d === 1) return 'igår';
  return `för ${d} dagar sedan`;
}

export const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let currentToast = null;

/**
 * Visar en kort toast. Med actionLabel/onAction blir det t.ex. "Ångra".
 * Bara en toast åt gången; en ny ersätter den gamla.
 */
export function toast(message, { actionLabel = null, onAction = null, duration = 5000, tone = 'neutral' } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return { dismiss() {} };
  currentToast?.dismiss(true);

  let timer = null;
  let remaining = duration;
  let started = 0;
  let gone = false;

  const el = h(
    'div',
    { class: `toast toast--${tone}` },
    tone === 'ok' ? icon('check', { size: 18, cls: 'toast-icon' }) : null,
    tone === 'hard' ? icon('flag', { size: 18, cls: 'toast-icon' }) : null,
    tone === 'error' ? icon('alert', { size: 18, cls: 'toast-icon' }) : null,
    tone === 'milestone' ? icon('sparkles', { size: 18, cls: 'toast-icon' }) : null,
    h('span', { class: 'toast-msg' }, message),
  );
  if (actionLabel && onAction) {
    el.append(
      h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          onclick: () => {
            api.dismiss();
            onAction();
          },
        },
        actionLabel,
      ),
    );
  }
  el.append(
    h(
      'button',
      { type: 'button', class: 'toast-close', 'aria-label': 'Stäng meddelandet', onclick: () => api.dismiss() },
      icon('close', { size: 16 }),
    ),
  );

  const start = () => {
    started = Date.now();
    timer = setTimeout(() => api.dismiss(), remaining);
  };
  const pause = () => {
    clearTimeout(timer);
    remaining -= Date.now() - started;
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', start);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', start);

  const api = {
    dismiss(immediate = false) {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      if (currentToast === api) currentToast = null;
      if (immediate || mq.reducedMotion()) el.remove();
      else {
        el.classList.add('is-leaving');
        setTimeout(() => el.remove(), 200);
      }
    },
  };
  root.append(el);
  currentToast = api;
  start();
  return api;
}

/* ------------------------------------------------------------------ */
/* Dialoger                                                            */
/* ------------------------------------------------------------------ */

let dialogSeq = 0;

/**
 * Generisk modal dialog. buttons: [{label, value, variant, onClick(close)}]
 * Resolvar med knappens value, eller null vid Esc/stäng.
 */
export function openDialog({ title, content, buttons = [], className = '', dismissible = true, initialFocus = null }) {
  const prevFocus = document.activeElement;
  const id = `dlg-title-${++dialogSeq}`;
  let returnValue = null;
  let resolveFn;
  const result = new Promise((r) => (resolveFn = r));

  const dlg = h('dialog', { class: `dialog ${className}`, 'aria-labelledby': id });
  const close = (value = null) => {
    returnValue = value;
    if (dlg.open) dlg.close();
  };

  const header = h(
    'div',
    { class: 'dialog-head' },
    h('h2', { class: 'dialog-title', id }, title),
    dismissible
      ? h(
          'button',
          { type: 'button', class: 'btn-icon btn-quiet dialog-x', 'aria-label': 'Stäng', onclick: () => close(null) },
          icon('close'),
        )
      : null,
  );
  const body = h('div', { class: 'dialog-body' }, content);
  const footer = buttons.length ? h('div', { class: 'dialog-actions' }) : null;
  for (const b of buttons) {
    footer.append(
      h(
        'button',
        {
          type: b.submit ? 'submit' : 'button',
          class: `btn btn-${b.variant || 'secondary'}`,
          'data-autofocus': b.autofocus ? '' : null,
          onclick: (e) => {
            if (b.submit) return; // hanteras av formuläret
            e.preventDefault();
            if (b.onClick) b.onClick(close);
            else close(b.value ?? null);
          },
        },
        b.label,
      ),
    );
  }
  const inner = h('div', { class: 'dialog-inner' }, header, body, footer);
  dlg.append(inner);

  dlg.addEventListener('cancel', (e) => {
    if (!dismissible) e.preventDefault();
    else returnValue = null;
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dismissible) close(null); // klick på bakgrunden
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.({ preventScroll: true });
    resolveFn(returnValue);
  });

  document.body.append(dlg);
  dlg.showModal();
  const focusEl =
    (initialFocus && dlg.querySelector(initialFocus)) ||
    dlg.querySelector('[data-autofocus]') ||
    footer?.querySelector('.btn-primary, .btn-danger, .btn-ok') ||
    dlg.querySelector('button, input, select');
  focusEl?.focus();
  return { el: dlg, body, close, result };
}

export async function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Avbryt', danger = false }) {
  const content = Array.isArray(message)
    ? message.map((m) => h('p', null, m))
    : h('p', null, message);
  const { result } = openDialog({
    title,
    content,
    buttons: [
      { label: cancelLabel, value: false, variant: 'secondary', autofocus: danger },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
  return (await result) === true;
}

export async function alertDialog({ title, message, label = 'OK' }) {
  const content = Array.isArray(message) ? message.map((m) => h('p', null, m)) : h('p', null, message);
  const { result } = openDialog({ title, content, buttons: [{ label, value: true, variant: 'primary' }] });
  await result;
}

/** Textinmatning. Resolvar med trimmad sträng eller null. */
export function promptDialog({ title, label, value = '', confirmLabel = 'Spara', maxLength = 120, hint = null }) {
  const inputId = `prompt-${++dialogSeq}`;
  const input = h('input', {
    id: inputId,
    class: 'input',
    type: 'text',
    value,
    maxlength: maxLength,
    autocomplete: 'off',
    enterkeyhint: 'done',
  });
  const error = h('p', { class: 'field-error', hidden: true, 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'field' },
    h('label', { for: inputId, class: 'label' }, label),
    input,
    hint ? h('p', { class: 'field-hint' }, hint) : null,
    error,
  );
  const dlg = openDialog({
    title,
    content: form,
    initialFocus: 'input',
    buttons: [
      { label: 'Avbryt', value: null, variant: 'secondary' },
      {
        label: confirmLabel,
        variant: 'primary',
        onClick: () => form.requestSubmit(),
      },
    ],
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) {
      error.textContent = 'Fältet kan inte vara tomt.';
      error.hidden = false;
      input.focus();
      return;
    }
    dlg.close(v);
  });
  input.select();
  return dlg.result;
}

/**
 * Val mellan flera alternativ (t.ex. Slå ihop / Ersätt vid import).
 * choices: [{value, label, description, variant}]
 */
export function choiceDialog({ title, message, choices }) {
  const list = h('div', { class: 'choice-list' });
  const content = [message ? (Array.isArray(message) ? message.map((m) => h('p', null, m)) : h('p', null, message)) : null, list];
  const dlg = openDialog({
    title,
    content,
    buttons: [{ label: 'Avbryt', value: null, variant: 'secondary' }],
  });
  for (const c of choices) {
    list.append(
      h(
        'button',
        { type: 'button', class: `choice ${c.variant ? 'choice--' + c.variant : ''}`, onclick: () => dlg.close(c.value) },
        h('span', { class: 'choice-label' }, c.label),
        c.description ? h('span', { class: 'choice-desc' }, c.description) : null,
      ),
    );
  }
  list.querySelector('button')?.focus();
  return dlg.result;
}

/** Förloppsdialog för långa operationer. */
export function progressDialog(title, text = '') {
  const bar = h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: '0%' } }));
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', title);
  const label = h('p', { class: 'progress-text', 'aria-live': 'polite' }, text);
  const dlg = openDialog({ title, content: [label, bar], dismissible: false });
  return {
    set(frac, newText) {
      const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
      bar.firstChild.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(pct));
      if (newText !== undefined) label.textContent = newText;
    },
    close() {
      dlg.close(null);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Menyer ("⋯")                                                         */
/* ------------------------------------------------------------------ */

let openMenuApi = null;

/**
 * Öppnar en meny vid anchor. items:
 *  { label, icon, onSelect, danger, disabled, badge }
 *  { label, checked:boolean, onSelect }            (kryssruta)
 *  { label, radio:true, checked, onSelect }        (radioval)
 *  { separator:true } | { heading:'Text' }
 */
export function openMenu(anchor, items, { label = 'Fler val' } = {}) {
  openMenuApi?.close(false);
  const backdrop = h('div', { class: 'menu-backdrop' });
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.heading) {
      menu.append(h('div', { class: 'menu-heading' }, it.heading));
      continue;
    }
    const isCheck = typeof it.checked === 'boolean';
    const role = isCheck ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
    const btn = h(
      'button',
      {
        type: 'button',
        role,
        class: `menu-item ${it.danger ? 'menu-item--danger' : ''}`,
        'aria-checked': isCheck ? String(it.checked) : null,
        disabled: it.disabled || null,
        tabindex: '-1',
        onclick: () => {
          api.close(true);
          it.onSelect?.();
        },
      },
      isCheck
        ? h('span', { class: 'menu-check' }, it.checked ? icon('check', { size: 18 }) : null)
        : it.icon
          ? icon(it.icon, { size: 18 })
          : null,
      h('span', { class: 'menu-label' }, it.label),
      it.badge ? badge(it.badge, { tone: 'premium' }) : null,
    );
    buttons.push(btn);
    menu.append(btn);
  }

  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close(true);
    } else if (e.key === 'Tab') {
      api.close(false);
    }
  };
  menu.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    api.close(true);
  });

  const api = {
    close(restoreFocus) {
      if (openMenuApi !== api) return;
      openMenuApi = null;
      menu.remove();
      backdrop.remove();
      window.removeEventListener('resize', onResize);
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && document.contains(anchor)) anchor.focus({ preventScroll: true });
    },
  };
  const onResize = () => api.close(false);

  document.body.append(backdrop, menu);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');

  // Placering: under ankaret, högerjusterat; uppåt om det inte får plats.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = Math.min(Math.max(8, r.right - mw), vw - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > vh - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
  top = Math.max(8, Math.min(top, vh - mh - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  window.addEventListener('resize', onResize);

  openMenuApi = api;
  (buttons.find((b) => b.getAttribute('aria-checked') === 'true') || buttons[0])?.focus();
  return api;
}

export function closeMenus() {
  openMenuApi?.close(false);
}

/* ------------------------------------------------------------------ */
/* Banners                                                             */
/* ------------------------------------------------------------------ */

/**
 * Diskret banner överst. actions: [{label, onClick, variant}].
 * Samma id ersätter befintlig banner.
 */
export function showBanner(id, { message, actions = [], tone = 'info', iconName = 'info', onDismiss = null, dismissLabel = 'Stäng' }) {
  const root = document.getElementById('banners');
  if (!root) return;
  hideBanner(id);
  const el = h(
    'div',
    { class: `banner banner--${tone}`, 'data-banner': id, role: tone === 'warning' ? 'alert' : 'status' },
    icon(iconName, { size: 18, cls: 'banner-icon' }),
    h('p', { class: 'banner-msg' }, message),
    h(
      'div',
      { class: 'banner-actions' },
      actions.map((a) =>
        h('button', { type: 'button', class: `btn btn-sm btn-${a.variant || 'quiet'}`, onclick: a.onClick }, a.label),
      ),
      onDismiss
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn-icon btn-quiet btn-icon-sm',
              'aria-label': dismissLabel,
              onclick: () => {
                hideBanner(id);
                onDismiss();
              },
            },
            icon('close', { size: 16 }),
          )
        : null,
    ),
  );
  root.append(el);
}

export function hideBanner(id) {
  document.querySelector(`#banners [data-banner="${id}"]`)?.remove();
}

/* ------------------------------------------------------------------ */
/* Zoomgester (pinch, dubbeltryck, Ctrl/⌘+scroll, Safari-gester)        */
/* ------------------------------------------------------------------ */

/**
 * Kopplar zoomgester till en scrollbar yta.
 * @param {HTMLElement} scroller  elementet som tar emot gesterna
 * @param {object} o
 *   getZoom(): number
 *   setZoom(z, clientX, clientY): void — ska behålla punkten under (x,y)
 *   preview: element som skalas med CSS under pågående pinch
 *   min, max
 *   onDoubleTap(clientX, clientY)
 *   onPinchStart()
 * @returns {() => void} avregistrering
 */
export function attachZoomGestures(scroller, o) {
  const clamp = (z) => Math.min(o.max, Math.max(o.min, z));
  let pinch = null;
  let lastTap = null;
  let tapStart = null;

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const m0 = mid(a, b);
      const r = o.preview.getBoundingClientRect();
      pinch = { d0: Math.max(10, dist(a, b)), m0, m: m0, z0: o.getZoom(), s: 1 };
      o.preview.style.transformOrigin = `${m0.x - r.left}px ${m0.y - r.top}px`;
      o.preview.style.willChange = 'transform';
      tapStart = null;
      o.onPinchStart?.();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      tapStart = { x: t.clientX, y: t.clientY, time: Date.now() };
    } else {
      tapStart = null;
    }
  }

  function onTouchMove(e) {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const s = clamp(pinch.z0 * (dist(a, b) / pinch.d0)) / pinch.z0;
      const m = mid(a, b);
      pinch.s = s;
      pinch.m = m;
      o.preview.style.transform = `translate(${m.x - pinch.m0.x}px, ${m.y - pinch.m0.y}px) scale(${s})`;
    } else if (tapStart && e.touches.length === 1) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > 10) tapStart = null;
    }
  }

  function onTouchEnd(e) {
    if (pinch && e.touches.length < 2) {
      const p = pinch;
      pinch = null;
      o.preview.style.transform = '';
      o.preview.style.transformOrigin = '';
      o.preview.style.willChange = '';
      if (Math.abs(p.s - 1) > 0.01) o.setZoom(p.z0 * p.s, p.m0.x, p.m0.y);
      scroller.scrollLeft -= p.m.x - p.m0.x;
      scroller.scrollTop -= p.m.y - p.m0.y;
      lastTap = null;
      return;
    }
    if (tapStart && e.touches.length === 0 && e.changedTouches.length === 1 && o.onDoubleTap) {
      const t = e.changedTouches[0];
      const now = Date.now();
      if (now - tapStart.time < 300) {
        if (lastTap && now - lastTap.time < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
          e.preventDefault();
          lastTap = null;
          o.onDoubleTap(t.clientX, t.clientY);
        } else {
          lastTap = { x: t.clientX, y: t.clientY, time: now };
        }
      }
    }
    tapStart = null;
  }

  // Ctrl/⌘ + hjul (inkl. pinch på styrplatta i Chrome/Firefox/Edge)
  let wheelAcc = 1;
  let wheelPoint = null;
  let wheelRaf = 0;
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 0.05 : 0.0045;
    const f = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * unit)));
    wheelAcc *= f;
    wheelPoint = { x: e.clientX, y: e.clientY };
    if (!wheelRaf) {
      wheelRaf = requestAnimationFrame(() => {
        wheelRaf = 0;
        o.setZoom(clamp(o.getZoom() * wheelAcc), wheelPoint.x, wheelPoint.y);
        wheelAcc = 1;
      });
    }
  }

  // Safari på macOS skickar gesture*-händelser för pinch på styrplatta.
  const useGestureEvents = !('ontouchstart' in window);
  let gesture = null;
  function onGestureStart(e) {
    e.preventDefault();
    if (!useGestureEvents) return;
    gesture = { z0: o.getZoom(), x: e.clientX, y: e.clientY };
  }
  function onGestureChange(e) {
    e.preventDefault();
    if (!gesture) return;
    o.setZoom(clamp(gesture.z0 * e.scale), gesture.x, gesture.y);
  }
  function onGestureEnd(e) {
    e.preventDefault();
    gesture = null;
  }

  scroller.addEventListener('touchstart', onTouchStart, { passive: true });
  scroller.addEventListener('touchmove', onTouchMove, { passive: false });
  scroller.addEventListener('touchend', onTouchEnd, { passive: false });
  scroller.addEventListener('touchcancel', onTouchEnd, { passive: false });
  scroller.addEventListener('wheel', onWheel, { passive: false });
  scroller.addEventListener('gesturestart', onGestureStart);
  scroller.addEventListener('gesturechange', onGestureChange);
  scroller.addEventListener('gestureend', onGestureEnd);

  return () => {
    scroller.removeEventListener('touchstart', onTouchStart);
    scroller.removeEventListener('touchmove', onTouchMove);
    scroller.removeEventListener('touchend', onTouchEnd);
    scroller.removeEventListener('touchcancel', onTouchEnd);
    scroller.removeEventListener('wheel', onWheel);
    scroller.removeEventListener('gesturestart', onGestureStart);
    scroller.removeEventListener('gesturechange', onGestureChange);
    scroller.removeEventListener('gestureend', onGestureEnd);
    cancelAnimationFrame(wheelRaf);
  };
}
