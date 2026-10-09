/**
 * fixtures.js — konstruerade textlager för testerna. Inga riktiga tentor:
 * raderna är påhittade men har samma struktur som det textlayer.js bygger.
 *
 * Mini-DSL: en sida är en lista rader. En rad är en sträng (brödtext) eller
 * ett objekt { t, bold, size, x, gap }. gap = extra lodrätt utrymme FÖRE
 * raden (andel av sidhöjden), t.ex. för en figur utan text.
 */

import { finalizeLayer, normalizeText } from '../js/textlayer.js';

const BODY = 11 / 842;
const HEAD = 12.5 / 842;

/** Bygger ett textlager av sidor med rader. */
export function makeLayer(pages, { header = null, pageNumbers = true } = {}) {
  const sidor = pages.map((rows, i) => {
    const sida = i + 1;
    const lines = [];
    if (header) lines.push(line(sida, 0.035, header, { size: 9 / 842, x: 0.12 }));
    let y = 0.075;
    for (const r of rows) {
      const row = typeof r === 'string' ? { t: r } : r;
      if (row.gap) y += row.gap;
      const size = row.size ?? (row.bold ? HEAD : BODY);
      if (row.t !== undefined && row.t !== '') lines.push(line(sida, y, row.t, { size, x: row.x ?? 0.12, bold: !!row.bold }));
      y += size * 1.25 + 0.006;
    }
    if (pageNumbers) lines.push(line(sida, 0.955, String(sida), { size: BODY, x: 0.495 }));
    return { sida, w: 595, h: 842, lines };
  });
  return finalizeLayer({ sidor });
}

function line(sida, yTopp, text, { size, x, bold = false }) {
  return {
    sida,
    yTopp,
    yBotten: yTopp + size * 1.2,
    xStart: x,
    xSlut: Math.min(0.95, x + text.length * 0.0085),
    text,
    norm: normalizeText(text),
    storlek: size,
    fet: bold,
    fetStart: bold,
    brus: false,
  };
}

const H = (t) => ({ t, bold: true });
const sol = (n, from, to) => Array.from({ length: to - from + 1 }, (_, k) => `Solution text for problem ${n}, line ${from + k}.`);

/* (a) Exempeltentan: SSY061 Mechatronics 2026-08-19 (konstruerad efter beskrivningen). */
export const SSY061 = makeLayer(
  [
    [
      { t: 'Exam in SSY061 Mechatronics', bold: true, size: 18 / 842 },
      'Date: 2026-08-19, 14:00-18:00',
      'Teacher: N.N., phone 031-772 00 00',
      'Allowed aids: Beta Mathematics Handbook, calculator (any type).',
      'The exam consists of 7 problems with a total of 25 points.',
      'Grading: 3: 10 points, 4: 15 points, 5: 20 points.',
      'Solutions and answers may be written in English or Swedish.',
      'Answer the following problems on separate sheets. Motivate all answers.',
      H('Problem 1. (2p)'),
      'Explain the difference between an open loop and a closed loop',
      'control system. Give one example of each.',
      H('Solution:'),
      ...sol(1, 1, 3),
      H('Problem 2. (3p)'),
      'A DC motor has armature resistance 2 ohm. Compute the stall torque',
      'when the supply voltage is 12 V and kt = 0.05 Nm/A.',
      'As in Problem 1, motivate the answer briefly.',
      H('Solution:'),
      ...sol(2, 1, 3),
    ],
    [
      H('Problem 3.'),
      'Consider the sensor below.',
      { t: 'a) What is the resolution of a 10 bit ADC? (1p)', x: 0.14 },
      { t: 'b) Compute the quantisation error for 0-5 V. (2p)', x: 0.14 },
      H('Solution:'),
      ...sol(3, 1, 3),
      H('Problem 4 (3p)'),
      'Describe how a PWM signal controls the speed of a DC motor.',
      H('Solution:'),
      ...sol(4, 1, 3),
      H('Problem 5. (4p)'),
      'A stepper motor has 200 steps per revolution.',
      { t: 'a) Compute the step angle. (2p)', x: 0.14 },
      { t: 'b) Compute the speed at 1 kHz. (2p)', x: 0.14 },
      H('Solution:'),
      ...sol(5, 1, 3),
    ],
    [
      H('Problem 6. (5 points)'),
      'An H-bridge drives a motor.',
      { t: 'a) Draw the H-bridge and explain. (3p)', x: 0.14 },
      { t: 'b) Explain dead time. (2p)', x: 0.14 },
      H('Solution:'),
      ...sol(6, 1, 3),
    ],
    [
      H('Problem 7. (5p)'),
      'Analyse the circuit in the figure. The operational amplifier is ideal.',
      'Compute the gain and the bandwidth of the filter.',
      { t: 'Figure 1: Active low-pass filter.', gap: 0.25, x: 0.2 },
      'Use the component values R1 = 10 kOhm, R2 = 100 kOhm, C = 10 nF.',
    ],
    [{ t: 'Figure 2: Bode diagram.', gap: 0.3, x: 0.2 }, H('Solution:'), ...sol(7, 1, 20)],
    [...sol(7, 21, 25), { t: 'Figure 3: Resulting Bode plot.', gap: 0.25, x: 0.2 }, ...sol(7, 26, 33), { t: "THAT'S ALL, GOOD LUCK!", bold: true, gap: 0.02 }],
  ],
  { header: 'SSY061 Mechatronics, exam 2026-08-19' },
);

