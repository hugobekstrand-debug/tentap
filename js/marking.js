/**
 * marking.js — markeringsläget: rita rektanglar runt uppgifter och facit.
 *
 * Koordinater: varje region lagras normaliserad (0–1) mot sidans viewport
 * vid skala 1 (rotation inräknad): { sida, x, y, w, h }. Därför är de
 * oberoende av zoom och skärmstorlek.
 *
 * Pek-konflikten (rita vs skrolla/zooma) löses med två lägen:
 *  - Skrolla: touch-action pan-x pan-y → en finger skrollar nativt.
 *  - Markera: touch-action none → en finger ritar.
 *  - Två fingrar: alltid egen pinch-zoom/panorering (avbryter ritning).
 *  - En VALD rektangel och dess handtag har alltid touch-action none,
 *    så de kan flyttas/ändras i båda lägena.
 *  - Dator: Markera är standard (musen ritar, hjulet skrollar). Håll
 *    Mellanslag för tillfälligt Skrolla-läge (dra för att panorera).
 *
 * Ångra/gör om: ögonblicksbilder av tentans uppgiftslista före varje
 * ändring. Allt sparas direkt till IndexedDB.
 */

import * as db from './db.js';
import { renderPage, regionImage, regionSizePt, deviceScale } from './pdf.js';
import { markingSummary } from './stats.js';
import {
  h,
  icon,
  navigate,
  mq,
  toast,
  openDialog,
  openMenu,
  promptDialog,
  attachZoomGestures,
  isTypingTarget,
  announce,
  plural,
} from './ui.js';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const TASK = 'regions';
const SOL = 'solutionRegions';
const MIN_REGION = 0.01; // minsta storlek (normaliserad) vid ändring
const MIN_DRAW_PX = 12; // mindre än så räknas som ett tryck, inte en ruta

