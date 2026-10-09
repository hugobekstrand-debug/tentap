/**
 * premium.js — Premium (AI-igenkänning med egen API-nyckel).
 *
 * "Premium" är bara en etikett: ingen betalning, inget konto, ingen backend.
 * Premium är upplåst när en giltig API-nyckel finns. Nyckeln ligger i
 * IndexedDB-storen "secrets" (åtskild från allt annat, aldrig i export) och
 * skickas bara till api.anthropic.com när du själv startar en AI-analys.
 *
 * AI körs ALDRIG automatiskt – bara när användaren väljer det.
 */

import * as db from './db.js';
import { getPdfData } from './db.js';
import { analyzeExam, testKey, validateResult, AiError } from './ai.js';
import { buildTasks, getTextLayer, STEG } from './extract.js';
import { tasksFromAnchors, summarize } from './detect.js';
import { applyWithUndo } from './analysis.js';
import { MODELLER } from './models.js';
import { h, icon, badge, toast, openDialog, alertDialog, stepper, navigate } from './ui.js';

export const KEY_ID = 'anthropicApiKey';
const PRICING_URL = 'https://www.anthropic.com/pricing#api';
const CONSOLE_URL = 'https://console.anthropic.com/';

export async function getApiKey() {
  try {
    return await db.getSecret(KEY_ID);
  } catch {
    return null;
  }
}

export async function hasApiKey() {
  return !!(await getApiKey());
}

/** "sk-ant-…a1b2" – visar aldrig hela nyckeln. */
export function maskKey(key) {
  const k = String(key || '');
  return k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••';
}

export function modelName(id) {
  return MODELLER.find((m) => m.id === id)?.namn || id;
}

/* ------------------------------------------------------------------ */
/* Nyckelformulär (används i Premium-sheeten och i Inställningar)       */
/* ------------------------------------------------------------------ */

/**
 * Fält + "Testa och spara". Gör ett minimalt anrop innan nyckeln sparas.
 * @param {{onSaved:(info:{modell:string})=>void}} o
 */
export function keyForm({ onSaved, autofocus = false }) {
  const id = `key-${Math.random().toString(36).slice(2, 7)}`;
  const input = h('input', {
    id,
    class: 'input input-mono',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'sk-ant-…',
    enterkeyhint: 'done',
    'aria-describedby': `${id}-hint ${id}-msg`,
  });
  const msg = h('p', { class: 'field-msg', id: `${id}-msg`, 'aria-live': 'polite', hidden: true });
  const btnLabel = h('span', null, 'Testa och spara');
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, btnLabel);
  const form = h(
    'form',
    { class: 'key-form', novalidate: true },
    h('label', { class: 'label', for: id }, 'API-nyckel'),
    h('div', { class: 'key-row' }, input, btn),
    h('p', { class: 'field-hint', id: `${id}-hint` }, 'Nyckeln sparas bara i den här webbläsaren och följer aldrig med i säkerhetskopior.'),
    msg,
  );
  const show = (text, tone) => {
    msg.replaceChildren(icon(tone === 'error' ? 'alert' : 'check', { size: 16 }), h('span', null, text));
    msg.className = `field-msg field-msg--${tone}`;
    msg.hidden = false;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) {
      show('Klistra in nyckeln först.', 'error');
      input.focus();
      return;
    }
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    btnLabel.textContent = 'Testar…';
    msg.hidden = true;
    try {
      const settings = await db.getSettings();
      const info = await testKey(key, settings.modell);
      await db.setSecret(KEY_ID, key);
      input.value = '';
      show(`Nyckeln fungerar och är sparad (${info.modell}).`, 'ok');
      onSaved?.(info);
    } catch (err) {
      if (err instanceof AiError && err.code === 'model') {
        // Nyckeln är giltig men modellen saknas: spara nyckeln och be om ett annat modellval.
        await db.setSecret(KEY_ID, key);
        input.value = '';
        show('Nyckeln är sparad, men den valda modellen finns inte för ditt konto. Välj en annan modell under Inställningar.', 'error');
        onSaved?.({ modell: null });
      } else {
        show(err instanceof AiError ? err.message : 'Nyckeln kunde inte testas. Försök igen.', 'error');
        input.focus();
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btnLabel.textContent = 'Testa och spara';
    }
  });
  if (autofocus) requestAnimationFrame(() => input.focus());
  return form;
}

