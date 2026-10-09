/**
 * db.js — IndexedDB-lagret för Tentaplugget.
 *
 * All data ligger lokalt i webbläsaren. Databasnamnet är unikt
 * ("tentaplugget-v1") eftersom alla repon under samma github.io-användare
 * delar samma origin och därmed samma IndexedDB-namnrymd.
 *
 * Object stores (DB-version = SCHEMA_VERSION):
 *   exams     { id, namn, antalSidor, sidor:[{w,h}], skapad, andrad, filnamn, storlek,
 *               extraktion, foregaendeUppgifter, facitPdf }          (v2: de tre sista)
 *   pdfs      { examId, data:ArrayBuffer, typ }       -- själva PDF-filen
 *   facitpdfs { examId, data:ArrayBuffer, typ }       -- valfri separat facit-PDF (v2)
 *   tasks     { id, examId, etikett, poang, ordning, regions, solutionRegions,
 *               status, klarTidpunkt, antalForsok, svarAntal, anteckning,
 *               delmoment, kalla, sakerhet, anmarkningar,           (v2: de fyra sista)
 *               skapad, andrad }                      -- index: examId
 *   log       { id, taskId, examId, at, dag }         -- "klar"-händelser (idag/streak)
 *   kv        { key, value }                          -- settings, schemaVersion
 *   secrets   { key, value }                          -- API-nyckel (v2). Läses ALDRIG av
 *                                                        export, finns aldrig i koden.
 *
 * Tentans extraktion (v2):
 *   extraktion { metod: "text"|"ai"|"manuell"|"ingen", tidpunkt, godkand,
 *                sammanfattning: { antal, summaPoang, angivenTotalpoang, varningar[] },
 *                rasvar: { modell, medFacit, tidpunkt, svar } }  -- cachat AI-svar
 *   foregaendeUppgifter { tidpunkt, extraktion, uppgifter[] }    -- ögonblicksbild för Ångra
 *   facitPdf { filnamn, storlek, antalSidor, sidor[] }           -- metadata; datan i facitpdfs
 * Regioner i en separat facit-PDF har fältet pdf: "facit".
 *
 * Fältnamn följer specens svenska datamodell, translittererade till ASCII
 * (poäng -> poang, antalFörsök -> antalForsok). Statusvärdena är exakt
 * "ej_gjord" | "klar" | "svår".
 *
 * Avvikelse från specen, medvetet: PDF:en lagras som ArrayBuffer i en egen
 * store i stället för som Blob på tentan. Blobbar i IndexedDB har historiskt
 * gått sönder i Safari/iOS ("WebKitBlobResource error"), och ArrayBuffer är
 * det mest robusta valet. Tentalistan behöver då inte heller läsa in
 * PDF-datan. Samma sak gäller den separata facit-PDF:en (specens
 * "facitPdfBlob"), som ligger i storen facitpdfs.
 *
 * Alla skrivningar som hör ihop görs i EN transaktion, så att ett avbrott
 * (stängd flik, fullt lagringsutrymme) aldrig lämnar halvskriven data.
 */

import { STANDARD_MODELL } from './models.js';

export const DB_NAME = 'tentaplugget-v1';
export const SCHEMA_VERSION = 2;

export const STATUS = Object.freeze({
  EJ_GJORD: 'ej_gjord',
  KLAR: 'klar',
  SVAR: 'svår',
});

export const SAKERHET = Object.freeze({ HOG: 'hög', LAG: 'låg', MANUELL: 'manuell' });
export const KALLA = Object.freeze({ TEXT: 'text', AI: 'ai', MANUELL: 'manuell' });
export const METOD = Object.freeze({ TEXT: 'text', AI: 'ai', MANUELL: 'manuell', INGEN: 'ingen' });

export const DEFAULT_SETTINGS = Object.freeze({
  viktaEfterPoang: false,
  ordning: 'blandad', // "blandad" | "kronologisk" | "svåra_först"
  valdaTentor: null, // null = alla tentor; annars lista med exam-id
  senastOppnadUppgift: {}, // { [scopeKey]: taskId } — återuppta pluggpass
  senasteExport: null, // ISO-datum
  tema: 'system', // "system" | "ljust" | "mörkt"
  backupPaminnelseDoldTill: null, // ISO-datum
  modell: STANDARD_MODELL, // Claude-modell för AI-igenkänning (Premium)
  dagsmal: 3, // uppgifter per dag ("Idag 2 av 3")
});

