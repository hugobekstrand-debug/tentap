/**
 * settings.js — Inställningar: tema, pluggläge, lagring och säkerhetskopior.
 */

import * as db from './db.js';
import { forgetExam } from './pdf.js';
import { runExport, runImport } from './backup.js';
import { applyTheme } from './theme.js';
import { APP_VERSION } from './version.js';
import { h, icon, navigate, confirmDialog, toast, fmtBytes, fmtDate, relativeDays } from './ui.js';

export async function renderSettings(root) {
  const view = h('div', { class: 'view view-settings' });
  root.append(view);
  let destroyed = false;

  async function refresh() {
    const [settings, storage, counts] = await Promise.all([db.getSettings(), db.storageInfo(), db.counts()]);
    if (destroyed) return;
    const focusKey = document.activeElement?.dataset?.focusKey;
    view.replaceChildren(
      h(
        'header',
        { class: 'page-header' },
        h('button', { type: 'button', class: 'btn-icon btn-quiet', 'aria-label': 'Tillbaka till biblioteket', onclick: () => navigate('#/') }, icon('back')),
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Inställningar'),
      ),
      appearance(settings),
      studySection(settings),
      backupSection(settings, counts),
      storageSection(storage),
      dangerSection(counts),
      about(),
    );
    if (focusKey) view.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function segmented(name, options, current, onChange, label) {
    return h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': label },
      options.map(([value, text]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': String(current === value),
            'data-focus-key': `${name}-${value}`,
            onclick: () => onChange(value),
          },
          text,
        ),
      ),
    );
  }

  function section(title, ...children) {
    return h('section', { class: 'card settings-section' }, h('h2', { class: 'section-title' }, title), children);
  }

  function row(label, desc, control) {
    return h(
      'div',
      { class: 'settings-row' },
      h('div', { class: 'settings-row-text' }, h('p', { class: 'settings-label' }, label), desc ? h('p', { class: 'settings-desc' }, desc) : null),
      control,
    );
  }

  function appearance(settings) {
    return section(
      'Utseende',
      row(
        'Tema',
        'Följ systemet eller välj själv.',
        segmented(
          'tema',
          [
            ['system', 'System'],
            ['ljust', 'Ljust'],
            ['mörkt', 'Mörkt'],
          ],
          settings.tema,
          async (v) => {
            applyTheme(v);
            await db.saveSettings({ tema: v });
          },
          'Tema',
        ),
      ),
    );
  }

  function studySection(settings) {
    const toggleId = 'weight-toggle';
    const toggle = h('input', {
      type: 'checkbox',
      id: toggleId,
      class: 'switch',
      role: 'switch',
      checked: settings.viktaEfterPoang || null,
      'data-focus-key': 'weight',
      onchange: (e) => db.saveSettings({ viktaEfterPoang: e.target.checked }),
    });
    return section(
      'Pluggläge',
      h(
        'div',
        { class: 'settings-row' },
        h(
          'div',
          { class: 'settings-row-text' },
          h('label', { class: 'settings-label', for: toggleId }, 'Väg efter poäng'),
          h('p', { class: 'settings-desc' }, 'En 10-poängare räknas som större än en 3-poängare. Uppgifter utan poäng räknas som 1.'),
        ),
        toggle,
      ),
      row(
        'Ordning',
        'Ej gjorda uppgifter kommer före svåra, utom med Svåra först.',
        segmented(
          'ordning',
          [
            ['blandad', 'Blandad'],
            ['kronologisk', 'Kronologisk'],
            ['svåra_först', 'Svåra först'],
          ],
          settings.ordning,
          (v) => db.saveSettings({ ordning: v }),
          'Ordning',
        ),
      ),
    );
  }

  function backupSection(settings, counts) {
    const last = settings.senasteExport;
    return section(
      'Säkerhetskopia',
      h(
        'p',
        { class: 'settings-desc' },
        'Datan ligger bara i den här webbläsaren på den här enheten. Exportera en säkerhetskopia regelbundet. Det är också så du flyttar allt mellan dator och mobil: exportera här och importera på den andra enheten.',
      ),
      h(
        'p',
        { class: 'settings-meta' },
        icon('shield', { size: 16 }),
        last ? `Senast exporterad ${fmtDate(last)} (${relativeDays(last)})` : 'Ingen säkerhetskopia exporterad än',
      ),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', disabled: !counts.exams || null, 'data-focus-key': 'export', onclick: () => runExport(APP_VERSION) },
          icon('download', { size: 18 }),
          'Exportera säkerhetskopia',
        ),
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-focus-key': 'import', onclick: () => runImport() }, icon('upload', { size: 18 }), 'Importera'),
      ),
    );
  }

  function storageSection(storage) {
    let status;
    if (storage.persisted === true) {
      status = h('p', { class: 'status-line status-line--ok' }, icon('shieldCheck', { size: 18 }), 'Skyddad – webbläsaren rensar inte datan automatiskt.');
    } else if (storage.persisted === false) {
      status = h(
        'p',
        { class: 'status-line status-line--warn' },
        icon('alert', { size: 18 }),
        'Inte skyddad – webbläsaren kan rensa datan om enheten får ont om utrymme. Installera appen på hemskärmen/datorn och exportera säkerhetskopior.',
      );
    } else {
      status = h('p', { class: 'status-line' }, icon('info', { size: 18 }), 'Webbläsaren visar inte om lagringen är skyddad. Exportera säkerhetskopior regelbundet.');
    }
    const usage =
      storage.usage !== null
        ? `Används: ${fmtBytes(storage.usage)}${storage.quota ? ` av ungefär ${fmtBytes(storage.quota)} tillgängligt` : ''}`
        : 'Lagringsanvändning: okänd';
    return section(
      'Lagring',
      status,
      h('p', { class: 'settings-meta' }, usage),
      storage.persisted === false
        ? h(
            'div',
            { class: 'button-row' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary',
                'data-focus-key': 'persist',
                onclick: async () => {
                  const ok = await db.requestPersistence();
                  toast(ok ? 'Lagringen är nu skyddad.' : 'Webbläsaren nekade just nu. Det brukar gå när appen är installerad eller används ofta.');
                  refresh();
                },
              },
              'Be om skydd',
            ),
          )
        : null,
    );
  }

  function dangerSection(counts) {
    return section(
      'Avancerat',
      row(
        'Radera all data',
        'Tar bort alla tentor, markeringar och framsteg från den här enheten.',
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger-outline',
            disabled: !counts.exams && !counts.tasks ? true : null,
            'data-focus-key': 'clear',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Radera all data?',
                message: [
                  `${counts.exams} tentor och ${counts.tasks} uppgifter tas bort från den här enheten, inklusive framsteg. Det går inte att ångra.`,
                  'Exportera en säkerhetskopia först om du vill kunna återställa.',
                ],
                confirmLabel: 'Radera allt',
                danger: true,
              });
              if (!ok) return;
              for (const e of await db.listExams()) forgetExam(e.id);
              await db.clearAll();
              applyTheme('system');
              toast('All data är raderad.');
            },
          },
          'Radera…',
        ),
      ),
    );
  }

  function about() {
    return h(
      'section',
      { class: 'settings-about' },
      h('p', null, `Tentaplugget ${APP_VERSION}`),
      h('p', null, 'Inga konton, ingen spårning. Inga data lämnar din enhet.'),
    );
  }

  const off = db.onChange((d) => {
    if (d.type === 'settings' || d.type === 'import' || d.type === 'exams') refresh();
  });
  await refresh();
  view.querySelector('h1')?.focus({ preventScroll: true });
  return {
    destroy() {
      destroyed = true;
      off();
    },
  };
}
