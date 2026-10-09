/**
 * stats.js — progress- och statistikberäkningar (rena funktioner, ingen DOM).
 *
 * Grundregel: 100 % visas ENDAST när alla uppgifter har status "klar".
 * "Svår" räknas inte som klar, och avrundning får aldrig ge 100 % i förtid.
 */

import { STATUS, dayKey } from './db.js';

const hasPoints = (t) => typeof t.poang === 'number' && Number.isFinite(t.poang) && t.poang > 0;
const round2 = (n) => Math.round(n * 100) / 100;
const pf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });

/** Poäng med svensk decimalform: "1,5". */
export const fmtPoints = (n) => pf.format(n);

/** Uppgifter utan poäng väger 1. */
export function weightOf(task) {
  return hasPoints(task) ? task.poang : 1;
}

/** Procent som heltal: 100 bara när allt är klart, minst 1 så fort något är klart. */
export function percent(done, total, allDone) {
  if (!total) return 0;
  if (allDone) return 100;
  const raw = (done / total) * 100;
  if (done > 0 && raw < 1) return 1;
  return Math.min(99, Math.round(raw));
}

/**
 * @param {object[]} tasks
 * @param {boolean} weighted väg efter poäng
 */
export function progress(tasks, weighted = false) {
  const r = {
    count: 0,
    doneCount: 0,
    hard: 0,
    remaining: 0,
    points: 0, // summa angivna poäng
    pointsDone: 0,
    unpointed: 0, // uppgifter utan poäng
    totalWeight: 0,
    doneWeight: 0,
    weighted,
    allDone: false,
    pct: 0,
  };
  for (const t of tasks) {
    const w = weightOf(t);
    const klar = t.status === STATUS.KLAR;
    r.count++;
    r.totalWeight += w;
    if (klar) {
      r.doneCount++;
      r.doneWeight += w;
    }
    if (t.status === STATUS.SVAR) r.hard++;
    if (hasPoints(t)) {
      r.points += t.poang;
      if (klar) r.pointsDone += t.poang;
    } else {
      r.unpointed++;
    }
  }
  r.points = round2(r.points);
  r.pointsDone = round2(r.pointsDone);
  r.totalWeight = round2(r.totalWeight);
  r.doneWeight = round2(r.doneWeight);
  r.remaining = r.count - r.doneCount;
  r.allDone = r.count > 0 && r.doneCount === r.count;
  r.pct = weighted
    ? percent(r.doneWeight, r.totalWeight, r.allDone)
    : percent(r.doneCount, r.count, r.allDone);
  return r;
}

/** "5 av 7 · 71 %" eller "14 av 25 p · 56 %". */
export function progressLabel(p) {
  const pct = `${p.pct} %`;
  if (p.weighted) return `${p.doneWeight} av ${p.totalWeight} p · ${pct}`;
  return `${p.doneCount} av ${p.count} · ${pct}`;
}

/** Antal unika uppgifter som markerats klara idag. */
export function todayCount(log, now = new Date()) {
  const today = dayKey(now);
  const ids = new Set();
  for (const e of log) if (e.dag === today) ids.add(e.taskId);
  return ids.size;
}

/**
 * Streak: antal dagar i rad med minst en klar uppgift. Räknas bakåt från
 * idag, eller från igår om inget är klart än idag (streaken lever till
 * dagen är slut).
 */
export function streak(log, now = new Date()) {
  const days = new Set(log.map((e) => e.dag));
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** Sammanfattning för markeringsläget: "7 uppgifter · 25 poäng". */
export function markingSummary(tasks) {
  const n = tasks.length;
  const points = round2(tasks.reduce((s, t) => s + (t.poang || 0), 0));
  const unpointed = tasks.filter((t) => !t.poang).length;
  let s = `${n} ${n === 1 ? 'uppgift' : 'uppgifter'} · ${fmtPoints(points)} poäng`;
  if (n && unpointed) s += ` (${unpointed} utan poäng)`;
  return s;
}

/** Stabil pseudoslumpad sorteringsnyckel (samma ordning mellan sessioner). */
export function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
