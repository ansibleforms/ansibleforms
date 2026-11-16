// A stored job's last use (#1437) : the form page names the stored job its values came from in
// the launch (lib/storedJobLaunch.js), so the server records when it was last used ; the stored
// jobs list shows that date as a sortable Last used column, and the stored job's page in its
// Details tab, in every language.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { storedJobOfLoad, withStoredJob, withPlannedStoredJob } from '@/lib/storedJobLaunch';
import getSettings from '@/config/settings';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
// the keys themselves : what a text is, not how it reads
const t = (key) => key;
const LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe('the stored job of a launch', () => {
  it('is the one loaded into the whole form, none for a subform tab', () => {
    expect(storedJobOfLoad('form', { id: 12 })).toBe(12);
    expect(storedJobOfLoad('form', { id: '12' })).toBe(12);
    expect(storedJobOfLoad('subform', { id: 12 })).toBeNull();
  });

  it('is none for a record without an id', () => {
    expect(storedJobOfLoad('form', null)).toBeNull();
    expect(storedJobOfLoad('form', {})).toBeNull();
    expect(storedJobOfLoad('form', { id: 'abc' })).toBeNull();
  });

  it('is named in the launch body, which is left as it was', () => {
    const body = { formName: 'Demo', extravars: {} };
    expect(withStoredJob(body, 12)).toEqual({ formName: 'Demo', extravars: {}, storedJobId: 12 });
    expect(body.storedJobId).toBeUndefined();
    expect(withStoredJob(body, null)).toBe(body);
  });

  it('is set by ?storedJob=<id> and Load, cleared by a form load, and sent by the launch', () => {
    const src = withoutComments(read('src/pages/form.vue'), '//', '\n');
    expect(src).toMatch(/launchStoredJobId\.value = storedJobOfLoad\('form', stored\)/);
    expect(src).toMatch(/launchStoredJobId\.value = storedJobOfLoad\(ctx\.scope, storedJob\)/);
    expect(src).toMatch(/const stale = \(\) => seq !== loadSeq;\s*launchStoredJobId\.value = null;/);
    expect(src).toMatch(/axios\.post\(`\/api\/v2\/job\/`, withStoredJob\(postdata, launchStoredJobId\.value\)\)/);
  });

  it('is named in a Run later, never in a Schedule, whose body is left as it was', () => {
    const body = { name: 'later', form: 'Demo', planned: true };
    expect(withPlannedStoredJob(body, 12, true)).toEqual({
      name: 'later',
      form: 'Demo',
      planned: true,
      stored_job_id: 12,
    });
    expect(body.stored_job_id).toBeUndefined();
    expect(withPlannedStoredJob(body, null, true)).toBe(body);
    // a schedule keeps its own copy of the values : its runs are no uses of the stored job
    const schedule = { name: 'nightly', form: 'Demo', planned: false };
    expect(withPlannedStoredJob(schedule, 12, false)).toBe(schedule);
  });

  it("is sent by the form's Run later", () => {
    const src = withoutComments(read('src/pages/form.vue'), '//', '\n');
    expect(src).toMatch(
      /axios\.post\(\s*'\/api\/v2\/schedule',\s*withPlannedStoredJob\(scheduleData, launchStoredJobId\.value, scheduleData\.planned\),?\s*\)/,
    );
  });
});

describe('where its last use shows', () => {
  it('a sortable Last used column in the stored jobs list, a dash until the first use', () => {
    const field = getSettings(t).stored_jobs.fields.find((f) => f.key === 'last_used_at');
    expect(field).toMatchObject({
      noInput: true,
      sortable: true,
      type: 'datetime',
      label: 'settings.storedJobs.lastUsed',
    });
    expect(field.render(null)).toBe('–');
    expect(field.render('2026-11-01T10:00:00.000Z')).not.toBe('–');
  });

  it("the stored job's Details tab, read only", () => {
    const page = read('src/pages/stored-job.vue');
    expect(page).toMatch(/fieldShown\('lastUsed'\)/);
    expect(page).toMatch(/stored\.last_used_at \? Helpers\.formatServerDate\(stored\.last_used_at\) : '–'/);
  });

  it('its label in every language, a word or two', async () => {
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default;
      const label = texts.settings.storedJobs.lastUsed;
      expect(label, lang).toBeTruthy();
      expect(label.length, lang).toBeLessThanOrEqual(24);
    }
  });
});

describe("the stored job's User field", () => {
  it('says under it that only that user changes or deletes it', () => {
    const page = read('src/pages/stored-job.vue');
    expect(page).toMatch(
      /:help="t\('settings\.storedJobs\.ownerHelp'\)"\s*:label="t\('settings\.storedJobs\.owner'\)"/,
    );
  });

  it('its help in every language, one line', async () => {
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default;
      const help = texts.settings.storedJobs.ownerHelp;
      expect(help, lang).toBeTruthy();
      expect(help.length, lang).toBeLessThanOrEqual(90);
    }
  });
});
