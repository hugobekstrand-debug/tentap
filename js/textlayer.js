/**
 * textlayer.js — läser PDF:ens textlager och bygger RADER.
 *
 * Koordinater: allt i resultatet är normaliserat (0–1) mot sidans viewport
 * vid skala 1 (rotation inräknad), med origo UPPE till vänster — samma
 * system som markeringarnas regioner. PDF:ens eget origo ligger nere till
 * vänster; viewport-transformen vänder på det.
 *
 * Varje rad: { sida, yTopp, yBotten, xStart, xSlut, text, norm, storlek,
 *              fet, fetStart, brus }
 *   storlek  = största teckenstorlek på raden (andel av sidhöjden)
 *   fet      = minst hälften av tecknen är fetstil
 *   fetStart = radens första ord är fetstil (typiskt för "Problem 1." följt av brödtext)
 *   brus     = sidhuvud, sidfot eller sidnummer (utesluts ur alla klipp)
 *
 * Allt utom extractTextLayer är rena funktioner utan DOM- eller PDF.js-beroende
 * (testas i tests.html). extractTextLayer använder bara dokumentobjektet.
 */

/** Under så här många tecken per sida i snitt räknas PDF:en som inskannad. */
export const MIN_TECKEN_PER_SIDA = 50;

/** Andel av sidhöjden överst/nederst där sidhuvud och sidfot letas. */
const KANT = 0.12;

const LIGATURER = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

/**
 * Normaliserar text för matchning: Unicode NFC (å/ä/ö som ett tecken),
 * ligaturer, typografiska apostrofer/streck, icke-brytande blanksteg →
 * vanligt, komprimerade blanksteg, gemener.
 */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURER[c] || c)
    .replace(/[    - 　]/g, ' ')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Samma rensning som normalizeText men med bevarade versaler (för visning). */
export function cleanText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURER[c] || c)
    .replace(/[    - 　]/g, ' ')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BOLD_RE = /(bold|black|heavy|semibold|demibold|demi|[-,]bd?$|-b$)/i;

/** Avgör om ett typsnittsnamn är fetstil ("ABCDEF+Times-Bold", "Helvetica-Bold"). */
export function isBoldFontName(name) {
  return !!name && BOLD_RE.test(String(name).replace(/^[A-Z]{6}\+/, ''));
}

/**
 * Bygger rader av textblock. Rent: inga PDF.js-objekt.
 * @param {Array<{str:string,x:number,y:number,w:number,size:number,bold?:boolean}>} items
 *   x = vänsterkant, y = baslinje (båda i punkter, origo uppe till vänster),
 *   w = bredd, size = teckenstorlek (punkter)
 * @param {{sida:number, w:number, h:number}} page sidans storlek i punkter
 * @returns rader sorterade uppifrån och ned, vänster till höger
 */