/* ------------------------------------------------------------------ */
/* Premium-sheet (bottom sheet på mobil, dialog på dator)               */
/* ------------------------------------------------------------------ */

/** Förklarar AI-läget och låter användaren lägga in en nyckel. Resolvar true om en nyckel sparades. */
export function openPremium() {
  let saved = false;
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'text-link' }, text, icon('external', { size: 14 }));
  const content = [
    h('div', { class: 'premium-head' }, badge('Premium', { tone: 'premium', iconName: 'sparkles' }), h('p', { class: 'premium-lead' }, 'Låt AI hitta uppgifter och facit när textigenkänningen inte räcker.')),
    h(
      'ul',
      { class: 'premium-points' },
      h('li', null, icon('sparkles', { size: 18 }), h('span', null, h('strong', null, 'Vad den gör: '), 'Claude läser hela tentan, hittar varje uppgift, poäng och facit. Appen klipper sedan ut dem exakt som vanligt.')),
      h('li', null, icon('scan', { size: 18 }), h('span', null, h('strong', null, 'När den hjälper: '), 'ovanliga layouter, rubriker utan nummer och inskannade PDF:er.')),
      h('li', null, icon('info', { size: 18 }), h('span', null, h('strong', null, 'Kostnad: '), 'vanligen några cent per tenta, beroende på antal sidor. Samma tenta analyseras bara en gång – svaret sparas. ', link(PRICING_URL, 'Se Anthropics prissida'))),
      h('li', null, icon('shield', { size: 18 }), h('span', null, h('strong', null, 'Integritet: '), 'när du startar en analys skickas tentans PDF (och facit-PDF:en, om du lagt till en) till Anthropics API. Inget annat lämnar enheten.')),
    ),
    h('h3', { class: 'premium-sub' }, 'Så skaffar du en nyckel'),
    h(
      'ol',
      { class: 'premium-steps' },
      h('li', null, 'Skapa ett konto i ', link(CONSOLE_URL, 'Anthropic Console'), '.'),
      h('li', null, 'Fyll på krediter under Billing.'),
      h('li', null, 'Sätt en utgiftsgräns under Limits, så vet du vad det högst kan kosta.'),
      h('li', null, 'Skapa en API-nyckel under API Keys och klistra in den här.'),
    ),
    keyForm({
      autofocus: true,
      onSaved: () => {
        saved = true;
        setTimeout(() => dlg.close(true), 900);
      },
    }),
  ];
  const dlg = openDialog({
    title: 'AI-igenkänning',
    className: 'dialog-premium',
    content,
    initialFocus: 'input',
  });
  return dlg.result.then(() => saved);
}

/* ------------------------------------------------------------------ */
/* AI-analys                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new AiError('aborted', 'Analysen avbröts.'));
    });
  });

/**
 * Kör AI-analysen för en tenta med förlopp, Avbryt och nedräkning vid
 * överbelastning. Ett sparat svar för samma tenta återanvänds (inget nytt
 * anrop) om inte force är satt. Resultatet sparas med Ångra.
 */
