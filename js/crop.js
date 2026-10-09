/**
 * crop.js — gör om intervall i dokumentet till rektanglar (regioner) och
 * beskär dem mot innehållet. Samma funktioner används av textigenkänningen
 * och AI-läget.
 *
 * Regionformat: samma som markeringsläget, { sida, x, y, w, h } normaliserat
 * 0–1 mot sidan (origo uppe till vänster), plus pdf: "facit" för regioner i
 * en separat facit-PDF.
 *
 * Regler:
 *  - Klippet börjar vid rubrikradens överkant (med lite luft, men aldrig
 *    ovanför föregående rads underkant – omslag och tidigare uppgift följer
 *    inte med) och slutar strax ovanför nästa rubrik/facit-markör/avslutsrad.
 *  - Över flera sidor: en rektangel per sida. Fortsättningssidor börjar under
 *    sidhuvudet och slutar ovanför sidfoten.
 *  - Autobeskärning: hitta de icke-vita pixlarnas yttre gräns inom
 *    rektangeln och lägg på lite luft – men aldrig utanför rektangeln, så
 *    nästa uppgifts rubrik kan aldrig komma med.
 *
 * Allt utom refineWithPixels är rena funktioner (testas i tests.html).
 */

const LUFT_OVER = 0.008; // luft ovanför rubriken (andel av sidhöjden)
const GLAPP_UNDER = 0.004; // glapp ovanför nästa rubrik
const MIN_HOJD = 0.012;
const KANT = 0.12;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Förberäknar gränser per sida: var sidhuvudet slutar, var sidfoten börjar
 * och textens vänster/högerkant.
 * @param {{sidor:Array<{sida:number,lines:object[]}>}} layer
 */
export function pageBounds(layer) {
  const map = new Map();
  let minX = 1;
  let maxX = 0;
  for (const p of layer.sidor) {
    for (const l of p.lines) {
      if (l.brus) continue;
      minX = Math.min(minX, l.xStart);
      maxX = Math.max(maxX, l.xSlut);
    }
  }
  if (minX > maxX) {
    minX = 0.05;
    maxX = 0.95;
  }
  const x0 = clamp(minX - 0.04, 0.01, 0.12);
  const x1 = clamp(maxX + 0.04, 0.88, 0.99);
  for (const p of layer.sidor) {
    const head = p.lines.filter((l) => l.brus && l.yTopp < KANT);
    const foot = p.lines.filter((l) => l.brus && l.yBotten > 1 - KANT);
    const content = p.lines.filter((l) => !l.brus);
    map.set(p.sida, {
      top: head.length ? Math.max(...head.map((l) => l.yBotten)) + 0.006 : 0.025,
      bottom: foot.length ? Math.min(...foot.map((l) => l.yTopp)) - 0.006 : 0.975,
      content,
      x0,
      x1,
    });
  }
  return map;
}

/** Underkanten på den lägsta innehållsraden ovanför y, eller null. */
function lastBottomAbove(content, y) {
  let best = null;
  for (const l of content) if (l.yBotten <= y + 0.002 && (best === null || l.yBotten > best)) best = l.yBotten;
  return best;
}

/**
 * Gör ett intervall till en rektangel per sida.
 * @param {{start:{sida:number,y:number}, end:{sida:number,y:number|null}, pdf?:'facit'}} interval
 *   end.y === null betyder "till sidans innehålls slut" (dokumentets slut)
 * @param {Map} bounds från pageBounds
 * @returns {Array<{sida,x,y,w,h,pdf?}>}
 */
export function intervalToRegions(interval, bounds) {
  const { start, end } = interval;
  const out = [];
  if (!start || !end) return out;
  for (let sida = start.sida; sida <= end.sida; sida++) {
    const b = bounds.get(sida);
    if (!b) continue;
    let top = b.top;
    if (sida === start.sida) {
      // Aldrig ovanför föregående rad: luften mellan raderna delas på mitten,
      // så att två intervall som möts (uppgift → facit) aldrig överlappar.
      const prevBottom = lastBottomAbove(b.content, start.y);
      top = Math.max(start.y - LUFT_OVER, prevBottom === null ? 0 : (prevBottom + start.y) / 2, Math.min(b.top, start.y));
    }
    let bottom = b.bottom; // dokumentets slut (end.y === null): till sidfoten
    if (sida === end.sida && end.y !== null) {
      const prevBottom = lastBottomAbove(b.content, end.y);
      bottom = Math.min(bottom, end.y - GLAPP_UNDER, prevBottom === null ? Infinity : Math.max((prevBottom + end.y) / 2, prevBottom));
    }
    if (bottom - top < MIN_HOJD) continue;
    // Bara marginal ovanför nästa rubrik på en fortsättningssida: hoppa över.
    if (sida !== start.sida && bottom - top < 0.03 && !b.content.some((l) => l.yTopp >= top && l.yBotten <= bottom)) continue;
    const r = { sida, x: b.x0, y: clamp(top, 0, 1), w: b.x1 - b.x0, h: clamp(bottom, 0, 1) - clamp(top, 0, 1) };
    if (interval.pdf === 'facit') r.pdf = 'facit';
    out.push(r);
  }
  return out;
}