/* ------------------------------------------------------------------ */
/* Fel                                                                 */
/* ------------------------------------------------------------------ */

export class StorageUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export class StorageFullError extends Error {
  constructor() {
    super(
      'Det finns inte tillräckligt med lagringsutrymme. Frigör utrymme på enheten ' +
        'eller ta bort tentor du inte längre behöver, och försök igen.',
    );
    this.name = 'StorageFullError';
  }
}

function wrapError(err) {
  if (!err) return new Error('Okänt lagringsfel');
  if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageFullError();
  }
  return err;
}

/* ------------------------------------------------------------------ */
/* Ändringshändelser (även mellan flikar)                              */
/* ------------------------------------------------------------------ */

const bus = new EventTarget();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DB_NAME) : null;
if (channel) {
  channel.onmessage = (ev) => {
    if (ev.data?.type === 'settings') settingsCache = null;
    bus.dispatchEvent(new CustomEvent('change', { detail: { ...ev.data, remote: true } }));
  };
}

/** Lyssna på dataändringar. Returnerar en funktion som slutar lyssna. */
export function onChange(fn) {
  const handler = (ev) => fn(ev.detail);
  bus.addEventListener('change', handler);
  return () => bus.removeEventListener('change', handler);
}

/** Lyssna på att databasen behöver stängas (ny version öppnad i annan flik). */
export function onVersionChange(fn) {
  bus.addEventListener('versionchange', fn);
}

function emit(detail) {
  bus.dispatchEvent(new CustomEvent('change', { detail }));
  try {
    channel?.postMessage(detail);
  } catch {
    /* ignorera */
  }
}

/* ------------------------------------------------------------------ */
/* Öppna och migrera                                                   */
/* ------------------------------------------------------------------ */

/**
 * Migreringar per DB-version. Nyckeln är versionen man migrerar TILL.
 * Lägg till nya steg här när datamodellen ändras — ta aldrig bort gamla.
 */
const MIGRATIONS = {
  1(db) {
    db.createObjectStore('exams', { keyPath: 'id' });
    db.createObjectStore('pdfs', { keyPath: 'examId' });
    const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
    tasks.createIndex('examId', 'examId', { unique: false });
    db.createObjectStore('log', { keyPath: 'id' });
    db.createObjectStore('kv', { keyPath: 'key' });
  },
  /**
   * v2: textigenkänning, AI (Premium) och separat facit-PDF.
   * Nya stores för hemligheter och facit-PDF:er. Befintliga tentor och
   * uppgifter får standardvärden: de är markerade för hand, så metod och
   * källa blir "manuell". Inget tas bort eller skrivs över.
   */
  2(db, tx) {
    if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('facitpdfs')) db.createObjectStore('facitpdfs', { keyPath: 'examId' });
    const withTasks = new Set();
    const tasks = tx.objectStore('tasks');
    tasks.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) {
        migrateExamsV2(tx, withTasks);
        return;
      }
      const t = cur.value;
      withTasks.add(t.examId);
      cur.update({
        ...t,
        delmoment: Array.isArray(t.delmoment) ? t.delmoment : [],
        kalla: t.kalla || KALLA.MANUELL,
        sakerhet: t.sakerhet || SAKERHET.MANUELL,
        anmarkningar: Array.isArray(t.anmarkningar) ? t.anmarkningar : [],
      });
      cur.continue();
    };
  },
};

function migrateExamsV2(tx, withTasks) {
  tx.objectStore('exams').openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    const e = cur.value;
    cur.update({
      ...e,
      extraktion: e.extraktion || defaultExtraktion(withTasks.has(e.id) ? METOD.MANUELL : METOD.INGEN),
      foregaendeUppgifter: e.foregaendeUppgifter ?? null,
      facitPdf: e.facitPdf ?? null,
    });
    cur.continue();
  };
}

