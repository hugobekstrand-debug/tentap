/**
 * backup.js — export och import av säkerhetskopior.
 *
 * Format: EN .json-fil
 * {
 *   app: "tentaplugget", format: 1, schemaVersion, appVersion, exportedAt,
 *   settings, log: [...], tasks: [...],
 *   exams: [{ ...tentans metadata, pdfMime, pdfBase64 }]
 * }
 *
 * Exporten byggs i bitar (Blob-delar) så att även stora PDF:er går att
 * exportera utan att hela filen behöver ligga som en enda sträng i minnet.
 * Importen validerar allt INNAN något skrivs, och skrivningen sker i en
 * enda transaktion (se db.importData).
 */

import * as db from './db.js';
import {
  h,
  openDialog,
  progressDialog,
  alertDialog,
  choiceDialog,
  confirmDialog,
  toast,
  fmtBytes,
  fmtDateTime,
  plural,
} from './ui.js';
import { forgetExam } from './pdf.js';

export const BACKUP_APP = 'tentaplugget';
export const BACKUP_FORMAT = 1;

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ */
/* Base64                                                              */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(clean);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function looksLikePdf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function backupFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `tentaplugget-backup-${db.dayKey(date)}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

/**
 * Bygger säkerhetskopian som en Blob.
 * @param {(frac:number, text:string) => void} onProgress
 */
export async function buildBackup(onProgress = () => {}, appVersion = '') {
  const { exams, tasks, log, settings } = await db.readAllForExport();
  const exportedAt = new Date();
  const head = {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    schemaVersion: db.SCHEMA_VERSION,
    appVersion,
    exportedAt: exportedAt.toISOString(),
    settings,
    log,
    tasks,
  };
  const parts = [JSON.stringify(head).slice(0, -1) + ',"exams":['];

  for (let i = 0; i < exams.length; i++) {
    const exam = exams[i];
    onProgress(i / Math.max(1, exams.length), `Packar ${exam.namn} (${i + 1} av ${exams.length})`);
    const data = await db.getPdfData(exam.id);
    if (!data) throw new Error(`PDF:en för "${exam.namn}" saknas i lagringen.`);
    const meta = JSON.stringify({ ...exam, pdfMime: 'application/pdf', pdfBase64: '\u0000' });
    const [before, after] = meta.split('"\\u0000"');
    parts.push((i ? ',' : '') + before + '"');
    const bytes = new Uint8Array(data);
    const CHUNK = 3 * 256 * 1024; // multipel av 3 => bitarna kan läggas ihop
    for (let off = 0; off < bytes.length; off += CHUNK) {
      parts.push(bytesToBase64(bytes.subarray(off, off + CHUNK)));
      const frac = (i + Math.min(1, (off + CHUNK) / bytes.length)) / exams.length;
      onProgress(frac, `Packar ${exam.namn} (${i + 1} av ${exams.length})`);
      await nextFrame();
    }
    parts.push('"' + after);
  }
  parts.push(']}');
  onProgress(1, 'Klart');
  return { blob: new Blob(parts, { type: 'application/json' }), filename: backupFilename(exportedAt), exportedAt };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Hela exportflödet med förloppsdialog och nedladdning/delning. */
export async function runExport(appVersion = '') {
  const { exams } = await db.counts();
  if (!exams) {
    await alertDialog({
      title: 'Inget att exportera än',
      message: 'Ladda upp minst en tenta först. Sedan kan du spara en säkerhetskopia här.',
    });
    return false;
  }
  const prog = progressDialog('Skapar säkerhetskopia', 'Förbereder…');
  let built;
  try {
    built = await buildBackup((f, t) => prog.set(f, t), appVersion);
  } catch (err) {
    prog.close();
    console.error(err);
    await alertDialog({
      title: 'Säkerhetskopian kunde inte skapas',
      message: [
        err?.message || 'Ett oväntat fel inträffade.',
        'Din data är orörd. Försök igen, och starta om webbläsaren om det fortsätter.',
      ],
    });
    return false;
  }
  prog.close();

  const { blob, filename } = built;
  const file = typeof File === 'function' ? new File([blob], filename, { type: 'application/json' }) : null;
  const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));

  const markExported = () => db.saveSettings({ senasteExport: new Date().toISOString() });

  const buttons = [];
  if (canShare) {
    buttons.push({
      label: 'Dela / spara i Filer',
      variant: 'secondary',
      onClick: async (close) => {
        try {
          await navigator.share({ files: [file], title: 'Tentaplugget – säkerhetskopia' });
          await markExported();
          close(true);
        } catch (err) {
          if (err?.name !== 'AbortError') toast('Delningen fungerade inte. Prova Ladda ner i stället.', { tone: 'error' });
        }
      },
    });
  }
  buttons.push({
    label: 'Ladda ner',
    variant: 'primary',
    onClick: async (close) => {
      triggerDownload(blob, filename);
      await markExported();
      close(true);
    },
  });

  const { result } = openDialog({
    title: 'Säkerhetskopian är klar',
    content: [
      h('p', null, `${filename} · ${fmtBytes(blob.size)}`),
      h(
        'p',
        { class: 'muted' },
        'Spara filen där du hittar den igen, t.ex. i molnet eller i Filer. På en annan enhet öppnar du Inställningar → Importera.',
      ),
    ],
    buttons,
  });
  const ok = await result;
  if (ok) toast('Säkerhetskopian är sparad.', { tone: 'ok' });
  return !!ok;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export class BackupError extends Error {}

/** Uppgradera äldre exportformat till nuvarande (lägg till steg här vid behov). */
function migrateBackup(obj) {
  // format 1 är nuvarande format.
  return obj;
}

/**
 * Läser och validerar en säkerhetskopia. Skriver INGENTING.
 * @returns {Promise<{exams:{exam:object,data:ArrayBuffer}[], tasks:object[], log:object[], settings:object, exportedAt:string, warnings:string[]}>}
 */
export async function readBackupFile(file, onProgress = () => {}) {
  if (!file || file.size === 0) throw new BackupError('Filen är tom.');
  onProgress(0.05, 'Läser filen…');
  let text;
  try {
    text = await file.text();
  } catch {
    throw new BackupError('Filen kunde inte läsas. Prova att spara om den och välj den igen.');
  }
  onProgress(0.2, 'Kontrollerar innehållet…');
  await nextFrame();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupError(
      'Filen går inte att läsa som en säkerhetskopia. Den kan vara ofullständig (t.ex. en avbruten nedladdning) eller vara en annan sorts fil.',
    );
  }
  text = null;
  if (!obj || typeof obj !== 'object' || obj.app !== BACKUP_APP) {
    throw new BackupError('Det här ser inte ut att vara en säkerhetskopia från Tentaplugget.');
  }
  if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion > db.SCHEMA_VERSION || (obj.format ?? 1) > BACKUP_FORMAT) {
    throw new BackupError(
      'Säkerhetskopian kommer från en nyare version av Tentaplugget. Ladda om appen så att den uppdateras, och försök igen.',
    );
  }
  obj = migrateBackup(obj);
  if (!Array.isArray(obj.exams) || !Array.isArray(obj.tasks)) {
    throw new BackupError('Säkerhetskopian saknar tentor eller uppgifter och verkar vara skadad.');
  }

  const warnings = [];
  const exams = [];
  const examPages = new Map();
  for (let i = 0; i < obj.exams.length; i++) {
    const e = obj.exams[i];
    const name = typeof e?.namn === 'string' ? e.namn : `Tenta ${i + 1}`;
    onProgress(0.2 + (0.7 * i) / Math.max(1, obj.exams.length), `Kontrollerar ${name}…`);
    await nextFrame();
    if (!e || typeof e.id !== 'string' || typeof e.pdfBase64 !== 'string') {
      throw new BackupError(`Tentan "${name}" i säkerhetskopian är ofullständig.`);
    }
    let bytes;
    try {
      bytes = base64ToBytes(e.pdfBase64);
    } catch {
      throw new BackupError(`PDF:en för "${name}" är skadad i säkerhetskopian.`);
    }
    if (!looksLikePdf(bytes)) throw new BackupError(`PDF:en för "${name}" är skadad i säkerhetskopian.`);
    const sidor = Array.isArray(e.sidor) ? e.sidor.filter((s) => s && s.w > 0 && s.h > 0) : [];
    const antalSidor = Number.isInteger(e.antalSidor) && e.antalSidor > 0 ? e.antalSidor : sidor.length;
    if (!antalSidor || sidor.length !== antalSidor) {
      throw new BackupError(`Tentan "${name}" saknar sidinformation och verkar vara skadad.`);
    }
    const { pdfBase64, pdfMime, ...meta } = e;
    exams.push({
      exam: { ...meta, namn: name, antalSidor, sidor, skapad: meta.skapad || new Date().toISOString() },
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    examPages.set(e.id, antalSidor);
  }

  const tasks = [];
  let dropped = 0;
  for (const t of obj.tasks) {
    if (!t || typeof t.id !== 'string' || !examPages.has(t.examId)) {
      dropped++;
      continue;
    }
    const n = db.normalizeTask(t, examPages.get(t.examId));
    const lostRegions =
      (Array.isArray(t.regions) ? t.regions.length : 0) - n.regions.length +
      ((Array.isArray(t.solutionRegions) ? t.solutionRegions.length : 0) - n.solutionRegions.length);
    if (lostRegions > 0) warnings.push(`${n.etikett}: ${plural(lostRegions, 'ogiltigt område', 'ogiltiga områden')} hoppades över.`);
    tasks.push(n);
  }
  if (dropped) warnings.push(`${plural(dropped, 'uppgift', 'uppgifter')} utan giltig tenta hoppades över.`);

  const log = (Array.isArray(obj.log) ? obj.log : []).filter(
    (e) => e && typeof e.id === 'string' && typeof e.dag === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.dag),
  );
  const settings = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  onProgress(1, 'Klart');
  return { exams, tasks, log, settings, exportedAt: obj.exportedAt || null, warnings };
}

/** Låter användaren välja en fil. Resolvar med File eller null. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Hela importflödet: välj fil → validera → fråga Ersätt/Slå ihop → bekräfta → skriv. */
export async function runImport(file = null) {
  file = file || (await pickFile('application/json,.json'));
  if (!file) return false;

  const prog = progressDialog('Läser säkerhetskopia', 'Läser filen…');
  let data;
  try {
    data = await readBackupFile(file, (f, t) => prog.set(f, t));
  } catch (err) {
    prog.close();
    await alertDialog({
      title: 'Säkerhetskopian kunde inte läsas',
      message: [
        err instanceof BackupError ? err.message : 'Ett oväntat fel inträffade när filen lästes.',
        'Ingenting har ändrats på den här enheten.',
      ],
    });
    return false;
  }
  prog.close();

  const current = await db.counts();
  const fileSummary =
    `Filen innehåller ${plural(data.exams.length, 'tenta', 'tentor')} och ` +
    `${plural(data.tasks.length, 'uppgift', 'uppgifter')}` +
    (data.exportedAt ? ` (sparad ${fmtDateTime(data.exportedAt)}).` : '.');

  let mode;
  if (!current.exams && !current.tasks) {
    const ok = await confirmDialog({
      title: 'Importera säkerhetskopia?',
      message: [fileSummary, ...data.warnings],
      confirmLabel: 'Importera',
    });
    if (!ok) return false;
    mode = 'replace';
  } else {
    mode = await choiceDialog({
      title: 'Importera säkerhetskopia',
      message: [
        fileSummary,
        `På den här enheten finns ${plural(current.exams, 'tenta', 'tentor')} och ${plural(current.tasks, 'uppgift', 'uppgifter')}.`,
        ...data.warnings,
      ],
      choices: [
        {
          value: 'merge',
          label: 'Slå ihop',
          description: 'Lägger till det som saknas och behåller den senast ändrade versionen av varje uppgift. Inget tas bort.',
        },
        {
          value: 'replace',
          label: 'Ersätt allt',
          description: 'Tar bort allt som finns på den här enheten och ersätter det med säkerhetskopian.',
          variant: 'danger',
        },
      ],
    });
    if (!mode) return false;
    if (mode === 'replace') {
      const sure = await confirmDialog({
        title: 'Ersätta all data?',
        message: [
          `${plural(current.exams, 'tenta', 'tentor')} och ${plural(current.tasks, 'uppgift', 'uppgifter')} på den här enheten tas bort, inklusive framsteg. Det går inte att ångra.`,
          'Vill du vara säker kan du först exportera en säkerhetskopia av det som finns här.',
        ],
        confirmLabel: 'Ersätt allt',
        danger: true,
      });
      if (!sure) return false;
    }
  }

  const saving = progressDialog('Importerar', 'Sparar…');
  saving.set(0.5);
  try {
    if (mode === 'replace') {
      for (const e of await db.listExams()) forgetExam(e.id);
    }
    await db.importData(data, mode);
  } catch (err) {
    saving.close();
    await alertDialog({
      title: 'Importen kunde inte slutföras',
      message: [
        err instanceof db.StorageFullError ? err.message : 'Ett oväntat fel inträffade när datan skulle sparas.',
        'Ingenting har ändrats — din tidigare data finns kvar.',
      ],
    });
    return false;
  }
  saving.close();
  toast(mode === 'merge' ? 'Säkerhetskopian är ihopslagen med din data.' : 'Säkerhetskopian är återställd.', {
    tone: 'ok',
  });
  return true;
}
