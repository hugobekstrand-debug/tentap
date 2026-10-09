/**
 * theme.js — ljust/mörkt läge.
 * "system" följer prefers-color-scheme; "ljust"/"mörkt" tvingar via
 * data-theme på <html>. Valet speglas i localStorage (bara som
 * bekvämlighet) så att rätt tema sätts innan sidan ritas vid nästa start.
 */

const KEY = 'tentaplugget-tema';

export function applyTheme(tema) {
  const root = document.documentElement;
  if (tema === 'ljust') root.dataset.theme = 'light';
  else if (tema === 'mörkt') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  try {
    localStorage.setItem(KEY, tema || 'system');
  } catch {
    /* privat läge e.d. – inte viktigt */
  }
  syncThemeColor();
}

/** Uppdaterar webbläsarens/OS:ets fältfärg efter aktuell bakgrund. */
export function syncThemeColor() {
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim();
    if (!bg) return;
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', bg);
  });
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);