export function defaultExtraktion(metod = METOD.INGEN) {
  return { metod, tidpunkt: null, godkand: null, sammanfattning: null, rasvar: null };
}

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new StorageUnavailableError('IndexedDB saknas'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    } catch (err) {
      reject(new StorageUnavailableError(err?.message || 'IndexedDB kunde inte öppnas'));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      for (let v = ev.oldVersion + 1; v <= ev.newVersion; v++) {
        MIGRATIONS[v]?.(db, tx);
      }
      tx.objectStore('kv').put({ key: 'schemaVersion', value: ev.newVersion });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        bus.dispatchEvent(new CustomEvent('versionchange'));
      };
      resolve(db);
    };
    req.onerror = () => reject(new StorageUnavailableError(req.error?.message || 'okänt fel'));
    req.onblocked = () => {
      /* En äldre flik håller databasen öppen; den stängs via onversionchange. */
    };
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Kontrollera att det faktiskt går att skriva (vissa privata lägen tillåter bara läsning). */
export async function probeStorage() {
  try {
    await tx(['kv'], 'readwrite', (t) => {
      const s = t.objectStore('kv');
      s.put({ key: '__probe', value: Date.now() });
      s.delete('__probe');
    });
  } catch (err) {
    if (err instanceof StorageFullError) throw err;
    throw new StorageUnavailableError(err?.message || 'skrivtest misslyckades');
  }
}

/* ------------------------------------------------------------------ */
/* Hjälpare                                                            */
/* ------------------------------------------------------------------ */

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Kör fn(transaction) och resolvar när transaktionen är committad.
 * fn får bara vänta på IDB-förfrågningar (inte på fetch e.d.), annars
 * stängs transaktionen automatiskt.
 */
async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(stores, mode);
    } catch (err) {
      reject(wrapError(err));
      return;
    }
    let result;
    let failed = false;
    t.oncomplete = () => resolve(result);
    t.onabort = () => {
      if (!failed) reject(wrapError(t.error || new DOMException('Transaktionen avbröts', 'AbortError')));
    };
    Promise.resolve()
      .then(() => fn(t))
      .then(
        (r) => {
          result = r;
        },
        (err) => {
          failed = true;
          try {
            t.abort();
          } catch {
            /* redan avslutad */
          }
          reject(wrapError(err));
        },
      );
  });
}

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const nowIso = () => new Date().toISOString();

/** Lokal dag som "ÅÅÅÅ-MM-DD". */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Normalisering                                                       */
/* ------------------------------------------------------------------ */

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Validerar och normaliserar en region. Returnerar null om den är ogiltig.
 * Regioner i en separat facit-PDF har pdf: "facit" och valideras mot den
 * PDF:ens sidantal (facitSidor).
 */
export function normalizeRegion(r, antalSidor = Infinity, facitSidor = Infinity) {
  if (!r || typeof r !== 'object') return null;
  const sida = Number(r.sida);
  const isFacit = r.pdf === 'facit';
  let { x, y, w, h } = r;
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (!Number.isInteger(sida) || sida < 1 || sida > (isFacit ? facitSidor : antalSidor)) return null;
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(clamp01(w), 1 - x);
  h = Math.min(clamp01(h), 1 - y);
  if (w <= 0.001 || h <= 0.001) return null;
  return isFacit ? { sida, x, y, w, h, pdf: 'facit' } : { sida, x, y, w, h };
}

/** Poäng: positivt tal (halvpoäng som "1,5" går bra), annars null. */
export function normalizePoang(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return Math.round(n * 100) / 100;
}

function normalizeDelmoment(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({ etikett: String(d.etikett ?? '').slice(0, 20), poang: normalizePoang(d.poang) }))
    .filter((d) => d.etikett)
    .slice(0, 26);
}

const SAKERHET_VALUES = Object.values(SAKERHET);
const KALLA_VALUES = Object.values(KALLA);

/** Fyller i standardvärden så att äldre/importerade uppgifter alltid har alla fält. */
export function normalizeTask(t, antalSidor = Infinity, facitSidor = Infinity) {
  const status = Object.values(STATUS).includes(t.status) ? t.status : STATUS.EJ_GJORD;
  return {
    id: String(t.id),
    examId: String(t.examId),
    etikett: String(t.etikett ?? '').slice(0, 120) || 'Uppgift',
    poang: normalizePoang(t.poang),
    ordning: Number.isFinite(t.ordning) ? t.ordning : 0,
    regions: (Array.isArray(t.regions) ? t.regions : [])
      .filter((r) => r?.pdf !== 'facit')
      .map((r) => normalizeRegion(r, antalSidor))
      .filter(Boolean),
    solutionRegions: (Array.isArray(t.solutionRegions) ? t.solutionRegions : [])
      .map((r) => normalizeRegion(r, antalSidor, facitSidor))
      .filter(Boolean),
    status,
    klarTidpunkt: status === STATUS.KLAR ? t.klarTidpunkt || null : null,
    antalForsok: Number.isInteger(t.antalForsok) && t.antalForsok >= 0 ? t.antalForsok : 0,
    svarAntal: Number.isInteger(t.svarAntal) && t.svarAntal >= 0 ? t.svarAntal : 0,
    anteckning: typeof t.anteckning === 'string' ? t.anteckning : '',
    delmoment: normalizeDelmoment(t.delmoment),
    kalla: KALLA_VALUES.includes(t.kalla) ? t.kalla : KALLA.MANUELL,
    sakerhet: SAKERHET_VALUES.includes(t.sakerhet) ? t.sakerhet : SAKERHET.MANUELL,
    anmarkningar: Array.isArray(t.anmarkningar) ? t.anmarkningar.filter((a) => typeof a === 'string').slice(0, 10) : [],
    skapad: t.skapad || nowIso(),
    andrad: t.andrad || t.skapad || nowIso(),
  };
}

