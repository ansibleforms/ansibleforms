// Stored jobs unused for N days expire (#1437). The setting (STORED_JOB_UNUSED_DAYS, beside the
// job retention on the settings page, read from /api/v2/app/config) is the most days a stored
// job may stay unused and what the Store dialog starts at ; a stored job may ask for fewer, never
// more and never none while the setting is above 0 (lib/storedJobUnused.js). The Store dialog and
// the stored job's page say so before a save is sent ; the server checks the same.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  unusedDaysMax,
  unusedDaysError,
  unusedDaysValue,
  unusedDaysWarning,
  removalOf,
  removalError,
  removalPayload,
} from '@/lib/storedJobUnused';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => withoutComments(readFileSync(path.join(here, '..', p), 'utf8'));
// the keys themselves, with their values : what a text is, not how it reads
const t = (key, values) => (values ? `${key}:${Object.values(values).join(',')}` : key);
const LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe('the days a stored job may stay unused', () => {
  it("the setting's days : a whole number, 0 for none", () => {
    expect(unusedDaysMax('30')).toBe(30);
    expect(unusedDaysMax(undefined)).toBe(0);
    expect(unusedDaysMax(-3)).toBe(0);
  });

  it('with a setting : 1 to its days, never more, never empty', () => {
    expect(unusedDaysError(30, 30)).toBeNull();
    expect(unusedDaysError(30, '5')).toBeNull();
    expect(unusedDaysError(30, 31)).toBe('tooLong');
    expect(unusedDaysError(30, '')).toBe('required');
    expect(unusedDaysError(30, null)).toBe('required');
  });

  it('without a setting : any whole number of at least 1, or empty', () => {
    expect(unusedDaysError(0, 400)).toBeNull();
    expect(unusedDaysError(0, '')).toBeNull();
    for (const v of [0, -2, 1.5, 'abc']) expect(unusedDaysError(0, v)).toBe('invalid');
  });

  it('are sent as a number, or null when empty', () => {
    expect(unusedDaysValue('12')).toBe(12);
    expect(unusedDaysValue('')).toBeNull();
    expect(unusedDaysValue(null)).toBeNull();
  });

  it('say the most allowed when there is a setting', () => {
    expect(unusedDaysWarning(30, t)).toBe('settings.storedJobs.unusedDaysInvalidMax:30');
    expect(unusedDaysWarning(0, t)).toBe('settings.storedJobs.unusedDaysInvalid');
  });
});

describe('when it is removed : one choice of three', () => {
  it('shows its days when it has some, else its date, else never - or, with a setting, its days', () => {
    expect(removalOf({ unused_days: 7, expires_at: '2027-01-01' }, 30)).toEqual({
      mode: 'unused',
      expires_at: '',
      unused_days: 7,
    });
    expect(removalOf({ expires_at: '2027-01-01' }, 30)).toEqual({
      mode: 'date',
      expires_at: '2027-01-01',
      unused_days: '',
    });
    expect(removalOf({}, 0)).toEqual({ mode: 'never', expires_at: '', unused_days: '' });
    expect(removalOf({}, 30)).toEqual({ mode: 'unused', expires_at: '', unused_days: 30 });
  });

  it('needs a date for a date, and days of 1 to the setting for days ; never needs nothing', () => {
    expect(removalError({ mode: 'date', expires_at: '' }, 0)).toBe('dateRequired');
    expect(removalError({ mode: 'date', expires_at: '2027-01-01' }, 30)).toBeNull();
    expect(removalError({ mode: 'unused', unused_days: '' }, 0)).toBe('required');
    expect(removalError({ mode: 'unused', unused_days: 31 }, 30)).toBe('tooLong');
    expect(removalError({ mode: 'unused', unused_days: '12' }, 30)).toBeNull();
    expect(removalError({ mode: 'never' }, 0)).toBeNull();
  });

  it('is saved as the two columns, the one its choice leaves out empty', () => {
    expect(removalPayload({ mode: 'never', expires_at: 'x', unused_days: 5 })).toEqual({
      expires_at: null,
      unused_days: null,
    });
    expect(removalPayload({ mode: 'date', expires_at: '2027-01-01', unused_days: 5 })).toEqual({
      expires_at: '2027-01-01',
      unused_days: null,
    });
    expect(removalPayload({ mode: 'unused', expires_at: '2027-01-01', unused_days: '9' })).toEqual({
      expires_at: null,
      unused_days: 9,
    });
  });

  it('never is offered only without a setting, and a date says the setting still applies', () => {
    const c = read('src/components/AppStoredJobRemoval.vue');
    expect(c).toMatch(/<div v-if="!max" class="form-check af-removal-row">/);
    expect(c).toMatch(/t\('settings\.storedJobs\.removedAlsoUnused', \{ days: max\.value \}\)/);
  });
});

describe('where they are set', () => {
  it('the Store dialog : one choice of when it is removed, checked before the save, then sent', () => {
    const form = read('src/pages/form.vue');
    expect(form).toMatch(/removal: removalOf\(\{\}, store\.storedJobUnusedDays\)/);
    expect(form).toMatch(/const why = removalError\(storeForm\.value\.removal, store\.storedJobUnusedDays\);/);
    expect(form).toMatch(/\.\.\.removalPayload\(storeForm\.value\.removal\)/);
    expect(form).toMatch(/<AppStoredJobRemoval\s+v-model="storeForm\.removal"/);
  });

  it("the stored job's page : the same choice, its days sent only when changed", () => {
    const page = read('src/pages/stored-job.vue');
    expect(page).toMatch(/v-model="edit\.removal"/);
    expect(page).toMatch(/\.\.\.\(removalChanged \? \{ unused_days: removal\.unused_days \} : \{\}\)/);
  });

  it('the setting : read from the app config, and on the settings page beside the job retention', () => {
    expect(read('src/lib/State.js')).toMatch(
      /store\.storedJobUnusedDays = Number\(data\.storedJobUnusedDays\) \|\| 0;/,
    );
    expect(read('src/pages/admin/settings.vue')).toMatch(/'JOB_RETENTION_DAYS',\s*'STORED_JOB_UNUSED_DAYS',/);
  });

  it('its texts in every language, the help on one line', async () => {
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default.settings.storedJobs;
      for (const key of [
        'unusedDays',
        'unusedDaysHelpMax',
        'removed',
        'removedNever',
        'removedOnDate',
        'removedWhenUnused',
        'removedDays',
        'removedHelp',
        'removedAlsoUnused',
        'removedDateRequired',
        'unusedDaysInvalid',
        'unusedDaysInvalidMax',
      ]) {
        expect(texts[key], `${lang} ${key}`).toBeTruthy();
      }
      expect(texts.unusedDays.length, lang).toBeLessThanOrEqual(20);
      expect(texts.removedHelp.length, lang).toBeLessThanOrEqual(90);
      expect(texts.removedAlsoUnused, lang).toContain('{days}');
      expect(texts.removedWhenUnused.length, lang).toBeLessThanOrEqual(25);
      expect(texts.unusedDaysHelpMax.length, lang).toBeLessThanOrEqual(90);
      expect(texts.unusedDaysHelpMax, lang).toContain('{days}');
      expect(texts.unusedDaysInvalidMax, lang).toContain('{days}');
    }
  });
});
