// How a schedule ends : timed by a cron or a rrule it ends never, on a date or after a number of
// runs, then is disabled or removed ; a one-time run only says whether it is removed after its
// run. Its page's Schedule tab and the New schedule wizard ask it with AppScheduleEnd, whose
// choice of three is AppEndChoice, shared with a stored job's removal. The next runs a cron or a
// rrule previews stop at the end. Its page also lists the jobs it started, in a Runs tab.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: {} })) } }));

import { endOf, endError, endPayload, runsBeforeEnd } from '../src/lib/scheduleEnd.js';
import getSettings from '../src/config/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => withoutComments(readFileSync(path.join(here, '..', p), 'utf8'));
const LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

describe('the end of a schedule', () => {
  it('never ends and a one-time run is removed after its run, unless the record says otherwise', () => {
    expect(endOf({})).toEqual({
      ends: 'never',
      end_at: '',
      end_count: '',
      end_action: 'disable',
      remove_after_run: true,
    });
    expect(endOf({ ends: 'count', end_count: 3, end_action: 'remove', remove_after_run: 0 })).toMatchObject({
      ends: 'count',
      end_count: 3,
      end_action: 'remove',
      remove_after_run: false,
    });
    // a kind it does not know : never
    expect(endOf({ ends: 'soon' }).ends).toBe('never');
  });

  it('needs a date for ends date, a whole number of at least 1 for ends count ; a one-time run nothing', () => {
    expect(endError(t, { ends: 'date', end_at: '' }, false)).toBe('settings.schedules.endDateRequired');
    expect(endError(t, { ends: 'date', end_at: '2030-01-01T00:00:00Z' }, false)).toBeNull();
    for (const n of ['', '0', '-2', '1.5', 'x'])
      expect(endError(t, { ends: 'count', end_count: n }, false), n).toBe('settings.schedules.endCountInvalid');
    expect(endError(t, { ends: 'count', end_count: '4' }, false)).toBeNull();
    expect(endError(t, { ends: 'date', end_at: '' }, true)).toBeNull();
  });

  it('is saved with the fields its kind uses ; a one-time run sends only its removal', () => {
    expect(endPayload({ ends: 'date', end_at: 'D', end_count: 5, end_action: 'remove' }, false)).toEqual({
      ends: 'date',
      end_at: 'D',
      end_count: null,
      end_action: 'remove',
    });
    expect(endPayload({ ends: 'count', end_at: 'D', end_count: '5' }, false)).toEqual({
      ends: 'count',
      end_at: null,
      end_count: 5,
      end_action: 'disable',
    });
    expect(endPayload({ ends: 'count', remove_after_run: false }, true)).toEqual({ remove_after_run: 0 });
    expect(endPayload(endOf({}), true)).toEqual({ remove_after_run: 1 });
  });

  it('stops the runs previewed at its date, or at the runs it has left', () => {
    const runs = [1, 2, 3].map((d) => new Date(`2030-01-0${d}T00:00:00Z`));
    expect(runsBeforeEnd(runs, null)).toEqual(runs);
    expect(runsBeforeEnd(runs, { ends: 'date', end_at: '2030-01-02T00:00:00Z' })).toEqual(runs.slice(0, 2));
    expect(runsBeforeEnd(runs, { ends: 'count', end_count: 4 }, 2)).toEqual(runs.slice(0, 2));
    expect(runsBeforeEnd(runs, { ends: 'count', end_count: 2 }, 5)).toEqual([]);
    expect(runsBeforeEnd(runs, { ends: 'never' }, 9)).toEqual(runs);
  });
});