/** Fält som bara pluggläget ändrar. Markeringsläget skriver aldrig över dem. */
export const PROGRESS_FIELDS = ['status', 'klarTidpunkt', 'antalForsok', 'svarAntal', 'anteckning'];

/** Fyller i standardvärden för tentans v2-fält (äldre data, import). */
export function normalizeExam(e) {
  if (!e) return e;
  const ex = e.extraktion && typeof e.extraktion === 'object' ? e.extraktion : null;
  const metod = ex && Object.values(METOD).includes(ex.metod) ? ex.metod : METOD.INGEN;
  return {
    ...e,
    extraktion: { ...defaultExtraktion(metod), ...(ex || {}), metod },
    foregaendeUppgifter: e.foregaendeUppgifter && Array.isArray(e.foregaendeUppgifter.uppgifter) ? e.foregaendeUppgifter : null,
    facitPdf:
      e.facitPdf && Number.isInteger(e.facitPdf.antalSidor) && Array.isArray(e.facitPdf.sidor) ? e.facitPdf : null,
  };
}

/* ------------------------------------------------------------------ */
/* Tentor                                                              */
/* ------------------------------------------------------------------ */

export async function listExams() {
  const exams = await tx(['exams'], 'readonly', (t) => reqP(t.objectStore('exams').getAll()));
  return exams.map(normalizeExam).sort((a, b) => String(a.skapad).localeCompare(String(b.skapad)));
}

export async function getExam(id) {
  return normalizeExam(await tx(['exams'], 'readonly', (t) => reqP(t.objectStore('exams').get(id))));
}

/** Sparar tenta + PDF atomiskt: antingen finns båda, eller ingen av dem. */
export async function addExam(exam, data) {
  const record = normalizeExam({ ...exam, skapad: exam.skapad || nowIso(), andrad: nowIso() });
  await tx(['exams', 'pdfs'], 'readwrite', (t) => {
    t.objectStore('exams').put(record);
    t.objectStore('pdfs').put({ examId: record.id, data, typ: 'application/pdf' });
  });
  emit({ type: 'exams' });
  return record;
}

export async function updateExam(id, patch) {
  const updated = await tx(['exams'], 'readwrite', async (t) => {
    const store = t.objectStore('exams');
    const exam = await reqP(store.get(id));
    if (!exam) throw new Error('Tentan finns inte längre.');
    const next = { ...exam, ...patch, id, andrad: nowIso() };
    store.put(next);
    return next;
  });
  emit({ type: 'exams' });
  return updated;
}

/** Tar bort tenta, PDF:er och uppgifter. Logghistoriken (streak) behålls. */
export async function deleteExam(id) {
  await tx(['exams', 'pdfs', 'facitpdfs', 'tasks'], 'readwrite', async (t) => {
    t.objectStore('exams').delete(id);
    t.objectStore('pdfs').delete(id);
    t.objectStore('facitpdfs').delete(id);
    const tasks = t.objectStore('tasks');
    const keys = await reqP(tasks.index('examId').getAllKeys(id));
    for (const k of keys) tasks.delete(k);
  });
  emit({ type: 'exams' });
}

/** @param {'tenta'|'facit'} which vilken PDF (tentan eller den separata facit-PDF:en) */
export async function getPdfData(examId, which = 'tenta') {
  const store = which === 'facit' ? 'facitpdfs' : 'pdfs';
  const rec = await tx([store], 'readonly', (t) => reqP(t.objectStore(store).get(examId)));
  if (!rec) return null;
  // Äldre/andra webbläsare kan ha lagrat Blob — hantera båda.
  if (rec.data instanceof ArrayBuffer) return rec.data;
  if (rec.data && typeof rec.data.arrayBuffer === 'function') return rec.data.arrayBuffer();
  return null;
}

