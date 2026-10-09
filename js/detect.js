/**
 * detect.js — hittar uppgifter, poäng och facit i en tentas textlager.
 *
 * Rena funktioner utan DOM: indata är raderna från textlayer.js, utdata är
 * uppgifter med intervall i dokumentet ({sida, y}) som crop.js gör om till
 * rektanglar. Samma intervall-logik används av AI-läget (via ankare).
 *
 * Översikt:
 *  1. Kandidater: rader som BÖRJAR med en rubrik.
 *     Familj 1: ord + nummer ("Problem 3.", "Uppgift 4 (3 p)", "Q2").
 *     Familj 2: bara nummer ("1." / "1)") – strängare krav, aldrig hög säkerhet.
 *  2. Sekvens: bästa strikt stigande följd per familj (helst från 1),
 *     rubriker måste ligga nära familjens median-x (hänvisningar i löptext
 *     faller bort), lika långa följder avgörs av rubrikpoäng (fet, större, ensam).
 *  3. Intervall: uppgift = rubrik → facit-markör / nästa rubrik / avslutsrad.
 *     Facit: inuti uppgiften ("Solution:"), samlat på slutet (numreringen
 *     börjar om efter "Lösningar"), eller i en separat facit-PDF.
 *  4. Poäng, delmoment, angiven totalpoäng, säkerhet, sammanfattning.
 */

import { normalizeText } from './textlayer.js';

/* ------------------------------------------------------------------ */
/* Mönster                                                             */
/* ------------------------------------------------------------------ */

const ORD = ['problem', 'uppgift', 'task', 'question', 'exercise', 'övning', 'fråga', 'assignment', 'q'];
const VISNINGSORD = {
  problem: 'Problem',
  uppgift: 'Uppgift',
  task: 'Task',
  question: 'Question',
  exercise: 'Exercise',
  övning: 'Övning',
  fråga: 'Fråga',
  assignment: 'Assignment',
  q: 'Question',
};
const EFTER_NUMMER = '(?=$|[\\s.:)(\\[\\],;–-])';
const FAM1_RE = new RegExp(`^(${ORD.join('|')})\\.?\\s*(?:nr\\.?\\s*|no\\.?\\s*|#\\s*)?(\\d{1,2})${EFTER_NUMMER}`, 'u');
const FAM2_RE = /^(\d{1,2})\s*[.)](?!\d)\s*(.*)$/u;
const LOSNING_NUMMER_RE = new RegExp(`^(?:solution|lösning)\\s+(?:(?:to|till|för)\\s+)?(?:(?:${ORD.join('|')})\\.?\\s*)?(\\d{1,2})${EFTER_NUMMER}`, 'u');

/** Facit-markör inuti en uppgift: kolon efter ordet, eller ordet ensamt på raden. */
const FACIT_RE = /^(?:solutions?|lösning(?:sförslag)?|svar|answers?|facit)(?:\s+(?:to|till|för)\s+[^:]{1,40})?\s*(?::|$)/u;
/** Rubrik för ett samlat facit på slutet. */
const SEKTION_RE = /^(?:suggested\s+)?(?:solutions?|lösningar|lösningsförslag|facit|answers)(?:\s+(?:to|till|for|för)\s+.{1,60})?\s*[:.]?$/u;
/** Avslutande rader som aldrig ingår i någon uppgift. */
const SLUT_RE = /(good luck|lycka till|that'?s all|that is all|end of (?:the )?exam|slut på tentan|tentamen slut|^slut[.!]?$)/u;

const TAL = '(\\d+(?:[.,]\\d+)?)';
const POANG_RES = [
  new RegExp(`[(\\[]\\s*${TAL}\\s*(?:p|pt|pts|points?|poäng|po|marks?|m)\\.?\\s*[)\\]]`, 'u'),
  new RegExp(`${TAL}\\s*(?:poäng|points?|pts|marks)(?![\\p{L}])`, 'u'),
];
/** "3p" / "3 p" i slutet av en rubrik- eller deluppgiftsrad. */
const POANG_SLUT_RE = new RegExp(`${TAL}\\s?p\\.?\\s*$`, 'u');
const DELUPPGIFT_RE = /^(?:\(([a-h])\)|([a-h])[.)])\s*(.*)$/u;

