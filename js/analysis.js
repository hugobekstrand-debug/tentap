/**
 * analysis.js — delade flöden för (om)analys: textigenkänning med stegvis
 * förlopp, separat facit-PDF och sparande med Ångra. Används av
 * granskningsvyn, startsidan och AI-läget (premium.js).
 */

import * as db from './db.js';
import { inspectPdf, forgetExam, PdfError } from './pdf.js';
import { recognizeText, forgetTextLayer, STEG } from './extract.js';
import { pickFile } from './backup.js';
import { h, toast, openDialog, confirmDialog, alertDialog, stepper, plural } from './ui.js';

export const METOD_TEXT = {
  text: 'Textigenkänning',
  ai: 'AI-igenkänning',
  manuell: 'Manuell markering',
  ingen: 'Inte analyserad',
};

/* ------------------------------------------------------------------ */
/* Delade flöden (används även av biblioteket)                          */
/* ------------------------------------------------------------------ */

/**
 * Sparar ett nytt igenkänningsresultat och erbjuder Ångra i en toast.
 * Framsteg bevaras på uppgifter med samma etikett.
 */
export async function applyWithUndo(examId, tasks, extraktion) {
  const res = await db.applyExtraction(examId, tasks, extraktion);
  const parts = [`${plural(tasks.length, 'uppgift', 'uppgifter')} från ${METOD_TEXT[extraktion.metod]?.toLowerCase() || 'analysen'}.`];
  if (res.preserved) parts.push(`Framsteg bevarat på ${plural(res.preserved, 'uppgift', 'uppgifter')}.`);
  if (res.exam.foregaendeUppgifter) {
    toast(parts.join(' '), {
      tone: 'ok',
      duration: 10000,
      actionLabel: 'Ångra',
      onAction: async () => {
        try {
          await db.undoExtraction(examId);
          toast('Det tidigare resultatet är återställt.');
        } catch {
          toast('Det gick inte att ångra. Ladda om sidan och försök igen.', { tone: 'error' });
        }
      },
    });
  } else {
    toast(parts.join(' '), { tone: 'ok' });
  }
  return res;
}

/** Kör textigenkänningen igen med stegvis förlopp, och sparar med Ångra. */
export async function rerunTextRecognition(examId) {
  const ctrl = new AbortController();
  const steps = h('div', { class: 'analysis-steps' }, stepper(STEG, 'read'));
  const dlg = openDialog({
    title: 'Hittar uppgifter',
    content: [h('p', null, 'Appen läser tentans text här på enheten. Inget skickas någonstans.'), steps],
    dismissible: false,
    buttons: [{ label: 'Avbryt', variant: 'secondary', onClick: () => ctrl.abort() }],
  });
  let r;
  try {
    r = await recognizeText(examId, { signal: ctrl.signal, onStep: (s) => steps.replaceChildren(stepper(STEG, s)) });
  } catch (err) {
    dlg.close(null);
    if (err?.name === 'AbortError') {
      toast('Analysen avbröts. Inget är ändrat.');
      return null;
    }
    console.error(err);
    await alertDialog({
      title: 'Uppgifterna kunde inte hittas',
      message: [
        err instanceof PdfError ? err.message : 'Något i PDF:en gick inte att läsa automatiskt.',
        'Dina uppgifter är orörda. Markera själv, eller prova AI-igenkänning (Premium).',
      ],
    });
    return null;
  }
  dlg.close(null);
  if (!r.tasks.length) {
    await alertDialog({
      title: r.extraktion.textlagerSaknas ? 'PDF:en saknar text' : 'Inga uppgifter hittades',
      message: [r.extraktion.forslag || 'Prova AI-igenkänning (Premium) eller markera själv.', 'Dina uppgifter är orörda.'],
    });
    return null;
  }
  return applyWithUndo(examId, r.tasks, r.extraktion);
}

/** Låter användaren välja en separat facit-PDF och sparar den till tentan. */
export async function addFacitPdf(examId) {
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return false;
  let data;
  let info;
  try {
    data = await file.arrayBuffer();
    const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
    if (!head.includes('%PDF-')) throw new PdfError('invalid', 'Filen verkar inte vara en giltig PDF. Välj facit i PDF-format.');
    info = await inspectPdf(data);
  } catch (err) {
    await alertDialog({
      title: 'Facit-PDF:en kunde inte läsas',
      message: [err instanceof PdfError ? err.message : 'Filen gick inte att öppna. Prova att spara om den som en ny PDF.'],
    });
    return false;
  }
  await db.setFacitPdf(examId, data, { filnamn: file.name, storlek: file.size, antalSidor: info.antalSidor, sidor: info.sidor });
  forgetExam(examId, 'facit');
  forgetTextLayer(examId);
  const exam = await db.getExam(examId);
  const tasks = await db.listTasks(examId);
  if (!tasks.length || exam.extraktion.metod === db.METOD.TEXT || exam.extraktion.metod === db.METOD.INGEN) {
    await rerunTextRecognition(examId);
    return true;
  }
  const ok = await confirmDialog({
    title: 'Koppla facit till uppgifterna?',
    message: [
      `${file.name} är sparad. Ska appen leta upp facit för varje uppgift nu?`,
      'Uppgifterna hittas då om med textigenkänningen. Framsteg bevaras på uppgifter med samma etikett, och du kan ångra.',
    ],
    confirmLabel: 'Koppla facit',
    cancelLabel: 'Senare',
  });
  if (ok) await rerunTextRecognition(examId);
  else toast('Facit-PDF:en är sparad.');
  return true;
}
