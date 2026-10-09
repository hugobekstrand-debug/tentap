/**
 * sw.js — service worker för Tentaplugget.
 *
 * Strategi:
 *  - App-skalet (HTML, CSS, JS, ikoner, PDF.js) förcachas vid installation
 *    i en versionerad cache. Svar ges cache-först → appen startar offline.
 *  - PDF.js-typsnitt och cmaps cachas när de används första gången.
 *  - En ny version aktiveras INTE tyst: appen visar en banner
 *    "Ny version tillgänglig – Uppdatera" och skickar SKIP_WAITING först
 *    när du trycker på knappen.
 *
 * NY VERSION: öka VERSION nedan (och APP_VERSION i js/version.js).
 * Lägger du till en fil i appen: lägg till den i SHELL också.
 * Alla sökvägar är relativa till sw.js, så det fungerar under /<repo-namn>/.
 */

const VERSION = '2.0.0';
const SHELL_CACHE = `tentaplugget-shell-${VERSION}`;
const RUNTIME_CACHE = 'tentaplugget-runtime-pdfjs-4.10.38';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/ai.js',
  './js/analysis.js',
  './js/app.js',
  './js/backup.js',
  './js/crop.js',
  './js/db.js',
  './js/detect.js',
  './js/extract.js',
  './js/library.js',
  './js/marking.js',
  './js/models.js',
  './js/pdf.js',
  './js/premium.js',
  './js/review.js',
  './js/settings.js',
  './js/stats.js',
  './js/study.js',
  './js/textlayer.js',
  './js/theme.js',
  './js/ui.js',
  './js/version.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // cache: 'reload' går förbi HTTP-cachen så att vi aldrig förcachar gamla filer.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('tentaplugget-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports?.[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // Sidnavigering: alltid app-skalet (hash-routing sköter resten).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = (await cache.match('./index.html')) || (await cache.match('./'));
        if (cached) return cached;
        return fetch(req);
      })(),
    );
    return;
  }

  // PDF.js-typsnitt/cmaps: cache när de används.
  if (url.pathname.includes('/vendor/pdfjs/cmaps/') || url.pathname.includes('/vendor/pdfjs/standard_fonts/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Övrigt: cache först, annars nätverket.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      return cached || fetch(req);
    })(),
  );
});