const TOTAL_RES = [
  new RegExp(`total(?:t|a|en)?\\s*(?:of\\s+|på\\s+|:\\s*)?(?:maximum\\s+)?${TAL}\\s*(?:points?|poäng|p|pts|marks)(?![\\p{L}])`, 'u'),
  new RegExp(`(?:max(?:imum|imalt)?|maxpoäng|maximal poäng)\\s*:?\\s*${TAL}\\s*(?:points?|poäng|p|pts|marks)(?![\\p{L}])`, 'u'),
  new RegExp(`${TAL}\\s*(?:points?|poäng|marks)\\s+(?:totalt|in total|total)(?![\\p{L}])`, 'u'),
  new RegExp(`(?:maxpoäng|maximal poäng|max(?:imum)? (?:score|points))\\s*:?\\s*${TAL}`, 'u'),
];

const num = (s) => Number(String(s).replace(',', '.'));

/** Första poängangivelse i en (normaliserad) rad, eller null. */
export function findPoints(norm, { allowBare = false } = {}) {
  for (const re of POANG_RES) {
    const m = norm.match(re);
    if (m) return num(m[1]);
  }
  if (allowBare) {
    const m = norm.match(POANG_SLUT_RE);
    if (m) return num(m[1]);
  }
  return null;
}

/** Angiven totalpoäng i en rad ("total of 25 points", "totalt 25 poäng", "max 25 p"). */
export function findTotal(norm) {
  for (const re of TOTAL_RES) {
    const m = norm.match(re);
    if (m) return num(m[1]);
  }
  return null;
}

export const isFacitMarker = (norm) => FACIT_RE.test(norm);
export const isSectionMarker = (norm) => norm.length <= 70 && SEKTION_RE.test(norm);
export const isEndLine = (norm) => norm.length <= 80 && SLUT_RE.test(norm);

/**
 * Tolkar en rad som rubrikkandidat.
 * @returns {{familj:1|2, ord:string|null, nummer:number, rest:string}|null}
 */
export function parseHeading(norm) {
  const m1 = norm.match(FAM1_RE);
  if (m1) return { familj: 1, ord: m1[1], nummer: Number(m1[2]), rest: norm.slice(m1[0].length) };
  const m2 = norm.match(FAM2_RE);
  if (m2) return { familj: 2, ord: null, nummer: Number(m2[1]), rest: m2[2] || '' };
  return null;
}

/* ------------------------------------------------------------------ */
/* Hjälpare                                                            */
/* ------------------------------------------------------------------ */

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Alla innehållsrader (utan brus) i läsordning, med globalt index. */
export function flattenLines(layer) {
  const out = [];
  for (const p of layer.sidor) {
    const lines = p.lines.filter((l) => !l.brus).sort((a, b) => a.yTopp - b.yTopp || a.xStart - b.xStart);
    for (const l of lines) out.push(l);
  }
  out.forEach((l, i) => (l.idx = i));
  return out;
}

/** "Ensam" rubrik: inget mer än poäng och skiljetecken efter numret. */
function isAlone(rest) {
  const r = rest
    .replace(POANG_RES[0], '')
    .replace(POANG_RES[1], '')
    .replace(POANG_SLUT_RE, '')
    .replace(/[\s.:)(\][,;–-]/g, '');
  return r.length < 3;
}

function headingScore(line, h, bodySize) {
  let s = 0;
  if (line.fetStart || line.fet) s += 2;
  if (line.storlek > bodySize * 1.08) s += 2;
  if (isAlone(h.rest)) s += 1;
  if (findPoints(line.norm, { allowBare: true }) !== null) s += 1;
  if (/^\s*[.:)]/.test(h.rest)) s += 0.5;
  return s;
}

/**
 * Bästa strikt stigande nummerföljd. Längd väger tyngst, luckor och start
 * på annat än 1 drar ned, lika långa följder avgörs av rubrikpoäng.
 * @param {Array<{nummer:number, score:number}>} cands i dokumentordning
 */
