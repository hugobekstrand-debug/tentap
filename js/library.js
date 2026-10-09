/**
 * library.js — startsidan: tentalista, total progress, uppladdning och
 * välkomstvy första gången.
 */

import * as db from './db.js';
import { inspectPdf, forgetExam, PdfError } from './pdf.js';
import { progress, progressLabel, todayCount, streak, fmtPoints } from './stats.js';
import { recognizeAndSave, STEG } from './extract.js';
import {
  h,
  icon,
  logo,
  navigate,
  openMenu,
  openDialog,
  confirmDialog,
  promptDialog,
  toast,
  fmtBytes,
  plural,
  daysSince,
  showBanner,
  hideBanner,
  stepper,
} from './ui.js';
import { runExport, runImport } from './backup.js';
import { rerunTextRecognition, addFacitPdf } from './analysis.js';
import { runAiAnalysis, hasApiKey } from './premium.js';
import { APP_VERSION } from './version.js';

const LARGE_PDF_BYTES = 60 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Uppladdning (används även av app.js för drag-and-drop)               */
/* ------------------------------------------------------------------ */

/** Status per fil i pågående/nyss avslutade uppladdningar. Överlever omritning. */
const uploads = [];
let uploadListeners = new Set();
const notifyUploads = () => uploadListeners.forEach((fn) => fn());

function defaultName(filename) {
  return (
    filename
      .replace(/\.pdf$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Namnlös tenta'
  );
}

/** Kort resultattext för en färdig igenkänning. */
function resultText(r) {
  const n = r.tasks.length;
  if (!n) {
    return r.extraktion.textlagerSaknas
      ? 'Sparad. PDF:en verkar inskannad – markera själv eller prova AI.'
      : 'Sparad. Inga uppgifter hittades – markera själv eller prova AI.';
  }
  const sum = r.extraktion.sammanfattning?.summaPoang;
  let t = `${plural(n, 'uppgift', 'uppgifter')} hittade${sum ? ` · ${fmtPoints(sum)} p` : ''}`;
  if (r.extraktion.forslag) t += ' · behöver koll';
  return t;
}

/**
 * Laddar upp flera PDF:er, en i taget, med status per fil. Varje tenta
 * sparas först och analyseras sedan med textigenkänningen (lokalt, gratis).
 * Laddas en enda fil upp öppnas granskningen direkt när den är klar.
 */
export async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const items = files.map((f) => ({ id: db.uid(), name: f.name, size: f.size, state: 'waiting', step: null, text: 'Väntar…', file: f }));
  uploads.unshift(...items);
  notifyUploads();

  const existing = await db.listExams();
  const names = new Set(existing.map((e) => e.namn));

  for (const item of items) {
    item.state = 'working';
    item.step = 'read';
    item.text = item.size > LARGE_PDF_BYTES ? `Stor fil (${fmtBytes(item.size)}) – det kan ta en stund.` : '';
    notifyUploads();
    try {
      const f = item.file;
      const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      if (!isPdf) throw new PdfError('invalid', 'Det här är ingen PDF-fil. Välj en tenta i PDF-format.');
      if (f.size === 0) throw new PdfError('invalid', 'Filen är tom. Prova att ladda ner tentan igen.');
      const data = await f.arrayBuffer();
      const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
      if (!head.includes('%PDF-')) {
        throw new PdfError('invalid', 'Filen verkar inte vara en giltig PDF. Den kan vara skadad eller ofullständigt nedladdad.');
      }
      const info = await inspectPdf(data);
      let namn = defaultName(f.name);
      if (names.has(namn)) {
        let n = 2;
        while (names.has(`${namn} (${n})`)) n++;
        namn = `${namn} (${n})`;
      }
      names.add(namn);
      const exam = await db.addExam(
        {
          id: db.uid(),
          namn,
          antalSidor: info.antalSidor,
          sidor: info.sidor,
          filnamn: f.name,
          storlek: f.size,
        },
        data,
      );
      // Om användaren valt ett urval av tentor: ta med nya tentor i urvalet.
      const settings = await db.getSettings();
      if (Array.isArray(settings.valdaTentor)) {
        await db.saveSettings({ valdaTentor: [...settings.valdaTentor, exam.id] });
      }
      item.examId = exam.id;
      try {
        const r = await recognizeAndSave(exam.id, {
          onStep: (step) => {
            item.step = step;
            notifyUploads();
          },
        });
        item.state = 'done';
        item.step = 'done';
        item.found = r.tasks.length;
        item.text = resultText(r);
      } catch (err) {
        console.warn('Igenkänningen misslyckades:', item.name, err);
        item.state = 'warn';
        item.found = 0;
        item.text = 'Tentan är sparad, men uppgifterna kunde inte hittas automatiskt. Markera dem själv eller prova AI.';
      }
    } catch (err) {
      console.warn('Uppladdning misslyckades:', item.name, err);
      item.state = 'error';
      if (err instanceof PdfError || err instanceof db.StorageFullError) item.text = err.message;
      else if (err?.name === 'NotReadableError') item.text = 'Filen kunde inte läsas. Den kan ha flyttats eller tagits bort. Välj den igen.';
      else item.text = 'Filen kunde inte laddas upp. Försök igen, eller spara om PDF:en och ladda upp den nya filen.';
    }
    item.file = null; // släpp referensen
    notifyUploads();
  }
  // En enda fil: gå direkt till granskningen (om man fortfarande är på startsidan).
  const only = items.length === 1 ? items[0] : null;
  if (only?.examId && (only.state === 'done' || only.state === 'warn') && /^#?\/?$/.test(location.hash)) {
    navigate(`#/granska/${only.examId}`);
  }
}