describe('where it is asked', () => {
  it('the page asks it under the timing, and saves it with the timing', () => {
    const page = read('src/pages/schedule.vue');
    expect(page).toMatch(/<AppScheduleEnd\s+v-show="fieldShown\('end'\)"\s+v-model="edit\.end"/);
    expect(page).toMatch(/:once="edit\.timing === 'once'"/);
    expect(page).toMatch(/\.\.\.endPayload\(e\.end, e\.timing === 'once'\)/);
    // the previews stop at the end
    expect(page).toMatch(/<BsRrule[^>]*:end="edit\.end"/);
    expect(page).toMatch(/<BsCron[^>]*:end="edit\.end"/s);
  });

  it('the wizard asks it in its schedule step, the full width, and sends it for the timing chosen', () => {
    const settings = getSettings(t);
    const end = settings.schedules.fields.find((f) => f.key === 'end');
    expect(end).toMatchObject({ step: 'when', type: 'component', flush: true, noTable: true });
    const item = { timing: 'once', end: endOf({}) };
    expect(end.props(item)).toMatchObject({ once: true });
    end.props(item)['onUpdate:modelValue']({ ...item.end, remove_after_run: false });
    expect(item.end.remove_after_run).toBe(false);
  });

  it('a recurring end is AppEndChoice, the choice of a stored job removal ; a one-time run a switch with its title above', () => {
    const c = read('src/components/AppScheduleEnd.vue');
    expect(c).toMatch(/<AppEndChoice/);
    expect(c).toMatch(/<label :class="\[labelClass, 'd-block'\]" :for="uid \+ '-remove'">/);
    // the switch says On or Off beside it
    expect(c).toMatch(/<BsSwitch\s+:id="uid \+ '-remove'"/);
    expect(read('src/components/AppStoredJobRemoval.vue')).toMatch(/<AppEndChoice/);
  });

  it('every text in every language, each on one line', async () => {
    const keys = [
      'ends',
      'endsNever',
      'endsOnDate',
      'endsAfter',
      'endsRuns',
      'endsCount',
      'endsRunsSoFar',
      'endAction',
      'endDisable',
      'endRemove',
      'endRepositoryHint',
      'endDateRequired',
      'endCountInvalid',
      'removeAfterRun',
      'removeAfterRunHelp',
      'removeAfterRunRepository',
      'tabRuns',
    ];
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default;
      for (const key of keys) {
        const text = texts.settings.schedules[key];
        expect(text, `${lang} ${key}`).toBeTruthy();
        expect(text.length, `${lang} ${key}`).toBeLessThanOrEqual(90);
      }
      // a radio label a word or two
      for (const key of ['endsNever', 'endsOnDate', 'endDisable', 'endRemove'])
        expect(texts.settings.schedules[key].split(' ').length, `${lang} ${key}`).toBeLessThanOrEqual(3);
      expect(texts.audit.actionLabels.schedule_end, lang).toBeTruthy();
    }
  });
});

describe("the schedule's page", () => {
  const page = read('src/pages/schedule.vue');

  it('has a Runs tab after the others, with the count of the jobs it started', () => {
    expect(page).toMatch(
      /key: 'runs', label: t\('settings\.schedules\.tabRuns'\), icon: 'history', count: runs\.value\.length/,
    );
    expect(page).toMatch(
      /axios\.get\(`\/api\/v2\/job\/\?schedule=\$\{encodeURIComponent\(scheduleId\.value\)\}&records=\$\{RUNS_SHOWN\}`\)/,
    );
    const tab = page.slice(page.indexOf('v-if="tabShown(\'runs\')"'));
    expect(tab).toMatch(/<AppLinkedTable/);
    expect(tab).toMatch(/:empty="t\('settings\.linked\.noJob'\)"/);
  });

  it('shows Enabled with its bold title above the switch, and the started job without a help line', () => {
    expect(page).toMatch(/<label class="form-label fw-bold d-block" for="af-schedule-enabled">/);
    expect(page).not.toMatch(/startedJobHelp/);
  });
});

describe('the schedules list', () => {
  it('shows the last run, the next run, then how it ended, as every job table puts Status after the times', () => {
    const keys = getSettings(t).schedules.fields.map((f) => f.key);
    expect(keys.indexOf('next_run')).toBe(keys.indexOf('last_run') + 1);
    expect(keys.indexOf('status')).toBe(keys.indexOf('next_run') + 1);
  });
});