/** Sparar en separat facit-PDF till tentan (ersätter en tidigare). */
export async function setFacitPdf(examId, data, meta) {
  const updated = await tx(['exams', 'facitpdfs'], 'readwrite', async (t) => {
    const store = t.objectStore('exams');
    const exam = await reqP(store.get(examId));
    if (!exam) throw new Error('Tentan finns inte längre.');
    const next = { ...exam, facitPdf: meta, andrad: nowIso() };
    store.put(next);
    t.objectStore('facitpdfs').put({ examId, data, typ: 'application/pdf' });
    return next;
  });
  emit({ type: 'exams' });
  return normalizeExam(updated);
}

/** Tar bort den separata facit-PDF:en och facitområden som pekar in i den. */
export async function removeFacitPdf(examId) {
  await tx(['exams', 'facitpdfs', 'tasks'], 'readwrite', async (t) => {
    const store = t.objectStore('exams');
    const exam = await reqP(store.get(examId));
    if (exam) store.put({ ...exam, facitPdf: null, andrad: nowIso() });
    t.objectStore('facitpdfs').delete(examId);
    const tasks = t.objectStore('tasks');
    for (const task of await reqP(tasks.index('examId').getAll(examId))) {
      const sol = (task.solutionRegions || []).filter((r) => r.pdf !== 'facit');
      if (sol.length !== (task.solutionRegions || []).length) tasks.put({ ...task, solutionRegions: sol, andrad: nowIso() });
    }
  });
  emit({ type: 'exams' });
  emit({ type: 'tasks', examId });
}

/* ------------------------------------------------------------------ */
/* Uppgifter                                                           */
/* ------------------------------------------------------------------ */

export async function listTasks(examId) {
  const tasks = await tx(['tasks'], 'readonly', (t) => {
    const store = t.objectStore('tasks');
    return reqP(examId ? store.index('examId').getAll(examId) : store.getAll());
  });
  return tasks.map((x) => normalizeTask(x)).sort((a, b) => a.ordning - b.ordning);
}

export async function getTask(id) {
  const t = await tx(['tasks'], 'readonly', (tr) => reqP(tr.objectStore('tasks').get(id)));
  return t ? normalizeTask(t) : null;
}

/** Sparar en uppgift (används av pluggläget för statusbyten). */
export async function putTask(task) {
  const rec = { ...task, andrad: nowIso() };
  await tx(['tasks'], 'readwrite', (t) => {
    t.objectStore('tasks').put(rec);
  });
  emit({ type: 'tasks', examId: task.examId });
  return rec;
}

/**
 * Ersätter en tentas uppgifter med listan (används av markeringsläget,
 * inkl. ångra/gör om). Uppgifter som inte finns i listan tas bort.
 * Framstegsfält (status m.m.) tas alltid från databasen för uppgifter som
 * redan finns, så att markeringsläget aldrig kan skriva över framsteg som
 * gjorts i en annan flik.
 */
export async function replaceExamTasks(examId, tasks) {
  await tx(['tasks'], 'readwrite', async (t) => {
    const store = t.objectStore('tasks');
    const existing = await reqP(store.index('examId').getAll(examId));
    const byId = new Map(existing.map((x) => [x.id, x]));
    const keep = new Set();
    for (const task of tasks) {
      const old = byId.get(task.id);
      const rec = { ...task, examId };
      if (old) {
        for (const f of PROGRESS_FIELDS) if (f in old) rec[f] = old[f];
        const changed = JSON.stringify(stripMeta(old)) !== JSON.stringify(stripMeta(rec));
        rec.andrad = changed ? nowIso() : old.andrad;
      } else {
        rec.andrad = nowIso();
      }
      store.put(rec);
      keep.add(task.id);
    }
    for (const old of existing) if (!keep.has(old.id)) store.delete(old.id);
  });
  emit({ type: 'tasks', examId });
}

function stripMeta(t) {
  const { andrad, ...rest } = t;
  return rest;
}

