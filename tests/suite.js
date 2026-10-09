/**
 * suite.js — tester för textlayer.js, detect.js och crop.js.
 * Körs i tests.html (webbläsare) eller med `node tests/run-node.mjs`.
 * Inget nätverk, ingen API-nyckel, inga riktiga tentor.
 */

import { buildLines, finalizeLayer, normalizeText, isBoldFontName } from '../js/textlayer.js';
import {
  detect,
  findPoints,
  findTotal,
  isFacitMarker,
  isEndLine,
  parseHeading,
  flattenLines,
  tasksFromAnchors,
} from '../js/detect.js';
import { pageBounds, intervalToRegions, autocropRect, cropRegionsOnPage } from '../js/crop.js';
import * as F from './fixtures.js';

const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}${msg ? ': ' : ''}fick ${a}, väntade ${e}`);
}

const lineOf = (layer, text) => {
  for (const p of layer.sidor) for (const l of p.lines) if (l.text === text) return l;
  throw new Error(`Raden "${text}" finns inte i fixturen`);
};
const bottomOf = (r) => r.y + r.h;
const allRegions = (layer, interval) => intervalToRegions(interval, pageBounds(layer));

/* ------------------------------------------------------------------ */
/* textlayer.js                                                        */
/* ------------------------------------------------------------------ */

test('Textlager', '"Problem" och "1." i separata block blir en rad', () => {
  const lines = buildLines(
    [
      { str: 'Problem', x: 70, y: 100, w: 45, size: 12, bold: true },
      { str: '1.', x: 118, y: 100, w: 8, size: 12, bold: true },
      { str: '(2p)', x: 130, y: 100.4, w: 20, size: 11 },
    ],
    { sida: 1, w: 595, h: 842 },
  );
  eq(lines.length, 1, 'antal rader');
  eq(lines[0].text, 'Problem 1. (2p)');
  eq(lines[0].norm, 'problem 1. (2p)');
  assert(lines[0].fetStart, 'första ordet ska vara fetstil');
  assert(Math.abs(lines[0].xStart - 70 / 595) < 1e-9, 'xStart');
});

test('Textlager', 'origo uppe till vänster, rader sorteras uppifrån', () => {
  const lines = buildLines(
    [
      { str: 'Andra', x: 70, y: 200, w: 30, size: 11 },
      { str: 'Första', x: 70, y: 100, w: 30, size: 11 },
    ],
    { sida: 2, w: 595, h: 842 },
  );
  eq(lines.map((l) => l.text), ['Första', 'Andra']);
  assert(lines[0].yTopp < lines[0].yBotten && lines[0].yBotten < lines[1].yTopp, 'yTopp/yBotten');
  eq(lines[0].sida, 2);
});

test('Textlager', 'exponent på samma rad slås ihop', () => {
  const lines = buildLines(
    [
      { str: 'x', x: 70, y: 100, w: 6, size: 11 },
      { str: '2', x: 76, y: 96, w: 4, size: 7 },
      { str: '+ 1', x: 82, y: 100, w: 14, size: 11 },
    ],
    { sida: 1, w: 595, h: 842 },
  );
  eq(lines.length, 1);
});

test('Textlager', 'normalisering: NFC, icke-brytande blanksteg, skiftläge', () => {
  eq(normalizeText('Uppgift 3'), 'uppgift 3');
  eq(normalizeText('Övning   2'), 'övning 2');
  eq(normalizeText('  LÖSNING:  '), 'lösning:');
  eq(normalizeText('ﬁnal'), 'final');
  eq(normalizeText('THAT’S ALL'), "that's all");
  eq(parseHeading(normalizeText('Övning 2.')).nummer, 2);
});

test('Textlager', 'fetstil från typsnittsnamn', () => {
  assert(isBoldFontName('ABCDEF+Times-Bold'), 'Times-Bold');
  assert(isBoldFontName('Helvetica-BoldOblique'), 'Helvetica-BoldOblique');
  assert(!isBoldFontName('Helvetica'), 'Helvetica');
  assert(!isBoldFontName('ABCDEF+CMR10'), 'CMR10');
});

test('Textlager', 'sidhuvud, sidfot och sidnummer blir brus, inte "Solution:"', () => {
  const L = F.SSY061;
  for (const p of L.sidor) {
    const head = p.lines.find((l) => l.text.startsWith('SSY061 Mechatronics'));
    const num = p.lines.find((l) => l.text === String(p.sida));
    assert(head?.brus, `sidhuvud sida ${p.sida}`);
    assert(num?.brus, `sidnummer sida ${p.sida}`);
  }
  assert(!lineOf(L, 'Solution:').brus, '"Solution:" ska inte vara brus');
});

test('Textlager', 'rubriker överst på varje sida räknas inte som sidhuvud', () => {
  const pages = [1, 2, 3, 4].map((n) => [
    { t: `Problem ${n} (3p)`, bold: true },
    'Beräkna strömmen genom motståndet R1 och ange svaret med enhet.',
    'Rita ett kretsschema och förklara varje steg i lösningen.',
  ]);
  const layer = F.makeLayer(pages, { header: 'ELA101 Elektroteknik' });
  for (const p of layer.sidor) {
    assert(!p.lines.find((l) => l.text.startsWith('Problem')).brus, `rubriken på sida ${p.sida}`);
    assert(p.lines.find((l) => l.text === 'ELA101 Elektroteknik').brus, `sidhuvud sida ${p.sida}`);
  }
  eq(detect(layer).tasks.length, 4);
});

test('Textlager', 'saknat textlager upptäcks (< 50 tecken per sida)', () => {
  assert(F.INSKANNAD.saknas, 'saknas');
  assert(!F.SSY061.saknas, 'SSY061 har textlager');
  const tunn = finalizeLayer({ sidor: [{ sida: 1, lines: [] }] });
  assert(tunn.saknas, 'tom sida');
});

/* ------------------------------------------------------------------ */
/* detect.js – mönster                                                 */
/* ------------------------------------------------------------------ */

test('Mönster', 'poäng i alla format', () => {
  const cases = [
    ['problem 1. (3 p)', 3],
    ['problem 1. (3p)', 3],
    ['uppgift 2 [3 p]', 3],
    ['b) detta ger 3 poäng', 3],
    ['worth 3 points', 3],
    ['(3 pts)', 3],
    ['3 marks', 3],
    ['a) beräkna (1,5 p)', 1.5],
    ['(2.5p)', 2.5],
    ['problem 7. (5 points)', 5],
    ['beräkna integralen', null],
  ];
  for (const [s, v] of cases) eq(findPoints(s), v, s);
  eq(findPoints('uppgift 4 3p', { allowBare: true }), 3, 'bart "3p" i slutet');
});

test('Mönster', 'angiven totalpoäng', () => {
  eq(findTotal('the exam consists of 7 problems with a total of 25 points.'), 25);
  eq(findTotal('tentan omfattar totalt 25 poäng.'), 25);
  eq(findTotal('max 25 p'), 25);
  eq(findTotal('grading: 3: 10 points, 4: 15 points'), null);
});

test('Mönster', 'facit-markörer kräver kolon eller ensamt ord', () => {
  for (const s of ['solution:', 'solutions:', 'lösning:', 'lösningsförslag', 'lösningsförslag:', 'svar: 42 v', 'answer:', 'facit', 'solution to problem 3:']) {
    assert(isFacitMarker(s), `"${s}" ska vara facit`);
  }
  for (const s of ['answer the following problems on separate sheets.', 'solutions and answers may be written in english or swedish.', 'svar ska motiveras']) {
    assert(!isFacitMarker(s), `"${s}" ska INTE vara facit`);
  }
});

test('Mönster', 'avslutsrader', () => {
  assert(isEndLine("that's all, good luck!"), 'THAT\'S ALL');
  assert(isEndLine('lycka till!'), 'lycka till');
  assert(isEndLine('end of exam'), 'end of exam');
  assert(!isEndLine('beräkna slutvärdet'), 'slutvärdet');
});

test('Mönster', 'rubrikfamiljer', () => {
  eq(parseHeading('problem 3.').nummer, 3);
  eq(parseHeading('uppgift 4 (3 p)').nummer, 4);
  eq(parseHeading('q2 (4p)').nummer, 2);
  eq(parseHeading('fråga 10: vad?').nummer, 10);
  eq(parseHeading('1. beräkna').familj, 2);
  eq(parseHeading('2.5 m lång'), null);
  eq(parseHeading('problemet är svårt'), null);
});

/* ------------------------------------------------------------------ */
/* (a) Exempeltentan SSY061                                            */
/* ------------------------------------------------------------------ */

const ssy = detect(F.SSY061);

test('SSY061', '7 uppgifter, rätt etiketter', () => {
  eq(ssy.tasks.map((t) => t.etikett), ['Problem 1', 'Problem 2', 'Problem 3', 'Problem 4', 'Problem 5', 'Problem 6', 'Problem 7']);
});

test('SSY061', 'poäng 2, 3, 3, 3, 4, 5, 5 = 25 p', () => {
  eq(ssy.tasks.map((t) => t.poang), [2, 3, 3, 3, 4, 5, 5]);
  eq(ssy.sammanfattning.summaPoang, 25);
});

test('SSY061', 'delmoment: P3 a=1 b=2, P5 a=2 b=2, P6 a=3 b=2', () => {
  eq(ssy.tasks[2].delmoment, [{ etikett: 'a', poang: 1 }, { etikett: 'b', poang: 2 }]);
  eq(ssy.tasks[4].delmoment, [{ etikett: 'a', poang: 2 }, { etikett: 'b', poang: 2 }]);
  eq(ssy.tasks[5].delmoment, [{ etikett: 'a', poang: 3 }, { etikett: 'b', poang: 2 }]);
  eq(ssy.tasks[0].delmoment, []);
});

test('SSY061', 'angiven totalpoäng 25 hittas och stämmer', () => {
  eq(ssy.angivenTotalpoang, 25);
  assert(!ssy.sammanfattning.varningar.some((v) => v.includes('summerar')), 'ingen poängvarning');
});

test('SSY061', 'alla uppgifter har facit (inuti) och hög säkerhet; inte svagt', () => {
  eq(ssy.facitFall, 'inuti');
  assert(ssy.tasks.every((t) => t.facit), 'facit för alla');
  eq(ssy.tasks.map((t) => t.sakerhet), Array(7).fill('hög'));
  assert(!ssy.svag, 'resultatet ska inte vara svagt');
});

test('SSY061', 'Problem 1 börjar vid rubriken, inte överst på omslagssidan', () => {
  const p1 = lineOf(F.SSY061, 'Problem 1. (2p)');
  const before = lineOf(F.SSY061, 'Answer the following problems on separate sheets. Motivate all answers.');
  const [r] = allRegions(F.SSY061, ssy.tasks[0]);
  eq(r.sida, 1);
  assert(r.y > before.yBotten, 'omslagstext får inte ingå');
  assert(r.y <= p1.yTopp, 'rubriken ska ingå');
});

test('SSY061', 'uppgift och facit är separata rektanglar; "Solution:" ingår inte i uppgiften', () => {
  const t = ssy.tasks[0];
  const solLine = F.SSY061.sidor[0].lines.find((l) => l.text === 'Solution:');
  const [tr] = allRegions(F.SSY061, t);
  const [fr] = allRegions(F.SSY061, t.facit);
  assert(bottomOf(tr) < solLine.yTopp, 'uppgiften slutar före facit');
  assert(fr.y <= solLine.yTopp && fr.y >= bottomOf(tr), 'facit börjar vid markören');
  const p2 = lineOf(F.SSY061, 'Problem 2. (3p)');
  assert(bottomOf(fr) < p2.yTopp, 'facit slutar före nästa rubrik');
});

test('SSY061', 'nästa uppgifts rubrik ryms aldrig i ett klipp', () => {
  const bounds = pageBounds(F.SSY061);
  for (let i = 0; i < ssy.tasks.length - 1; i++) {
    const next = ssy.tasks[i + 1].start;
    for (const iv of [ssy.tasks[i], ssy.tasks[i].facit]) {
      for (const r of intervalToRegions(iv, bounds)) {
        if (r.sida === next.sida) assert(bottomOf(r) < next.y || r.y > next.y, `${ssy.tasks[i].etikett} sida ${r.sida}`);
      }
    }
  }
});

test('SSY061', 'Problem 7 och dess facit går över flera sidor (flera rektanglar)', () => {
  const t = ssy.tasks[6];
  const tr = allRegions(F.SSY061, t);
  const fr = allRegions(F.SSY061, t.facit);
  eq(tr.map((r) => r.sida), [4, 5], 'uppgiftens sidor');
  eq(fr.map((r) => r.sida), [5, 6], 'facits sidor');
});

test('SSY061', 'sidhuvud, sidnummer och "THAT\'S ALL, GOOD LUCK!" ingår aldrig', () => {
  const bounds = pageBounds(F.SSY061);
  const end = lineOf(F.SSY061, "THAT'S ALL, GOOD LUCK!");
  for (const t of ssy.tasks) {
    for (const iv of [t, t.facit]) {
      for (const r of intervalToRegions(iv, bounds)) {
        const page = F.SSY061.sidor[r.sida - 1];
        for (const l of page.lines.filter((x) => x.brus)) {
          assert(bottomOf(r) <= l.yTopp || r.y >= l.yBotten, `brus "${l.text}" i ${t.etikett} sida ${r.sida}`);
        }
        if (r.sida === end.sida) assert(bottomOf(r) < end.yTopp, 'avslutsraden');
      }
    }
  }
});

test('SSY061', 'omslagets "Solutions and answers may be written…" blir inte facit', () => {
  const cover = lineOf(F.SSY061, 'Solutions and answers may be written in English or Swedish.');
  for (const t of ssy.tasks) assert(!(t.facit.start.sida === 1 && Math.abs(t.facit.start.y - cover.yTopp) < 1e-9), t.etikett);
});

/* ------------------------------------------------------------------ */
/* (b) Svenska                                                         */
/* ------------------------------------------------------------------ */

test('Svenska', '"Uppgift 1 (4 p)" + "Lösning:" efter varje uppgift', () => {
  const r = detect(F.SVENSK_INUTI);
  eq(r.tasks.map((t) => t.etikett), ['Uppgift 1', 'Uppgift 2', 'Uppgift 3', 'Uppgift 4']);
  eq(r.tasks.map((t) => t.poang), [4, 6, 4, 6]);
  eq(r.angivenTotalpoang, 20);
  eq(r.tasks[1].delmoment, [{ etikett: 'a', poang: 2 }, { etikett: 'b', poang: 4 }]);
  assert(r.tasks.every((t) => t.facit), 'facit');
  const last = allRegions(F.SVENSK_INUTI, r.tasks[3].facit);
  const lycka = lineOf(F.SVENSK_INUTI, 'Lycka till!');
  assert(bottomOf(last[last.length - 1]) < lycka.yTopp, '"Lycka till!" ingår inte');
  assert(!r.svag, 'inte svagt');
});

test('Svenska', 'facit samlat på slutet efter "Lösningar" paras på nummer', () => {
  const r = detect(F.SVENSK_SLUTET);
  eq(r.tasks.length, 4);
  eq(r.facitFall, 'slutet');
  eq(r.tasks.map((t) => t.facit?.start.sida), [2, 2, 2, 2]);
  const losningar = lineOf(F.SVENSK_SLUTET, 'Lösningar');
  const lastTask = allRegions(F.SVENSK_SLUTET, r.tasks[3]);
  assert(lastTask.every((x) => x.sida === 1), 'sista uppgiften slutar före "Lösningar"');
  const f1 = allRegions(F.SVENSK_SLUTET, r.tasks[0].facit)[0];
  assert(f1.y > losningar.yTopp, 'facit 1 börjar efter sektionsrubriken');
  const u2 = r.tasks[1].facit.start;
  assert(bottomOf(f1) < u2.y, 'facit 1 slutar före facit 2');
});

/* ------------------------------------------------------------------ */
/* (c) Bara siffror                                                    */
/* ------------------------------------------------------------------ */

test('Siffror', '"1." … "4." som rubriker: hittas men med låg säkerhet', () => {
  const r = detect(F.BARA_SIFFROR);
  eq(r.familj, 2);
  eq(r.tasks.map((t) => t.etikett), ['Uppgift 1', 'Uppgift 2', 'Uppgift 3', 'Uppgift 4']);
  eq(r.tasks.map((t) => t.poang), [3, 3, 3, 3]);
  eq(r.angivenTotalpoang, 12);
  assert(r.tasks.every((t) => t.sakerhet === 'låg'), 'aldrig hög säkerhet');
  assert(r.tasks[0].anmarkningar.length > 0, 'förklarande anmärkning');
});

test('Siffror', 'ord-rubriker vinner över numrerad instruktionslista', () => {
  const r = detect(F.INSTRUKTIONSLISTA);
  eq(r.familj, 1);
  eq(r.tasks.map((t) => t.etikett), ['Uppgift 1', 'Uppgift 2', 'Uppgift 3']);
});

/* ------------------------------------------------------------------ */
/* (d) Separat facit-PDF                                               */
/* ------------------------------------------------------------------ */

test('Separat facit', 'facit i separat PDF paras ihop på nummer', () => {
  const utan = detect(F.UTAN_FACIT);
  assert(utan.tasks.every((t) => !t.facit), 'utan facit-PDF: inget facit');
  const r = detect(F.UTAN_FACIT, { facitLayer: F.SEPARAT_FACIT });
  eq(r.tasks.length, 3);
  eq(r.facitFall, 'separat');
  assert(r.tasks.every((t) => t.facit?.pdf === 'facit'), 'pdf: "facit"');
  eq(r.tasks.map((t) => t.facit.start.sida), [1, 1, 2]);
  const regs = allRegions(F.SEPARAT_FACIT, r.tasks[0].facit);
  assert(regs.every((x) => x.pdf === 'facit'), 'regionerna märks med pdf: "facit"');
  const p2 = lineOf(F.SEPARAT_FACIT, 'Problem 2');
  assert(bottomOf(regs[0]) < p2.yTopp, 'facit 1 slutar före Problem 2');
  const good = lineOf(F.UTAN_FACIT, 'Good luck!');
  const last = allRegions(F.UTAN_FACIT, r.tasks[2]);
  assert(bottomOf(last[0]) < good.yTopp, '"Good luck!" ingår inte');
  eq(r.angivenTotalpoang, 12);
});

/* ------------------------------------------------------------------ */
/* (e) Utan textlager                                                  */
/* ------------------------------------------------------------------ */

test('Utan textlager', 'inskannad PDF ger "för svag" med förslag om AI eller manuell markering', () => {
  const r = detect(F.INSKANNAD);
  assert(r.textlagerSaknas, 'textlagerSaknas');
  assert(r.svag, 'svag');
  eq(r.tasks.length, 0);
  assert(/AI-igenkänning/.test(r.forslag) && /markera/.test(r.forslag), r.forslag);
});

test('Svagt resultat', 'bara 1 uppgift ger förslaget "Jag hittade bara 1 uppgift…"', () => {
  const one = F.makeLayer([[{ t: 'Problem 1 (3p)', bold: true }, 'Beräkna strömmen genom motståndet R1 i kretsen nedan.', 'Ange svaret med två värdesiffror.']]);
  const r = detect(one);
  eq(r.tasks.length, 1);
  assert(r.svag, 'svag');
  eq(r.forslag, 'Jag hittade bara 1 uppgift. Prova AI-igenkänning (Premium) eller markera själv.');
});

/* ------------------------------------------------------------------ */
/* (f) Hänvisning i löptext                                            */
/* ------------------------------------------------------------------ */

test('Hänvisning', '"se Problem 2" och indragen/otydlig "Problem 2 …" blir inte rubriker', () => {
  const r = detect(F.HANVISNING);
  eq(r.tasks.map((t) => t.etikett), ['Problem 1', 'Problem 2', 'Problem 3']);
  const real = lineOf(F.HANVISNING, 'Problem 2 (5 p)');
  eq(r.tasks[1].start.y, real.yTopp, 'Problem 2 börjar vid den riktiga rubriken');
  eq(r.tasks.map((t) => t.poang), [5, 5, 5]);
  eq(r.tasks.map((t) => t.sakerhet), ['hög', 'hög', 'hög']);
});

/* ------------------------------------------------------------------ */
/* Säkerhet                                                            */
/* ------------------------------------------------------------------ */

test('Säkerhet', 'lucka i numreringen och saknade poäng ger "låg" med anmärkning', () => {
  const layer = F.makeLayer([
    [{ t: 'Problem 1 (3p)', bold: true }, 'Text.', { t: 'Problem 2 (3p)', bold: true }, 'Text.', { t: 'Problem 4', bold: true }, 'Text.'],
  ]);
  const r = detect(layer);
  eq(r.tasks.map((t) => t.etikett), ['Problem 1', 'Problem 2', 'Problem 4']);
  eq(r.tasks[2].sakerhet, 'låg');
  assert(r.tasks[2].anmarkningar.some((a) => a.includes('hoppar från 2 till 4')), 'lucka');
  assert(r.tasks[2].anmarkningar.some((a) => a.includes('Poäng hittades inte')), 'poäng saknas');
  eq(r.tasks[0].sakerhet, 'hög');
});

/* ------------------------------------------------------------------ */
/* crop.js                                                             */
/* ------------------------------------------------------------------ */

function canvasLike(w, hgt, blocks) {
  const data = new Uint8ClampedArray(w * hgt * 4).fill(255);
  for (const [x0, y0, x1, y1] of blocks) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
  }
  return { data, width: w, height: hgt };
}

test('Klipp', 'autobeskärning hittar innehållets gräns och lägger på luft', () => {
  const img = canvasLike(100, 100, [[20, 30, 40, 50]]);
  eq(autocropRect(img.data, 100, 100, { x: 0, y: 0, w: 100, h: 100 }, { pad: 2 }), { x: 18, y: 28, w: 24, h: 24 });
});

test('Klipp', 'helt vit rektangel blir tom (null)', () => {
  const img = canvasLike(50, 50, []);
  eq(autocropRect(img.data, 50, 50, { x: 0, y: 0, w: 50, h: 50 }), null);
});

test('Klipp', 'luften går aldrig utanför rektangeln (nästa rubrik kommer aldrig med)', () => {
  const img = canvasLike(100, 100, [[10, 10, 90, 58], [10, 62, 90, 70]]);
  const c = autocropRect(img.data, 100, 100, { x: 0, y: 0, w: 100, h: 60 }, { pad: 8 });
  assert(c.y + c.h <= 60, `slutar på ${c.y + c.h}`);
});

test('Klipp', 'normaliserade regioner beskärs och tomma tas bort', () => {
  const img = canvasLike(200, 400, [[40, 100, 160, 140]]);
  const out = cropRegionsOnPage(
    [
      { sida: 1, x: 0.05, y: 0.2, w: 0.9, h: 0.2 },
      { sida: 1, x: 0.05, y: 0.6, w: 0.9, h: 0.2 },
    ],
    img,
    { padPx: 0 },
  );
  eq(out.length, 1);
  eq([out[0].x, out[0].y, out[0].w, out[0].h], [0.2, 0.25, 0.6, 0.1]);
});

/* ------------------------------------------------------------------ */
/* AI-ankare (hybridmetoden), utan nätverk                             */
/* ------------------------------------------------------------------ */

test('Ankare', 'AI:ns ankartexter slås upp i textlagret; okänt ankare ger reservruta och "låg"', () => {
  const ai = [
    { etikett: 'Problem 1', poang: 2, startSida: 1, startAnkare: 'Problem 1. (2p)', facitStartSida: 1, facitStartAnkare: 'Solution:', sakerhet: 'hög' },
    { etikett: 'Problem 2', poang: 3, startSida: 1, startAnkare: 'Problem 2. (3p)', facitStartSida: 1, facitStartAnkare: 'Solution text for problem 2, line 1.', sakerhet: 'hög' },
    { etikett: 'Problem 9', poang: 1, startSida: 3, startAnkare: 'Detta finns inte i tentan', uppskattadRuta: { sida: 3, x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, sakerhet: 'hög' },
  ];
  const t = tasksFromAnchors(F.SSY061, null, ai);
  const p1 = lineOf(F.SSY061, 'Problem 1. (2p)');
  eq(t[0].start, { sida: 1, y: p1.yTopp });
  eq(t[0].sakerhet, 'hög');
  assert(t[0].facit && t[0].facit.start.y > p1.yTopp, 'facit hittat');
  eq(t[2].start, null);
  eq(t[2].sakerhet, 'låg');
  eq(t[2].ruta, { sida: 3, x: 0.1, y: 0.1, w: 0.8, h: 0.2 });
  const L = flattenLines(F.SSY061);
  assert(L.length > 50, 'rader');
});

/* ------------------------------------------------------------------ */

/** Kör alla tester. @returns {Array<{group,name,ok,error}>} */
export function runAll() {
  return tests.map(({ group, name, fn }) => {
    try {
      fn();
      return { group, name, ok: true, error: null };
    } catch (err) {
      return { group, name, ok: false, error: err?.message || String(err) };
    }
  });
}
