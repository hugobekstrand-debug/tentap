/**
 * study.js — pluggläget (fokusläge): en uppgift i taget.
 *
 * Kö: alla uppgifter som inte är "klar". Standard är "ej_gjord" först,
 * därefter "svår". Sortering inom grupperna:
 *   blandad     – stabil pseudoslump (samma ordning mellan sessioner)
 *   kronologisk – tentornas ordning, sedan uppgifternas ordning
 *   svåra_först – som blandad, men svåra före ej gjorda
 *
 * Statusbyten är optimistiska (UI uppdateras direkt) och sparas i samma
 * transaktion som loggen. Varje statusbyte ger en toast med "Ångra".
 */

import * as db from './db.js';
import { regionImage, regionSizePt, deviceScale } from './pdf.js';
import { progress, progressLabel, stableHash } from './stats.js';
import {
  h,
  icon,
  navigate,
  mq,
  toast,
  openDialog,
  openMenu,
  confirmDialog,
  attachZoomGestures,
  isTypingTarget,
  announce,
  plural,
} from './ui.js';

const { KLAR, SVAR, EJ_GJORD } = db.STATUS;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ACTION_COOLDOWN_MS = 350; // skydd mot dubbeltryck

export async function renderStudy(root, examIdParam = null) {
  const settings = await db.getSettings();
  const allExams = await db.listExams();
  let exams;
  if (examIdParam) exams = allExams.filter((e) => e.id === examIdParam);
  else if (Array.isArray(settings.valdaTentor)) exams = allExams.filter((e) => settings.valdaTentor.includes(e.id));
  else exams = allExams;
  const examById = new Map(exams.map((e) => [e.id, e]));
  const examIndex = new Map(exams.map((e, i) => [e.id, i]));
  const tasks = (await db.listTasks()).filter((t) => examById.has(t.examId) && t.regions.length);
  const scopeKey = examIdParam ? `exam:${examIdParam}` : 'alla';

  if (!exams.length || !tasks.length) {
    root.append(emptyState(examIdParam, exams));
    return { destroy() {} };
  }

  /* ------------------------------------------------------------------ */
  /* Tillstånd                                                          */
  /* ------------------------------------------------------------------ */

  const S = {
    settings,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    queue: [],
    current: null,
    history: [],
    forward: [],
    facitOpen: false,
    zoom: 1,
    busy: false,
    lockUntil: 0,
    celebrating: false,
  };
  let destroyed = false;
  let showSeq = 0;

  /** Bildupplösning: skarpt på enheten, med marginal för zoom. */
  const stageGuess = Math.min(window.innerWidth, 1100);
  const refPageW = Math.max(...exams.map((e) => e.sidor[0]?.w || 595));
  const basePxPerPt = Math.min(6, Math.max(2.5, (Math.max(2, deviceScale()) * stageGuess * 1.5) / refPageW));

  /* ------------------------------------------------------------------ */
  /* Kö                                                                  */
  /* ------------------------------------------------------------------ */

  function comparator() {
    if (S.settings.ordning === 'kronologisk') {
      return (a, b) => examIndex.get(a.examId) - examIndex.get(b.examId) || a.ordning - b.ordning;
    }
    return (a, b) => stableHash(a.id) - stableHash(b.id);
  }

  function buildQueue() {
    const open = [...S.tasks.values()].filter((t) => t.status !== KLAR);
    const cmp = comparator();
    const notDone = open.filter((t) => t.status === EJ_GJORD).sort(cmp);
    const hard = open.filter((t) => t.status === SVAR).sort(cmp);
    return (S.settings.ordning === 'svåra_först' ? [...hard, ...notDone] : [...notDone, ...hard]).map((t) => t.id);
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  const view = h('div', { class: 'view view-study' });

  const barFill = h('div', { class: 'bar-fill' });
  const bar = h(
    'div',
    { class: 'bar study-bar-progress', role: 'progressbar', 'aria-label': 'Framsteg', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    barFill,
  );
  const progressText = h('span', { class: 'study-progress-text', 'aria-live': 'polite' });
  const helpBtn = h(
    'button',
    { type: 'button', class: 'btn-icon btn-quiet only-fine', 'aria-label': 'Kortkommandon', title: 'Kortkommandon (?)', onclick: () => showHelp() },
    icon('keyboard'),
  );
  const moreBtn = h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': 'Inställningar för pluggläget', title: 'Inställningar' }, icon('sliders'));
  moreBtn.addEventListener('click', () => openStudyMenu());

  const topbar = h(
    'header',
    { class: 'study-top' },
    h(
      'button',
      { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': 'Lämna pluggläget', title: 'Lämna (Esc)', onclick: () => navigate('#/') },
      icon('back'),
    ),
    h('div', { class: 'study-progress' }, bar, progressText),
    helpBtn,
    moreBtn,
  );

  const caption = h('p', { class: 'task-caption' });
  const sheet = h('article', { class: 'task-sheet' });
  const zoomWrap = h('div', { class: 'study-zoom' }, sheet);
  const stage = h('div', { class: 'study-stage', tabindex: '0', 'aria-label': 'Uppgift' }, caption, zoomWrap);

  const kbd = (k) => h('kbd', { class: 'kbd only-fine', 'aria-hidden': 'true' }, k);
  const prevBtn = h(
    'button',
    { type: 'button', class: 'btn btn-quiet prev-btn', 'aria-label': 'Föregående', title: 'Föregående (←)', onclick: () => prev() },
    icon('chevronLeft', { size: 18 }),
    h('span', { class: 'prev-label', 'aria-hidden': 'true' }, 'Föregående'),
  );
  const skipBtn = h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => skip() }, h('span', null, 'Hoppa över'), icon('skip', { size: 18 }), kbd('H'));
  const facitLabel = h('span', null, 'Visa facit');
  const facitBtn = h('button', { type: 'button', class: 'btn btn-secondary facit-btn', 'aria-expanded': 'false', onclick: () => toggleFacit() }, icon('eye', { size: 18 }), facitLabel, kbd('F'));
  const hardBtn = h('button', { type: 'button', class: 'btn btn-hard btn-lg', onclick: () => act('svar') }, icon('flag', { size: 20 }), h('span', null, 'Svår, kom tillbaka'), kbd('S'));
  const doneBtn = h('button', { type: 'button', class: 'btn btn-ok btn-lg', onclick: () => act('klar') }, icon('check', { size: 20 }), h('span', null, 'Klar'), kbd('K'));

  const bottom = h(
    'footer',
    { class: 'study-bar' },
    h(
      'div',
      { class: 'study-bar-inner' },
      h('div', { class: 'study-bar-secondary' }, prevBtn, facitBtn, skipBtn),
      h('div', { class: 'study-bar-primary' }, hardBtn, doneBtn),
    ),
  );

  const celebrateEl = h('section', { class: 'celebrate', hidden: true, 'aria-labelledby': 'celebrate-title' });

  view.append(topbar, stage, bottom, celebrateEl);
  root.append(view);

  /* ------------------------------------------------------------------ */
  /* Progress                                                            */
  /* ------------------------------------------------------------------ */

  function updateProgress() {
    const p = progress([...S.tasks.values()], S.settings.viktaEfterPoang);
    barFill.style.width = `${p.pct}%`;
    bar.setAttribute('aria-valuenow', String(p.pct));
    bar.setAttribute('aria-valuetext', progressLabel(p));
    bar.classList.toggle('is-done', p.allDone);
    progressText.textContent = progressLabel(p);
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Visa uppgift                                                        */
  /* ------------------------------------------------------------------ */

  let sheetMaxPt = 595;

  function baseWidth() {
    const pad = mq.narrow() ? 24 : 48;
    const avail = Math.max(240, stage.clientWidth - pad);
    return Math.min(avail, sheetMaxPt * 1.6, 1100);
  }

  function applyWidth() {
    sheet.style.width = `${Math.round(baseWidth() * S.zoom)}px`;
  }

  function setZoom(z, fx, fy) {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - S.zoom) < 0.001) return;
    const sr = stage.getBoundingClientRect();
    fx ??= sr.left + sr.width / 2;
    fy ??= sr.top + sr.height / 2;
    const before = sheet.getBoundingClientRect();
    const relX = (fx - before.left) / before.width;
    const relY = (fy - before.top) / before.height;
    S.zoom = z;
    applyWidth();
    const after = sheet.getBoundingClientRect();
    stage.scrollLeft += after.left + relX * after.width - fx;
    stage.scrollTop += after.top + relY * after.height - fy;
    stage.classList.toggle('is-zoomed', z > 1.01);
    scheduleSharpen();
  }

  /** Bygger en stapel bilder (en per region) i samma skala. */
  function imageStack(exam, regions, alt, kind) {
    const stack = h('div', { class: 'img-stack' });
    regions.forEach((r, i) => {
      const s = regionSizePt(r, exam);
      const img = h('img', { alt: i === 0 ? alt : `${alt}, del ${i + 1}`, draggable: 'false', decoding: 'async' });
      const frame = h(
        'div',
        { class: 'img-frame is-loading', style: { width: `${Math.min(100, (s.w / sheetMaxPt) * 100)}%`, aspectRatio: `${s.w} / ${s.h}` } },
        img,
      );
      frame.dataset.kind = kind;
      frame.dataset.index = String(i);
      frame.dataset.pxPerPt = String(basePxPerPt);
      stack.append(frame);
      loadInto(frame, img, exam.id, r, basePxPerPt);
    });
    return stack;
  }

  function loadInto(frame, img, examId, region, pxPerPt) {
    regionImage(examId, region, pxPerPt)
      .then((res) => {
        if (!frame.isConnected && destroyed) return;
        img.onload = () => frame.classList.remove('is-loading');
        img.width = res.width;
        img.height = res.height;
        img.src = res.url;
        frame.dataset.pxPerPt = String(pxPerPt);
      })
      .catch((err) => {
        console.error(err);
        frame.classList.remove('is-loading');
        frame.classList.add('has-error');
        frame.replaceChildren(h('p', { class: 'img-error' }, 'Bilden kunde inte visas. Ladda om sidan och försök igen.'));
      });
  }

  /** Efter zoom: rendera om i högre upplösning om det behövs. */
  let sharpenTimer = 0;
  function scheduleSharpen() {
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(sharpen, 350);
  }
  function sharpen() {
    const t = S.tasks.get(S.current);
    if (!t) return;
    const exam = examById.get(t.examId);
    const cssPerPt = sheet.clientWidth / sheetMaxPt;
    const needed = Math.min(8, cssPerPt * deviceScale() * 1.1);
    for (const frame of sheet.querySelectorAll('.img-frame:not(.has-error)')) {
      if (needed <= Number(frame.dataset.pxPerPt) * 1.05) continue;
      const list = frame.dataset.kind === 'sol' ? t.solutionRegions : t.regions;
      const r = list[Number(frame.dataset.index)];
      const img = frame.querySelector('img');
      if (r && img) loadInto(frame, img, exam.id, r, Math.round(needed * 4) / 4);
    }
  }

  let facitSection = null;

  function showTask(id) {
    const seq = ++showSeq;
    const t = S.tasks.get(id);
    if (!t) return;
    S.current = id;
    S.facitOpen = false;
    S.zoom = 1;
    stage.classList.remove('is-zoomed');
    const exam = examById.get(t.examId);
    const sizes = [...t.regions, ...t.solutionRegions].map((r) => regionSizePt(r, exam).w);
    sheetMaxPt = Math.max(...sizes, 1);

    caption.replaceChildren(
      ...[
        h('span', { class: 'task-caption-text' }, `${exam.namn} · ${t.etikett}${t.poang ? ` · ${t.poang} p` : ''}`),
        t.status === SVAR ? h('span', { class: 'chip chip--hard' }, icon('flag', { size: 14 }), 'Svår sedan tidigare') : null,
        t.status === KLAR ? h('span', { class: 'chip chip--ok' }, icon('check', { size: 14 }), 'Klar') : null,
      ].filter(Boolean),
    );

    const alt = `${t.etikett} – bild från tentan ${exam.namn}`;
    const taskImgs = imageStack(exam, t.regions, alt, 'task');
    facitSection = null;
    sheet.replaceChildren(taskImgs);
    if (t.solutionRegions.length) {
      facitSection = h(
        'section',
        { class: 'facit', hidden: true, 'aria-label': `Facit för ${t.etikett}`, id: 'facit-section' },
        h('h2', { class: 'facit-title' }, icon('check', { size: 16 }), 'Facit'),
      );
      sheet.append(facitSection);
    }
    applyWidth();
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    if (!mq.reducedMotion()) {
      sheet.classList.remove('is-entering');
      void sheet.offsetWidth;
      sheet.classList.add('is-entering');
    }

    facitBtn.hidden = false;
    facitBtn.style.visibility = t.solutionRegions.length ? '' : 'hidden';
    facitBtn.disabled = !t.solutionRegions.length;
    facitBtn.setAttribute('aria-controls', t.solutionRegions.length ? 'facit-section' : '');
    facitBtn.setAttribute('aria-expanded', 'false');
    facitLabel.textContent = 'Visa facit';
    facitBtn.firstChild.replaceWith(icon('eye', { size: 18 }));
    prevBtn.disabled = !S.history.length;

    S.lockUntil = Date.now() + ACTION_COOLDOWN_MS;
    rememberCurrent(id);
    // Förladda facit och nästa uppgift i bakgrunden.
    setTimeout(() => {
      if (seq !== showSeq || destroyed) return;
      for (const r of t.solutionRegions) regionImage(exam.id, r, basePxPerPt).catch(() => {});
      const nextId = S.queue.find((x) => x !== id);
      const nt = nextId && S.tasks.get(nextId);
      if (nt) for (const r of nt.regions) regionImage(nt.examId, r, basePxPerPt).catch(() => {});
    }, 300);
  }

  let rememberTimer = 0;
  function rememberCurrent(id) {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(async () => {
      const s = await db.getSettings();
      await db.saveSettings({ senastOppnadUppgift: { ...(s.senastOppnadUppgift || {}), [scopeKey]: id } });
    }, 500);
  }

  function toggleFacit() {
    const t = S.tasks.get(S.current);
    if (!t || !t.solutionRegions.length || !facitSection || S.celebrating) return;
    S.facitOpen = !S.facitOpen;
    if (S.facitOpen && facitSection.children.length === 1) {
      const exam = examById.get(t.examId);
      facitSection.append(imageStack(exam, t.solutionRegions, `Facit för ${t.etikett}`, 'sol'));
    }
    facitSection.hidden = !S.facitOpen;
    facitBtn.setAttribute('aria-expanded', String(S.facitOpen));
    facitLabel.textContent = S.facitOpen ? 'Dölj facit' : 'Visa facit';
    facitBtn.firstChild.replaceWith(icon(S.facitOpen ? 'eyeOff' : 'eye', { size: 18 }));
    if (S.facitOpen) {
      requestAnimationFrame(() => {
        const top = facitSection.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - 12;
        stage.scrollTo({ top, behavior: mq.reducedMotion() ? 'auto' : 'smooth' });
      });
      announce('Facit visas. Välj Klar eller Svår.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Åtgärder                                                            */
  /* ------------------------------------------------------------------ */

  const sessionSnapshot = () => ({
    queue: [...S.queue],
    history: [...S.history],
    forward: [...S.forward],
    current: S.current,
  });

  function goToQueueHead() {
    if (!S.queue.length) celebrate();
    else showTask(S.queue[0]);
  }

  async function act(kind) {
    if (S.busy || S.celebrating || !S.current || Date.now() < S.lockUntil) return;
    S.busy = true;
    const id = S.current;
    const before = structuredClone(S.tasks.get(id));
    const session = sessionSnapshot();
    const now = new Date().toISOString();
    const next = { ...before, antalForsok: before.antalForsok + 1 };
    let logEntry = null;
    if (kind === 'klar') {
      next.status = KLAR;
      if (before.status !== KLAR) {
        next.klarTidpunkt = now;
        logEntry = { taskId: id, examId: before.examId };
      }
      S.queue = S.queue.filter((x) => x !== id);
    } else {
      next.status = SVAR;
      next.klarTidpunkt = null;
      next.svarAntal = before.svarAntal + 1;
      S.queue = S.queue.filter((x) => x !== id);
      S.queue.push(id);
    }
    // Optimistiskt: uppdatera direkt.
    S.tasks.set(id, next);
    S.history.push(id);
    S.forward = [];
    updateProgress();
    goToQueueHead();

    let res;
    try {
      res = await db.saveTaskProgress(next, { addLogEntry: logEntry });
    } catch (err) {
      console.error(err);
      S.tasks.set(id, before);
      restoreSession(session);
      S.busy = false;
      toast(
        err instanceof db.StorageFullError ? err.message : 'Ändringen kunde inte sparas. Försök igen.',
        { tone: 'error', duration: 8000 },
      );
      return;
    }
    if (destroyed) return;
    S.tasks.set(id, res.task);
    S.busy = false;

    const undoSnap = { id, before, session, logId: res.log?.id || null };
    const onlyOneLeft = kind === 'svar' && S.queue.length === 1;
    const msg =
      kind === 'klar'
        ? 'Markerad som klar'
        : onlyOneLeft
          ? 'Markerad som svår. Det är den enda kvar – ta den igen när du är redo.'
          : 'Markerad som svår – den kommer tillbaka senare';
    toast(msg, {
      tone: kind === 'klar' ? 'ok' : 'hard',
      actionLabel: 'Ångra',
      onAction: () => undoAction(undoSnap),
    });
  }

  function restoreSession(s) {
    S.queue = s.queue;
    S.history = s.history;
    S.forward = s.forward;
    hideCelebrate();
    updateProgress();
    if (s.current) showTask(s.current);
  }

  async function undoAction(snap) {
    if (S.busy) return;
    S.busy = true;
    try {
      const res = await db.saveTaskProgress(snap.before, { removeLogId: snap.logId });
      S.tasks.set(snap.id, res.task);
    } catch (err) {
      console.error(err);
      S.busy = false;
      toast('Det gick inte att ångra. Försök igen.', { tone: 'error' });
      return;
    }
    restoreSession(snap.session);
    S.busy = false;
    S.lockUntil = 0;
    announce('Ångrat');
  }

  function skip() {
    if (S.busy || S.celebrating || !S.current || Date.now() < S.lockUntil) return;
    const id = S.current;
    if (S.forward.length) {
      S.history.push(id);
      showTask(S.forward.pop());
      return;
    }
    const t = S.tasks.get(id);
    S.queue = S.queue.filter((x) => x !== id);
    if (t.status !== KLAR) S.queue.push(id);
    S.history.push(id);
    if (S.queue.length === 1 && S.queue[0] === id) toast('Det här är den enda uppgiften kvar.');
    goToQueueHead();
  }

  function prev() {
    if (S.busy || !S.history.length) return;
    if (S.celebrating) hideCelebrate();
    else if (S.current) S.forward.push(S.current);
    showTask(S.history.pop());
  }

  function forwardOrSkip() {
    if (S.celebrating) return;
    if (S.forward.length) {
      S.history.push(S.current);
      showTask(S.forward.pop());
    } else {
      skip();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Firande                                                             */
  /* ------------------------------------------------------------------ */

  function celebrate() {
    S.celebrating = true;
    S.current = null;
    clearTimeout(rememberTimer);
    const all = [...S.tasks.values()];
    const p = updateProgress();
    const wasHard = all.filter((t) => t.svarAntal > 0).length;
    stage.hidden = true;
    bottom.hidden = true;
    const scopeName = examIdParam ? examById.get(examIdParam)?.namn : exams.length === 1 ? exams[0].namn : `${exams.length} tentor`;
    celebrateEl.replaceChildren(
      h(
        'div',
        { class: 'celebrate-inner' },
        h('div', { class: 'celebrate-mark', 'aria-hidden': 'true' }, icon('checkCircle', { size: 56 })),
        h('h1', { class: 'celebrate-title', id: 'celebrate-title', tabindex: '-1' }, '100 % – alla uppgifter klara'),
        h('p', { class: 'celebrate-lead' }, `Snyggt jobbat. Du har gått igenom allt i ${scopeName}. 🎉`),
        h(
          'dl',
          { class: 'celebrate-stats' },
          h('div', null, h('dt', null, 'Uppgifter'), h('dd', null, String(p.count))),
          p.points ? h('div', null, h('dt', null, 'Poäng'), h('dd', null, String(p.points))) : null,
          h('div', null, h('dt', null, 'Har varit svåra'), h('dd', null, String(wasHard))),
        ),
        h(
          'div',
          { class: 'celebrate-actions' },
          h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => navigate('#/') }, 'Tillbaka till biblioteket'),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => resetAll() }, icon('refresh', { size: 18 }), 'Nollställ framsteg'),
        ),
      ),
    );
    celebrateEl.hidden = false;
    celebrateEl.querySelector('h1').focus({ preventScroll: true });
    db.getSettings()
      .then((s) => {
        const map = { ...(s.senastOppnadUppgift || {}) };
        delete map[scopeKey];
        return db.saveSettings({ senastOppnadUppgift: map });
      })
      .catch(() => {});
  }

  function hideCelebrate() {
    if (!S.celebrating) return;
    S.celebrating = false;
    celebrateEl.hidden = true;
    stage.hidden = false;
    bottom.hidden = false;
  }

  async function resetAll() {
    const ids = [...examById.keys()];
    const ok = await confirmDialog({
      title: 'Nollställa framsteg?',
      message: `Alla ${plural(S.tasks.size, 'uppgift', 'uppgifter')} markeras som ej gjorda så att du kan börja om. Markeringarna finns kvar. Det går inte att ångra.`,
      confirmLabel: 'Nollställ',
      danger: true,
    });
    if (!ok) return;
    await db.resetProgress(ids);
    const fresh = (await db.listTasks()).filter((t) => S.tasks.has(t.id));
    S.tasks = new Map(fresh.map((t) => [t.id, t]));
    S.history = [];
    S.forward = [];
    S.queue = buildQueue();
    hideCelebrate();
    updateProgress();
    goToQueueHead();
    toast('Framstegen är nollställda. Lycka till!');
  }

  /* ------------------------------------------------------------------ */
  /* Meny, hjälp, tangentbord                                            */
  /* ------------------------------------------------------------------ */

  async function setSetting(patch) {
    S.settings = await db.saveSettings(patch);
  }

  function openStudyMenu() {
    const o = S.settings.ordning;
    openMenu(
      moreBtn,
      [
        { heading: 'Progress' },
        {
          label: 'Väg efter poäng',
          checked: !!S.settings.viktaEfterPoang,
          onSelect: async () => {
            await setSetting({ viktaEfterPoang: !S.settings.viktaEfterPoang });
            updateProgress();
          },
        },
        { separator: true },
        { heading: 'Ordning' },
        ...[
          ['blandad', 'Blandad'],
          ['kronologisk', 'Kronologisk'],
          ['svåra_först', 'Svåra först'],
        ].map(([value, label]) => ({
          label,
          radio: true,
          checked: o === value,
          onSelect: async () => {
            if (o === value) return;
            await setSetting({ ordning: value });
            S.queue = buildQueue();
            if (S.current && S.queue.includes(S.current)) {
              S.queue = [S.current, ...S.queue.filter((x) => x !== S.current)];
            }
            announce(`Ordning: ${label}`);
          },
        })),
        { separator: true },
        { label: 'Kortkommandon', icon: 'keyboard', onSelect: () => showHelp() },
      ],
      { label: 'Inställningar för pluggläget' },
    );
  }

  function showHelp() {
    const rows = [
      ['K', 'Klar'],
      ['S', 'Svår, kom tillbaka'],
      ['H', 'Hoppa över'],
      ['F', 'Visa/dölj facit'],
      ['←', 'Föregående'],
      ['→', 'Nästa'],
      ['Ctrl + scroll', 'Zooma bilden'],
      ['Esc', 'Lämna pluggläget'],
    ];
    openDialog({
      title: 'Kortkommandon',
      content: h(
        'dl',
        { class: 'shortcut-list' },
        rows.map(([k, d]) => h('div', null, h('dt', null, h('kbd', { class: 'kbd' }, k)), h('dd', null, d))),
      ),
      buttons: [{ label: 'Stäng', value: null, variant: 'primary' }],
    });
  }

  function onKeyDown(e) {
    if (document.querySelector('dialog[open], .menu')) return;
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      navigate('#/');
      return;
    }
    if (k === '?') {
      e.preventDefault();
      showHelp();
      return;
    }
    if (S.celebrating) return;
    const lower = k.toLowerCase();
    const map = {
      k: () => act('klar'),
      s: () => act('svar'),
      h: () => skip(),
      f: () => toggleFacit(),
      arrowleft: () => prev(),
      arrowright: () => forwardOrSkip(),
    };
    if (map[lower]) {
      e.preventDefault();
      if (!e.repeat) map[lower]();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  const detachZoom = attachZoomGestures(stage, {
    getZoom: () => S.zoom,
    setZoom: (z, x, y) => setZoom(z, x, y),
    preview: sheet,
    min: MIN_ZOOM,
    max: MAX_ZOOM,
    onDoubleTap: (x, y) => (S.zoom > 1.05 ? setZoom(1, x, y) : setZoom(2.5, x, y)),
  });

  const ro = new ResizeObserver(() => applyWidth());
  ro.observe(stage);

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  S.queue = buildQueue();
  const last = settings.senastOppnadUppgift?.[scopeKey];
  if (last && S.queue.includes(last)) S.queue = [last, ...S.queue.filter((x) => x !== last)];
  updateProgress();
  goToQueueHead();
  if (!S.celebrating) stage.focus({ preventScroll: true });

  return {
    destroy() {
      destroyed = true;
      clearTimeout(sharpenTimer);
      document.removeEventListener('keydown', onKeyDown);
      detachZoom();
      ro.disconnect();
    },
  };
}

function emptyState(examIdParam, exams) {
  const single = examIdParam && exams.length === 1;
  let title;
  let text;
  if (!exams.length) {
    title = examIdParam ? 'Tentan hittades inte' : 'Inga tentor valda';
    text = examIdParam
      ? 'Den kan ha tagits bort.'
      : 'Ladda upp en tenta eller välj vilka tentor som ska ingå på startsidan.';
  } else if (single) {
    title = 'Inga uppgifter markerade än';
    text = 'Markera uppgifterna i tentan först – dra en ruta runt varje uppgift. Sedan kan du plugga dem en i taget.';
  } else {
    title = 'Inga uppgifter markerade än';
    text = 'De valda tentorna har inga markerade uppgifter. Öppna en tenta och välj Markera uppgifter.';
  }
  return h(
    'div',
    { class: 'view view-empty' },
    h(
      'div',
      { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('marquee', { size: 28 })),
      h('h1', { tabindex: '-1' }, title),
      h('p', null, text),
      h(
        'div',
        { class: 'empty-actions' },
        single
          ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => navigate(`#/markera/${examIdParam}`) }, 'Markera uppgifter')
          : null,
        h('button', { type: 'button', class: single ? 'btn btn-secondary' : 'btn btn-primary', onclick: () => navigate('#/') }, 'Till biblioteket'),
      ),
    ),
  );
}