/* (b) Svenska rubriker "Uppgift 1 (4 p)" och "Lösning:" efter varje uppgift. */
export const SVENSK_INUTI = makeLayer(
  [
    [
      { t: 'Tentamen i envariabelanalys', bold: true, size: 16 / 842 },
      'Hjälpmedel: inga. Tentan omfattar totalt 20 poäng.',
      'Betygsgränser: 3: 8 p, 4: 12 p, 5: 16 p.',
      H('Uppgift 1 (4 p)'),
      'Beräkna integralen. Förklara stegen.',
      H('Lösning:'),
      'Partiell integration ger svaret 1.',
      H('Uppgift 2 (6 p)'),
      'Bestäm alla lokala extrempunkter.',
      { t: 'a) Derivera funktionen. (2 p)', x: 0.14 },
      { t: 'b) Undersök teckenväxlingen. (4 p)', x: 0.14 },
      H('Lösning:'),
      'Derivatan är noll i x = 0 och x = 2.',
    ],
    [H('Uppgift 3 (4 p)'), 'Lös differentialekvationen.', H('Lösning:'), 'y = C e^x.', H('Uppgift 4 (6 p)'), 'Visa olikheten.', H('Lösning:'), 'Induktion.', { t: 'Lycka till!', bold: true }],
  ],
  { header: 'TMA123 Envariabelanalys' },
);

/* (b2) Svenska rubriker, facit samlat på slutet efter "Lösningar". */
export const SVENSK_SLUTET = makeLayer(
  [
    [
      { t: 'Tentamen i envariabelanalys', bold: true, size: 16 / 842 },
      'Tentan omfattar totalt 20 poäng.',
      H('Uppgift 1 (4 p)'),
      'Beräkna integralen.',
      H('Uppgift 2 (6 p)'),
      'Bestäm extrempunkterna.',
      H('Uppgift 3 (4 p)'),
      'Lös ekvationen.',
      H('Uppgift 4 (6 p)'),
      'Visa olikheten.',
    ],
    [{ t: 'Lösningar', bold: true, size: 14 / 842 }, H('Uppgift 1'), 'Svaret blir 1.', H('Uppgift 2'), 'Svaret blir 2.', H('Uppgift 3'), 'Svaret blir 3.', H('Uppgift 4'), 'Svaret blir 4.'],
  ],
  { header: 'TMA123 Envariabelanalys' },
);

/* (c) Bara siffror som rubriker. */
export const BARA_SIFFROR = makeLayer([
  [
    { t: 'Tenta i fysik', bold: true, size: 16 / 842 },
    'Skriv tydligt. Max 12 p.',
    H('1. (3 p)'),
    'Beräkna kraften på lådan.',
    H('2. (3 p)'),
    'Beräkna accelerationen.',
    H('3. (3 p)'),
    'Hur långt glider lådan?',
    H('4. (3 p)'),
    'Rita ett kraftdiagram.',
  ],
]);

/* (c2) Ord-rubriker vinner över en numrerad instruktionslista på omslaget. */
export const INSTRUKTIONSLISTA = makeLayer([
  [
    'Instruktioner:',
    '1. Skriv namn på varje blad.',
    '2. Endast en uppgift per blad.',
    '3. Motivera alla svar.',
    '4. Inga mobiltelefoner.',
    H('Uppgift 1 (5 p)'),
    'Text.',
    H('Uppgift 2 (5 p)'),
    'Text.',
    H('Uppgift 3 (5 p)'),
    'Text.',
  ],
]);

/* (d) Tenta utan facit + separat facit-PDF. */
export const UTAN_FACIT = makeLayer(
  [
    ['Exam in Control Theory. In total 12 points.', H('Problem 1 (4p)'), 'Find the transfer function.', H('Problem 2 (4p)'), 'Sketch the Bode plot.'],
    [H('Problem 3 (4p)'), 'Design a PI controller.', { t: 'Good luck!', bold: true }],
  ],
  { header: 'ERE103 exam' },
);
export const SEPARAT_FACIT = makeLayer(
  [
    [{ t: 'Solutions to exam in Control Theory', bold: true, size: 16 / 842 }, H('Problem 1'), 'G(s) = 1/(s+1).', 'More text.', H('Problem 2'), 'See plot.'],
    [H('Problem 3'), 'Kp = 2, Ti = 0.5.'],
  ],
  { header: 'ERE103 solutions' },
);

/* (e) PDF utan textlager (inskannad). */
export const INSKANNAD = makeLayer([[], [{ t: 'ab' }], []], { pageNumbers: false });

/* (f) Hänvisningar i löptext får inte bli rubriker. */
export const HANVISNING = makeLayer([
  [
    'Tentan omfattar totalt 15 poäng.',
    H('Problem 1 (5 p)'),
    'Använd resultatet, se Problem 2, för att lösa uppgiften.',
    { t: 'Problem 2 och 3 handlar om samma krets, så läs båda.', x: 0.2 },
    'Problem 2 är den svåraste uppgiften på tentan.',
    H('Problem 2 (5 p)'),
    'Beräkna strömmen.',
    H('Problem 3 (5 p)'),
    'Beräkna spänningen. Se Problem 1.',
  ],
]);