function clearFinishedUploads() {
  for (let i = uploads.length - 1; i >= 0; i--) {
    if (['done', 'warn', 'error'].includes(uploads[i].state)) uploads.splice(i, 1);
  }
  notifyUploads();
}

/* ------------------------------------------------------------------ */
/* Vy                                                                  */
/* ------------------------------------------------------------------ */

export async function renderLibrary(root) {
  const view = h('div', { class: 'view view-library' });
  root.append(view);

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    multiple: true,
    class: 'visually-hidden',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });
  const pickFiles = () => fileInput.click();

  let destroyed = false;
  let renderSeq = 0;

  async function refresh() {
    const seq = ++renderSeq;
    const [exams, tasks, settings, log, premium] = await Promise.all([
      db.listExams(),
      db.listTasks(),
      db.getSettings(),
      db.listLog(),
      hasApiKey(),
    ]);
    if (destroyed || seq !== renderSeq) return;
    const activeEl = document.activeElement;
    const focusKey = activeEl?.dataset?.focusKey;

    view.replaceChildren(fileInput);
    view.append(header());

    if (!exams.length) {
      view.append(welcome());
      hideBanner('backup');
    } else {
      const tasksByExam = groupBy(tasks, (t) => t.examId);
      const selected = Array.isArray(settings.valdaTentor)
        ? exams.filter((e) => settings.valdaTentor.includes(e.id))
        : exams;
      const selectedTasks = selected.flatMap((e) => (tasksByExam.get(e.id) || []).filter(hasRegions));
      // Översikten visas först när det finns något att plugga – annars är
      // kortets "Markera uppgifter" det enda tydliga valet.
      if (tasks.some(hasRegions)) view.append(overview(exams, selected, selectedTasks, settings, log));
      view.append(examList(exams, tasksByExam, settings, premium));
      view.append(uploadSection(false));
      updateBackupBanner(exams, settings);
    }
    view.append(footer());

    if (focusKey) view.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function header() {
    return h(
      'header',
      { class: 'lib-header' },
      h('div', { class: 'brand' }, logo(30), h('span', { class: 'brand-name' }, 'Tentaplugget')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn-icon btn-quiet',
          'aria-label': 'Inställningar',
          title: 'Inställningar',
          'data-focus-key': 'settings',
          onclick: () => navigate('#/installningar'),
        },
        icon('sliders'),
      ),
    );
  }

  function welcome() {
    const steps = [
      ['Ladda upp tentor', 'Gamla tentor som PDF. Flera på en gång går bra.'],
      ['Markera uppgifterna', 'Dra en ruta runt varje uppgift – och runt facit, om det finns.'],
      ['Plugga', 'En uppgift i taget, tills progress-baren når 100 %.'],
    ];
    return h(
      'section',
      { class: 'welcome', 'aria-labelledby': 'welcome-title' },
      h('h1', { id: 'welcome-title', class: 'welcome-title', tabindex: '-1' }, 'Plugga tentor som en inlämningsuppgift'),
      h('p', { class: 'welcome-lead' }, 'En ändlig lista uppgifter. En i taget. Du ser hela tiden hur långt du har kommit.'),
      h(
        'ol',
        { class: 'steps' },
        steps.map(([title, text], i) =>
          h(
            'li',
            { class: 'step' },
            h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(i + 1)),
            h('div', null, h('p', { class: 'step-title' }, title), h('p', { class: 'step-text' }, text)),
          ),
        ),
      ),
      uploadSection(true),
      h(
        'p',
        { class: 'welcome-fine' },
        'Allt sparas bara här, i den här webbläsaren. ',
        h(
          'button',
          { type: 'button', class: 'link-btn', onclick: () => runImport() },
          'Har du en säkerhetskopia? Importera den',
        ),
      ),
    );
  }

  function overview(exams, selected, selectedTasks, settings, log) {
    const p = progress(selectedTasks, settings.viktaEfterPoang);
    const today = todayCount(log);
    const days = streak(log);
    const allSelected = selected.length === exams.length;
    const scopeText = allSelected ? (exams.length === 1 ? 'Din tenta' : 'Alla tentor') : `${selected.length} av ${exams.length} tentor`;

    const bar = h(
      'div',
      {
        class: `bar bar-lg ${p.allDone ? 'is-done' : ''}`,
        role: 'progressbar',
        'aria-label': 'Total progress',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(p.pct),
        'aria-valuetext': progressLabel(p),
      },
      h('div', { class: 'bar-fill', style: { width: `${p.pct}%` } }),
    );

    const noTasks = selectedTasks.length === 0;
    const meta = [];
    if (!noTasks) {
      if (p.hard) meta.push(h('span', { class: 'chip chip--hard' }, icon('flag', { size: 14 }), `${p.hard} svåra`));
      meta.push(h('span', { class: 'muted' }, p.allDone ? 'Allt klart' : `${p.remaining} kvar`));
    }

    const activity = [];
    if (today > 0) activity.push(`Idag: ${plural(today, 'uppgift', 'uppgifter')} klar${today === 1 ? '' : 'a'}`);
    if (days > 1) activity.push(`${days} dagar i rad`);

    return h(
      'section',
      { class: 'card overview', 'aria-labelledby': 'overview-title' },
      h(
        'div',
        { class: 'overview-head' },
        h('h1', { class: 'overview-title', id: 'overview-title', tabindex: '-1' }, scopeText),
        exams.length > 1
          ? h(
              'button',
              { type: 'button', class: 'link-btn', 'data-focus-key': 'choose', onclick: () => chooseExams(exams, settings) },
              'Välj tentor',
            )
          : null,
      ),
      noTasks
        ? h('p', { class: 'muted overview-empty' }, 'Inga uppgifter markerade än. Börja med Markera uppgifter på en tenta nedan.')
        : [h('p', { class: 'overview-numbers' }, progressLabel(p)), bar, h('div', { class: 'overview-meta' }, meta)],
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-lg btn-block',
          disabled: noTasks || null,
          'data-focus-key': 'study-all',
          onclick: () => navigate('#/plugga'),
        },
        allSelected ? 'Plugga alla' : 'Plugga valda',
        icon('arrowRight'),
      ),
      activity.length ? h('p', { class: 'activity' }, icon('calendar', { size: 16 }), activity.join(' · ')) : null,
    );
  }

  function examList(exams, tasksByExam, settings, premium) {
    return h(
      'section',
      { class: 'exams', 'aria-labelledby': 'exams-title' },
      h('h2', { class: 'section-title', id: 'exams-title' }, 'Tentor'),
      h(
        'ul',
        { class: 'exam-list' },
        exams.map((exam) => examCard(exam, (tasksByExam.get(exam.id) || []).filter(hasRegions), settings, premium)),
      ),
    );
  }

  function examCard(exam, tasks, settings, premium) {
    const p = progress(tasks, settings.viktaEfterPoang);
    const hasTasks = tasks.length > 0;
    const moreBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn-icon btn-quiet',
        'aria-label': `Fler val för ${exam.namn}`,
        'data-focus-key': `more-${exam.id}`,
      },
      icon('more'),
    );
    moreBtn.addEventListener('click', () =>
      openMenu(
        moreBtn,
        [
          { label: 'Granska uppgifter', icon: 'list', onSelect: () => navigate(`#/granska/${exam.id}`) },
          { label: 'Markera manuellt', icon: 'marquee', onSelect: () => navigate(`#/markera/${exam.id}`) },
          { label: 'Analysera med AI', icon: 'sparkles', badge: premium ? null : 'Premium', onSelect: () => runAiAnalysis(exam.id) },
          { label: 'Hitta uppgifter automatiskt', icon: 'scan', onSelect: () => rerunTextRecognition(exam.id) },
          exam.facitPdf ? null : { label: 'Lägg till facit-PDF', icon: 'fileText', onSelect: () => addFacitPdf(exam.id) },
          { separator: true },
          { label: 'Byt namn', icon: 'edit', onSelect: () => renameExam(exam) },
          { label: 'Nollställ framsteg', icon: 'refresh', disabled: !hasTasks, onSelect: () => resetExam(exam, tasks) },
          { separator: true },
          { label: 'Ta bort tenta', icon: 'trash', danger: true, onSelect: () => removeExam(exam, tasks) },
        ],
        { label: `Val för ${exam.namn}` },
      ),
    );

    let metaText;
    if (!hasTasks) metaText = 'Inga uppgifter markerade än';
    else if (p.allDone) metaText = `Alla ${p.count} klara`;
    else metaText = `${p.doneCount} av ${p.count} klara`;
    const pointsText = hasTasks && p.points ? ` · ${p.pointsDone} av ${p.points} p` : '';

    return h(
      'li',
      { class: `exam-card ${p.allDone ? 'is-done' : ''}` },
      h(
        'div',
        { class: 'exam-card-main' },
        h('h3', { class: 'exam-name' }, exam.namn),
        h('p', { class: 'exam-meta' }, metaText + pointsText),
        hasTasks
          ? h(
              'div',
              {
                class: `bar bar-thin ${p.allDone ? 'is-done' : ''}`,
                role: 'progressbar',
                'aria-label': `Progress för ${exam.namn}`,
                'aria-valuemin': '0',
                'aria-valuemax': '100',
                'aria-valuenow': String(p.pct),
              },
              h('div', { class: 'bar-fill', style: { width: `${p.pct}%` } }),
            )
          : null,
        hasTasks && (p.hard || p.allDone)
          ? h(
              'div',
              { class: 'exam-chips' },
              p.allDone ? h('span', { class: 'chip chip--ok' }, icon('check', { size: 14 }), 'Klar') : null,
              p.hard ? h('span', { class: 'chip chip--hard' }, icon('flag', { size: 14 }), `${p.hard} ${p.hard === 1 ? 'svår' : 'svåra'}`) : null,
            )
          : null,
      ),
      h(
        'div',
        { class: 'exam-card-actions' },
        hasTasks
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                'data-focus-key': `study-${exam.id}`,
                onclick: () => navigate(`#/plugga/${exam.id}`),
              },
              'Plugga',
            )
          : h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                'data-focus-key': `mark-${exam.id}`,
                onclick: () => navigate(`#/markera/${exam.id}`),
              },
              'Markera uppgifter',
            ),
        moreBtn,
      ),
    );
  }

  /* ---------- Uppladdningsyta ---------- */

  let uploadListEl = null;
  function uploadSection(isWelcome) {
    const zone = h(
      'div',
      { class: `dropzone ${isWelcome ? 'dropzone--hero' : ''}` },
      h('span', { class: 'dropzone-icon' }, icon('upload', { size: isWelcome ? 28 : 22 })),
      h(
        'div',
        { class: 'dropzone-text' },
        h('p', { class: 'dropzone-title' }, isWelcome ? 'Släpp dina tentor här' : 'Lägg till fler tentor'),
        h('p', { class: 'dropzone-hint' }, 'PDF-filer · flera på en gång går bra'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: `btn ${isWelcome ? 'btn-primary btn-lg' : 'btn-secondary'}`,
          'data-focus-key': 'upload',
          onclick: pickFiles,
        },
        icon('upload', { size: 18 }),
        'Ladda upp tentor',
      ),
    );
    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('is-over');
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    });

    uploadListEl = h('div', { class: 'upload-status-wrap', 'aria-live': 'polite' });
    renderUploads();
    return h(
      'section',
      { class: 'upload', 'aria-label': 'Ladda upp tentor' },
      zone,
      uploadListEl,
    );
  }

  function renderUploads() {
    if (!uploadListEl) return;
    uploadListEl.replaceChildren();
    if (!uploads.length) return;
    const busy = uploads.some((u) => u.state === 'working' || u.state === 'waiting');
    const ul = h(
      'ul',
      { class: 'upload-status' },
      uploads.map((u) =>
        h(
          'li',
          { class: `upload-item upload-item--${u.state}` },
          h(
            'span',
            { class: 'upload-item-icon' },
            u.state === 'done'
              ? icon('checkCircle', { size: 20 })
              : u.state === 'error' || u.state === 'warn'
                ? icon('alert', { size: 20 })
                : icon('spinner', { size: 20, cls: u.state === 'working' ? 'spin' : '' }),
          ),
          h(
            'div',
            { class: 'upload-item-body' },
            h('p', { class: 'upload-item-name' }, u.name),
            u.state === 'working' ? stepper(STEG, u.step) : null,
            u.state === 'waiting' ? h('p', { class: 'upload-item-text' }, 'Väntar på sin tur') : null,
            u.text ? h('p', { class: 'upload-item-text' }, u.text) : null,
          ),
          (u.state === 'done' || u.state === 'warn') && u.examId
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-secondary',
                  onclick: () => navigate(`#/granska/${u.examId}`),
                },
                u.found ? 'Granska' : 'Välj hur',
              )
            : null,
        ),
      ),
    );
    uploadListEl.append(ul);
    if (!busy) {
      uploadListEl.append(
        h('button', { type: 'button', class: 'link-btn upload-clear', onclick: clearFinishedUploads }, 'Dölj listan'),
      );
    }
  }

  function footer() {
    return h(
      'footer',
      { class: 'lib-footer' },
      h('p', null, `Tentaplugget ${APP_VERSION} · Datan finns bara på den här enheten.`),
    );
  }

  /* ---------- Åtgärder ---------- */

  async function chooseExams(exams, settings) {
    const chosen = new Set(Array.isArray(settings.valdaTentor) ? settings.valdaTentor : exams.map((e) => e.id));
    const list = h(
      'div',
      { class: 'check-list' },
      exams.map((e) =>
        h(
          'label',
          { class: 'check-row' },
          h('input', {
            type: 'checkbox',
            value: e.id,
            checked: chosen.has(e.id) || null,
            onchange: (ev) => (ev.target.checked ? chosen.add(e.id) : chosen.delete(e.id)),
          }),
          h('span', null, e.namn),
        ),
      ),
    );
    const { result } = openDialog({
      title: 'Vilka tentor ingår?',
      content: [h('p', { class: 'muted' }, 'Plugga alla och den totala progressen gäller de tentor du väljer här.'), list],
      buttons: [
        { label: 'Avbryt', value: null, variant: 'secondary' },
        { label: 'Spara', value: 'save', variant: 'primary' },
      ],
    });
    if ((await result) !== 'save') return;
    const ids = exams.map((e) => e.id).filter((id) => chosen.has(id));
    if (!ids.length) {
      toast('Välj minst en tenta.');
      return;
    }
    await db.saveSettings({ valdaTentor: ids.length === exams.length ? null : ids });
  }

  async function renameExam(exam) {
    const name = await promptDialog({ title: 'Byt namn', label: 'Namn på tentan', value: exam.namn, hint: 'Till exempel "SSY061 2026-08-19".' });
    if (!name || name === exam.namn) return;
    await db.updateExam(exam.id, { namn: name });
    toast('Namnet är ändrat.');
  }

  async function resetExam(exam, tasks) {
    const ok = await confirmDialog({
      title: 'Nollställa framsteg?',
      message: `Alla ${plural(tasks.length, 'uppgift', 'uppgifter')} i ${exam.namn} markeras som ej gjorda. Markeringarna finns kvar. Det går inte att ångra.`,
      confirmLabel: 'Nollställ',
      danger: true,
    });
    if (!ok) return;
    await db.resetProgress([exam.id]);
    toast('Framstegen är nollställda.');
  }

  async function removeExam(exam, tasks) {
    const ok = await confirmDialog({
      title: `Ta bort ${exam.namn}?`,
      message: [
        `PDF:en, ${plural(tasks.length, 'markerad uppgift', 'markerade uppgifter')} och alla framsteg för tentan försvinner. Det går inte att ångra.`,
        'Tips: exportera en säkerhetskopia först om du kan vilja ha kvar den.',
      ],
      confirmLabel: 'Ta bort tentan',
      danger: true,
    });
    if (!ok) return;
    await db.deleteExam(exam.id);
    forgetExam(exam.id);
    const settings = await db.getSettings();
    if (Array.isArray(settings.valdaTentor)) {
      const rest = settings.valdaTentor.filter((id) => id !== exam.id);
      await db.saveSettings({ valdaTentor: rest.length ? rest : null });
    }
    toast(`${exam.namn} är borttagen.`);
  }

  /* ---------- Påminnelse om säkerhetskopia ---------- */

  function updateBackupBanner(exams, settings) {
    const oldest = exams.reduce((min, e) => (!min || e.skapad < min ? e.skapad : min), null);
    const since = settings.senasteExport || oldest;
    const days = daysSince(since);
    const snoozed = settings.backupPaminnelseDoldTill && new Date(settings.backupPaminnelseDoldTill) > new Date();
    if (days > 7 && !snoozed) {
      showBanner('backup', {
        message: settings.senasteExport
          ? `Det var ${days} dagar sedan du sparade en säkerhetskopia.`
          : 'Du har inte sparat någon säkerhetskopia än.',
        iconName: 'shield',
        actions: [{ label: 'Exportera', variant: 'secondary', onClick: () => runExport(APP_VERSION) }],
        dismissLabel: 'Påminn mig senare',
        onDismiss: () => {
          const until = new Date();
          until.setDate(until.getDate() + 2);
          db.saveSettings({ backupPaminnelseDoldTill: until.toISOString() });
        },
      });
    } else {
      hideBanner('backup');
    }
  }

  /* ---------- Livscykel ---------- */

  const offChange = db.onChange(() => refresh());
  const onUploads = () => {
    renderUploads();
  };
  uploadListeners.add(onUploads);

  await refresh();
  view.querySelector('h1')?.focus({ preventScroll: true });

  return {
    destroy() {
      destroyed = true;
      offChange();
      uploadListeners.delete(onUploads);
      hideBanner('backup');
    },
  };
}

function hasRegions(t) {
  return t.regions.length > 0;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