/** Nollställ framsteg: behåll uppgifterna men sätt alla till "ej_gjord". */
export async function resetProgress(examIds) {
  await tx(['tasks'], 'readwrite', async (t) => {
    const store = t.objectStore('tasks');
    for (const examId of examIds) {
      const tasks = await reqP(store.index('examId').getAll(examId));
      for (const task of tasks) {
        store.put({
          ...task,
          status: STATUS.EJ_GJORD,
          klarTidpunkt: null,
          svarAntal: 0,
          andrad: nowIso(),
        });
      }
    }
  });
  emit({ type: 'tasks' });
}

/* ------------------------------------------------------------------ */
/* Igenkänning: ersätt uppgifter med Ångra                              */
/* ------------------------------------------------------------------ */

/** Jämförbar etikett: "Problem 3", "Uppgift 3" och "3." matchar varandra. */
export function labelKey(etikett) {
  const s = String(etikett || '').normalize('NFC').toLowerCase();
  const m = s.match(/(\d+)\s*([a-h])?\b/);
  return m ? `${m[1]}${m[2] || ''}` : s.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Ersätter tentans uppgifter med ett igenkänningsresultat, i EN transaktion.
 * - Uppgifter som matchar en befintlig på etikett behåller dess id, status
 *   och framsteg (så att logg/streak och "fortsätt där du var" fungerar).
 * - Den tidigare uppsättningen sparas i exam.foregaendeUppgifter (Ångra).
 * @returns {{exam:object, tasks:object[], preserved:number}}
 */
export async function applyExtraction(examId, newTasks, extraktion) {
  let preserved = 0;
  const result = await tx(['exams', 'tasks'], 'readwrite', async (t) => {
    const exams = t.objectStore('exams');
    const store = t.objectStore('tasks');
    const exam = await reqP(exams.get(examId));
    if (!exam) throw new Error('Tentan finns inte längre.');
    const existing = (await reqP(store.index('examId').getAll(examId))).sort((a, b) => a.ordning - b.ordning);
    const byKey = new Map();
    for (const old of existing) {
      const k = labelKey(old.etikett);
      if (!byKey.has(k)) byKey.set(k, old);
    }
    const used = new Set();
    const now = nowIso();
    const out = newTasks.map((task, i) => {
      const old = byKey.get(labelKey(task.etikett));
      const rec = { ...task, examId, ordning: i, skapad: task.skapad || now, andrad: now };
      if (old && !used.has(old.id)) {
        used.add(old.id);
        rec.id = old.id;
        rec.skapad = old.skapad || rec.skapad;
        for (const f of PROGRESS_FIELDS) if (f in old) rec[f] = old[f];
        if (old.status && old.status !== STATUS.EJ_GJORD) preserved++;
      }
      return rec;
    });
    for (const old of existing) store.delete(old.id);
    for (const rec of out) store.put(rec);
    const prev = normalizeExam(exam);
    const next = {
      ...exam,
      extraktion: {
        ...extraktion,
        // Det cachade AI-svaret följer med, så att samma tenta aldrig faktureras två gånger.
        rasvar: extraktion.rasvar ?? prev.extraktion.rasvar ?? null,
      },
      foregaendeUppgifter: { tidpunkt: now, extraktion: { ...prev.extraktion, rasvar: null }, uppgifter: existing },
      andrad: now,
    };
    exams.put(next);
    return { exam: normalizeExam(next), tasks: out.map((x) => normalizeTask(x)) };
  });
  emit({ type: 'tasks', examId });
  emit({ type: 'exams' });
  return { ...result, preserved };
}

/** Ångra: återställ uppgifterna från ögonblicksbilden före senaste omanalys. */
export async function undoExtraction(examId) {
  await tx(['exams', 'tasks'], 'readwrite', async (t) => {
    const exams = t.objectStore('exams');
    const store = t.objectStore('tasks');
    const exam = normalizeExam(await reqP(exams.get(examId)));
    const snap = exam?.foregaendeUppgifter;
    if (!snap) throw new Error('Det finns inget att ångra.');
    const current = await reqP(store.index('examId').getAll(examId));
    const currentById = new Map(current.map((x) => [x.id, x]));
    for (const c of current) store.delete(c.id);
    for (const old of snap.uppgifter) {
      // Framsteg som gjorts sedan omanalysen (samma id) följer med tillbaka.
      const now = currentById.get(old.id);
      const rec = { ...old };
      if (now) for (const f of PROGRESS_FIELDS) if (f in now) rec[f] = now[f];
      store.put(rec);
    }
    exams.put({
      ...exam,
      extraktion: { ...snap.extraktion, rasvar: exam.extraktion.rasvar },
      foregaendeUppgifter: null,
      andrad: nowIso(),
    });
  });
  emit({ type: 'tasks', examId });
  emit({ type: 'exams' });
}

/* ------------------------------------------------------------------ */
/* Hemligheter (API-nyckel). Egen store, aldrig i export.               */
/* ------------------------------------------------------------------ */

export async function getSecret(key) {
  const rec = await tx(['secrets'], 'readonly', (t) => reqP(t.objectStore('secrets').get(key)));
  return rec?.value ?? null;
}

export async function setSecret(key, value) {
  await tx(['secrets'], 'readwrite', (t) => {
    t.objectStore('secrets').put({ key, value });
  });
  emit({ type: 'secrets' });
}

export async function deleteSecret(key) {
  await tx(['secrets'], 'readwrite', (t) => {
    t.objectStore('secrets').delete(key);
  });
  emit({ type: 'secrets' });
}

/* ------------------------------------------------------------------ */
/* Logg (för "idag" och streak)                                        */
/* ------------------------------------------------------------------ */

export async function addLog(entry) {
  const rec = { id: uid(), at: nowIso(), dag: dayKey(), ...entry };
  await tx(['log'], 'readwrite', (t) => {
    t.objectStore('log').put(rec);
  });
  emit({ type: 'log' });
  return rec;
}

export async function deleteLog(id) {
  await tx(['log'], 'readwrite', (t) => {
    t.objectStore('log').delete(id);
  });
  emit({ type: 'log' });
}

export function listLog() {
  return tx(['log'], 'readonly', (t) => reqP(t.objectStore('log').getAll()));
}

/**
 * Pluggläget: spara uppgiftens nya status och logga/avlogga i samma
 * transaktion, så att uppgift och statistik aldrig hamnar i otakt.
 */
export async function saveTaskProgress(task, { addLogEntry = null, removeLogId = null } = {}) {
  const rec = { ...task, andrad: nowIso() };
  let logRec = null;
  await tx(['tasks', 'log'], 'readwrite', (t) => {
    t.objectStore('tasks').put(rec);
    if (addLogEntry) {
      logRec = { id: uid(), at: nowIso(), dag: dayKey(), ...addLogEntry };
      t.objectStore('log').put(logRec);
    }
    if (removeLogId) t.objectStore('log').delete(removeLogId);
  });
  emit({ type: 'tasks', examId: task.examId });
  return { task: rec, log: logRec };
}

/* ------------------------------------------------------------------ */
/* Inställningar                                                       */
/* ------------------------------------------------------------------ */

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return structuredClone(settingsCache);
  const rec = await tx(['kv'], 'readonly', (t) => reqP(t.objectStore('kv').get('settings')));
  settingsCache = { ...DEFAULT_SETTINGS, ...(rec?.value || {}) };
  return structuredClone(settingsCache);
}