export function buildLines(items, page) {
  const list = items
    .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '' && it.size > 0)
    .map((it) => ({ ...it, w: Math.max(0, it.w || 0) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  /** @type {Array<{y:number,size:number,items:object[]}>} */
  const groups = [];
  for (const it of list) {
    // Rad-tolerans: halva teckenhöjden (index/exponenter hamnar på samma rad).
    let g = null;
    for (let k = groups.length - 1; k >= 0 && k >= groups.length - 3; k--) {
      const cand = groups[k];
      if (Math.abs(cand.y - it.y) <= 0.5 * Math.max(cand.size, it.size)) {
        g = cand;
        break;
      }
    }
    if (!g) {
      g = { y: it.y, size: it.size, items: [] };
      groups.push(g);
    }
    g.items.push(it);
    if (it.size > g.size) {
      g.size = it.size;
      g.y = it.y; // baslinjen från den största texten
    }
  }

  const lines = groups.map((g) => {
    const its = g.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let boldChars = 0;
    let chars = 0;
    for (const it of its) {
      const s = it.str;
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        const needSpace = gap > 0.18 * Math.min(it.size, g.size) && !/\s$/.test(text) && !/^\s/.test(s);
        if (needSpace) text += ' ';
      }
      text += s;
      prevEnd = Math.max(prevEnd ?? -Infinity, it.x + it.w);
      const n = s.replace(/\s/g, '').length;
      chars += n;
      if (it.bold) boldChars += n;
    }
    const first = its[0];
    const minY = Math.min(...its.map((it) => it.y - 0.95 * it.size));
    const maxY = Math.max(...its.map((it) => it.y + 0.25 * it.size));
    const xEnd = Math.max(...its.map((it) => it.x + it.w));
    const clean = cleanText(text);
    return {
      sida: page.sida,
      yTopp: clamp01(minY / page.h),
      yBotten: clamp01(maxY / page.h),
      xStart: clamp01(first.x / page.w),
      xSlut: clamp01(xEnd / page.w),
      text: clean,
      norm: normalizeText(clean),
      storlek: g.size / page.h,
      fet: chars > 0 && boldChars / chars >= 0.5,
      fetStart: !!first.bold,
      brus: false,
    };
  });
  return lines.filter((l) => l.norm !== '').sort((a, b) => a.yTopp - b.yTopp || a.xStart - b.xStart);
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

const PAGE_NUMBER_RE = /^(?:(?:sida|page|s\.|p\.)\s*)?[-–(]?\s*\d{1,3}\s*[-–)]?(?:\s*(?:\/|av|of)\s*\d{1,3})?$/;
/**
 * Rader som ser ut som uppgiftsrubriker ("Problem 3", "4.") jämförs exakt,
 * inte med normaliserade siffror. Annars skulle "Problem 3" överst på sida 2
 * och "Problem 4" överst på sida 3 tolkas som ett upprepat sidhuvud.
 */
const HEADINGISH_RE = /^\p{L}{1,12}\.?\s*\d{1,2}(?=$|[\s.:)(\[\],;–-])|^\d{1,2}\s*[.)]/u;

/**
 * Markerar sidhuvuden, sidfötter och sidnummer som brus och räknar ut om
 * textlager saknas. Muterar och returnerar layer.
 *  - En rad i övre/nedre kanten som (med siffror normaliserade) återkommer
 *    på minst hälften av sidorna (och minst två) är sidhuvud/sidfot.
 *  - En ensam siffra ("3", "- 3 -", "Sida 3 av 8") i kanten är ett sidnummer.
 * @param {{sidor:Array<{sida:number,lines:object[]}>}} layer
 */
export function finalizeLayer(layer) {
  const sidor = layer.sidor;
  const inEdge = (l) => l.yBotten < KANT || l.yTopp > 1 - KANT;
  const key = (l) => `${l.yTopp < 0.5 ? 'top' : 'bot'}|${HEADINGISH_RE.test(l.norm) ? l.norm : l.norm.replace(/\d+/g, '#')}`;
  const pagesWith = new Map();
  for (const p of sidor) {
    const seen = new Set();
    for (const l of p.lines) if (inEdge(l)) seen.add(key(l));
    for (const k of seen) pagesWith.set(k, (pagesWith.get(k) || 0) + 1);
  }
  const need = Math.max(2, Math.ceil(sidor.length / 2));
  let tecken = 0;
  for (const p of sidor) {
    for (const l of p.lines) {
      tecken += l.norm.length;
      if (!inEdge(l)) continue;
      if (PAGE_NUMBER_RE.test(l.norm) || (sidor.length >= 2 && (pagesWith.get(key(l)) || 0) >= need)) l.brus = true;
    }
  }
  layer.tecken = tecken;
  layer.medelTecken = sidor.length ? tecken / sidor.length : 0;
  layer.saknas = layer.medelTecken < MIN_TECKEN_PER_SIDA;
  return layer;
}

/** 2D-transform: a × b (PDF-matriser [a,b,c,d,e,f]). */
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Läser textlagret för alla sidor i ett PDF.js-dokument.
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {{signal?:AbortSignal, onPage?:(n:number,total:number)=>void}} opts
 * @returns {Promise<{sidor:Array<{sida,w,h,lines}>, tecken:number, medelTecken:number, saknas:boolean}>}
 */
export async function extractTextLayer(doc, { signal, onPage } = {}) {
  const sidor = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal?.aborted) throw new DOMException('Avbrutet', 'AbortError');
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Typsnittsnamnen (för fetstil) finns först när sidans operatorlista är laddad.
    let fontsReady = false;
    try {
      await page.getOperatorList();
      fontsReady = true;
    } catch {
      /* fetstil blir okänd, inte ett fel */
    }
    const boldCache = new Map();
    const boldOf = (fontName) => {
      if (!fontsReady || !fontName) return false;
      if (boldCache.has(fontName)) return boldCache.get(fontName);
      let b = false;
      try {
        if (page.commonObjs.has(fontName)) {
          const f = page.commonObjs.get(fontName);
          b = !!(f?.bold || f?.black || isBoldFontName(f?.name) || isBoldFontName(f?.loadedName));
        }
      } catch {
        b = false;
      }
      if (!b) b = isBoldFontName(content.styles?.[fontName]?.fontFamily);
      boldCache.set(fontName, b);
      return b;
    };
    const items = [];
    for (const it of content.items) {
      if (typeof it.str !== 'string' || !it.transform) continue;
      const tx = mul(vp.transform, it.transform);
      const size = Math.hypot(tx[2], tx[3]);
      // Lodrät text (t.ex. marginaltext) hoppas över.
      if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.5 && Math.abs(tx[0]) < 0.01 * size) continue;
      items.push({ str: it.str, x: tx[4], y: tx[5], w: it.width * (vp.scale || 1), size, bold: boldOf(it.fontName) });
    }
    sidor.push({ sida: n, w: vp.width, h: vp.height, lines: buildLines(items, { sida: n, w: vp.width, h: vp.height }) });
    page.cleanup();
    onPage?.(n, doc.numPages);
  }
  return finalizeLayer({ sidor });
}
