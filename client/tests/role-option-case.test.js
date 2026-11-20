// The role option labels are written in sentence case.
//
// They mixed Title Case ("Edit All Forms", "Edit Playbooks") with sentence case ("Show all
// settings"). Every label now starts with a capital and keeps the others only for the names
// of the app's sections and menus (Designer, Server log, Backups, Schedules...), as the
// sentence-case labels around them do. German is left out, where every noun is capitalized,
// and Japanese and Chinese, which have no case.
import { describe, it, expect } from 'vitest';
import { roleOptionGroups } from '@/config/roles';

// the words a label may capitalize after its first one : the app's sections, menus and
// buttons as each language names them ; acronyms (API, MCP) are always allowed
const NAMES = {
  en: ['Appearance', 'Audit', 'Backups', 'Connections', 'Designer', 'Jobs', 'Run', 'Schedules', 'Server'],
  fr: ['Connexions', 'Designer', 'Exécuter', 'Jobs', 'Journal', 'Planifications', 'Sauvegardes'],
  it: ['Aspetto', 'Backup', 'Connessioni', 'Designer', 'Esegui', 'Job', 'Log', 'Pianificazioni', 'Registro'],
  es: ['Apariencia', 'Conexiones', 'Copias', 'Diseñador', 'Ejecutar', 'Programaciones', 'Registro', 'Trabajos'],
  ca: ['Connexions', 'Còpies', 'Dissenyador', 'Executar', 'Programacions', 'Registre', 'Tasques'],
  pt: ['Agendamentos', 'Aparência', 'Cópias', 'Designer', 'Executar', 'Ligações', 'Registo', 'Tarefas'],
  pl: ['Dziennik', 'Harmonogramy', 'Kopie', 'Połączenia', 'Projektanta', 'Uruchom', 'Wygląd', 'Zadania'],
  nl: [],
};

const KEYS = roleOptionGroups.flatMap((g) => g.keys);

/**
 * The i18n key of a role option's label.
 *
 * Args:
 *   key (string): the option, as allowFormDesign.
 *
 * Returns:
 *   string: its label's key under settings.settingsPage.
 */
function labelKey(key) {
  return 'roleOption' + key.charAt(0).toUpperCase() + key.slice(1);
}

describe('the role option labels', () => {
  it('in English read "Edit all forms", keeping "Show Designer"', async () => {
    const en = (await import('../src/locales/en.js')).default.settings.settingsPage;
    expect(en.roleOptionDesignAllForms).toBe('Edit all forms');
    expect(en.roleOptionAllowPlaybookDesign).toBe('Edit playbooks');
    expect(en.roleOptionShowDesigner).toBe('Show Designer');
    expect(en.roleOptionShowLogs).toBe('Show Server log');
  });

  it.each(Object.keys(NAMES))('in %s capitalize only their first word and the names of sections', async (lang) => {
    const page = (await import(`../src/locales/${lang}.js`)).default.settings.settingsPage;
    const wrong = [];
    for (const key of KEYS) {
      const label = page[labelKey(key)];
      const words = label.match(/[\p{L}'-]+/gu).slice(1);
      for (const word of words) {
        const upper = word.charAt(0) !== word.charAt(0).toLowerCase();
        if (upper && !NAMES[lang].includes(word) && !/^[A-Z]{2,}\b/.test(word)) wrong.push(`${key}: ${label}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