export async function saveSettings(patch) {
  const next = await tx(['kv'], 'readwrite', async (t) => {
    const store = t.objectStore('kv');
    const rec = await reqP(store.get('settings'));
    const value = { ...DEFAULT_SETTINGS, ...(rec?.value || {}), ...patch };
    store.put({ key: 'settings', value });
    return value;
  });
  settingsCache = next;
  emit({ type: 'settings' });
  return structuredClone(next);
}

/* ------------------------------------------------------------------ */
/* Export / import / rensa                                             */
/* ------------------------------------------------------------------ */

/**
 * Allt utom PDF-datan (som läses en i taget vid export för att spara minne).
 * Storen "secrets" läses medvetet INTE: API-nyckeln följer aldrig med i en export.
 */
export async function readAllForExport() {
  return tx(['exams', 'tasks', 'log', 'kv'], 'readonly', async (t) => {
    const [exams, tasks, log, settingsRec] = await Promise.all([
      reqP(t.objectStore('exams').getAll()),
      reqP(t.objectStore('tasks').getAll()),
      reqP(t.objectStore('log').getAll()),
      reqP(t.objectStore('kv').get('settings')),
    ]);
    return { exams, tasks, log, settings: { ...DEFAULT_SETTINGS, ...(settingsRec?.value || {}) } };
  });
}

