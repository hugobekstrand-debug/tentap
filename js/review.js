/**
 * review.js — granskningsvyn efter igenkänning (#/granska/<id>).
 *
 * Visar vad igenkänningen hittade: antal uppgifter, poängsumma mot tentans
 * angivna totalpoäng, säkerhet per uppgift och om facit hittades. Uppgifter
 * med låg säkerhet visas överst. En uppgift öppnas i en detaljvy där man kan
 * byta etikett/poäng, ta bort, slå ihop med nästa, dela, eller justera
 * rektangeln i markeringsvyn (#/markera/<id>/<uppgift>).
 *
 * Utvägar som alltid finns: Analysera med AI (Premium) och Markera manuellt.
 * Omanalys sparar en ögonblicksbild och erbjuder Ångra (db.undoExtraction).
 */

import * as db from './db.js';
import { regionImage, regionSizePt, deviceScale, forgetExam } from './pdf.js';
import { forgetTextLayer } from './extract.js';
import { fmtPoints } from './stats.js';
import { openPremium, runAiAnalysis, hasApiKey } from './premium.js';
import { METOD_TEXT, rerunTextRecognition, addFacitPdf } from './analysis.js';
import {
  h,
  icon,
  navigate,
  toast,
  openDialog,
  openMenu,
  confirmDialog,
  badge,
  emptyState,
  plural,
  announce,
} from './ui.js';

/* ------------------------------------------------------------------ */
/* Vy                                                                  */
/* ------------------------------------------------------------------ */

