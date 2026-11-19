// The job tables' column headers : Title Case in English ("Start Time", "Launched By", "Last
// Run"), and in every language starting with a capital letter, as their own convention has it.
// The Jobs list, the Runs tabs of a schedule, a stored job, a runner and a system task, the
// Schedules list and the System list. The tables draw their headers upper case (styles/
// tables.scss, .af-table) : the texts are right still, for a table that does not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import getSettings from '@/config/settings';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const read = (file) => readFileSync(join(import.meta.dirname, '../src', file), 'utf8');
const locales = Object.fromEntries(
  await Promise.all(LANGS.map(async (l) => [l, (await import(`@/locales/${l}.js`)).default])),
);
const text = (lang, key) => key.split('.').reduce((o, p) => o?.[p], locales[lang]);

/**
 * The header keys of a page's column list : its label: t('...') between two marks.
 *
 * Args:
 *   file (string): the page, under src.
 *   from (string): where its column list starts.
 *   to (string): a mark after it.
 *
 * Returns:
 *   string[]: the keys.
 */
function pageHeaders(file, from, to) {
  const src = read(file);
  const at = src.indexOf(from);
  const part = src.slice(at, src.indexOf(to, at));
  return [...part.matchAll(/label: t\('([\w.]+)'\)/g)].map((m) => m[1]);
}

// a list's columns as AppAdminMulti draws them : a column's own title, else the field's label
const listHeaders = (list) =>
  getSettings((k) => k)
    [list].fields.filter((f) => !f.noTable && (f.columnLabel || f.label))
    .map((f) => f.columnLabel || f.label);

const TABLES = {
  jobs: pageHeaders('pages/jobs.vue', 'const columnDefs', 'const hiddenColumns'),
  scheduleRuns: pageHeaders('pages/schedule.vue', 'const runColumns', ']);'),
  storedJobRuns: pageHeaders('pages/stored-job.vue', 'const runColumns', ']);'),
  runnerRuns: pageHeaders('pages/admin/runner.vue', 'const jobColumns', ']);'),
  systemRuns: pageHeaders('pages/system-task.vue', 'const runColumns', ']);'),
  schedules: listHeaders('schedules'),
  system: listHeaders('system_tasks'),
};

describe("the job tables' column headers", () => {
  it('finds the headers of every table', () => {
    for (const [table, keys] of Object.entries(TABLES)) expect(keys.length, table).toBeGreaterThan(4);
    expect(TABLES.jobs).toEqual([
      'jobs.id',
      'jobs.form',
      'jobs.jobType',
      'jobs.startTime',
      'jobs.endTime',
      'jobs.duration',
      'jobs.status',
      'jobs.launchedBy',
    ]);
  });

  it('are Title Case in English', () => {
    for (const [table, keys] of Object.entries(TABLES)) {
      for (const key of keys) {
        const header = text('en', key);
        expect(typeof header, `${table} ${key}`).toBe('string');
        for (const word of header.split(' ')) expect(word, `${table} ${key} : ${header}`).not.toMatch(/^[a-z]/);
      }
    }
    expect(['startTime', 'endTime', 'launchedBy', 'jobType', 'id'].map((k) => text('en', `jobs.${k}`))).toEqual([
      'Start Time',
      'End Time',
      'Launched By',
      'Job Type',
      'ID',
    ]);
    expect(text('en', 'settings.fields.lastRunColumn')).toBe('Last Run');
    expect(text('en', 'settings.schedules.nextRunColumn')).toBe('Next Run');
  });

  it('start with a capital letter in every language', () => {
    for (const lang of LANGS) {
      for (const [table, keys] of Object.entries(TABLES)) {
        for (const key of keys) {
          const header = text(lang, key);
          expect(typeof header, `${lang} ${table} ${key}`).toBe('string');
          expect(header[0], `${lang} ${table} ${key} : ${header}`).toBe(header[0].toUpperCase());
        }
      }
    }
  });

  it('keep the field labels of the record pages and dialogs as they are : a header has its own key', () => {
    expect(text('en', 'settings.fields.lastRun')).toBe('Last run');
    expect(text('en', 'settings.schedules.nextRun')).toBe('Next run');
    expect(TABLES.schedules).toContain('settings.fields.lastRunColumn');
    expect(TABLES.system).toContain('settings.schedules.nextRunColumn');
    expect(TABLES.schedules).not.toContain('settings.fields.lastRun');
  });
});