export async function counts() {
  return tx(['exams', 'tasks'], 'readonly', async (t) => {
    const [exams, tasks] = await Promise.all([
      reqP(t.objectStore('exams').count()),
      reqP(t.objectStore('tasks').count()),
    ]);
    return { exams, tasks };
  });
}

/**
 * Skriver importerad data i EN transaktion. Misslyckas något (t.ex. fullt
 * lagringsutrymme) rullas allt tillbaka och befintlig data är orörd.
 *
 * mode "replace": allt befintligt tas bort och ersätts.
 * mode "merge":   inget tas bort. Nya tentor/uppgifter läggs till; finns
 *                 samma uppgift redan behålls den som ändrats senast.
 *
 * @param {{exams:Array<{exam:object,data:ArrayBuffer,facitData?:ArrayBuffer}>, tasks:object[], log:object[], settings:object}} data
 */
export async function importData(data, mode) {
  await tx(['exams', 'pdfs', 'facitpdfs', 'tasks', 'log', 'kv'], 'readwrite', async (t) => {
    const exams = t.objectStore('exams');
    const pdfs = t.objectStore('pdfs');
    const facitpdfs = t.objectStore('facitpdfs');
    const putFacit = (exam, buf) => {
      if (buf && exam.facitPdf) facitpdfs.put({ examId: exam.id, data: buf, typ: 'application/pdf' });
    };
    const tasks = t.objectStore('tasks');
    const log = t.objectStore('log');
    const kv = t.objectStore('kv');

    if (mode === 'replace') {
      exams.clear();
      pdfs.clear();
      facitpdfs.clear();
      tasks.clear();
      log.clear();
      for (const { exam, data: buf, facitData } of data.exams) {
        exams.put(exam);
        pdfs.put({ examId: exam.id, data: buf, typ: 'application/pdf' });
        putFacit(exam, facitData);
      }
      for (const task of data.tasks) tasks.put(task);
      for (const entry of data.log) log.put(entry);
      kv.put({ key: 'settings', value: { ...DEFAULT_SETTINGS, ...data.settings } });
      return;
    }

    // merge
    for (const { exam, data: buf, facitData } of data.exams) {
      const old = await reqP(exams.get(exam.id));
      if (!old) {
        exams.put(exam);
        pdfs.put({ examId: exam.id, data: buf, typ: 'application/pdf' });
        putFacit(exam, facitData);
      } else if (String(exam.andrad) > String(old.andrad)) {
        exams.put({ ...old, namn: exam.namn, andrad: exam.andrad });
      }
    }
    for (const task of data.tasks) {
      const old = await reqP(tasks.get(task.id));
      if (!old || String(task.andrad) > String(old.andrad)) tasks.put(task);
    }
    for (const entry of data.log) {
      const old = await reqP(log.get(entry.id));
      if (!old) log.put(entry);
    }
    const rec = await reqP(kv.get('settings'));
    const current = { ...DEFAULT_SETTINGS, ...(rec?.value || {}) };
    const importedExport = data.settings?.senasteExport;
    if (importedExport && (!current.senasteExport || importedExport > current.senasteExport)) {
      current.senasteExport = importedExport;
    }
    if (Array.isArray(current.valdaTentor)) {
      for (const { exam } of data.exams) {
        if (!current.valdaTentor.includes(exam.id)) current.valdaTentor.push(exam.id);
      }
    }
    kv.put({ key: 'settings', value: current });
  });
  settingsCache = null;
  emit({ type: 'import' });
  emit({ type: 'settings' });
}

/** Raderar ALL data, även en sparad API-nyckel (används bara efter uttrycklig bekräftelse). */
export async function clearAll() {
  await tx(['exams', 'pdfs', 'facitpdfs', 'tasks', 'log', 'kv', 'secrets'], 'readwrite', (t) => {
    for (const s of ['exams', 'pdfs', 'facitpdfs', 'tasks', 'log', 'secrets']) t.objectStore(s).clear();
    const kv = t.objectStore('kv');
    kv.delete('settings');
    kv.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
  });
  settingsCache = null;
  emit({ type: 'import' });
  emit({ type: 'settings' });
  emit({ type: 'secrets' });
}

/* ------------------------------------------------------------------ */
/* Lagringsstatus                                                      */
/* ------------------------------------------------------------------ */

/** Be webbläsaren skydda datan från automatisk rensning. */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      info.usage = est.usage ?? null;
      info.quota = est.quota ?? null;
    }
  } catch {
    /* ej tillgängligt */
  }
  return info;
}
