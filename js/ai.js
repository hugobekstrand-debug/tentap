/**
 * ai.js — AI-igenkänning via Claude API (Premium, egen API-nyckel).
 *
 * Anropet görs direkt från webbläsaren till api.anthropic.com med
 * användarens egen nyckel (headern anthropic-dangerous-direct-browser-access).
 * Ingen server, ingen backend. Bara tentans PDF (och en separat facit-PDF)
 * skickas – inget annat lämnar enheten.
 *
 * Strukturerat svar: modellen ska anropa verktyget "registrera_uppgifter"
 * (strict: true, så argumenten följer schemat). De aktuella modellerna
 * (Sonnet 5.5, Opus 5.5) godtar inte tvingad tool_choice ("tool"/"any" ger
 * 400), så vi använder tool_choice "auto" + en tydlig instruktion, och
 * kontrollerar själva att anropet gjordes. Svaret valideras dessutom här.
 * Ogiltigt eller uteblivet svar: ett nytt försök, sedan ett vänligt fel.
 *
 * Hybridmetoden: modellen pekar ut VAD som finns (etiketter, poäng och den
 * exakta texten där varje uppgift och facit börjar). De exakta
 * koordinaterna kommer sedan från textlagret (detect.findAnchor) och klippen
 * görs av crop.js, precis som i textigenkänningen.
 */

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
/** Server-side fallback vid avböjd förfrågan (inte för Haiku, som saknar det). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 16000;

/** Anthropics gränser för PDF i en förfrågan (32 MB inkl. base64, 600 sidor). */
export const MAX_PDF_BYTES = 23 * 1024 * 1024; // base64 växer med en tredjedel
export const MAX_PDF_PAGES = 600;

export const TOOL_NAME = 'registrera_uppgifter';

