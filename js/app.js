/**
 * app.js — start, routing och service worker.
 *
 * Routes (hash-baserade, fungerar under /<repo-namn>/ på GitHub Pages):
 *   #/                 bibliotek
 *   #/markera/<id>     markeringsläge
 *   #/plugga           plugga valda tentor
 *   #/plugga/<id>      plugga en tenta
 *   #/installningar    inställningar
 *
 * Varje vy är en async funktion (root) => { destroy() }.
 * Nya vyer (t.ex. timer, AI-extraktion) läggs till i ROUTES.
 */

import * as db from './db.js';
import { renderLibrary, uploadFiles } from './library.js';
import { renderMarking } from './marking.js';
import { renderStudy } from './study.js';
import { renderSettings } from './settings.js';
import { applyTheme, syncThemeColor } from './theme.js';
import { h, icon, showBanner, hideBanner, closeMenus, navigate } from './ui.js';

const app = document.getElementById('app');

const ROUTES = [
  { re: /^#?\/?$/, view: 'library', render: (root) => renderLibrary(root) },
  { re: /^#\/markera\/([\w-]+)$/, view: 'marking', render: (root, m) => renderMarking(root, m[1]) },
  { re: /^#\/plugga\/([\w-]+)$/, view: 'study', render: (root, m) => renderStudy(root, m[1]) },
  { re: /^#\/plugga$/, view: 'study', render: (root) => renderStudy(root, null) },
  { re: /^#\/installningar$/, view: 'settings', render: (root) => renderSettings(root) },
];

let current = null;
let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  closeMenus();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  try {
    current?.destroy?.();
  } catch (err) {
    console.error(err);
  }
  current = null;

  const hash = location.hash || '#/';
  const match = ROUTES.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  if (!match) {
    navigate('#/');
    return;
  }
  document.body.dataset.view = match.r.view;
  // Vyn renderas i en ny behållare som redan sitter i dokumentet (så att
  // mått stämmer). Tom behållare visar en diskret laddningsindikator via CSS.
  const holder = h('div', { class: 'view-holder' });
  app.replaceChildren(holder);
  window.scrollTo(0, 0);
  let instance;
  try {
    instance = await match.r.render(holder, match.m);
  } catch (err) {
    console.error(err);
    if (seq !== routeSeq) return;
    holder.replaceChildren(errorView(err));
    return;
  }
  if (seq !== routeSeq) {
    instance?.destroy?.();
    return;
  }
  current = instance;
  const heading = app.querySelector('h1[tabindex="-1"]');
  heading?.focus({ preventScroll: true });
}

function errorView(err) {
  return h(
    'div',
    { class: 'view view-empty' },
    h(
      'div',
      { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('alert', { size: 28 })),
      h('h1', { tabindex: '-1' }, 'Sidan kunde inte visas'),
      h(
        'p',
        null,
        err instanceof db.StorageFullError
          ? err.message
          : 'Något oväntat hände när vyn skulle laddas. Din data är kvar. Prova att ladda om sidan.',
      ),
      h(
        'div',
        { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, 'Ladda om'),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => navigate('#/') }, 'Till biblioteket'),
      ),
    ),
  );
}

/** Visas direkt vid start om IndexedDB inte går att använda (t.ex. privat läge). */
function storageUnavailableView() {
  return h(
    'div',
    { class: 'view view-empty' },
    h(
      'div',
      { class: 'empty-state empty-state--warning' },
      h('span', { class: 'empty-icon' }, icon('alert', { size: 28 })),
      h('h1', { tabindex: '-1' }, 'Webbläsaren tillåter inte lagring här'),
      h(
        'p',
        null,
        'Tentaplugget sparar dina tentor och framsteg i webbläsaren, men det går inte just nu. Det händer oftast i privat/inkognito-läge eller om webbplatsdata är blockerad.',
      ),
      h('p', null, 'Öppna sidan i ett vanligt fönster, eller tillåt webbplatsdata för den här sidan, och ladda om. Inget av det du gör här skulle annars sparas.'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, 'Försök igen'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Service worker och uppdateringar                                    */
/* ------------------------------------------------------------------ */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service worker kunde inte registreras', err);
    return;
  }
  let userAskedToUpdate = false;
  const offerUpdate = (worker) => {
    showBanner('update', {
      message: 'Ny version tillgänglig',
      iconName: 'refresh',
      actions: [
        {
          label: 'Uppdatera',
          variant: 'primary',
          onClick: () => {
            userAskedToUpdate = true;
            (reg.waiting || worker)?.postMessage({ type: 'SKIP_WAITING' });
          },
        },
      ],
      onDismiss: () => {},
      dismissLabel: 'Senare',
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    nw?.addEventListener('statechange', () => {
      if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userAskedToUpdate) return; // första installationen: ladda inte om
    userAskedToUpdate = false;
    location.reload();
  });
  const check = () => reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 60 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  registerServiceWorker();

  try {
    await db.openDB();
    await db.probeStorage();
  } catch (err) {
    console.error(err);
    document.body.dataset.view = 'error';
    app.replaceChildren(storageUnavailableView());
    app.querySelector('h1')?.focus();
    return;
  }

  const settings = await db.getSettings();
  applyTheme(settings.tema);
  syncThemeColor();

  // Be webbläsaren att inte rensa datan automatiskt.
  db.requestPersistence();

  db.onVersionChange(() => {
    showBanner('versionchange', {
      message: 'Appen har uppdaterats i en annan flik. Ladda om för att fortsätta.',
      tone: 'warning',
      iconName: 'alert',
      actions: [{ label: 'Ladda om', variant: 'primary', onClick: () => location.reload() }],
    });
  });

  db.onChange((d) => {
    if (d.type === 'settings' && d.remote) db.getSettings().then((s) => applyTheme(s.tema));
  });

  // Släpp PDF:er var som helst på startsidan; hindra att webbläsaren öppnar filen i andra vyer.
  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (document.body.dataset.view === 'library') uploadFiles(e.dataTransfer.files);
  });

  window.addEventListener('online', () => hideBanner('offline'));

  window.addEventListener('hashchange', route);
  await route();
}

init();
