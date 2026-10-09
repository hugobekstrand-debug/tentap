/**
 * pdf.js — tunn wrapper runt PDF.js.
 *
 * - Laddar PDF.js från vendor/ (fungerar offline). Saknas filerna faller vi
 *   tillbaka på jsDelivr med EXAKT samma version.
 * - Öppnade dokument cachas per tenta (begränsat antal).
 * - Uppgiftsbilder renderas som utsnitt direkt ur PDF:en (viewport-offset),
 *   i hög upplösning, och cachas i minnet som PNG-blobbar med en bytegräns.
 *   Källdatan i IndexedDB rörs aldrig.
 */

import { getPdfData } from './db.js';

export const PDFJS_VERSION = '4.10.38';
const VENDOR_BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
const CDN_ROOT = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

/** Högsta antal pixlar per canvas (iOS Safari klarar ca 16,7 Mpx). */
const MAX_CANVAS_PX = 16_000_000;
/** Minnesgräns för cachade uppgiftsbilder. */
const MAX_IMAGE_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_IMAGE_CACHE_ENTRIES = 300;
const MAX_OPEN_DOCS = 8;

let libPromise = null;
let assetBase = VENDOR_BASE; // där cmaps/ och standard_fonts/ finns

export class PdfError extends Error {
  /** @param {'password'|'invalid'|'missing'|'unsupported'|'unknown'} code */
  constructor(code, message, cause) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.cause = cause;
  }
}

/** Laddar PDF.js (vendor först, annars CDN). */
export function loadPdfLib() {
  if (!libPromise) {
    libPromise = (async () => {
      try {
        const lib = await import(VENDOR_BASE + 'pdf.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = VENDOR_BASE + 'pdf.worker.min.mjs';
        assetBase = VENDOR_BASE;
        return lib;
      } catch (vendorErr) {
        console.warn('PDF.js saknas i vendor/, försöker CDN', vendorErr);
        try {
          const lib = await import(CDN_ROOT + 'legacy/build/pdf.min.mjs');
          lib.GlobalWorkerOptions.workerSrc = CDN_ROOT + 'legacy/build/pdf.worker.min.mjs';
          assetBase = CDN_ROOT;
          return lib;
        } catch (cdnErr) {
          throw new PdfError(
            'unsupported',
            'PDF-läsaren kunde inte laddas. Kontrollera att mappen vendor/pdfjs finns (se README), ' +
              'eller anslut till internet och ladda om sidan.',
            cdnErr,
          );
        }
      }
    })();
    libPromise.catch(() => {
      libPromise = null;
    });
  }
  return libPromise;
}

function mapError(err) {
  if (err instanceof PdfError) return err;
  const name = err?.name || '';
  if (name === 'PasswordException') {
    return new PdfError(
      'password',
      'Den här PDF:en är lösenordsskyddad. Ta bort lösenordet (t.ex. genom att skriva ut den som en ny PDF) och försök igen.',
      err,
    );
  }
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new PdfError(
      'invalid',
      'Filen gick inte att öppna som PDF. Den kan vara skadad eller ofullständigt nedladdad. Prova att ladda ner den igen.',
      err,
    );
  }
  if (name === 'MissingPDFException') {
    return new PdfError('missing', 'PDF:en hittades inte.', err);
  }
  return new PdfError(
    'unknown',
    'PDF:en kunde inte läsas. Prova att spara om den som en ny PDF och ladda upp igen.',
    err,
  );
}

/** Öppnar ett PDF-dokument från en ArrayBuffer (kopieras, eftersom PDF.js tar över bufferten). */
async function openDocument(data) {
  const lib = await loadPdfLib();
  const loadingTask = lib.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: assetBase + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assetBase + 'standard_fonts/',
    isEvalSupported: false,
    enableXfa: false,
  });
  // Ingen onPassword-hanterare: en lösenordsskyddad PDF ger då PasswordException.
  try {
    return await loadingTask.promise;
  } catch (err) {
    loadingTask.destroy();
    throw mapError(err);
  }
}