export async function renderReview(root, examId) {
  const view = h('div', { class: 'view view-review' });
  root.append(view);
  let destroyed = false;
  let seq = 0;
  let exam = null;
  let tasks = [];

  async function refresh() {
    const my = ++seq;
    const [e, t, premium] = await Promise.all([db.getExam(examId), db.listTasks(examId), hasApiKey()]);
    if (destroyed || my !== seq) return;
    exam = e;
    tasks = t;
    const focusKey = document.activeElement?.dataset?.focusKey;
    if (!exam) {
      view.replaceChildren(
        emptyState({
          iconName: 'file',
          title: 'Tentan hittades inte',
          text: 'Den kan ha tagits bort, eller så finns den på en annan enhet.',
          actions: [{ label: 'Till startsidan', variant: 'primary', onClick: () => navigate('#/') }],
        }),
      );
      return;
    }
    view.replaceChildren(header(), summary(premium), list(premium), escapes(premium));
    if (focusKey) view.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function header() {
    const more = h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': 'Fler val', 'data-focus-key': 'more' }, icon('more'));
    more.addEventListener('click', () =>
      openMenu(
        more,
        [
          { label: 'Hitta uppgifter igen (text)', icon: 'scan', onSelect: () => rerunTextRecognition(examId) },
          exam.extraktion.rasvar
            ? { label: 'Analysera om med AI (nytt anrop)', icon: 'sparkles', onSelect: () => startAi({ force: true }) }
            : null,
          exam.facitPdf
            ? { label: 'Ta bort facit-PDF', icon: 'trash', onSelect: () => removeFacit() }
            : { label: 'Lägg till facit-PDF', icon: 'fileText', onSelect: () => addFacitPdf(examId) },
          exam.foregaendeUppgifter
            ? { label: 'Återställ förra resultatet', icon: 'undo', onSelect: () => undoLast() }
            : null,
        ].filter(Boolean),
        { label: 'Fler val för granskningen' },
      ),
    );
    return h(
      'header',
      { class: 'page-header' },
      h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': 'Tillbaka till startsidan', onclick: () => navigate('#/') }, icon('back')),
      h('div', { class: 'page-header-text' }, h('p', { class: 'page-kicker' }, 'Granska uppgifter'), h('p', { class: 'page-sub' }, exam.namn)),
      more,
    );
  }

  function summary(premium) {
    const ex = exam.extraktion;
    const sum = Math.round(tasks.reduce((s, t) => s + (t.poang || 0), 0) * 100) / 100;
    const given = ex.sammanfattning?.angivenTotalpoang ?? null;
    const n = tasks.length;
    const title = n
      ? `Hittade ${plural(n, 'uppgift', 'uppgifter')}${sum ? ` · ${fmtPoints(sum)} p` : ''}`
      : ex.textlagerSaknas
        ? 'PDF:en saknar läsbar text'
        : 'Inga uppgifter hittades';
    const low = tasks.filter((t) => t.sakerhet === db.SAKERHET.LAG).length;
    const children = [
      h('div', { class: 'review-badges' }, badge(METOD_TEXT[ex.metod] || 'Okänd metod', { tone: 'neutral', iconName: ex.metod === 'ai' ? 'sparkles' : ex.metod === 'text' ? 'scan' : 'marquee' }), exam.facitPdf ? badge('Separat facit-PDF', { tone: 'neutral', iconName: 'fileText' }) : null),
      h('h1', { class: 'review-title', tabindex: '-1' }, title),
    ];
    if (n && given !== null && sum > 0 && Math.abs(sum - given) > 0.01) {
      children.push(
        h('p', { class: 'note note--info' }, icon('info', { size: 18 }), `Uppgifterna summerar till ${fmtPoints(sum)} p, tentan anger ${fmtPoints(given)} p.`),
      );
    } else if (n && given !== null && Math.abs(sum - given) <= 0.01) {
      children.push(h('p', { class: 'note note--ok' }, icon('check', { size: 18 }), `Stämmer med tentans totalpoäng (${fmtPoints(given)} p).`));
    }
    if (ex.forslag && (ex.metod === 'text' || ex.metod === 'ingen')) {
      children.push(suggestionCard(ex.forslag, premium));
    } else if (low && ex.metod === 'text') {
      children.push(
        h(
          'div',
          { class: 'hint-card' },
          h('p', null, `Inte nöjd? ${low === 1 ? 'En uppgift' : `${low} uppgifter`} behöver koll.`),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-focus-key': 'ai-hint', onclick: () => startAi() }, 'Prova AI-igenkänning', premium ? null : badge('Premium', { tone: 'premium' })),
        ),
      );
    }
    children.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-lg btn-block',
          disabled: !n || null,
          'data-focus-key': 'approve',
          onclick: () => approve(),
        },
        'Godkänn och börja plugga',
      ),
    );
    return h('section', { class: 'review-summary', 'aria-labelledby': 'review-title' }, children);
  }

  function suggestionCard(text, premium) {
    return h(
      'div',
      { class: 'suggest-card', role: 'note' },
      h('p', { class: 'suggest-text' }, text),
      h(
        'div',
        { class: 'button-row' },
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'suggest-ai', onclick: () => startAi() }, icon('sparkles', { size: 18 }), 'Analysera med AI', premium ? null : badge('Premium', { tone: 'premium' })),
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'suggest-mark', onclick: () => navigate(`#/markera/${examId}`) }, icon('marquee', { size: 18 }), 'Markera själv'),
      ),
    );
  }

  function list() {
    if (!tasks.length) return null;
    const order = [...tasks].sort((a, b) => rank(a) - rank(b) || a.ordning - b.ordning);
    return h(
      'section',
      { class: 'review-list-wrap', 'aria-labelledby': 'review-list-title' },
      h('h2', { class: 'section-title', id: 'review-list-title' }, 'Uppgifter'),
      h('ul', { class: 'review-list' }, order.map((t) => row(t))),
    );
  }

  const rank = (t) => (t.sakerhet === db.SAKERHET.LAG ? 0 : 1);

  function row(t) {
    const img = h('img', { alt: '', decoding: 'async', class: 'thumb-img' });
    const thumb = h('span', { class: 'thumb', 'aria-hidden': 'true' }, img);
    loadThumb(t, img, thumb);
    const low = t.sakerhet === db.SAKERHET.LAG;
    return h(
      'li',
      null,
      h(
        'button',
        { type: 'button', class: 'review-row', 'data-focus-key': `row-${t.id}`, onclick: () => openDetail(t.id) },
        thumb,
        h(
          'span',
          { class: 'review-row-text' },
          h('span', { class: 'review-row-label' }, t.etikett),
          h(
            'span',
            { class: 'review-row-meta' },
            h('span', null, t.poang ? `${fmtPoints(t.poang)} p` : 'Inga poäng'),
            h('span', { class: `facit-flag ${t.solutionRegions.length ? 'has' : 'none'}` }, icon(t.solutionRegions.length ? 'check' : 'minus', { size: 14 }), t.solutionRegions.length ? 'Facit' : 'Inget facit'),
          ),
        ),
        low ? badge('Behöver koll', { tone: 'warn', iconName: 'alert' }) : badge('Säker', { tone: 'ok', iconName: 'check' }),
        icon('chevronRight', { size: 18, cls: 'review-row-chevron' }),
      ),
    );
  }

  async function loadThumb(t, img, thumb) {
    const r = t.regions[0];
    if (!r) {
      thumb.classList.add('has-error');
      return;
    }
    const size = regionSizePt(r, exam);
    const pxPerPt = Math.max(0.2, (96 * deviceScale()) / Math.max(1, size.w));
    try {
      const res = await regionImage(examId, r, pxPerPt);
      img.src = res.url;
      thumb.classList.add('is-loaded');
    } catch {
      thumb.classList.add('has-error');
    }
  }

  function escapes(premium) {
    return h(
      'section',
      { class: 'review-escapes', 'aria-label': 'Andra sätt' },
      h('p', { class: 'muted' }, 'Stämmer något inte? Du kan alltid välja ett annat sätt.'),
      h(
        'div',
        { class: 'button-row' },
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'esc-ai', onclick: () => startAi() }, icon('sparkles', { size: 18 }), 'Analysera med AI', premium ? null : badge('Premium', { tone: 'premium' })),
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'esc-mark', onclick: () => navigate(`#/markera/${examId}`) }, icon('marquee', { size: 18 }), 'Markera manuellt'),
      ),
    );
  }

  /* ---------- Åtgärder ---------- */

  async function startAi(opts = {}) {
    if (!(await hasApiKey())) {
      const ok = await openPremium();
      if (!ok) return;
    }
    await runAiAnalysis(examId, opts);
  }

  async function approve() {
    await db.updateExam(examId, { extraktion: { ...exam.extraktion, godkand: new Date().toISOString() } });
    navigate(`#/plugga/${examId}`);
  }

  async function undoLast() {
    const ok = await confirmDialog({
      title: 'Återställa förra resultatet?',
      message: 'Uppgifterna från före den senaste analysen kommer tillbaka. Framsteg du gjort sedan dess följer med där etiketten stämmer.',
      confirmLabel: 'Återställ',
    });
    if (!ok) return;
    await db.undoExtraction(examId);
    toast('Det tidigare resultatet är återställt.');
  }

  async function removeFacit() {
    const ok = await confirmDialog({
      title: 'Ta bort facit-PDF:en?',
      message: 'Facit som kommer från den separata PDF:en försvinner från uppgifterna. Tentan och dina framsteg finns kvar.',
      confirmLabel: 'Ta bort',
      danger: true,
    });
    if (!ok) return;
    await db.removeFacitPdf(examId);
    forgetExam(examId, 'facit');
    forgetTextLayer(examId);
    toast('Facit-PDF:en är borttagen.');
  }

  /** Sparar en ny uppgiftslista (framsteg skyddas av db.replaceExamTasks) med Ångra. */
  async function saveTasks(next, message) {
    const before = structuredClone(tasks);
    next.forEach((t, i) => (t.ordning = i));
    await db.replaceExamTasks(examId, next);
    toast(message, {
      actionLabel: 'Ångra',
      onAction: async () => {
        await db.replaceExamTasks(examId, before);
        announce('Ångrat');
      },
    });
  }

  /* ---------- Detaljvy ---------- */

  function openDetail(taskId) {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    const idx = tasks.findIndex((x) => x.id === taskId);
    const next = tasks[idx + 1] || null;

    const labelInput = h('input', { class: 'input', type: 'text', value: t.etikett, maxlength: '120', autocomplete: 'off', id: 'detail-label' });
    const pointsInput = h('input', { class: 'input input-short', type: 'text', inputmode: 'decimal', maxlength: '6', value: t.poang ?? '', placeholder: '–', autocomplete: 'off', id: 'detail-points' });
    const error = h('p', { class: 'field-error', hidden: true, 'aria-live': 'polite' });

    // Uppgift och facit i samma skala.
    const maxW = Math.max(...[...t.regions, ...t.solutionRegions].map((r) => regionSizePt(r, exam).w), 1);
    const images = h('div', { class: 'detail-images' }, imageStack(t.regions, `${t.etikett}, bild från tentan`, maxW));
    if (t.solutionRegions.length) {
      images.append(h('h3', { class: 'facit-title' }, icon('check', { size: 16 }), 'Facit'), imageStack(t.solutionRegions, `Facit för ${t.etikett}`, maxW));
    } else {
      images.append(h('p', { class: 'note note--info' }, icon('info', { size: 18 }), 'Inget facit hittades för den här uppgiften.'));
    }

    const content = [
      t.anmarkningar.length
        ? h('ul', { class: 'notes-list' }, t.anmarkningar.map((a) => h('li', null, icon('alert', { size: 16 }), a)))
        : null,
      h(
        'div',
        { class: 'panel-fields panel-fields--row' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'detail-label' }, 'Etikett'), labelInput),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'detail-points' }, 'Poäng'), pointsInput),
      ),
      t.delmoment.length
        ? h('p', { class: 'muted detail-parts' }, `Delmoment: ${t.delmoment.map((d) => `${d.etikett}${d.poang ? ` (${fmtPoints(d.poang)} p)` : ''}`).join(', ')}`)
        : null,
      error,
      images,
      h(
        'div',
        { class: 'detail-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => go(`#/markera/${examId}/${t.id}`) }, icon('marquee', { size: 18 }), 'Justera rutan'),
        next ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => merge() }, icon('merge', { size: 18 }), `Slå ihop med ${next.etikett}`) : null,
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => split() }, icon('split', { size: 18 }), 'Dela'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-danger-text', onclick: () => remove() }, icon('trash', { size: 18 }), 'Ta bort'),
      ),
    ];

    const dlg = openDialog({
      title: t.etikett,
      className: 'dialog-wide',
      content,
      initialFocus: '#detail-label',
      buttons: [
        { label: 'Avbryt', variant: 'secondary', value: null },
        { label: 'Spara', variant: 'primary', onClick: (close) => save(close) },
      ],
    });

    function go(hash) {
      dlg.close(null);
      navigate(hash);
    }

    async function save(close) {
      const etikett = labelInput.value.trim();
      const raw = pointsInput.value.trim();
      const poang = db.normalizePoang(raw);
      if (!etikett) return showError('Skriv en etikett, t.ex. "Problem 3".', labelInput);
      if (raw && poang === null) return showError('Poäng ska vara ett tal, t.ex. 3 eller 1,5. Lämna tomt om du inte vet.', pointsInput);
      close('saved');
      if (etikett === t.etikett && poang === t.poang && t.sakerhet !== db.SAKERHET.LAG) return;
      const list = tasks.map((x) => (x.id === t.id ? { ...x, etikett, poang, sakerhet: db.SAKERHET.MANUELL, anmarkningar: [] } : x));
      await saveTasks(list, `${etikett} är sparad och markerad som kontrollerad.`);
    }

    function showError(msg, input) {
      error.textContent = msg;
      error.hidden = false;
      input.focus();
    }

    async function merge() {
      dlg.close(null);
      const merged = {
        ...t,
        regions: [...t.regions, ...next.regions],
        solutionRegions: [...t.solutionRegions, ...next.solutionRegions],
        poang: t.poang !== null && next.poang !== null ? Math.round((t.poang + next.poang) * 100) / 100 : t.poang ?? next.poang,
        delmoment: [...t.delmoment, ...next.delmoment],
        sakerhet: db.SAKERHET.MANUELL,
        anmarkningar: [],
      };
      const list = tasks.filter((x) => x.id !== next.id).map((x) => (x.id === t.id ? merged : x));
      await saveTasks(list, `${t.etikett} och ${next.etikett} är ihopslagna.`);
    }

    async function remove() {
      dlg.close(null);
      await saveTasks(tasks.filter((x) => x.id !== t.id), `${t.etikett} är borttagen.`);
    }

    function split() {
      dlg.close(null);
      openSplit(t);
    }
  }

  function imageStack(regions, alt, maxW = Math.max(...regions.map((r) => regionSizePt(r, exam).w), 1)) {
    const stack = h('div', { class: 'img-stack' });
    regions.forEach((r, i) => {
      const s = regionSizePt(r, exam);
      const img = h('img', { alt: i ? `${alt}, del ${i + 1}` : alt, decoding: 'async' });
      const frame = h('div', { class: 'img-frame is-loading', style: { width: `${(s.w / maxW) * 100}%`, aspectRatio: `${s.w} / ${s.h}` } }, img);
      stack.append(frame);
      const pxPerPt = Math.min(4, Math.max(1.5, (Math.min(720, window.innerWidth) * deviceScale()) / maxW));
      regionImage(examId, r, pxPerPt)
        .then((res) => {
          img.onload = () => frame.classList.remove('is-loading');
          img.src = res.url;
        })
        .catch(() => {
          frame.classList.remove('is-loading');
          frame.classList.add('has-error');
          frame.replaceChildren(h('p', { class: 'img-error' }, 'Bilden kunde inte visas. Ladda om sidan och försök igen.'));
        });
    });
    return stack;
  }

  /** Dela en uppgift i två: välj var med ett reglage över bilden. */
  function openSplit(t) {
    const heights = t.regions.map((r) => regionSizePt(r, exam).h);
    const total = heights.reduce((a, b) => a + b, 0);
    const stack = imageStack(t.regions, `${t.etikett}, bild från tentan`);
    const lineEl = h('div', { class: 'split-line', 'aria-hidden': 'true' });
    const wrap = h('div', { class: 'split-wrap' }, stack, lineEl);
    const range = h('input', { type: 'range', min: '5', max: '95', value: '50', class: 'split-range', id: 'split-range', 'aria-describedby': 'split-help' });
    const place = () => (lineEl.style.top = `${range.value}%`);
    range.addEventListener('input', place);
    place();
    const { result } = openDialog({
      title: `Dela ${t.etikett}`,
      className: 'dialog-wide',
      content: [
        h('p', { id: 'split-help' }, 'Dra reglaget till där den andra uppgiften börjar. Allt ovanför linjen blir kvar, allt under blir en ny uppgift.'),
        h('label', { class: 'label', for: 'split-range' }, 'Var ska uppgiften delas?'),
        range,
        wrap,
      ],
      buttons: [
        { label: 'Avbryt', variant: 'secondary', value: null },
        { label: 'Dela här', variant: 'primary', value: 'split' },
      ],
    });
    result.then(async (v) => {
      if (v !== 'split') return;
      const target = (Number(range.value) / 100) * total;
      let acc = 0;
      const first = [];
      const second = [];
      t.regions.forEach((r, i) => {
        const hgt = heights[i];
        if (acc + hgt <= target) first.push(r);
        else if (acc >= target) second.push(r);
        else {
          const f = (target - acc) / hgt;
          first.push({ ...r, h: r.h * f });
          second.push({ ...r, y: r.y + r.h * f, h: r.h * (1 - f) });
        }
        acc += hgt;
      });
      const valid = (list) => list.map((r) => db.normalizeRegion(r, exam.antalSidor)).filter(Boolean);
      const a = valid(first);
      const b = valid(second);
      if (!a.length || !b.length) {
        toast('Välj en plats närmare mitten för att dela uppgiften.', { tone: 'error' });
        return;
      }
      const newTask = db.normalizeTask({
        id: db.uid(),
        examId,
        etikett: `${t.etikett} – del 2`,
        poang: null,
        regions: b,
        solutionRegions: [],
        kalla: t.kalla,
        sakerhet: db.SAKERHET.MANUELL,
      });
      const list = [];
      for (const x of tasks) {
        if (x.id === t.id) list.push({ ...x, regions: a, sakerhet: db.SAKERHET.MANUELL, anmarkningar: [] }, newTask);
        else list.push(x);
      }
      await saveTasks(list, `${t.etikett} är delad i två.`);
    });
  }

  const off = db.onChange((d) => {
    if (['tasks', 'exams', 'import', 'secrets'].includes(d.type)) refresh();
  });
  await refresh();
  return {
    destroy() {
      destroyed = true;
      off();
    },
  };
}
