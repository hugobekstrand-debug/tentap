/**
 * db.js — IndexedDB-lagret för Tentaplugget.
 *
 * All data ligger lokalt i webbläsaren. Databasnamnet är unikt
 * ("tentaplugget-v1") eftersom alla repon under samma github.io-användare
 * delar samma origin och därmed samma IndexedDB-namnrymd.
 *
 * Object stores (DB-version = SCHEMA_VERSION):
 *   exams  { id, namn, antalSidor, sidor:[{w,h}], skapad, andrad, filnamn, storlek }
 *   pdfs   { examId, data:ArrayBuffer, typ }            -- själva PDF-filen
 *   tasks  { id, examId, etikett, poang, ordning, regions, solutionRegions,
 *            status, klarTidpunkt, antalForsok, svarAntal, anteckning,
 *            skapad, andrad }                           -- index: examId
 *   log    { id, taskId, examId, at, dag }              -- "klar"-händelser (idag/streak)
 *   kv     { key, value }                               -- settings, schemaVersion
 *
 * Fältnamn följer specens svenska datamodell, translittererade till ASCII
 * (poäng -> poang, antalFörsök -> antalForsok). Statusvärdena är exakt
 * "ej_gjord" | "klar" | "svår".
 *
 * Avvikelse från specen, medvetet: PDF:en lagras som ArrayBuffer i en egen
 * store i stället för som Blob på tentan. Blobbar i IndexedDB har historiskt
 * gått sönder i Safari/iOS ("WebKitBlobResource error"), och ArrayBuffer är
 * det mest robusta valet. Tentalistan behöver då inte heller läsa in
 * PDF-datan.
 *
 * Alla skrivningar som hör ihop görs i EN transaktion, så att ett avbrott
 * (stängd flik, fullt lagringsutrymme) aldrig lämnar halvskriven data.
 */

export const DB_NAME = 'tentaplugget-v1';
export const SCHEMA_VERSION = 1;

export const STATUS = Object.freeze({
  EJ_GJORD: 'ej_gjord',
  KLAR: 'klar',
  SVAR: 'svår',
});

