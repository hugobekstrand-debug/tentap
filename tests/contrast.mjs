// Kontrollerar textkontraster mot WCAG AA för ljust och mörkt läge.
// Läser färgtokens direkt ur css/styles.css: node tests/contrast.mjs
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');

/** Läser `--namn: värde;` ur ett CSS-block. */
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\wåäö-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('/* ---------- Mörkt läge')));
const darkStart = css.indexOf(":root[data-theme='dark'] {");
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', darkStart))) };

function resolve(map, name, depth = 0) {
  let v = map[name];
  if (!v) throw new Error(`Token saknas: ${name}`);
  const ref = v.match(/^var\((--[\wåäö-]+)\)$/);
  if (ref && depth < 10) v = resolve(map, ref[1], depth + 1);
  return v;
}

function rgb(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
}
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [beskrivning, förgrund, bakgrund, krav] – 4.5 = brödtext, 3 = stor text (≥ 18,66 px fet) eller UI-gräns
const PAIRS = [
  ['Brödtext på bakgrund', '--c-text', '--c-bg', 4.5],
  ['Brödtext på yta', '--c-text', '--c-surface', 4.5],
  ['Sekundär text på bakgrund', '--c-text-2', '--c-bg', 4.5],
  ['Tredje textnivå på bakgrund', '--c-text-3', '--c-bg', 4.5],
  ['Tredje textnivå på yta 2', '--c-text-3', '--c-surface-2', 4.5],
  ['Orange länk/text på bakgrund', '--c-accent-text', '--c-bg', 4.5],
  ['Orange text på subtil orange', '--c-accent-text', '--c-accent-subtle', 4.5],
  ['"Behöver koll" (orange text på orange-100)', '--c-warn-text', '--c-accent-soft', 4.5],
  ['Primärknapp: text på orange (19 px fet = stor text)', '--c-on-accent', '--c-accent', 3],
  ['Liten primärknapp: text på mörkare orange', '--c-on-accent', '--c-accent-hover', 4.5],
  ['"Klar"-bricka', '--c-ok-text', '--c-ok-soft', 4.5],
  ['Grön text på bakgrund', '--c-ok-text', '--c-bg', 4.5],
  ['"Svår"-bricka', '--c-hard-text', '--c-hard-soft', 4.5],
  ['"Svår"-knapp: text på yta', '--c-hard-text', '--c-surface', 4.5],
  ['Feltext på bakgrund', '--c-danger', '--c-bg', 4.5],
  ['Feltext på röd yta', '--c-danger', '--c-danger-soft', 4.5],
  ['Destruktiv knapp', '--c-on-danger', '--c-danger', 4.5],
  ['Toast', '--c-toast-text', '--c-toast-bg', 4.5],
  ['Firande: text på orange', '--c-celebrate-text', '--c-celebrate-bg', 4.5],
  ['Facit-rubrik', '--c-facit-text', '--c-bg', 4.5],
  ['Fältkant mot yta (UI, 3:1)', '--c-border-strong', '--c-surface', 3],
  ['Fokusring mot bakgrund (UI, 3:1)', '--c-focus', '--c-bg', 3],
];

let failed = 0;
for (const [mode, map] of [
  ['Ljust', light],
  ['Mörkt', dark],
]) {
  console.log(`\n${mode} läge`);
  for (const [desc, fg, bg, need] of PAIRS) {
    const a = resolve(map, fg);
    const b = resolve(map, bg);
    const r = ratio(a, b);
    const ok = r >= need;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FEL '} ${r.toFixed(2).padStart(5)}:1 (krav ${need}:1)  ${desc}  ${a} på ${b}`);
  }
}
console.log(failed ? `\n${failed} par klarar inte WCAG AA.` : '\nAlla par klarar WCAG AA.');
process.exit(failed ? 1 : 0);
