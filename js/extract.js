/**
 * extract.js — kör igenkänningen för en sparad tenta: textlager → detect →
 * klipp → autobeskärning. Används vid uppladdning, vid omanalys och av
 * AI-läget (som bara byter ut "detect" mot modellens svar + ankare).
 *
 * Resultatet sparas med db.applyExtraction, som bevarar framsteg på
 * uppgifter med samma etikett och sparar en ögonblicksbild för Ångra.
 */

import * as db from './db.js';
import { getDocument, renderPagePixels } from './pdf.js';
import { extractTextLayer } from './textlayer.js';
import { detect } from './detect.js';
import { pageBounds, intervalToRegions, refineWithPixels } from './crop.js';

/** Stegen som visas under analys. */
export const STEG = Object.freeze([
  { id: 'read', label: 'Läser tentan' },
  { id: 'find', label: 'Hittar uppgifter' },
  { id: 'crop', label: 'Klipper ut figurer' },
  { id: 'done', label: 'Klar' },
]);

const textLayerCache = new Map(); // `${examId}|${which}|${andrad}` -> Promise<layer>

/** Textlagret för tentan (eller facit-PDF:en), cachat per session. */
export function getTextLayer(exam, which = 'tenta', { signal } = {}) {
  const key = `${exam.id}|${which}|${which === 'facit' ? exam.facitPdf?.filnamn : ''}`;
  if (!textLayerCache.has(key)) {
    const p = (async () => extractTextLayer(await getDocument(exam.id, which), { signal }))();
    textLayerCache.set(key, p);
    p.catch(() => textLayerCache.delete(key));
  }
  return textLayerCache.get(key);
}

export function forgetTextLayer(examId) {
  for (const k of [...textLayerCache.keys()]) if (k.startsWith(examId + '|')) textLayerCache.delete(k);
}

/**
 * Gör uppgifter med intervall (från detect eller AI-ankare) till sparbara
 * uppgifter med regioner, autobeskurna mot sidornas pixlar.
 * @param {object} exam
 * @param {Array} found uppgifter med start/end/facit (och ev. ruta/facitRuta)
 * @param {{layer, facitLayer, kalla:'text'|'ai', signal?:AbortSignal}} o
 */
export async function buildTasks(exam, found, { layer, facitLayer, kalla, signal }) {
  const bounds = layer && !layer.saknas ? pageBounds(layer) : new Map();
  const fbounds = facitLayer && !facitLayer.saknas ? pageBounds(facitLayer) : new Map();
  const rough = found.map((t) => {
    const regions = t.start ? intervalToRegions(t, bounds) : t.ruta ? [t.ruta] : [];
    let sol = [];
    if (t.facit) sol = intervalToRegions(t.facit, t.facit.pdf === 'facit' ? fbounds : bounds);
    else if (t.facitRuta) sol = [t.facitRuta];
    return { regions, sol };
  });
  const lists = rough.flatMap((r) => [r.regions, r.sol]);
  const refined = await refineWithPixels(
    lists,
    (sida, pdf) => renderPagePixels(exam.id, sida, pdf === 'facit' ? 'facit' : 'tenta'),
    { signal },
  );
  return found.map((t, i) => {
    const regions = refined[2 * i].length ? refined[2 * i] : rough[i].regions;
    const solutionRegions = refined[2 * i + 1].length ? refined[2 * i + 1] : rough[i].sol;
    return db.normalizeTask(
      {
        id: db.uid(),
        examId: exam.id,
        etikett: t.etikett,
        poang: t.poang,
        ordning: i,
        regions,
        solutionRegions,
        delmoment: t.delmoment,
        kalla,
        sakerhet: t.sakerhet,
        anmarkningar: t.anmarkningar,
      },
      exam.antalSidor,
      exam.facitPdf?.antalSidor ?? 0,
    );
  });
}

/**
 * Kör textigenkänningen (gratis, lokalt) för en sparad tenta.
 * @param {string} examId
 * @param {{onStep?:(id:string)=>void, signal?:AbortSignal}} o
 * @returns {Promise<{tasks:object[], extraktion:object, result:object}>}
 */
export async function recognizeText(examId, { onStep = () => {}, signal } = {}) {
  const exam = await db.getExam(examId);
  if (!exam) throw new Error('Tentan finns inte längre.');
  onStep('read');
  const layer = await getTextLayer(exam, 'tenta', { signal });
  const facitLayer = exam.facitPdf ? await getTextLayer(exam, 'facit', { signal }).catch(() => null) : null;
  if (signal?.aborted) throw new DOMException('Avbrutet', 'AbortError');
  onStep('find');
  const result = detect(layer, { facitLayer });
  onStep('crop');
  const tasks = result.tasks.length ? await buildTasks(exam, result.tasks, { layer, facitLayer, kalla: db.KALLA.TEXT, signal }) : [];
  const extraktion = {
    metod: tasks.length ? db.METOD.TEXT : db.METOD.INGEN,
    tidpunkt: new Date().toISOString(),
    godkand: null,
    sammanfattning: result.sammanfattning,
    forslag: result.forslag,
    textlagerSaknas: result.textlagerSaknas,
    facitFall: result.facitFall,
  };
  onStep('done');
  return { tasks, extraktion, result };
}

/** Kör textigenkänningen och sparar resultatet (med Ångra-ögonblicksbild). */
export async function recognizeAndSave(examId, opts = {}) {
  const r = await recognizeText(examId, opts);
  const saved = await db.applyExtraction(examId, r.tasks, r.extraktion);
  return { ...r, ...saved };
}