export const DEFAULT_SETTINGS = Object.freeze({
  viktaEfterPoang: false,
  ordning: 'blandad', // "blandad" | "kronologisk" | "svåra_först"
  valdaTentor: null, // null = alla tentor; annars lista med exam-id
  senastOppnadUppgift: {}, // { [scopeKey]: taskId } — återuppta pluggpass
  senasteExport: null, // ISO-datum
  tema: 'system', // "system" | "ljust" | "mörkt"
  backupPaminnelseDoldTill: null, // ISO-datum
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
};

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

/** Validerar och normaliserar en region. Returnerar null om den är ogiltig. */
export function normalizeRegion(r, antalSidor = Infinity) {
  if (!r || typeof r !== 'object') return null;
  const sida = Number(r.sida);
  let { x, y, w, h } = r;
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (!Number.isInteger(sida) || sida < 1 || sida > antalSidor) return null;
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(clamp01(w), 1 - x);
  h = Math.min(clamp01(h), 1 - y);
  if (w <= 0.001 || h <= 0.001) return null;
  return { sida, x, y, w, h };
}

export function normalizePoang(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
  return n;
}

/** Fyller i standardvärden så att äldre/importerade uppgifter alltid har alla fält. */
export function normalizeTask(t, antalSidor = Infinity) {
  const status = Object.values(STATUS).includes(t.status) ? t.status : STATUS.EJ_GJORD;
  return {
    id: String(t.id),
    examId: String(t.examId),
    etikett: String(t.etikett ?? '').slice(0, 120) || 'Uppgift',
    poang: normalizePoang(t.poang),
    ordning: Number.isFinite(t.ordning) ? t.ordning : 0,
    regions: (Array.isArray(t.regions) ? t.regions : [])
      .map((r) => normalizeRegion(r, antalSidor))
      .filter(Boolean),
    solutionRegions: (Array.isArray(t.solutionRegions) ? t.solutionRegions : [])
      .map((r) => normalizeRegion(r, antalSidor))
      .filter(Boolean),
    status,
    klarTidpunkt: status === STATUS.KLAR ? t.klarTidpunkt || null : null,
    antalForsok: Number.isInteger(t.antalForsok) && t.antalForsok >= 0 ? t.antalForsok : 0,
    svarAntal: Number.isInteger(t.svarAntal) && t.svarAntal >= 0 ? t.svarAntal : 0,
    anteckning: typeof t.anteckning === 'string' ? t.anteckning : '',
    skapad: t.skapad || nowIso(),
    andrad: t.andrad || t.skapad || nowIso(),
  };
}

/** Fält som bara pluggläget ändrar. Markeringsläget skriver aldrig över dem. */
const PROGRESS_FIELDS = ['status', 'klarTidpunkt', 'antalForsok', 'svarAntal', 'anteckning'];

/* ------------------------------------------------------------------ */
/* Tentor                                                              */
/* ------------------------------------------------------------------ */

export async function listExams() {
  const exams = await tx(['exams'], 'readonly', (t) => reqP(t.objectStore('exams').getAll()));
  return exams.sort((a, b) => String(a.skapad).localeCompare(String(b.skapad)));
}

export function getExam(id) {
  return tx(['exams'], 'readonly', (t) => reqP(t.objectStore('exams').get(id)));
}

/** Sparar tenta + PDF atomiskt: antingen finns båda, eller ingen av dem. */
export async function addExam(exam, data) {
  const record = { ...exam, skapad: exam.skapad || nowIso(), andrad: nowIso() };
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

/** Tar bort tenta, PDF och uppgifter. Logghistoriken (streak) behålls. */
export async function deleteExam(id) {
  await tx(['exams', 'pdfs', 'tasks'], 'readwrite', async (t) => {
    t.objectStore('exams').delete(id);
    t.objectStore('pdfs').delete(id);
    const tasks = t.objectStore('tasks');
    const keys = await reqP(tasks.index('examId').getAllKeys(id));
    for (const k of keys) tasks.delete(k);
  });
  emit({ type: 'exams' });
}

export async function getPdfData(examId) {
  const rec = await tx(['pdfs'], 'readonly', (t) => reqP(t.objectStore('pdfs').get(examId)));
  if (!rec) return null;
  // Äldre/andra webbläsare kan ha lagrat Blob — hantera båda.
  if (rec.data instanceof ArrayBuffer) return rec.data;
  if (rec.data && typeof rec.data.arrayBuffer === 'function') return rec.data.arrayBuffer();
  return null;
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

/** Allt utom PDF-datan (som läses en i taget vid export för att spara minne). */
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
 * @param {{exams:Array<{exam:object,data:ArrayBuffer}>, tasks:object[], log:object[], settings:object}} data
 */
export async function importData(data, mode) {
  await tx(['exams', 'pdfs', 'tasks', 'log', 'kv'], 'readwrite', async (t) => {
    const exams = t.objectStore('exams');
    const pdfs = t.objectStore('pdfs');
    const tasks = t.objectStore('tasks');
    const log = t.objectStore('log');
    const kv = t.objectStore('kv');

    if (mode === 'replace') {
      exams.clear();
      pdfs.clear();
      tasks.clear();
      log.clear();
      for (const { exam, data: buf } of data.exams) {
        exams.put(exam);
        pdfs.put({ examId: exam.id, data: buf, typ: 'application/pdf' });
      }
      for (const task of data.tasks) tasks.put(task);
      for (const entry of data.log) log.put(entry);
      kv.put({ key: 'settings', value: { ...DEFAULT_SETTINGS, ...data.settings } });
      return;
    }

    // merge
    for (const { exam, data: buf } of data.exams) {
      const old = await reqP(exams.get(exam.id));
      if (!old) {
        exams.put(exam);
        pdfs.put({ examId: exam.id, data: buf, typ: 'application/pdf' });
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

/** Raderar ALL data (används bara efter uttrycklig bekräftelse). */
export async function clearAll() {
  await tx(['exams', 'pdfs', 'tasks', 'log', 'kv'], 'readwrite', (t) => {
    for (const s of ['exams', 'pdfs', 'tasks', 'log']) t.objectStore(s).clear();
    const kv = t.objectStore('kv');
    kv.delete('settings');
    kv.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
  });
  settingsCache = null;
  emit({ type: 'import' });
  emit({ type: 'settings' });
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