const clone = (x) => structuredClone(x);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export async function renderMarking(root, examId) {
  const exam = await db.getExam(examId);
  if (!exam) {
    root.append(notFound());
    return { destroy() {} };
  }

  /* ------------------------------------------------------------------ */
  /* Tillstånd                                                          */
  /* ------------------------------------------------------------------ */

  const S = {
    tasks: await db.listTasks(examId),
    zoom: 1,
    mode: mq.coarse() ? 'scroll' : 'mark',
    tempScroll: false,
    sel: null, // { taskId, kind, index }
    pending: null, // { region, el } — nyritad ruta som väntar på panelen
    append: null, // { taskId, kind } — nästa ruta läggs till befintlig uppgift
    undo: [],
    redo: [],
    listOpen: false,
  };
  let destroyed = false;
  const maxPageW = Math.max(...exam.sidor.map((s) => s.w));

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */

  const view = h('div', { class: 'view view-marking' });

  const iconBtn = (name, label, onclick, extra = {}) =>
    h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': label, title: label, onclick, ...extra }, icon(name));

  const undoBtn = iconBtn('undo', 'Ångra (Ctrl+Z)', () => undo());
  const redoBtn = iconBtn('redo', 'Gör om (Ctrl+Shift+Z)', () => redo());
  const summaryEl = h('p', { class: 'topbar-sub' });
  const titleEl = h('h1', { class: 'topbar-title', tabindex: '-1' }, exam.namn);

  const topbar = h(
    'header',
    { class: 'topbar' },
    iconBtn('back', 'Tillbaka till biblioteket', () => navigate('#/')),
    h('div', { class: 'topbar-text' }, titleEl, summaryEl),
    h(
      'div',
      { class: 'topbar-actions' },
      undoBtn,
      redoBtn,
      h(
        'button',
        { type: 'button', class: 'btn btn-primary btn-done', onclick: () => finish() },
        h('span', { class: 'only-wide' }, 'Klar med markering'),
        h('span', { class: 'only-narrow' }, 'Klar'),
      ),
    ),
  );

  const segScroll = h(
    'button',
    { type: 'button', class: 'seg-btn', title: 'Skrolla (håll Mellanslag)', onclick: () => setMode('scroll') },
    icon('move', { size: 18 }),
    h('span', null, 'Skrolla'),
  );
  const segMark = h(
    'button',
    { type: 'button', class: 'seg-btn', title: 'Markera: dra en ruta', onclick: () => setMode('mark') },
    icon('marquee', { size: 18 }),
    h('span', null, 'Markera'),
  );
  const zoomLabel = h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-sm zoom-label', title: 'Anpassa till bredd', onclick: () => setZoom(1) },
    '100 %',
  );
  const pageInd = h('span', { class: 'page-indicator' }, `Sida 1 av ${exam.antalSidor}`);
  const listCount = h('span', { class: 'count-badge' }, '0');
  const listBtn = h(
    'button',
    { type: 'button', class: 'btn btn-secondary list-toggle', 'aria-expanded': 'false', onclick: () => (S.listOpen ? closeList() : openList()) },
    icon('list', { size: 18 }),
    h('span', null, 'Uppgifter'),
    listCount,
  );

  const toolbar = h(
    'div',
    { class: 'mark-toolbar', role: 'toolbar', 'aria-label': 'Verktyg för markering' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Läge' }, segScroll, segMark),
    h(
      'div',
      { class: 'zoom-group', role: 'group', 'aria-label': 'Zoom' },
      iconBtn('minus', 'Zooma ut', () => setZoom(S.zoom / 1.25)),
      zoomLabel,
      iconBtn('plus', 'Zooma in', () => setZoom(S.zoom * 1.25)),
      iconBtn('fit', 'Anpassa till bredd', () => setZoom(1), { class: 'btn-icon btn-quiet only-wide' }),
    ),
    pageInd,
    listBtn,
  );

  const hintText = h('span', { class: 'mark-hint-text' });
  const hintAction = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', onclick: () => cancelAppend() }, 'Avbryt');
  const hint = h('div', { class: 'mark-hint', role: 'status', hidden: true }, icon('info', { size: 18 }), hintText, hintAction);

  const pagesEl = h('div', { class: 'pdf-pages' });
  const scroller = h('div', { class: 'pdf-scroller', tabindex: '0', 'aria-label': 'PDF-sidor' }, pagesEl);
  const pagePill = h('div', { class: 'page-pill', 'aria-hidden': 'true' });
  const main = h('div', { class: 'mark-main' }, scroller, pagePill);

  const listEl = h('ol', { class: 'task-list' });
  const listSummary = h('p', { class: 'sidebar-sub' });
  const sidebarTitle = h('h2', { class: 'sidebar-title', tabindex: '-1', id: 'mark-list-title' }, 'Uppgifter');
  const sidebar = h(
    'aside',
    { class: 'mark-sidebar', 'aria-labelledby': 'mark-list-title' },
    h(
      'div',
      { class: 'sidebar-head' },
      h('div', null, sidebarTitle, listSummary),
      h('button', { type: 'button', class: 'btn-icon btn-quiet only-narrow', 'aria-label': 'Stäng listan', onclick: () => closeList() }, icon('close')),
    ),
    listEl,
  );
  const sheetBackdrop = h('div', { class: 'sheet-backdrop', hidden: true, onclick: () => closeList() });

  const panel = h('div', { class: 'region-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'panel-title', hidden: true });

  view.append(topbar, toolbar, hint, main, sidebar, sheetBackdrop);
  root.append(view);

  /* ------------------------------------------------------------------ */
  /* Sidor: layout och lazy rendering                                   */
  /* ------------------------------------------------------------------ */

  const pages = exam.sidor.map((size, i) => {
    const num = i + 1;
    const canvas = h('canvas', { class: 'page-canvas', 'aria-hidden': 'true' });
    const overlay = h('div', { class: 'page-overlay' });
    const skeleton = h('div', { class: 'page-skeleton' }, h('span', null, `Sida ${num}`));
    const el = h('div', { class: 'page', dataset: { page: String(num) }, role: 'group', 'aria-label': `Sida ${num}` }, skeleton, canvas, overlay);
    return { num, size, el, canvas, overlay, skeleton, cssWidth: 0, renderedWidth: 0, ctrl: null, near: false };
  });
  const pageByEl = new Map(pages.map((p) => [p.el, p]));
  pagesEl.append(...pages.map((p) => p.el));

  function fitWidth() {
    const pad = mq.narrow() ? 12 : 24;
    return Math.max(200, scroller.clientWidth - pad * 2);
  }

  function layout() {
    const fw = fitWidth();
    for (const p of pages) {
      const w = Math.round(fw * S.zoom * (p.size.w / maxPageW));
      p.cssWidth = w;
      p.el.style.width = `${w}px`;
      p.el.style.height = `${Math.round((w * p.size.h) / p.size.w)}px`;
    }
    zoomLabel.textContent = `${Math.round(S.zoom * 100)} %`;
    scheduleRender();
    positionPanel();
  }

  /** Zoomar och behåller punkten under (fx, fy) på samma ställe. */
  function setZoom(z, fx, fy) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(z - S.zoom) < 0.001) return;
    const sr = scroller.getBoundingClientRect();
    fx ??= sr.left + sr.width / 2;
    fy ??= sr.top + sr.height / 2;
    const before = pagesEl.getBoundingClientRect();
    const relX = (fx - before.left) / before.width;
    const relY = (fy - before.top) / before.height;
    S.zoom = z;
    layout();
    const after = pagesEl.getBoundingClientRect();
    scroller.scrollLeft += after.left + relX * after.width - fx;
    scroller.scrollTop += after.top + relY * after.height - fy;
  }

  let renderTimer = 0;
  let rendering = 0;
  function scheduleRender(delay = 120) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(pump, delay);
  }
  function pump() {
    if (destroyed) return;
    const sr = scroller.getBoundingClientRect();
    const cy = sr.top + sr.height / 2;
    const needs = pages
      .filter((p) => p.near && !p.ctrl && p.renderedWidth !== p.cssWidth)
      .sort((a, b) => {
        const ra = a.el.getBoundingClientRect();
        const rb = b.el.getBoundingClientRect();
        return Math.abs(ra.top + ra.height / 2 - cy) - Math.abs(rb.top + rb.height / 2 - cy);
      });
    while (rendering < 2 && needs.length) renderOne(needs.shift());
  }
  async function renderOne(p) {
    rendering++;
    const ctrl = new AbortController();
    p.ctrl = ctrl;
    const w = p.cssWidth;
    try {
      const ok = await renderPage(exam.id, p.num, p.canvas, w, ctrl.signal);
      if (ok && !ctrl.signal.aborted) {
        p.renderedWidth = w;
        p.el.classList.add('is-rendered');
        p.el.classList.remove('has-error');
      }
    } catch (err) {
      console.error(err);
      if (!ctrl.signal.aborted) {
        p.renderedWidth = w; // försök inte om och om igen
        p.el.classList.add('has-error');
        p.skeleton.firstChild.textContent = err?.message
          ? `Sida ${p.num} kunde inte visas. ${err.message}`
          : `Sida ${p.num} kunde inte visas.`;
      }
    } finally {
      rendering--;
      if (p.ctrl === ctrl) p.ctrl = null;
      if (!destroyed) pump();
    }
  }
  function releasePage(p) {
    p.ctrl?.abort();
    p.ctrl = null;
    if (p.renderedWidth) {
      p.canvas.width = 0;
      p.canvas.height = 0;
      p.renderedWidth = 0;
      p.el.classList.remove('is-rendered');
    }
  }

  const nearIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = pageByEl.get(e.target);
        if (p) p.near = e.isIntersecting;
      }
      scheduleRender(40);
    },
    { root: scroller, rootMargin: '700px 0px' },
  );
  const farIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (!e.isIntersecting) releasePage(pageByEl.get(e.target));
    },
    { root: scroller, rootMargin: '2500px 0px' },
  );
  for (const p of pages) {
    nearIO.observe(p.el);
    farIO.observe(p.el);
  }

  let pageRaf = 0;
  function updatePageIndicator() {
    pageRaf = 0;
    const sr = scroller.getBoundingClientRect();
    const y = sr.top + sr.height * 0.4;
    let cur = 1;
    for (const p of pages) {
      if (p.el.getBoundingClientRect().top <= y) cur = p.num;
      else break;
    }
    const text = `Sida ${cur} av ${exam.antalSidor}`;
    if (pageInd.textContent !== text) {
      pageInd.textContent = text;
      pagePill.textContent = text;
    }
  }
  scroller.addEventListener(
    'scroll',
    () => {
      if (!pageRaf) pageRaf = requestAnimationFrame(updatePageIndicator);
      pagePill.classList.add('is-visible');
      clearTimeout(pillTimer);
      pillTimer = setTimeout(() => pagePill.classList.remove('is-visible'), 900);
    },
    { passive: true },
  );
  let pillTimer = 0;

  const ro = new ResizeObserver(() => {
    const frac = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    layout();
    scroller.scrollTop = frac * scroller.scrollHeight;
    syncSidebarMode();
  });
  ro.observe(scroller);

  const detachZoom = attachZoomGestures(scroller, {
    getZoom: () => S.zoom,
    setZoom: (z, x, y) => setZoom(z, x, y),
    preview: pagesEl,
    min: MIN_ZOOM,
    max: MAX_ZOOM,
    onPinchStart: () => cancelDrag(),
  });

  /* ------------------------------------------------------------------ */
  /* Läge                                                                */
  /* ------------------------------------------------------------------ */

  const effectiveMode = () => (S.tempScroll ? 'scroll' : S.mode);

  function applyMode() {
    const m = effectiveMode();
    view.dataset.mode = m;
    segScroll.setAttribute('aria-pressed', String(S.mode === 'scroll'));
    segMark.setAttribute('aria-pressed', String(S.mode === 'mark'));
    updateHint();
  }
  function setMode(m) {
    S.mode = m;
    applyMode();
  }

  /* ------------------------------------------------------------------ */
  /* Hjälpare för regioner                                              */
  /* ------------------------------------------------------------------ */

  const taskById = (id) => S.tasks.find((t) => t.id === id);
  const selRegion = () => {
    if (!S.sel) return null;
    return taskById(S.sel.taskId)?.[S.sel.kind]?.[S.sel.index] || null;
  };
  const docPos = (r) => r.sida - 1 + r.y;
  const taskPos = (t) => (t.regions[0] ? docPos(t.regions[0]) : Infinity);
  const pct = (n) => `${(n * 100).toFixed(4)}%`;

  function normPoint(clientX, clientY, pageEl) {
    const r = pageEl.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  }

  function renumber() {
    S.tasks.forEach((t, i) => (t.ordning = i));
  }

  /** Uppgiften som ligger närmast före positionen i dokumentet. */
  function taskBefore(pos) {
    let best = null;
    for (const t of S.tasks) {
      const tp = taskPos(t);
      if (tp <= pos && (!best || tp >= taskPos(best))) best = t;
    }
    return best;
  }

  function suggestLabel(prev) {
    const base = prev?.etikett || S.tasks[S.tasks.length - 1]?.etikett;
    if (!base) return 'Problem 1';
    const m = base.match(/^(.*?)(\d+)([a-z])?$/i);
    if (!m) return `Problem ${S.tasks.length + 1}`;
    if (m[3]) {
      const next = String.fromCharCode(m[3].charCodeAt(0) + 1);
      return /[a-z]/i.test(next) ? `${m[1]}${m[2]}${next}` : `${m[1]}${parseInt(m[2], 10) + 1}`;
    }
    return `${m[1]}${parseInt(m[2], 10) + 1}`;
  }

  /* ------------------------------------------------------------------ */
  /* Ändringar, ångra/gör om, spara                                      */
  /* ------------------------------------------------------------------ */

  let saveChain = Promise.resolve();
  function save() {
    const snapshot = clone(S.tasks);
    saveChain = saveChain
      .then(() => db.replaceExamTasks(exam.id, snapshot))
      .catch((err) => {
        console.error(err);
        toast(
          err instanceof db.StorageFullError
            ? err.message
            : 'Ändringen kunde inte sparas. Ladda om sidan och försök igen.',
          { tone: 'error', duration: 8000 },
        );
      });
    return saveChain;
  }

  function pushUndo(label, before) {
    S.undo.push({ label, tasks: before });
    if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
  }

  /** Kör fn som ändrar S.tasks, med ångra-punkt och direkt sparande. */
  function mutate(label, fn) {
    const before = clone(S.tasks);
    fn();
    pushUndo(label, before);
    refreshAll();
    save();
    return S.undo[S.undo.length - 1];
  }

  /** Toast med "Ångra" som bara ångrar just den här ändringen. */
  function undoToast(message, entry) {
    toast(message, {
      actionLabel: 'Ångra',
      onAction: () => {
        if (S.undo[S.undo.length - 1] === entry) undo();
      },
    });
  }

  function undo() {
    if (!S.undo.length) return;
    const e = S.undo.pop();
    S.redo.push({ label: e.label, tasks: clone(S.tasks) });
    S.tasks = e.tasks;
    afterHistory(`Ångrade: ${e.label}`);
  }
  function redo() {
    if (!S.redo.length) return;
    const e = S.redo.pop();
    S.undo.push({ label: e.label, tasks: clone(S.tasks) });
    S.tasks = e.tasks;
    afterHistory(`Gjorde om: ${e.label}`);
  }
  function afterHistory(msg) {
    cancelPending();
    S.append = null;
    if (!selRegion()) S.sel = null;
    refreshAll();
    if (S.sel) openEditPanel();
    else closePanel();
    save();
    announce(msg);
  }

  function refreshAll() {
    renderRegions();
    renderList();
    summaryEl.textContent = markingSummary(S.tasks);
    listSummary.textContent = markingSummary(S.tasks);
    listCount.textContent = String(S.tasks.length);
    listBtn.setAttribute('aria-label', `Uppgifter (${S.tasks.length})`);
    undoBtn.disabled = !S.undo.length;
    redoBtn.disabled = !S.redo.length;
    updateHint();
  }

  /* ------------------------------------------------------------------ */
  /* Rendera markeringar                                                 */
  /* ------------------------------------------------------------------ */

  function regionLabel(t, kind, i) {
    const n = t[kind].length;
    const part = n > 1 ? ` (${i + 1}/${n})` : '';
    if (kind === SOL) return `Facit · ${t.etikett}${part}`;
    return `${t.etikett}${part}${t.poang ? ` · ${t.poang} p` : ''}`;
  }

  function renderRegions() {
    for (const p of pages) p.overlay.querySelectorAll('.region:not(.region--draft)').forEach((n) => n.remove());
    for (const t of S.tasks) {
      for (const kind of [TASK, SOL]) {
        t[kind].forEach((r, i) => {
          if (r.pdf === 'facit') return; // ligger i den separata facit-PDF:en, inte på de här sidorna
          const p = pages[r.sida - 1];
          if (!p) return;
          const selected = !!S.sel && S.sel.taskId === t.id && S.sel.kind === kind && S.sel.index === i;
          const label = regionLabel(t, kind, i);
          const el = h(
            'div',
            {
              class: `region region--${kind === TASK ? 'task' : 'facit'}${selected ? ' is-selected' : ''}`,
              style: { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) },
              tabindex: '0',
              role: 'button',
              'aria-label': `${label}${selected ? ' (vald)' : ''}`,
              'aria-pressed': String(selected),
              dataset: { taskId: t.id, kind, index: String(i) },
            },
            h('span', { class: 'region-label' }, kind === SOL ? icon('check', { size: 12 }) : null, label),
          );
          if (selected) {
            for (const c of ['nw', 'ne', 'sw', 'se']) {
              el.append(h('span', { class: `handle handle--${c}`, dataset: { corner: c }, 'aria-hidden': 'true' }));
            }
          }
          p.overlay.append(el);
        });
      }
    }
  }

  function selectedEl() {
    return pagesEl.querySelector('.region.is-selected');
  }

  function select(taskId, kind, index, { scroll = false } = {}) {
    cancelPending();
    S.sel = { taskId, kind, index };
    renderRegions();
    renderList();
    if (scroll) scrollToRegion(selRegion());
    openEditPanel();
  }

  function deselect() {
    if (!S.sel) return;
    S.sel = null;
    renderRegions();
    renderList();
    closePanel();
  }

  function scrollToRegion(r) {
    if (!r) return;
    const p = pages[r.sida - 1];
    const top = p.el.offsetTop + r.y * p.el.offsetHeight - 48;
    const left = p.el.offsetLeft + r.x * p.el.offsetWidth - 24;
    scroller.scrollTo({
      top: Math.max(0, top),
      left: Math.max(0, left),
      behavior: mq.reducedMotion() ? 'auto' : 'smooth',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Pekare: rita, flytta, ändra storlek, panorera                       */
  /* ------------------------------------------------------------------ */

  let drag = null;
  const touches = new Set();
  let lastPointer = null;
  let autoRaf = 0;

  function onPointerDown(e) {
    if (e.pointerType === 'touch') {
      touches.add(e.pointerId);
      if (touches.size > 1) {
        cancelDrag();
        return;
      }
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.region-panel')) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const p = pageByEl.get(pageEl);
    const handle = e.target.closest('.handle');
    const regionEl = e.target.closest('.region:not(.region--draft)');
    const mode = effectiveMode();

    if (handle && S.sel) {
      beginEdit(e, p, 'resize', handle.dataset.corner);
    } else if (regionEl && regionEl.classList.contains('is-selected') && !(S.tempScroll && e.pointerType === 'mouse')) {
      beginEdit(e, p, 'move');
    } else if (regionEl) {
      drag = { type: 'tap', pointerId: e.pointerId, regionEl, x: e.clientX, y: e.clientY, p, mode };
    } else if (mode === 'mark') {
      e.preventDefault();
      beginDraw(e, p, e.clientX, e.clientY);
    } else if (e.pointerType === 'mouse') {
      e.preventDefault();
      drag = { type: 'pan', pointerId: e.pointerId, x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop };
      pagesEl.setPointerCapture(e.pointerId);
      view.classList.add('is-panning');
    } else {
      drag = { type: 'tap-empty', pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }

  function beginDraw(e, p, clientX, clientY) {
    cancelPending();
    if (S.sel) deselect();
    const start = normPoint(clientX, clientY, p.el);
    const el = h('div', { class: 'region region--draft' });
    p.overlay.append(el);
    drag = { type: 'draw', pointerId: e.pointerId, p, x0: clamp(start.x, 0, 1), y0: clamp(start.y, 0, 1), rect: null, el };
    try {
      pagesEl.setPointerCapture(e.pointerId);
    } catch {
      /* pekaren kan redan vara släppt */
    }
    lastPointer = { x: clientX, y: clientY };
    startAutoScroll();
  }

  function beginEdit(e, p, type, corner = null) {
    const r = selRegion();
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const start = normPoint(e.clientX, e.clientY, p.el);
    drag = {
      type,
      corner,
      pointerId: e.pointerId,
      p,
      start,
      orig: { ...r },
      before: clone(S.tasks),
      moved: false,
    };
    pagesEl.setPointerCapture(e.pointerId);
    lastPointer = { x: e.clientX, y: e.clientY };
    startAutoScroll();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    applyDrag(e.clientX, e.clientY);
  }

  function applyDrag(clientX, clientY) {
    switch (drag.type) {
      case 'tap': {
        if (Math.hypot(clientX - drag.x, clientY - drag.y) > 6) {
          if (drag.mode === 'mark') {
            const { p, x, y, pointerId } = drag;
            beginDraw({ pointerId }, p, x, y);
            applyDrag(clientX, clientY);
          } else {
            drag = null;
          }
        }
        break;
      }
      case 'tap-empty':
        if (Math.hypot(clientX - drag.x, clientY - drag.y) > 6) drag = null;
        break;
      case 'draw': {
        const pt = normPoint(clientX, clientY, drag.p.el);
        const x = clamp(pt.x, 0, 1);
        const y = clamp(pt.y, 0, 1);
        const rect = {
          x: Math.min(drag.x0, x),
          y: Math.min(drag.y0, y),
          w: Math.abs(x - drag.x0),
          h: Math.abs(y - drag.y0),
        };
        drag.rect = rect;
        Object.assign(drag.el.style, { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) });
        break;
      }
      case 'move':
      case 'resize': {
        const pt = normPoint(clientX, clientY, drag.p.el);
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        const o = drag.orig;
        let { x, y, w, h: hh } = o;
        if (drag.type === 'move') {
          x = clamp(o.x + dx, 0, 1 - o.w);
          y = clamp(o.y + dy, 0, 1 - o.h);
        } else {
          let x1 = o.x;
          let y1 = o.y;
          let x2 = o.x + o.w;
          let y2 = o.y + o.h;
          if (drag.corner.includes('w')) x1 = clamp(o.x + dx, 0, x2 - MIN_REGION);
          else x2 = clamp(o.x + o.w + dx, x1 + MIN_REGION, 1);
          if (drag.corner.includes('n')) y1 = clamp(o.y + dy, 0, y2 - MIN_REGION);
          else y2 = clamp(o.y + o.h + dy, y1 + MIN_REGION, 1);
          x = x1;
          y = y1;
          w = x2 - x1;
          hh = y2 - y1;
        }
        const r = selRegion();
        if (!r) return;
        Object.assign(r, { x, y, w, h: hh });
        drag.moved = true;
        const el = selectedEl();
        if (el) Object.assign(el.style, { left: pct(x), top: pct(y), width: pct(w), height: pct(hh) });
        break;
      }
      case 'pan':
        scroller.scrollLeft = drag.sl - (clientX - drag.x);
        scroller.scrollTop = drag.st - (clientY - drag.y);
        break;
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    view.classList.remove('is-panning');
    switch (d.type) {
      case 'tap': {
        const { taskId, kind, index } = d.regionEl.dataset;
        select(taskId, kind, Number(index));
        break;
      }
      case 'tap-empty':
        if (S.pending) cancelPending();
        else deselect();
        break;
      case 'draw':
        finishDraw(d);
        break;
      case 'move':
      case 'resize':
        if (d.moved && JSON.stringify(d.orig) !== JSON.stringify(selRegion())) {
          pushUndo(d.type === 'move' ? 'Flytta område' : 'Ändra storlek', d.before);
          refreshAll();
          save();
        }
        positionPanel();
        break;
    }
  }

  function onPointerCancel(e) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (drag && e.pointerId === drag.pointerId) cancelDrag();
  }

  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    view.classList.remove('is-panning');
    if (d.type === 'draw') d.el.remove();
    if ((d.type === 'move' || d.type === 'resize') && d.moved) {
      S.tasks = d.before;
      renderRegions();
    }
  }

  function startAutoScroll() {
    if (!autoRaf) autoRaf = requestAnimationFrame(autoScrollTick);
  }
  function autoScrollTick() {
    autoRaf = 0;
    if (!drag || !['draw', 'move', 'resize'].includes(drag.type) || !lastPointer) return;
    const r = scroller.getBoundingClientRect();
    const edge = 48;
    let dy = 0;
    if (lastPointer.y < r.top + edge) dy = -(r.top + edge - lastPointer.y) / 3;
    else if (lastPointer.y > r.bottom - edge) dy = (lastPointer.y - (r.bottom - edge)) / 3;
    if (dy) {
      scroller.scrollTop += dy;
      applyDrag(lastPointer.x, lastPointer.y);
    }
    autoRaf = requestAnimationFrame(autoScrollTick);
  }

  pagesEl.addEventListener('pointerdown', onPointerDown);
  pagesEl.addEventListener('pointermove', onPointerMove);
  pagesEl.addEventListener('pointerup', onPointerUp);
  pagesEl.addEventListener('pointercancel', onPointerCancel);
  pagesEl.addEventListener('lostpointercapture', (e) => {
    if (drag && e.pointerId === drag.pointerId && drag.type !== 'tap' && drag.type !== 'tap-empty') onPointerUp(e);
  });
  pagesEl.addEventListener('keydown', (e) => {
    const regionEl = e.target.closest?.('.region:not(.region--draft)');
    if (regionEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const { taskId, kind, index } = regionEl.dataset;
      select(taskId, kind, Number(index));
    }
  });
  // Hindra iOS långtrycksmeny och textmarkering när man ritar.
  pagesEl.addEventListener('contextmenu', (e) => {
    if (effectiveMode() === 'mark') e.preventDefault();
  });

  function finishDraw(d) {
    const r = d.rect;
    const wpx = r ? r.w * d.p.el.clientWidth : 0;
    const hpx = r ? r.h * d.p.el.clientHeight : 0;
    if (!r || wpx < MIN_DRAW_PX || hpx < MIN_DRAW_PX) {
      d.el.remove();
      if (S.sel) deselect();
      return;
    }
    const region = db.normalizeRegion({ sida: d.p.num, ...r }, exam.antalSidor);
    if (!region) {
      d.el.remove();
      return;
    }
    if (S.append) {
      d.el.remove();
      const { taskId, kind } = S.append;
      S.append = null;
      const t = taskById(taskId);
      if (!t) return;
      const entry = mutate(kind === TASK ? 'Lägg till område' : 'Lägg till facit', () => {
        t[kind].push(region);
        S.sel = { taskId, kind, index: t[kind].length - 1 };
      });
      openEditPanel();
      undoToast(kind === TASK ? `Område tillagt i ${t.etikett}` : `Facit tillagt till ${t.etikett}`, entry);
      return;
    }
    S.pending = { region, el: d.el };
    d.el.classList.add('is-pending');
    openNewPanel();
  }

  function cancelPending() {
    if (!S.pending) return;
    S.pending.el.remove();
    S.pending = null;
    closePanel();
  }

  function startAppend(taskId, kind) {
    cancelPending();
    S.sel = null;
    S.append = { taskId, kind };
    closePanel();
    closeList();
    renderRegions();
    renderList();
    setMode('mark');
  }

  function cancelAppend() {
    if (!S.append) return;
    S.append = null;
    updateHint();
  }

  /* ------------------------------------------------------------------ */
  /* Panel för ny/vald markering                                         */
  /* ------------------------------------------------------------------ */

  function closePanel() {
    if (panel.hidden) return;
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    panel.replaceChildren();
    panel.remove();
    if (hadFocus) scroller.focus({ preventScroll: true });
  }

  function mountPanel() {
    panel.hidden = false;
    if (mq.narrow()) {
      if (panel.parentNode !== view) view.append(panel);
    } else if (panel.parentNode !== pagesEl) {
      pagesEl.append(panel);
    }
    positionPanel();
    revealPanel();
  }

  /**
   * Skrolla så att rutan man redigerar syns – på mobil ovanför bottom
   * sheeten, på dator tillsammans med den flytande panelen.
   */
  function revealPanel() {
    const anchor = S.pending?.el || selectedEl();
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const visibleTop = sr.top + 12;
    let bottom;
    let visibleBottom;
    if (mq.narrow()) {
      bottom = a.bottom;
      visibleBottom = Math.min(sr.bottom, pr.top) - 12;
    } else {
      bottom = Math.max(a.bottom, pr.bottom);
      visibleBottom = sr.bottom - 12;
    }
    const top = Math.min(a.top, mq.narrow() ? a.top : pr.top);
    if (bottom > visibleBottom) {
      // Skrolla ned, men aldrig så långt att rutans överkant försvinner.
      scroller.scrollTop += Math.max(0, Math.min(bottom - visibleBottom, top - visibleTop));
    } else if (top < visibleTop) {
      scroller.scrollTop -= visibleTop - top;
    }
  }

  function positionPanel() {
    if (panel.hidden) return;
    if (mq.narrow()) {
      panel.classList.add('as-sheet');
      if (panel.parentNode !== view) view.append(panel);
      panel.style.left = '';
      panel.style.top = '';
      adjustForKeyboard();
      return;
    }
    panel.classList.remove('as-sheet');
    panel.style.bottom = '';
    if (panel.parentNode !== pagesEl) pagesEl.append(panel);
    const anchor = S.pending?.el || selectedEl();
    if (!anchor) return;
    const pr = pagesEl.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const W = pagesEl.offsetWidth;
    let left = r.right - pr.left + 12;
    let top = r.top - pr.top;
    if (left + pw > W - 8) {
      left = r.left - pr.left - pw - 12;
      if (left < 8) {
        left = clamp(r.left - pr.left, 8, Math.max(8, W - pw - 8));
        top = r.bottom - pr.top + 12;
      }
    }
    top = clamp(top, 8, Math.max(8, pagesEl.offsetHeight - ph - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** På mobil: lyft bottom sheet över tangentbordet. */
  function adjustForKeyboard() {
    const vv = window.visualViewport;
    if (!vv || !panel.classList.contains('as-sheet')) return;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    panel.style.bottom = covered ? `${covered}px` : '';
  }
  window.visualViewport?.addEventListener('resize', adjustForKeyboard);

  function panelHead(title, sub) {
    return h(
      'div',
      { class: 'panel-head' },
      h('div', null, h('h2', { class: 'panel-title', id: 'panel-title', tabindex: '-1' }, title), sub ? h('p', { class: 'panel-sub' }, sub) : null),
      h(
        'button',
        {
          type: 'button',
          class: 'btn-icon btn-quiet',
          'aria-label': 'Stäng',
          onclick: () => (S.pending ? cancelPending() : deselect()),
        },
        icon('close'),
      ),
    );
  }

  function field(label, input, hintText) {
    const id = `f-${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hintText ? h('p', { class: 'field-hint' }, hintText) : null);
  }

  function taskOptions(selectedId) {
    return S.tasks.map((t) =>
      h(
        'option',
        { value: t.id, selected: t.id === selectedId || null },
        `${t.etikett}${t.solutionRegions.length ? ' (har facit)' : ''}`,
      ),
    );
  }

  function openNewPanel() {
    const region = S.pending.region;
    const pos = docPos(region);
    const prev = taskBefore(pos);
    const anySolutions = S.tasks.some((t) => t.solutionRegions.length);
    let kind = S.tasks.length && anySolutions && prev && !prev.solutionRegions.length ? SOL : TASK;

    const labelInput = h('input', { class: 'input', type: 'text', value: suggestLabel(prev), maxlength: '120', autocomplete: 'off', enterkeyhint: 'done' });
    const pointsInput = h('input', {
      class: 'input input-short',
      type: 'text',
      inputmode: 'decimal',
      maxlength: '6',
      autocomplete: 'off',
      placeholder: '–',
      enterkeyhint: 'done',
    });
    const taskSelect = h('select', { class: 'input' }, taskOptions((prev || S.tasks[S.tasks.length - 1])?.id));
    const error = h('p', { class: 'field-error', hidden: true, 'aria-live': 'polite' });

    const taskFields = h('div', { class: 'panel-fields' }, field('Etikett', labelInput), field('Poäng', pointsInput, 'Valfritt'));
    const solFields = h('div', { class: 'panel-fields' }, field('Facit till', taskSelect));

    const btnTask = h('button', { type: 'button', class: 'seg-btn', onclick: () => setKind(TASK) }, 'Uppgift');
    const btnSol = h(
      'button',
      { type: 'button', class: 'seg-btn', onclick: () => setKind(SOL), disabled: !S.tasks.length || null, title: S.tasks.length ? null : 'Markera en uppgift först' },
      'Facit',
    );
    const kindSeg = h('div', { class: 'seg seg-block', role: 'group', 'aria-label': 'Typ av markering' }, btnTask, btnSol);

    function setKind(k) {
      kind = k;
      btnTask.setAttribute('aria-pressed', String(k === TASK));
      btnSol.setAttribute('aria-pressed', String(k === SOL));
      taskFields.hidden = k !== TASK;
      solFields.hidden = k !== SOL;
      S.pending?.el.classList.toggle('is-facit', k === SOL);
      error.hidden = true;
    }

    const form = h(
      'form',
      { class: 'panel-form', novalidate: true },
      panelHead('Ny markering', `Sida ${region.sida}`),
      kindSeg,
      taskFields,
      solFields,
      !S.tasks.length ? h('p', { class: 'field-hint' }, 'Markera uppgiften först, sedan dess facit.') : null,
      error,
      h(
        'div',
        { class: 'panel-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => cancelPending() }, 'Avbryt'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Spara'),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!S.pending) return;
      if (kind === TASK) {
        const etikett = labelInput.value.trim();
        const rawPoints = pointsInput.value.trim();
        const poang = db.normalizePoang(rawPoints);
        if (!etikett) return showError('Skriv en etikett, t.ex. "Problem 3".', labelInput);
        if (rawPoints && poang === null) return showError('Poäng ska vara ett tal, t.ex. 3 eller 1,5. Lämna tomt om du inte vet.', pointsInput);
        createTask(etikett, poang, S.pending.region);
      } else {
        const t = taskById(taskSelect.value);
        if (!t) return showError('Välj vilken uppgift facit hör till.', taskSelect);
        const reg = S.pending.region;
        S.pending.el.remove();
        S.pending = null;
        mutate('Lägg till facit', () => t.solutionRegions.push(reg));
        closePanel();
        announce(`Facit sparat till ${t.etikett}`);
      }
    });
    function showError(msg, input) {
      error.textContent = msg;
      error.hidden = false;
      input.focus();
    }
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelPending();
      }
    });

    panel.replaceChildren(form);
    setKind(kind);
    mountPanel();
    if (!mq.coarse()) {
      const f = kind === TASK ? labelInput : taskSelect;
      f.focus({ preventScroll: true });
      if (f === labelInput) labelInput.select();
    } else {
      panel.querySelector('.panel-title').focus({ preventScroll: true });
    }
  }

  function createTask(etikett, poang, region) {
    S.pending.el.remove();
    S.pending = null;
    mutate('Ny uppgift', () => {
      const t = db.normalizeTask({
        id: db.uid(),
        examId: exam.id,
        etikett,
        poang,
        ordning: 0,
        regions: [region],
        solutionRegions: [],
      });
      const pos = docPos(region);
      let idx = S.tasks.findIndex((x) => taskPos(x) > pos);
      if (idx === -1) idx = S.tasks.length;
      S.tasks.splice(idx, 0, t);
      renumber();
    });
    closePanel();
    announce(`${etikett} sparad`);
  }

  function openEditPanel() {
    const t = S.sel && taskById(S.sel.taskId);
    const r = selRegion();
    if (!t || !r) {
      closePanel();
      return;
    }
    const { kind, index } = S.sel;
    const isTask = kind === TASK;
    const children = [];
    children.push(
      panelHead(
        isTask ? t.etikett : `Facit · ${t.etikett}`,
        `${isTask ? 'Uppgift' : 'Facit'} · område ${index + 1} av ${t[kind].length} · sida ${r.sida}`,
      ),
    );

    if (isTask) {
      const labelInput = h('input', { class: 'input', type: 'text', value: t.etikett, maxlength: '120', autocomplete: 'off', enterkeyhint: 'done' });
      const pointsInput = h('input', {
        class: 'input input-short',
        type: 'text',
        inputmode: 'decimal',
        maxlength: '6',
        value: t.poang ?? '',
        placeholder: '–',
        autocomplete: 'off',
        enterkeyhint: 'done',
      });
      const error = h('p', { class: 'field-error', hidden: true, 'aria-live': 'polite' });
      const commitLabel = () => {
        const v = labelInput.value.trim();
        if (!v) {
          labelInput.value = t.etikett;
          return;
        }
        if (v !== t.etikett) {
          const id = t.id;
          mutate('Byt etikett', () => (taskById(id).etikett = v));
          refreshPanelHead();
        }
      };
      const commitPoints = () => {
        const raw = pointsInput.value.trim();
        const v = db.normalizePoang(raw);
        if (raw && v === null) {
          error.textContent = 'Poäng ska vara ett tal, t.ex. 3 eller 1,5.';
          error.hidden = false;
          return;
        }
        error.hidden = true;
        if (v !== t.poang) {
          const id = t.id;
          mutate('Ändra poäng', () => (taskById(id).poang = v));
        }
      };
      labelInput.addEventListener('change', commitLabel);
      pointsInput.addEventListener('change', commitPoints);
      for (const inp of [labelInput, pointsInput]) {
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            inp.blur();
          }
        });
      }
      children.push(h('div', { class: 'panel-fields panel-fields--row' }, field('Etikett', labelInput), field('Poäng', pointsInput)), error);
      children.push(
        h(
          'p',
          { class: 'panel-facit-status' },
          t.solutionRegions.length
            ? [icon('check', { size: 16 }), `Facit kopplat (${plural(t.solutionRegions.length, 'område', 'områden')})`]
            : [icon('info', { size: 16 }), 'Inget facit kopplat'],
        ),
      );
    } else {
      const sel = h('select', { class: 'input' }, taskOptions(t.id));
      sel.addEventListener('change', () => {
        const target = taskById(sel.value);
        if (!target || target.id === t.id) return;
        const moved = { ...r };
        mutate('Koppla facit', () => {
          const src = taskById(t.id);
          src.solutionRegions.splice(index, 1);
          const dst = taskById(target.id);
          dst.solutionRegions.push(moved);
          S.sel = { taskId: dst.id, kind: SOL, index: dst.solutionRegions.length - 1 };
        });
        openEditPanel();
        announce(`Facit kopplat till ${target.etikett}`);
      });
      children.push(h('div', { class: 'panel-fields' }, field('Facit till', sel)));
    }

    const lastTaskRegion = isTask && t.regions.length === 1;
    children.push(
      h(
        'div',
        { class: 'panel-links' },
        h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => startAppend(t.id, TASK) }, icon('squarePlus', { size: 18 }), 'Lägg till område'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => startAppend(t.id, SOL) }, icon('link', { size: 18 }), isTask && !t.solutionRegions.length ? 'Markera facit' : 'Lägg till facitområde'),
        h(
          'button',
          { type: 'button', class: 'btn btn-quiet btn-sm btn-danger-text', onclick: () => deleteSelectedRegion() },
          icon('trash', { size: 18 }),
          lastTaskRegion ? 'Ta bort uppgiften' : 'Ta bort området',
        ),
        !lastTaskRegion && isTask
          ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-danger-text', onclick: () => deleteTask(t.id) }, icon('trash', { size: 18 }), 'Ta bort hela uppgiften')
          : null,
      ),
      h('div', { class: 'panel-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => deselect() }, 'Klar')),
    );

    const wrap = h('div', { class: 'panel-form' }, children);
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        deselect();
      }
    });
    const hadFocus = panel.contains(document.activeElement);
    panel.replaceChildren(wrap);
    mountPanel();
    if (hadFocus || !mq.coarse()) panel.querySelector('.panel-title').focus({ preventScroll: true });
  }

  function refreshPanelHead() {
    const t = S.sel && taskById(S.sel.taskId);
    const title = panel.querySelector('.panel-title');
    if (t && title) title.textContent = S.sel.kind === TASK ? t.etikett : `Facit · ${t.etikett}`;
  }

  function deleteSelectedRegion() {
    if (!S.sel) return;
    const { taskId, kind, index } = S.sel;
    const t = taskById(taskId);
    if (!t) return;
    if (kind === TASK && t.regions.length === 1) {
      deleteTask(taskId);
      return;
    }
    const entry = mutate('Ta bort område', () => {
      taskById(taskId)[kind].splice(index, 1);
      S.sel = null;
    });
    closePanel();
    undoToast(kind === SOL ? 'Facitområdet är borttaget' : 'Området är borttaget', entry);
  }

  function deleteTask(taskId) {
    const t = taskById(taskId);
    if (!t) return;
    const label = t.etikett;
    const entry = mutate('Ta bort uppgift', () => {
      S.tasks = S.tasks.filter((x) => x.id !== taskId);
      renumber();
      if (S.sel?.taskId === taskId) S.sel = null;
    });
    if (!S.sel) closePanel();
    undoToast(`${label} är borttagen`, entry);
  }

  /* ------------------------------------------------------------------ */
  /* Sidopanel: lista över uppgifter                                     */
  /* ------------------------------------------------------------------ */

  function renderList() {
    const focusKey = document.activeElement?.dataset?.focusKey;
    listEl.replaceChildren();
    if (!S.tasks.length) {
      listEl.append(
        h(
          'li',
          { class: 'task-list-empty' },
          h('p', null, 'Inga uppgifter markerade än.'),
          h('p', { class: 'muted' }, 'Välj Markera och dra en ruta runt första uppgiften. Gör sedan samma sak med facit, om det finns.'),
        ),
      );
      return;
    }
    S.tasks.forEach((t, i) => listEl.append(listItem(t, i)));
    if (focusKey) listEl.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function listItem(t, i) {
    const active = S.sel?.taskId === t.id;
    const img = h('img', { alt: '', decoding: 'async', class: 'thumb-img' });
    const thumb = h('span', { class: 'thumb', 'aria-hidden': 'true' }, img);
    loadThumb(t, img, thumb);

    const facit = t.solutionRegions.length
      ? h('span', { class: 'chip chip--facit' }, icon('check', { size: 12 }), 'Facit')
      : h('span', { class: 'chip chip--muted' }, 'Inget facit');
    const meta = [t.poang ? `${t.poang} p` : 'Inga poäng', t.regions.length > 1 ? `${t.regions.length} områden` : null].filter(Boolean).join(' · ');

    const grip = h(
      'button',
      { type: 'button', class: 'grip', 'aria-label': `Flytta ${t.etikett}. Använd pilknapparna för att ändra ordning.`, title: 'Dra för att ändra ordning', tabindex: '-1' },
      icon('grip', { size: 18 }),
    );
    grip.addEventListener('pointerdown', (e) => startListDrag(e, i));

    const more = h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': `Fler val för ${t.etikett}`, 'data-focus-key': `more-${t.id}` }, icon('more'));
    more.addEventListener('click', () =>
      openMenu(more, [
        { label: 'Flytta upp', icon: 'chevronUp', disabled: i === 0, onSelect: () => move(i, i - 1) },
        { label: 'Flytta ned', icon: 'chevronDown', disabled: i === S.tasks.length - 1, onSelect: () => move(i, i + 1) },
        { separator: true },
        { label: 'Byt etikett', icon: 'edit', onSelect: () => renameTask(t.id) },
        { label: 'Ändra poäng', icon: 'edit', onSelect: () => changePoints(t.id) },
        { label: 'Lägg till område', icon: 'squarePlus', onSelect: () => startAppend(t.id, TASK) },
        { label: t.solutionRegions.length ? 'Lägg till facitområde' : 'Markera facit', icon: 'link', onSelect: () => startAppend(t.id, SOL) },
        { separator: true },
        { label: 'Ta bort uppgiften', icon: 'trash', danger: true, onSelect: () => deleteTask(t.id) },
      ], { label: `Val för ${t.etikett}` }),
    );

    return h(
      'li',
      { class: `task-item${active ? ' is-active' : ''}`, dataset: { id: t.id } },
      grip,
      h(
        'button',
        {
          type: 'button',
          class: 'task-item-main',
          'data-focus-key': `main-${t.id}`,
          onclick: () => {
            closeList();
            select(t.id, TASK, 0, { scroll: true });
          },
        },
        thumb,
        h('span', { class: 'task-item-text' }, h('span', { class: 'task-item-label' }, t.etikett), h('span', { class: 'task-item-meta' }, meta), facit),
      ),
      h(
        'span',
        { class: 'task-item-order only-wide' },
        h('button', { type: 'button', class: 'btn-icon btn-quiet btn-icon-sm', 'aria-label': `Flytta upp ${t.etikett}`, 'data-focus-key': `up-${t.id}`, disabled: i === 0 || null, onclick: () => move(i, i - 1, `up-${t.id}`) }, icon('chevronUp', { size: 18 })),
        h('button', { type: 'button', class: 'btn-icon btn-quiet btn-icon-sm', 'aria-label': `Flytta ned ${t.etikett}`, 'data-focus-key': `down-${t.id}`, disabled: i === S.tasks.length - 1 || null, onclick: () => move(i, i + 1, `down-${t.id}`) }, icon('chevronDown', { size: 18 })),
      ),
      more,
    );
  }

  async function loadThumb(t, img, thumb) {
    const r = t.regions[0];
    if (!r) return;
    const size = regionSizePt(r, exam);
    const pxPerPt = Math.max(0.15, (72 * deviceScale()) / Math.max(1, size.w));
    try {
      const res = await regionImage(exam.id, r, pxPerPt);
      img.src = res.url;
      thumb.classList.add('is-loaded');
    } catch {
      thumb.classList.add('has-error');
    }
  }

  function move(from, to, focusKey) {
    if (to < 0 || to >= S.tasks.length || from === to) return;
    const id = S.tasks[from].id;
    mutate('Ändra ordning', () => {
      const [t] = S.tasks.splice(from, 1);
      S.tasks.splice(to, 0, t);
      renumber();
    });
    const key = focusKey ? focusKey.replace(/^(up|down)-.*/, (m, dir) => `${dir}-${id}`) : `main-${id}`;
    const el = listEl.querySelector(`[data-focus-key="${key}"]`);
    (el && !el.disabled ? el : listEl.querySelector(`[data-focus-key="main-${id}"]`))?.focus({ preventScroll: true });
    announce(`Flyttad till plats ${to + 1} av ${S.tasks.length}`);
  }

  async function renameTask(id) {
    const t = taskById(id);
    if (!t) return;
    const v = await promptDialog({ title: 'Byt etikett', label: 'Etikett', value: t.etikett });
    if (!v || v === t.etikett) return;
    mutate('Byt etikett', () => (taskById(id).etikett = v));
    if (S.sel?.taskId === id) openEditPanel();
  }

  async function changePoints(id) {
    const t = taskById(id);
    if (!t) return;
    const v = await promptDialog({ title: 'Ändra poäng', label: 'Poäng', value: t.poang ?? '', hint: 'Till exempel 3 eller 1,5. Skriv 0 för att ta bort poängen.' });
    if (v === null) return;
    const p = v === '0' ? null : db.normalizePoang(v);
    if (v !== '0' && p === null) {
      toast('Poäng ska vara ett tal, t.ex. 3 eller 1,5.', { tone: 'error' });
      return;
    }
    mutate('Ändra poäng', () => (taskById(id).poang = p));
    if (S.sel?.taskId === id) openEditPanel();
  }

  /** Dra och släpp i listan (pekare). */
  function startListDrag(e, index) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const items = [...listEl.children];
    const rects = items.map((x) => x.getBoundingClientRect());
    const li = items[index];
    const step = rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height;
    let target = index;
    li.classList.add('is-dragging');
    const onMove = (ev) => {
      const dy = ev.clientY - e.clientY;
      li.style.transform = `translateY(${dy}px)`;
      const center = rects[index].top + rects[index].height / 2 + dy;
      target = 0;
      for (let j = 0; j < rects.length; j++) {
        if (j === index) continue;
        if (center > rects[j].top + rects[j].height / 2) target = j < index ? j + 1 : j;
      }
      if (center < rects[0].top + rects[0].height / 2) target = 0;
      items.forEach((it, j) => {
        if (j === index) return;
        let shift = 0;
        if (index < j && j <= target) shift = -step;
        else if (target <= j && j < index) shift = step;
        it.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      items.forEach((it) => (it.style.transform = ''));
      li.classList.remove('is-dragging');
      if (target !== index) move(index, target);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  }

  /* ---------- Listan som bottom sheet på mobil ---------- */

  function syncSidebarMode() {
    const narrow = mq.narrow();
    if (!narrow) {
      sidebar.inert = false;
      sidebar.classList.remove('is-open');
      sheetBackdrop.hidden = true;
      S.listOpen = false;
      listBtn.setAttribute('aria-expanded', 'false');
    } else {
      sidebar.inert = !S.listOpen;
    }
  }
  function openList() {
    if (!mq.narrow()) {
      sidebarTitle.focus();
      return;
    }
    S.listOpen = true;
    sidebar.classList.add('is-open');
    sidebar.inert = false;
    sheetBackdrop.hidden = false;
    listBtn.setAttribute('aria-expanded', 'true');
    sidebarTitle.focus({ preventScroll: true });
  }
  function closeList() {
    if (!S.listOpen) return;
    S.listOpen = false;
    sidebar.classList.remove('is-open');
    sheetBackdrop.hidden = true;
    sidebar.inert = mq.narrow();
    listBtn.setAttribute('aria-expanded', 'false');
    if (sidebar.contains(document.activeElement)) listBtn.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* Tips/hint och avslut                                               */
  /* ------------------------------------------------------------------ */

  function updateHint() {
    if (S.append) {
      const t = taskById(S.append.taskId);
      hintText.textContent = t
        ? S.append.kind === SOL
          ? `Dra en ruta runt facit till ${t.etikett}.`
          : `Dra en ruta runt nästa del av ${t.etikett}.`
        : '';
      hintAction.hidden = false;
      hint.hidden = false;
    } else if (!S.tasks.length) {
      hintText.textContent =
        effectiveMode() === 'mark'
          ? 'Dra en ruta runt första uppgiften.'
          : 'Välj Markera och dra sedan en ruta runt första uppgiften.';
      hintAction.hidden = true;
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  async function finish() {
    cancelPending();
    deselect();
    if (!S.tasks.length) {
      toast('Markera minst en uppgift först: välj Markera och dra en ruta runt uppgiften.');
      return;
    }
    await saveChain;
    const noFacit = S.tasks.filter((t) => !t.solutionRegions.length).length;
    const { result } = openDialog({
      title: 'Markeringen är klar',
      content: [
        h('p', { class: 'dialog-lead' }, markingSummary(S.tasks)),
        h(
          'p',
          { class: 'muted' },
          noFacit
            ? `${plural(noFacit, 'uppgift saknar', 'uppgifter saknar')} facit. Det går bra – de visas utan facit när du pluggar.`
            : 'Alla uppgifter har facit kopplat.',
        ),
        h('p', { class: 'muted' }, 'Du kan alltid komma tillbaka och ändra markeringarna.'),
      ],
      buttons: [
        { label: 'Fortsätt markera', value: null, variant: 'secondary' },
        { label: 'Plugga nu', value: 'study', variant: 'primary' },
      ],
    });
    if ((await result) === 'study') navigate(`#/plugga/${exam.id}`);
  }

  /* ------------------------------------------------------------------ */
  /* Tangentbord                                                         */
  /* ------------------------------------------------------------------ */

  function onKeyDown(e) {
    if (document.querySelector('dialog[open], .menu')) return;
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === ' ' && !e.target.closest?.('button, [role="button"], a')) {
      e.preventDefault();
      if (!S.tempScroll) {
        S.tempScroll = true;
        applyMode();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (S.pending) cancelPending();
      else if (S.append) cancelAppend();
      else if (S.sel) deselect();
      else if (S.listOpen) closeList();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
      e.preventDefault();
      deleteSelectedRegion();
      return;
    }
    if (e.key === '+' || e.key === '=') setZoom(S.zoom * 1.25);
    else if (e.key === '-') setZoom(S.zoom / 1.25);
    else if (e.key === '0') setZoom(1);
  }
  function onKeyUp(e) {
    if (e.key === ' ' && S.tempScroll) {
      S.tempScroll = false;
      applyMode();
    }
  }
  function onBlur() {
    if (S.tempScroll) {
      S.tempScroll = false;
      applyMode();
    }
  }
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  applyMode();
  layout();
  refreshAll();
  syncSidebarMode();
  updatePageIndicator();
  titleEl.focus({ preventScroll: true });

  return {
    destroy() {
      destroyed = true;
      clearTimeout(renderTimer);
      cancelAnimationFrame(autoRaf);
      nearIO.disconnect();
      farIO.disconnect();
      ro.disconnect();
      detachZoom();
      pages.forEach(releasePage);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.visualViewport?.removeEventListener('resize', adjustForKeyboard);
      panel.remove();
    },
  };
}

function notFound() {
  return h(
    'div',
    { class: 'view view-empty' },
    h(
      'div',
      { class: 'empty-state' },
      h('h1', { tabindex: '-1' }, 'Tentan hittades inte'),
      h('p', null, 'Den kan ha tagits bort, eller så finns den på en annan enhet.'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate('#/') }, 'Till biblioteket'),
    ),
  );
}