export function bestSequence(cands) {
  const n = cands.length;
  if (!n) return [];
  const val = new Array(n);
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    val[i] = 10 + cands[i].score - (cands[i].nummer - 1) * 3;
    for (let j = 0; j < i; j++) {
      if (cands[j].nummer >= cands[i].nummer) continue;
      const gaps = cands[i].nummer - cands[j].nummer - 1;
      const v = val[j] + 10 + cands[i].score - gaps * 6;
      if (v > val[i]) {
        val[i] = v;
        prev[i] = j;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (val[i] > val[best]) best = i;
  const seq = [];
  for (let i = best; i !== -1; i = prev[i]) seq.push(cands[i]);
  return seq.reverse();
}

/** Längsta luckfria del (n, n+1, n+2 …) av en följd. */
function longestConsecutiveRun(seq) {
  let best = [];
  let cur = [];
  for (const c of seq) {
    if (cur.length && c.nummer === cur[cur.length - 1].nummer + 1) cur.push(c);
    else cur = [c];
    if (cur.length > best.length) best = [...cur];
  }
  return best;
}

/**
 * Väljer rubriker bland raderna [from, to).
 * @returns {{headings:Array, familj:1|2|null, ord:string|null, fam2Count:number}}
 */
function chooseHeadings(L, from, to, bodySize, { allowSolutionWords = false } = {}) {
  const fam1ByWord = new Map();
  const fam2 = [];
  for (let i = from; i < to; i++) {
    const line = L[i];
    let h = parseHeading(line.norm);
    if (!h && allowSolutionWords) {
      const m = line.norm.match(LOSNING_NUMMER_RE);
      if (m) h = { familj: 1, ord: 'lösning', nummer: Number(m[1]), rest: line.norm.slice(m[0].length) };
    }
    if (!h) continue;
    const cand = { ...h, line, score: headingScore(line, h, bodySize) };
    if (h.familj === 1) {
      const key = allowSolutionWords ? '*' : h.ord;
      if (!fam1ByWord.has(key)) fam1ByWord.set(key, []);
      fam1ByWord.get(key).push(cand);
    } else {
      fam2.push(cand);
    }
  }

  const filterX = (cands) => {
    const mx = median(cands.map((c) => c.line.xStart));
    return cands.filter((c) => Math.abs(c.line.xStart - mx) <= 0.05);
  };

  let best1 = [];
  let ord = null;
  for (const [word, cands] of fam1ByWord) {
    const seq = bestSequence(filterX(cands));
    const score = (s) => s.length * 100 + s.reduce((a, c) => a + c.score, 0);
    if (score(seq) > score(best1)) {
      best1 = seq;
      ord = word;
    }
  }
  if (best1.length >= 2) return { headings: best1, familj: 1, ord, fam2Count: fam2.length };

  // Familj 2: strängare krav (C).
  if (fam2.length && fam2.length <= 40) {
    const run = longestConsecutiveRun(bestSequence(filterX(fam2)));
    const strong = run.filter((c) => c.line.fetStart || c.line.fet || c.line.storlek > bodySize * 1.08 || isAlone(c.rest));
    if (run.length >= 2 && strong.length * 2 >= run.length) return { headings: run, familj: 2, ord: null, fam2Count: fam2.length };
  }
  if (best1.length === 1) return { headings: best1, familj: 1, ord, fam2Count: fam2.length };
  return { headings: [], familj: null, ord: null, fam2Count: fam2.length };
}

function labelFor(h) {
  if (h.familj === 2 || !h.ord || h.ord === 'lösning') return `Uppgift ${h.nummer}`;
  const w = VISNINGSORD[h.ord] || h.ord;
  return `${w} ${h.nummer}`;
}

const posStart = (line) => ({ sida: line.sida, y: line.yTopp });

/** Slutet av ett intervall: överkanten på raden `idx`, eller dokumentets slut. */
function posEnd(L, idx) {
  if (idx >= L.length || idx < 0) return { sida: L.length ? L[L.length - 1].sida : 1, y: null };
  return { sida: L[idx].sida, y: L[idx].yTopp };
}

/** Delmoment och poäng inom raderna [from, to). */
function pointsAndParts(L, from, to) {
  const headingLine = L[from];
  const headingPts = findPoints(headingLine.norm, { allowBare: true });
  const parts = [];
  let expected = 'a';
  const bodyPoints = [];
  for (let i = from; i < to; i++) {
    const line = L[i];
    const m = i === from ? null : line.norm.match(DELUPPGIFT_RE);
    const letter = m ? m[1] || m[2] : null;
    if (letter && letter === expected && (m[3] || '').length > 0) {
      parts.push({ etikett: letter, poang: findPoints(line.norm, { allowBare: true }), lineIdx: i });
      expected = String.fromCharCode(expected.charCodeAt(0) + 1);
      continue;
    }
    if (i === from) continue;
    const p = findPoints(line.norm);
    if (p !== null) {
      if (parts.length && parts[parts.length - 1].poang === null) parts[parts.length - 1].poang = p;
      else if (!parts.length) bodyPoints.push(p);
    }
  }
  const delmoment = parts.length >= 2 ? parts.map(({ etikett, poang }) => ({ etikett, poang })) : [];
  let poang = headingPts;
  if (poang === null && delmoment.length && delmoment.some((d) => d.poang !== null)) {
    poang = Math.round(delmoment.reduce((s, d) => s + (d.poang || 0), 0) * 100) / 100;
  }
  if (poang === null && bodyPoints.length) poang = bodyPoints[0];
  return { poang, delmoment };
}

/** Intervallets längd i "sidor" (för att hitta ovanligt stora/små uppgifter). */
export function spanPages(start, end) {
  const endY = end.y === null ? 0.95 : end.y;
  return end.sida + endY - (start.sida + start.y);
}

/* ------------------------------------------------------------------ */
/* Huvudfunktion                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {{sidor:Array, saknas:boolean}} layer tentans textlager (textlayer.js)
 * @param {{facitLayer?:object}} opts separat facit-PDF:s textlager
 * @returns {{
 *   tasks: Array<{nummer, etikett, poang, delmoment, sakerhet, anmarkningar,
 *                 start:{sida,y}, end:{sida,y|null}, facit:null|{pdf?:'facit', start, end}}>,
 *   angivenTotalpoang:number|null, familj:1|2|null, textlagerSaknas:boolean,
 *   facitFall:'inuti'|'slutet'|'separat'|null,
 *   sammanfattning:{antal, summaPoang, angivenTotalpoang, varningar:string[]},
 *   svag:boolean, forslag:string|null
 * }}
 */
export function detect(layer, opts = {}) {
  if (!layer || layer.saknas) {
    return weakResult({
      textlagerSaknas: true,
      forslag:
        'Den här PDF:en verkar vara inskannad, så den saknar text som appen kan läsa. Prova AI-igenkänning (Premium) eller markera uppgifterna själv.',
    });
  }
  const L = flattenLines(layer);
  if (!L.length) return weakResult({ textlagerSaknas: true, forslag: 'PDF:en innehåller ingen läsbar text. Prova AI-igenkänning (Premium) eller markera själv.' });
  const bodySize = median(L.map((l) => l.storlek));

  // Samlat facit på slutet: sektionsrubrik följd av rubriker som börjar om.
  let sectionIdx = -1;
  let main = chooseHeadings(L, 0, L.length, bodySize);
  for (let i = 0; i < L.length && main.headings.length; i++) {
    if (!isSectionMarker(L[i].norm) || isFacitMarker(L[i].norm) && !/^(?:solutions|lösningar|lösningsförslag|facit|answers|suggested)/.test(L[i].norm)) continue;
    const before = main.headings.filter((h) => h.line.idx < i);
    if (!before.length) continue;
    const after = chooseHeadings(L, i + 1, L.length, bodySize, { allowSolutionWords: true });
    const maxBefore = Math.max(...before.map((h) => h.nummer));
    if (after.headings.length >= 1 && after.headings[0].nummer <= maxBefore) {
      sectionIdx = i;
      main = chooseHeadings(L, 0, i, bodySize);
      break;
    }
  }

  const headings = main.headings;
  const endIdx = sectionIdx >= 0 ? sectionIdx : L.length;
  const enders = new Set();
  for (let i = 0; i < L.length; i++) if (isEndLine(L[i].norm)) enders.add(i);
  const headingIdx = new Set(headings.map((h) => h.line.idx));
  const nextBoundary = (i, limit) => {
    for (let k = i + 1; k < limit; k++) if (headingIdx.has(k) || enders.has(k)) return k;
    return limit;
  };

  // Facit samlat på slutet: rubriker efter sektionen, parade på nummer.
  const facitByNum = new Map();
  let facitFall = null;
  if (sectionIdx >= 0) {
    const sol = chooseHeadings(L, sectionIdx + 1, L.length, bodySize, { allowSolutionWords: true }).headings;
    const solIdx = new Set(sol.map((h) => h.line.idx));
    sol.forEach((h) => {
      let k = h.line.idx + 1;
      while (k < L.length && !solIdx.has(k) && !enders.has(k)) k++;
      if (!facitByNum.has(h.nummer)) facitByNum.set(h.nummer, { start: posStart(h.line), end: posEnd(L, k) });
    });
    if (facitByNum.size) facitFall = 'slutet';
  }

  // Separat facit-PDF: samma igenkänning, parat på nummer.
  if (opts.facitLayer && !opts.facitLayer.saknas) {
    const FL = flattenLines(opts.facitLayer);
    const fBody = median(FL.map((l) => l.storlek));
    const sol = chooseHeadings(FL, 0, FL.length, fBody, { allowSolutionWords: true }).headings;
    const solIdx = new Set(sol.map((h) => h.line.idx));
    sol.forEach((h) => {
      let k = h.line.idx + 1;
      while (k < FL.length && !solIdx.has(k) && !isEndLine(FL[k].norm)) k++;
      if (!facitByNum.has(h.nummer)) facitByNum.set(h.nummer, { pdf: 'facit', start: posStart(h.line), end: posEnd(FL, k) });
    });
    if (sol.length) facitFall = facitFall || 'separat';
  }

  const tasks = headings.map((h, k) => {
    const from = h.line.idx;
    const boundary = nextBoundary(from, endIdx);
    let facitIdx = -1;
    for (let i = from + 1; i < boundary; i++) {
      if (isFacitMarker(L[i].norm)) {
        facitIdx = i;
        break;
      }
    }
    const taskEnd = facitIdx >= 0 ? facitIdx : boundary;
    const { poang, delmoment } = pointsAndParts(L, from, taskEnd);
    let facit = null;
    if (facitIdx >= 0) {
      facit = { start: posStart(L[facitIdx]), end: posEnd(L, boundary) };
      facitFall = facitFall || 'inuti';
    } else if (facitByNum.has(h.nummer)) {
      facit = facitByNum.get(h.nummer);
    }
    return {
      nummer: h.nummer,
      etikett: labelFor(h),
      poang,
      delmoment,
      familj: main.familj,
      start: posStart(h.line),
      end: posEnd(L, taskEnd),
      facit,
      prevNummer: k ? headings[k - 1].nummer : null,
      sakerhet: 'hög',
      anmarkningar: [],
    };
  });

  // Angiven totalpoäng på omslaget (rader före första rubriken, annars sida 1).
  let angivenTotalpoang = null;
  const coverEnd = headings.length ? headings[0].line.idx : L.length;
  for (let i = 0; i < coverEnd && angivenTotalpoang === null; i++) angivenTotalpoang = findTotal(L[i].norm);
  if (angivenTotalpoang === null) {
    for (const l of L) {
      if (l.sida !== 1) break;
      if (headingIdx.has(l.idx)) continue;
      angivenTotalpoang = findTotal(l.norm);
      if (angivenTotalpoang !== null) break;
    }
  }

  assessSafety(tasks);
  return { ...summarize(tasks, angivenTotalpoang), familj: main.familj, facitFall, textlagerSaknas: false };
}

/**
 * Sätter säkerhet ("hög"/"låg") och förklarande anmärkningar per uppgift (I).
 * Muterar och returnerar tasks.
 */
export function assessSafety(tasks) {
  const anyPoints = tasks.some((t) => t.poang !== null);
  const facitCount = tasks.filter((t) => t.facit).length;
  tasks.forEach((t, i) => {
    const notes = t.anmarkningar || (t.anmarkningar = []);
    if (t.familj === 2) notes.push('Rubriken är bara en siffra. Kontrollera att det verkligen är en uppgift.');
    if (i === 0 && t.nummer > 1 && t.familj) notes.push(`Numreringen börjar på ${t.nummer}. Kontrollera att ingen uppgift saknas före.`);
    if (t.prevNummer !== null && t.prevNummer !== undefined && t.nummer !== t.prevNummer + 1) {
      notes.push(`Numreringen hoppar från ${t.prevNummer} till ${t.nummer}. Kontrollera att ingen uppgift saknas.`);
    }
    if (t.poang === null && anyPoints) notes.push('Poäng hittades inte, men andra uppgifter har poäng.');
    const span = spanPages(t.start, t.end);
    if (span > 2.05) notes.push('Uppgiften är ovanligt lång. Kontrollera att den inte innehåller nästa uppgift.');
    else if (span < 0.025) notes.push('Uppgiften är ovanligt kort. Kontrollera klippet.');
    if (!t.facit && facitCount > 0 && facitCount === tasks.length - 1 && tasks.length > 1) {
      notes.push('Facit hittades inte, men finns för de andra uppgifterna.');
    }
    if (tasks.length === 1 && t.familj) notes.push('Bara en uppgift hittades.');
    t.sakerhet = notes.length || t.familj === 2 ? 'låg' : 'hög';
  });
  return tasks;
}

/** Sammanfattning (J) och bedömning av om resultatet är för svagt (K). */
export function summarize(tasks, angivenTotalpoang) {
  const summaPoang = Math.round(tasks.reduce((s, t) => s + (t.poang || 0), 0) * 100) / 100;
  const varningar = [];
  const lowCount = tasks.filter((t) => t.sakerhet === 'låg').length;
  const diff = angivenTotalpoang !== null && summaPoang > 0 ? summaPoang - angivenTotalpoang : 0;
  if (angivenTotalpoang !== null && summaPoang > 0 && Math.abs(diff) > 0.01) {
    varningar.push(`Uppgifterna summerar till ${fmt(summaPoang)} p, tentan anger ${fmt(angivenTotalpoang)} p.`);
  }
  if (lowCount) varningar.push(`${lowCount} ${lowCount === 1 ? 'uppgift behöver' : 'uppgifter behöver'} koll.`);
  const facitCount = tasks.filter((t) => t.facit).length;
  if (tasks.length && !facitCount) varningar.push('Inget facit hittades.');

  let forslag = null;
  if (tasks.length < 2) {
    forslag =
      tasks.length === 1
        ? 'Jag hittade bara 1 uppgift. Prova AI-igenkänning (Premium) eller markera själv.'
        : 'Jag hittade inga uppgifter. Prova AI-igenkänning (Premium) eller markera själv.';
  } else if (angivenTotalpoang && summaPoang > 0 && Math.abs(diff) / angivenTotalpoang > 0.25) {
    forslag = `Poängen stämmer inte med tentans totalpoäng (${fmt(summaPoang)} av ${fmt(angivenTotalpoang)} p). Prova AI-igenkänning (Premium) eller justera själv.`;
  } else if (lowCount * 3 > tasks.length) {
    forslag = `${lowCount} av ${tasks.length} uppgifter är osäkra. Prova AI-igenkänning (Premium) eller justera själv.`;
  }
  return {
    tasks,
    angivenTotalpoang,
    sammanfattning: { antal: tasks.length, summaPoang, angivenTotalpoang, varningar },
    svag: forslag !== null,
    forslag,
  };
}

const fmt = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

function weakResult({ textlagerSaknas, forslag }) {
  return {
    tasks: [],
    angivenTotalpoang: null,
    familj: null,
    facitFall: null,
    textlagerSaknas,
    sammanfattning: { antal: 0, summaPoang: 0, angivenTotalpoang: null, varningar: textlagerSaknas ? ['Textlager saknas.'] : [] },
    svag: true,
    forslag,
  };
}

/* ------------------------------------------------------------------ */
/* Ankare (AI-läget): modellen säger VAD, textlagret säger VAR          */
/* ------------------------------------------------------------------ */

const compact = (s) => normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Hittar raden som börjar med ankartexten, närmast angiven sida.
 * @returns {object|null} raden (med idx från flattenLines)
 */
export function findAnchor(L, anchor, sidaHint = null, { afterIdx = -1 } = {}) {
  const a = compact(anchor);
  if (a.length < 2) return null;
  const probe = a.slice(0, 40);
  let best = null;
  let bestRank = -Infinity;
  for (const line of L) {
    if (line.idx <= afterIdx) continue;
    const c = compact(line.norm);
    if (!c) continue;
    // Exakt träff > raden börjar med ankaret > ankaret börjar med (en kort) rad.
    let quality = 0;
    if (c === a || c === probe) quality = 3;
    else if (c.startsWith(probe)) quality = 2 - Math.min(1, (c.length - probe.length) / 200);
    else if (c.length >= 4 && probe.startsWith(c) && c.length >= Math.min(probe.length, 8)) quality = 1;
    if (!quality) continue;
    const dist = sidaHint ? Math.abs(line.sida - sidaHint) : 0;
    if (sidaHint && dist > 1) continue;
    const rank = quality * 10 - dist * 4;
    if (rank > bestRank) {
      best = line;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Bygger uppgifter med intervall från AI:ns ankare.
 * @param {object} layer tentans textlager
 * @param {object|null} facitLayer separat facit-PDF:s textlager
 * @param {Array} aiTasks validerade uppgifter från ai.js
 * @returns {Array} samma format som detect().tasks, plus `ruta`/`facitRuta`
 *   (uppskattad reservruta) när ankaret inte hittades
 */
export function tasksFromAnchors(layer, facitLayer, aiTasks) {
  const L = layer && !layer.saknas ? flattenLines(layer) : [];
  const FL = facitLayer && !facitLayer.saknas ? flattenLines(facitLayer) : [];
  const enders = new Set(L.filter((l) => isEndLine(l.norm)).map((l) => l.idx));

  const starts = aiTasks.map((t) => (L.length ? findAnchor(L, t.startAnkare, t.startSida) : null));
  const facitStarts = aiTasks.map((t, i) => {
    if (!t.facitStartAnkare) return null;
    const inFacitPdf = t.facitDokument === 'facit';
    const lines = inFacitPdf ? FL : L;
    // Facit i tentan ligger efter uppgiftens start.
    const afterIdx = !inFacitPdf && starts[i] ? starts[i].idx : -1;
    return lines.length ? { line: findAnchor(lines, t.facitStartAnkare, t.facitStartSida, { afterIdx }), facitPdf: inFacitPdf } : null;
  });
  const boundaries = new Set([
    ...starts.filter(Boolean).map((l) => l.idx),
    ...facitStarts.filter((f) => f?.line && !f.facitPdf).map((f) => f.line.idx),
    ...enders,
  ]);
  const facitBoundaries = new Set(facitStarts.filter((f) => f?.line && f.facitPdf).map((f) => f.line.idx));
  const next = (idx, set, len) => {
    for (let k = idx + 1; k < len; k++) if (set.has(k)) return k;
    return len;
  };

  const tasks = aiTasks.map((t, i) => {
    const anm = t.anmarkning ? [t.anmarkning] : [];
    const s = starts[i];
    const out = {
      nummer: i + 1,
      etikett: t.etikett,
      poang: t.poang,
      delmoment: t.delmoment || [],
      start: null,
      end: null,
      ruta: null,
      facit: null,
      facitRuta: null,
      sakerhet: t.sakerhet === 'låg' ? 'låg' : 'hög',
      anmarkningar: anm,
    };
    if (s) {
      let endIdx = next(s.idx, boundaries, L.length);
      if (t.slutSida && endIdx < L.length && L[endIdx].sida > t.slutSida + 1) endIdx = L.length;
      out.start = posStart(s);
      out.end = posEnd(L, endIdx);
    } else {
      out.ruta = t.uppskattadRuta || null;
      out.sakerhet = 'låg';
      out.anmarkningar.push('Uppgiftens start hittades inte i textlagret. Klippet är en uppskattning.');
    }
    const f = facitStarts[i];
    if (f?.line) {
      const lines = f.facitPdf ? FL : L;
      let endIdx = f.facitPdf ? next(f.line.idx, facitBoundaries, lines.length) : next(f.line.idx, boundaries, lines.length);
      if (t.facitSlutAnkare) {
        const endLine = findAnchor(lines, t.facitSlutAnkare, null, { afterIdx: f.line.idx });
        if (endLine && endLine.idx < endIdx) endIdx = endLine.idx + 1;
      }
      out.facit = { ...(f.facitPdf ? { pdf: 'facit' } : {}), start: posStart(f.line), end: posEnd(lines, endIdx) };
    } else if (t.facitStartAnkare || t.facitStartSida) {
      out.facitRuta = t.uppskattadFacitRuta || null;
      if (!out.facitRuta) out.anmarkningar.push('Facit nämndes men hittades inte i textlagret.');
      out.sakerhet = 'låg';
    }
    return out;
  });
  return tasks;
}