/**
 * Autobeskär en rektangel mot innehållet i en bild (RGBA, rad för rad).
 * @param {Uint8ClampedArray|Uint8Array} data RGBA-pixlar
 * @param {number} width bildens bredd i pixlar
 * @param {number} height bildens höjd i pixlar
 * @param {{x:number,y:number,w:number,h:number}} rect i pixlar
 * @param {{threshold?:number, pad?:number}} opts pad i pixlar
 * @returns {{x,y,w,h}|null} beskuren rektangel (inom rect), eller null om den är tom
 */
export function autocropRect(data, width, height, rect, { threshold = 235, pad = 6 } = {}) {
  const x0 = clamp(Math.floor(rect.x), 0, width);
  const y0 = clamp(Math.floor(rect.y), 0, height);
  const x1 = clamp(Math.ceil(rect.x + rect.w), 0, width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), 0, height);
  let top = -1;
  let bottom = -1;
  let left = x1;
  let right = -1;
  for (let y = y0; y < y1; y++) {
    let rowHas = false;
    const rowOff = y * width * 4;
    for (let x = x0; x < x1; x++) {
      const o = rowOff + x * 4;
      const a = data[o + 3];
      if (a < 16) continue;
      // Mörkaste kanalen avgör (färgade figurer räknas också).
      const v = Math.min(data[o], data[o + 1], data[o + 2]);
      if (v < threshold) {
        rowHas = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (rowHas) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;
  const nx0 = Math.max(x0, left - pad);
  const ny0 = Math.max(y0, top - pad);
  const nx1 = Math.min(x1, right + 1 + pad);
  const ny1 = Math.min(y1, bottom + 1 + pad);
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

/**
 * Beskär normaliserade regioner mot en renderad sida (rent, givet pixlarna).
 * Tomma regioner (bara vitt) tas bort.
 * @param {Array} regions regioner på SAMMA sida
 * @param {{data:Uint8ClampedArray, width:number, height:number}} img sidan renderad
 */
export function cropRegionsOnPage(regions, img, { padPx } = {}) {
  const pad = padPx ?? Math.max(4, Math.round(img.height * 0.006));
  const out = [];
  for (const r of regions) {
    const px = { x: r.x * img.width, y: r.y * img.height, w: r.w * img.width, h: r.h * img.height };
    const c = autocropRect(img.data, img.width, img.height, px, { pad });
    if (!c || c.h < 3 || c.w < 3) continue;
    const n = { ...r, x: c.x / img.width, y: c.y / img.height, w: c.w / img.width, h: c.h / img.height };
    out.push(n);
  }
  return out;
}

/**
 * Beskär alla regioner mot sidornas pixlar. renderPage(sida, pdf) ska ge
 * {data,width,height} för sidan (varje sida renderas bara en gång).
 * @param {Array<Array>} regionLists listor med regioner
 * @param {(sida:number, pdf:'tenta'|'facit') => Promise<{data,width,height}>} renderPage
 */
export async function refineWithPixels(regionLists, renderPage, { signal } = {}) {
  const byPage = new Map();
  regionLists.forEach((list, li) =>
    list.forEach((r, ri) => {
      const key = `${r.pdf === 'facit' ? 'facit' : 'tenta'}|${r.sida}`;
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push({ li, ri, r });
    }),
  );
  const result = regionLists.map((list) => list.map(() => undefined));
  for (const [key, entries] of byPage) {
    if (signal?.aborted) throw new DOMException('Avbrutet', 'AbortError');
    const [pdf, sidaStr] = key.split('|');
    let img = null;
    try {
      img = await renderPage(Number(sidaStr), pdf);
    } catch {
      img = null;
    }
    for (const e of entries) {
      if (!img) {
        result[e.li][e.ri] = e.r; // kunde inte rendera: behåll den oberörda rektangeln
        continue;
      }
      const [c] = cropRegionsOnPage([e.r], img);
      result[e.li][e.ri] = c || null;
    }
  }
  return result.map((list) => list.filter(Boolean));
}