export class AiError extends Error {
  /**
   * @param {'nokey'|'auth'|'permission'|'model'|'ratelimit'|'toolarge'|'overloaded'|'server'|'network'|'aborted'|'invalid'|'refusal'|'billing'} code
   */
  constructor(code, message, { retryAfter = null, detail = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* Schema och instruktioner                                            */
/* ------------------------------------------------------------------ */

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const RUTA = {
  type: 'object',
  description: 'Uppskattad ruta, normaliserad 0–1 mot sidan med origo uppe till vänster. Används bara som reserv.',
  properties: {
    sida: { type: 'integer' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
  required: ['sida', 'x', 'y', 'w', 'h'],
  additionalProperties: false,
};

export const TOOL = {
  name: TOOL_NAME,
  description:
    'Registrerar tentans huvuduppgifter, deras poäng och var uppgifter och facit finns. Anropas exakt en gång med hela resultatet.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      angivenTotalpoang: { ...nullable({ type: 'number' }), description: 'Tentans angivna totalpoäng (t.ex. från omslaget), annars null.' },
      uppgifter: {
        type: 'array',
        description: 'Huvuduppgifterna i den ordning de kommer i tentan.',
        items: {
          type: 'object',
          properties: {
            etikett: { type: 'string', description: 'T.ex. "Problem 3" eller "Uppgift 2", som i tentan.' },
            poang: { ...nullable({ type: 'number' }), description: 'Uppgiftens totalpoäng, eller null om den inte anges.' },
            delmoment: {
              type: 'array',
              description: 'Deluppgifter (a, b, c …) med egna poäng. Tom lista om det inte finns några.',
              items: {
                type: 'object',
                properties: { etikett: { type: 'string' }, poang: nullable({ type: 'number' }) },
                required: ['etikett', 'poang'],
                additionalProperties: false,
              },
            },
            startSida: { type: 'integer', description: 'Sidan (1-baserad) där uppgiften börjar.' },
            startAnkare: { type: 'string', description: 'EXAKT text på raden där uppgiften börjar, ordagrant från PDF:en (t.ex. "Problem 3. (3p)").' },
            slutSida: { type: 'integer', description: 'Sidan där uppgiftstexten (utan facit) slutar.' },
            facitDokument: { type: 'string', enum: ['tenta', 'facit', 'saknas'], description: 'Var facit finns: i tentan, i den separata facit-PDF:en, eller saknas.' },
            facitStartSida: { ...nullable({ type: 'integer' }), description: 'Sidan där facit börjar (i det dokument som facitDokument anger).' },
            facitStartAnkare: { ...nullable({ type: 'string' }), description: 'EXAKT text på raden där facit för uppgiften börjar, t.ex. "Solution:".' },
            facitSlutAnkare: { ...nullable({ type: 'string' }), description: 'Valfritt: exakt text på facits sista rad.' },
            uppskattadRuta: RUTA,
            uppskattadFacitRuta: nullable(RUTA),
            sakerhet: { type: 'string', enum: ['hög', 'låg'] },
            anmarkning: { ...nullable({ type: 'string' }), description: 'Kort anmärkning på svenska om något är osäkert, annars null.' },
          },
          required: [
            'etikett',
            'poang',
            'delmoment',
            'startSida',
            'startAnkare',
            'slutSida',
            'facitDokument',
            'facitStartSida',
            'facitStartAnkare',
            'facitSlutAnkare',
            'uppskattadRuta',
            'uppskattadFacitRuta',
            'sakerhet',
            'anmarkning',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['angivenTotalpoang', 'uppgifter'],
    additionalProperties: false,
  },
};

export const SYSTEM_PROMPT = `Du analyserar en tenta (ett skriftligt prov) som PDF, och ibland en separat facit-PDF. Resultatet används för att klippa ut varje uppgift och dess facit så att studenten kan plugga en uppgift i taget.

Gör så här:
1. Hitta varje HUVUDUPPGIFT, oavsett språk och rubrikord (Problem, Uppgift, Task, Question, Exercise, Övning, Fråga, Assignment, eller bara en siffra).
2. Ignorera omslag, instruktioner, regler, tillåtna hjälpmedel, betygsgränser och avslutande text (t.ex. "Good luck", "Lycka till"). De är inga uppgifter.
3. Deluppgifter (a, b, c …) hör till sin huvuduppgift. Registrera dem inte som egna uppgifter, men rapportera dem i delmoment med sina poäng.
4. Läs ut poäng per uppgift och per delmoment. Om bara delmomenten har poäng är uppgiftens poäng deras summa. Läs också ut tentans angivna totalpoäng om den finns.
5. Avgör var facit finns: direkt efter varje uppgift (t.ex. efter "Solution:" eller "Lösning:"), samlat i slutet, eller i den separata facit-PDF:en. Om inget facit finns: facitDokument = "saknas" och null i facitfälten.
6. startAnkare och facitStartAnkare ska vara den EXAKTA texten på raden där uppgiften respektive facit börjar, ordagrant som den står i PDF:en. De används för att hitta rätt plats i textlagret.
7. uppskattadRuta (och uppskattadFacitRuta) är en ungefärlig ruta på startsidan, normaliserad 0–1 med origo uppe till vänster. Den används bara om ankaret inte går att hitta, t.ex. i inskannade PDF:er.
8. Sätt sakerhet = "låg" och skriv en kort anmärkning på svenska när något är osäkert.

Svara genom att anropa verktyget ${TOOL_NAME} exakt en gång med hela resultatet. Skriv ingen annan text.`;

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function headers(key, beta = null) {
  const h = {
    'x-api-key': key,
    'anthropic-version': VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
  if (beta) h['anthropic-beta'] = beta;
  return h;
}

/** Gör om ett HTTP-fel till ett AiError med ett begripligt meddelande. */
async function toError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const msg = String(body?.error?.message || '');
  const retry = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
  switch (res.status) {
    case 401:
      return new AiError('auth', 'API-nyckeln godtogs inte. Kontrollera att du kopierat hela nyckeln (den börjar med "sk-ant-"), eller skapa en ny i Anthropic Console.');
    case 403:
      return new AiError('permission', 'Nyckeln saknar behörighet för det här. Kontrollera nyckeln och arbetsytan i Anthropic Console.', { detail: msg });
    case 404:
      return new AiError('model', 'Modellen finns inte för ditt konto. Välj en annan modell under Inställningar → AI-igenkänning.', { detail: msg });
    case 413:
      return new AiError('toolarge', 'PDF:en är för stor för att skickas i ett anrop. Dela upp tentan i mindre PDF:er och försök igen.', { detail: msg });
    case 429:
      return new AiError('ratelimit', 'För många förfrågningar just nu.', { retryAfter: retryAfter ?? 20, detail: msg });
    case 529:
      return new AiError('overloaded', 'Anthropics tjänst är tillfälligt överbelastad. Vänta en stund och försök igen.', { retryAfter: retryAfter ?? 30 });
    case 400:
      if (/credit balance|billing|purchase credits/i.test(msg)) {
        return new AiError('billing', 'Kontot saknar krediter. Fyll på under Billing i Anthropic Console och försök igen.', { detail: msg });
      }
      if (/page|too (long|large|many)|exceed|maximum/i.test(msg)) {
        return new AiError('toolarge', 'Tentan har för många sidor eller är för stor för ett anrop. Dela upp den i mindre PDF:er och försök igen.', { detail: msg });
      }
      return new AiError('invalid', 'Anropet godtogs inte av Anthropic. Försök igen, eller markera uppgifterna själv.', { detail: msg });
    default:
      if (res.status >= 500) return new AiError('server', 'Anthropics tjänst svarade med ett fel. Vänta en stund och försök igen.', { retryAfter: retryAfter ?? 15, detail: msg });
      return new AiError('invalid', 'Oväntat svar från Anthropic. Försök igen, eller markera uppgifterna själv.', { detail: msg });
  }
}

async function request(url, init, signal) {
  let res;
  try {
    res = await fetch(url, { ...init, signal, cache: 'no-store', credentials: 'omit' });
  } catch (err) {
    if (err?.name === 'AbortError') throw new AiError('aborted', 'Analysen avbröts.');
    throw new AiError('network', 'Det gick inte att nå Anthropic. Kontrollera internetanslutningen och försök igen.');
  }
  if (!res.ok) throw await toError(res);
  return res;
}

/**
 * Minimalt anrop för att testa nyckeln: hämtar modellens info (kostar inget).
 * @returns {Promise<{ok:true, modell:string}>}
 */
export async function testKey(key, model, signal) {
  if (!/^sk-ant-/.test(String(key).trim())) {
    throw new AiError('auth', 'Det där ser inte ut som en API-nyckel från Anthropic. En nyckel börjar med "sk-ant-".');
  }
  const res = await request(`${API}/models/${encodeURIComponent(model)}`, { method: 'GET', headers: headers(key.trim()) }, signal);
  const body = await res.json().catch(() => ({}));
  return { ok: true, modell: body.display_name || model };
}

/* ------------------------------------------------------------------ */
/* Analys                                                              */
/* ------------------------------------------------------------------ */

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Kontrollerar storleken innan något skickas. Kastar AiError("toolarge"). */
export function checkSize({ pdfBytes, pages, facitBytes = 0, facitPages = 0 }) {
  if (pdfBytes + facitBytes > MAX_PDF_BYTES) {
    throw new AiError('toolarge', 'PDF:en är större än vad som kan skickas i ett anrop (cirka 23 MB). Dela upp tentan i mindre PDF:er, eller komprimera den, och försök igen.');
  }
  if (pages + facitPages > MAX_PDF_PAGES) {
    throw new AiError('toolarge', `Tentan har för många sidor för ett anrop (högst ${MAX_PDF_PAGES}). Dela upp den i mindre PDF:er och försök igen.`);
  }
}

function buildBody({ model, pdfData, facitData, antalSidor, facitSidor }) {
  const content = [
    { type: 'text', text: `Dokument 1 är TENTAN (${antalSidor} sidor).` },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(pdfData) }, title: 'Tentan' },
  ];
  if (facitData) {
    content.push(
      { type: 'text', text: `Dokument 2 är en SEPARAT FACIT-PDF (${facitSidor} sidor). Använd facitDokument = "facit" för facit som finns här.` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(facitData) }, title: 'Facit' },
    );
  }
  content.push({ type: 'text', text: `Analysera tentan och anropa verktyget ${TOOL_NAME} med resultatet.` });
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [{ role: 'user', content }],
  };
  const useFallback = !/haiku/i.test(model);
  if (useFallback) body.fallbacks = 'default';
  return { body, beta: useFallback ? FALLBACK_BETA : null };
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function cleanRuta(r, maxSida) {
  if (!r || typeof r !== 'object' || ![r.x, r.y, r.w, r.h].every(isNum) || !Number.isInteger(r.sida)) return null;
  if (r.sida < 1 || r.sida > maxSida) return null;
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  const w = Math.min(clamp01(r.w), 1 - x);
  const h = Math.min(clamp01(r.h), 1 - y);
  return w > 0.01 && h > 0.01 ? { sida: r.sida, x, y, w, h } : null;
}

/**
 * Validerar verktygsanropets argument mot schemat och tentans sidantal.
 * @returns {{ok:true, value:object}|{ok:false, errors:string[]}}
 */
export function validateResult(input, { antalSidor, facitSidor = 0 }) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['svaret är inget objekt'] };
  if (!Array.isArray(input.uppgifter) || !input.uppgifter.length) return { ok: false, errors: ['inga uppgifter'] };
  const total = isNum(input.angivenTotalpoang) && input.angivenTotalpoang > 0 ? input.angivenTotalpoang : null;
  const uppgifter = [];
  input.uppgifter.forEach((u, i) => {
    if (!u || typeof u !== 'object') return errors.push(`uppgift ${i + 1} saknas`);
    if (typeof u.etikett !== 'string' || !u.etikett.trim()) errors.push(`uppgift ${i + 1}: etikett`);
    if (!Number.isInteger(u.startSida) || u.startSida < 1 || u.startSida > antalSidor) errors.push(`uppgift ${i + 1}: startSida`);
    if (typeof u.startAnkare !== 'string') errors.push(`uppgift ${i + 1}: startAnkare`);
    const dok = ['tenta', 'facit', 'saknas'].includes(u.facitDokument) ? u.facitDokument : 'saknas';
    const facitMax = dok === 'facit' ? facitSidor : antalSidor;
    const facitStartSida = Number.isInteger(u.facitStartSida) && u.facitStartSida >= 1 && u.facitStartSida <= facitMax ? u.facitStartSida : null;
    uppgifter.push({
      etikett: String(u.etikett || `Uppgift ${i + 1}`).trim().slice(0, 120),
      poang: isNum(u.poang) && u.poang > 0 ? Math.round(u.poang * 100) / 100 : null,
      delmoment: Array.isArray(u.delmoment)
        ? u.delmoment
            .filter((d) => d && typeof d.etikett === 'string' && d.etikett.trim())
            .map((d) => ({ etikett: d.etikett.trim().slice(0, 20), poang: isNum(d.poang) && d.poang > 0 ? d.poang : null }))
        : [],
      startSida: u.startSida,
      startAnkare: String(u.startAnkare || ''),
      slutSida: Number.isInteger(u.slutSida) ? u.slutSida : u.startSida,
      facitDokument: dok === 'facit' && !facitSidor ? 'saknas' : dok,
      facitStartSida: dok === 'saknas' ? null : facitStartSida,
      facitStartAnkare: dok === 'saknas' ? null : typeof u.facitStartAnkare === 'string' && u.facitStartAnkare.trim() ? u.facitStartAnkare : null,
      facitSlutAnkare: typeof u.facitSlutAnkare === 'string' && u.facitSlutAnkare.trim() ? u.facitSlutAnkare : null,
      uppskattadRuta: cleanRuta(u.uppskattadRuta, antalSidor),
      uppskattadFacitRuta: dok === 'saknas' ? null : cleanRuta(u.uppskattadFacitRuta, facitMax),
      sakerhet: u.sakerhet === 'låg' ? 'låg' : 'hög',
      anmarkning: typeof u.anmarkning === 'string' && u.anmarkning.trim() ? u.anmarkning.trim().slice(0, 300) : null,
    });
  });
  if (errors.length) return { ok: false, errors };
  // Reservrutan för facit gäller facit-PDF:en när facit ligger där.
  for (const u of uppgifter) if (u.uppskattadFacitRuta && u.facitDokument === 'facit') u.uppskattadFacitRuta.pdf = 'facit';
  return { ok: true, value: { angivenTotalpoang: total, uppgifter } };
}

/**
 * Plockar ut verktygsanropet ur ett svar (hanterar avböjda förfrågningar).
 * @returns {object|null} verktygets input, eller null om modellen inte anropade det
 */
export function extractToolInput(msg) {
  if (msg?.stop_reason === 'refusal') {
    throw new AiError('refusal', 'AI:n avböjde att analysera den här PDF:en. Markera uppgifterna själv i stället.', { detail: msg.stop_details?.category || null });
  }
  if (msg?.stop_reason === 'max_tokens') return null;
  const block = (msg?.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
  return block ? block.input : null;
}

/**
 * Skickar tentan till Claude och returnerar ett validerat resultat.
 * Ogiltigt eller uteblivet verktygsanrop: ett nytt försök, sedan AiError("invalid").
 * 429/529 kastas som AiError med retryAfter – anroparen visar nedräkning.
 * @returns {Promise<{svar:object, value:object, modell:string}>}
 */
export async function analyzeExam({ key, model, pdfData, facitData = null, antalSidor, facitSidor = 0, signal }) {
  if (!key) throw new AiError('nokey', 'Lägg in en API-nyckel för att använda AI-igenkänning.');
  checkSize({ pdfBytes: pdfData.byteLength, pages: antalSidor, facitBytes: facitData?.byteLength || 0, facitPages: facitSidor });
  const { body, beta } = buildBody({ model, pdfData, facitData, antalSidor, facitSidor });
  const json = JSON.stringify(body);
  let lastErrors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(`${API}/messages`, { method: 'POST', headers: headers(key, beta), body: json }, signal);
    let msg;
    try {
      msg = await res.json();
    } catch {
      lastErrors = ['svaret gick inte att läsa'];
      continue;
    }
    const input = extractToolInput(msg);
    if (!input) {
      lastErrors = ['verktyget anropades inte'];
      continue;
    }
    const v = validateResult(input, { antalSidor, facitSidor });
    if (v.ok) return { svar: input, value: v.value, modell: msg.model || model };
    lastErrors = v.errors;
  }
  throw new AiError('invalid', 'AI:n gav inget användbart svar för den här tentan. Försök igen senare, eller markera uppgifterna själv.', {
    detail: lastErrors.join('; '),
  });
}