export async function runAiAnalysis(examId, { force = false } = {}) {
  const key = await getApiKey();
  if (!key) {
    const ok = await openPremium();
    if (!ok) return null;
    return runAiAnalysis(examId, { force });
  }
  const exam = await db.getExam(examId);
  if (!exam) return null;
  const settings = await db.getSettings();
  const medFacit = !!exam.facitPdf;
  const cached = exam.extraktion.rasvar;
  const useCache = !force && cached?.svar && cached.medFacit === medFacit;

  const ctrl = new AbortController();
  const steps = h('div', { class: 'analysis-steps' }, stepper(STEG, 'read'));
  const status = h('p', { class: 'analysis-status', 'aria-live': 'polite' }, useCache ? 'Använder det sparade AI-svaret – inget nytt anrop.' : `Skickar tentan till Anthropic (${modelName(settings.modell)})…`);
  const dlg = openDialog({
    title: 'AI-igenkänning',
    content: [steps, status],
    dismissible: false,
    buttons: [{ label: 'Avbryt', variant: 'secondary', onClick: () => ctrl.abort() }],
  });
  const step = (s) => steps.replaceChildren(stepper(STEG, s));

  try {
    let svar;
    let value;
    let modell = settings.modell;
    if (useCache) {
      const v = validateResult(cached.svar, { antalSidor: exam.antalSidor, facitSidor: exam.facitPdf?.antalSidor || 0 });
      if (!v.ok) throw new AiError('invalid', 'Det sparade AI-svaret går inte att använda. Välj "Analysera om med AI" för ett nytt anrop.');
      svar = cached.svar;
      value = v.value;
      modell = cached.modell;
    } else {
      const [pdfData, facitData] = await Promise.all([getPdfData(examId), medFacit ? getPdfData(examId, 'facit') : null]);
      if (!pdfData) throw new AiError('invalid', 'PDF:en för tentan saknas i lagringen.');
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await analyzeExam({
            key,
            model: settings.modell,
            pdfData,
            facitData,
            antalSidor: exam.antalSidor,
            facitSidor: exam.facitPdf?.antalSidor || 0,
            signal: ctrl.signal,
          });
          ({ svar, value, modell } = r);
          break;
        } catch (err) {
          const retryable = err instanceof AiError && ['ratelimit', 'overloaded', 'server'].includes(err.code);
          if (!retryable || attempt >= 2) throw err;
          for (let s = Math.ceil(err.retryAfter || 20); s > 0; s--) {
            status.textContent = `${err.code === 'ratelimit' ? 'För många förfrågningar just nu.' : 'Tjänsten är upptagen.'} Försöker igen om ${s} s…`;
            await sleep(1000, ctrl.signal);
          }
          status.textContent = 'Försöker igen…';
        }
      }
    }
    step('find');
    status.textContent = 'Letar upp uppgifterna i PDF:ens text…';
    const layer = await getTextLayer(exam, 'tenta', { signal: ctrl.signal }).catch(() => null);
    const facitLayer = medFacit ? await getTextLayer(exam, 'facit', { signal: ctrl.signal }).catch(() => null) : null;
    const found = tasksFromAnchors(layer, facitLayer, value.uppgifter);
    step('crop');
    status.textContent = 'Klipper ut uppgifter och figurer…';
    const tasks = await buildTasks(exam, found, { layer, facitLayer, kalla: db.KALLA.AI, signal: ctrl.signal });
    const { sammanfattning } = summarize(found, value.angivenTotalpoang);
    step('done');
    dlg.close(null);
    if (!tasks.length) {
      await alertDialog({ title: 'Inga uppgifter hittades', message: 'AI:n hittade inga uppgifter i tentan. Markera dem själv i stället.' });
      return null;
    }
    const extraktion = {
      metod: db.METOD.AI,
      tidpunkt: new Date().toISOString(),
      godkand: null,
      sammanfattning,
      forslag: null,
      textlagerSaknas: !layer || layer.saknas,
      rasvar: { modell, medFacit, tidpunkt: useCache ? cached.tidpunkt : new Date().toISOString(), svar },
    };
    const res = await applyWithUndo(examId, tasks, extraktion);
    if (useCache) toast('Använde det sparade AI-svaret – inget nytt anrop.', { duration: 4000 });
    if (!location.hash.startsWith(`#/granska/${examId}`)) navigate(`#/granska/${examId}`);
    return res;
  } catch (err) {
    dlg.close(null);
    if (err instanceof AiError && err.code === 'aborted') {
      toast('Analysen avbröts. Inget är ändrat.');
      return null;
    }
    if (err?.name === 'AbortError') {
      toast('Analysen avbröts. Inget är ändrat.');
      return null;
    }
    console.error(err);
    const message = err instanceof AiError ? err.message : 'Något oväntat hände under analysen.';
    const { result } = openDialog({
      title: err?.code === 'auth' ? 'API-nyckeln fungerar inte' : 'AI-analysen kunde inte slutföras',
      content: [h('p', null, message), h('p', { class: 'muted' }, 'Dina uppgifter är orörda.')],
      buttons: [
        err?.code === 'auth' ? { label: 'Byt nyckel', variant: 'secondary', value: 'key' } : { label: 'Markera själv', variant: 'secondary', value: 'mark' },
        { label: 'OK', variant: 'primary', value: null },
      ],
    });
    const choice = await result;
    if (choice === 'key') openPremium();
    if (choice === 'mark') navigate(`#/markera/${examId}`);
    return null;
  }
}