/**
 * Läser in en uppladdad PDF och returnerar antal sidor och sidstorlekar
 * (i PDF-punkter, med sidrotation inräknad). Kastar PdfError med vänligt
 * felmeddelande.
 */
export async function inspectPdf(data) {
  const doc = await openDocument(data);
  try {
    const sidor = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      sidor.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100 });
      page.cleanup();
    }
    if (!sidor.length) throw new PdfError('invalid', 'PDF:en innehåller inga sidor.');
    return { antalSidor: doc.numPages, sidor };
  } finally {
    doc.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* Dokumentcache                                                       */
/* ------------------------------------------------------------------ */

const docs = new Map(); // "examId|tenta" eller "examId|facit" -> Promise<PDFDocumentProxy>

/**
 * Öppnar (och cachar) tentans PDF, eller dess separata facit-PDF.
 * @param {'tenta'|'facit'} which
 */
export function getDocument(examId, which = 'tenta') {
  const key = `${examId}|${which}`;
  if (docs.has(key)) {
    const p = docs.get(key);
    docs.delete(key);
    docs.set(key, p); // LRU: flytta sist
    return p;
  }
  const p = (async () => {
    const data = await getPdfData(examId, which);
    if (!data) {
      throw new PdfError('missing', which === 'facit' ? 'Facit-PDF:en för den här tentan saknas i lagringen.' : 'PDF:en för den här tentan saknas i lagringen.');
    }
    return openDocument(data);
  })();
  docs.set(key, p);
  p.catch(() => docs.delete(key));
  while (docs.size > MAX_OPEN_DOCS) {
    const [oldKey, oldP] = docs.entries().next().value;
    docs.delete(oldKey);
    oldP.then((d) => d.destroy()).catch(() => {});
  }
  return p;
}

/** Öppnar en PDF direkt från data (utan cache), t.ex. vid igenkänning före sparande. */
export function openPdfData(data) {
  return openDocument(data);
}

/** Stäng och glöm en tentas dokument och bilder (t.ex. när tentan tas bort). */
export function forgetExam(examId, which = null) {
  for (const w of which ? [which] : ['tenta', 'facit']) {
    const key = `${examId}|${w}`;
    const p = docs.get(key);
    docs.delete(key);
    p?.then((d) => d.destroy()).catch(() => {});
  }
  for (const [key, entry] of imageCache) {
    if (key.startsWith(examId + '|') && (!which || key.includes(`|${which}|`))) {
      URL.revokeObjectURL(entry.url);
      imageBytes -= entry.bytes;
      imageCache.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function deviceScale() {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
}

function capScale(scale, w, h) {
  const px = w * scale * h * scale;
  return px > MAX_CANVAS_PX ? scale * Math.sqrt(MAX_CANVAS_PX / px) : scale;
}

/**
 * Renderar en hel sida i en canvas med bredden cssWidth (CSS-pixlar),
 * i enhetens pixeltäthet. Ritar först i en dold canvas så att den synliga
 * aldrig blinkar tom. Avbryts via signal.
 */
export async function renderPage(examId, pageNum, canvas, cssWidth, signal) {
  const doc = await getDocument(examId);
  if (signal?.aborted) return false;
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = capScale((cssWidth / base.width) * deviceScale(), base.width, base.height);
  const viewport = page.getViewport({ scale });
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.floor(viewport.width));
  tmp.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvasContext: tmp.getContext('2d'), viewport });
  const onAbort = () => task.cancel();
  signal?.addEventListener('abort', onAbort);
  try {
    await task.promise;
  } catch (err) {
    tmp.width = tmp.height = 0;
    if (err?.name === 'RenderingCancelledException') return false;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) {
    tmp.width = tmp.height = 0;
    return false;
  }
  canvas.width = tmp.width;
  canvas.height = tmp.height;
  canvas.getContext('2d').drawImage(tmp, 0, 0);
  tmp.width = tmp.height = 0; // frigör minne direkt
  return true;
}

/**
 * Renderar en hel sida till pixeldata (för autobeskärning av klipp).
 * @param {'tenta'|'facit'} which
 * @returns {Promise<{data:Uint8ClampedArray,width:number,height:number}>}
 */
export async function renderPagePixels(examId, pageNum, which = 'tenta', targetHeight = 1400) {
  const doc = await getDocument(examId, which);
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = capScale(targetHeight / base.height, base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // papperets färg (bilddata, inte UI)
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: 'rgba(0,0,0,0)' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
  page.cleanup();
  return { data: img.data, width: img.width, height: img.height };
}

/* ------------------------------------------------------------------ */
/* Uppgiftsbilder (utsnitt) med LRU-cache                              */
/* ------------------------------------------------------------------ */

const imageCache = new Map(); // key -> { url, bytes, width, height }
let imageBytes = 0;
const inflight = new Map();

const docOf = (r) => (r.pdf === 'facit' ? 'facit' : 'tenta');

function cacheKey(examId, r, pxPerPt) {
  const f = (n) => n.toFixed(5);
  return `${examId}|${docOf(r)}|${r.sida}|${f(r.x)}|${f(r.y)}|${f(r.w)}|${f(r.h)}|${pxPerPt.toFixed(3)}`;
}

function remember(key, entry) {
  imageCache.set(key, entry);
  imageBytes += entry.bytes;
  while (
    (imageBytes > MAX_IMAGE_CACHE_BYTES || imageCache.size > MAX_IMAGE_CACHE_ENTRIES) &&
    imageCache.size > 1
  ) {
    const [oldKey, old] = imageCache.entries().next().value;
    imageCache.delete(oldKey);
    imageBytes -= old.bytes;
    // Vänta lite med att släppa URL:en ifall en <img> precis håller på att ladda den.
    setTimeout(() => URL.revokeObjectURL(old.url), 10_000);
  }
}

/**
 * Renderar ett utsnitt (region) av en sida till en bild.
 * @param {string} examId
 * @param {{sida:number,x:number,y:number,w:number,h:number,pdf?:'facit'}} region normaliserad
 * @param {number} pxPerPt pixlar per PDF-punkt (1 pt = 1/72 tum)
 * @returns {Promise<{url:string,width:number,height:number}>}
 */
export function regionImage(examId, region, pxPerPt) {
  const key = cacheKey(examId, region, pxPerPt);
  const hit = imageCache.get(key);
  if (hit) {
    imageCache.delete(key);
    imageCache.set(key, hit);
    return Promise.resolve(hit);
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const doc = await getDocument(examId, docOf(region));
    const page = await doc.getPage(region.sida);
    const base = page.getViewport({ scale: 1 });
    const cropW = region.w * base.width;
    const cropH = region.h * base.height;
    const scale = capScale(pxPerPt, cropW, cropH);
    const viewport = page.getViewport({
      scale,
      offsetX: -region.x * base.width * scale,
      offsetY: -region.y * base.height * scale,
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropW * scale));
    canvas.height = Math.max(1, Math.round(cropH * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // papperets färg (bilddata, inte UI)
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: 'rgba(0,0,0,0)' }).promise;
    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Bilden kunde inte skapas'))), 'image/png'),
    );
    const entry = {
      url: URL.createObjectURL(blob),
      bytes: blob.size,
      width: canvas.width,
      height: canvas.height,
    };
    canvas.width = canvas.height = 0;
    remember(key, entry);
    return entry;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

/**
 * Regionens storlek i PDF-punkter.
 * @param {object} region
 * @param {Array|object} sidorOrExam tentans sidor, eller hela tentan (då
 *   används facit-PDF:ens sidor för regioner med pdf: "facit")
 */
export function regionSizePt(region, sidorOrExam) {
  const sidor = Array.isArray(sidorOrExam)
    ? sidorOrExam
    : region.pdf === 'facit'
      ? sidorOrExam?.facitPdf?.sidor
      : sidorOrExam?.sidor;
  const s = sidor?.[region.sida - 1] || { w: 595, h: 842 };
  return { w: region.w * s.w, h: region.h * s.h };
}
