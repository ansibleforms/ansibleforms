// Schedules kept in a git repository : the repository's Schedules usage (use_for_schedules, one
// repository at most, a type of the Designer group : lib/repositoryUsage.js), the question asked
// before it is turned on or off, the Repository badge of a schedule's page, and the timing of a
// schedule : a cron, a rrule or a one time run, the same three choices whatever the repositories.
// No "where it lives" choice : the server decides.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// the server's preview of the usage, and the toasts said after
let previewData = {};
vi.mock('axios', () => ({
  default: {
    get: vi.fn(async (url) => {
      if (url.includes('/usage-preview?types=schedules'))
        return { data: { unpushed: !!previewData.unpushed, types: { schedules: previewData } } };
      if (url === '/api/v2/schedule/repositories')
        return { data: { records: previewData.active ? [{ name: previewData.active }] : [] } };
      return { data: {} };
    }),
  },
}));
const toasts = [];
vi.mock('vue-sonner', () => ({
  toast: { success: (m) => toasts.push(['success', m]), error: (m) => toasts.push(['error', m]) },
}));

import getSettings from '../src/config/settings.js';
import { rruleProblem, rruleValidationMessage, defaultRrule, zoneOf, rruleCell } from '../src/config/rrule.js';
import { timingKind, scheduleTiming } from '../src/config/settings.js';
import { intlZone } from '../src/lib/rruleRules.js';
import { confirmPrompt, answerConfirm } from '../src/lib/confirmPrompt.js';
import {
  usageType,
  confirmUsageChange,
  confirmUsageDelete,
  usageToast,
  activationLines,
  repositoryBadge,
} from '../src/lib/repositoryUsage.js';

// the key, with its values, as the text : what reaches the page is checked, not a translation
const t = (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key);
const settings = getSettings(t);
const field = (list, key) => settings[list].fields.find((f) => f.key === key);

describe('the Schedules usage of a repository', () => {
  it('is an object type of the Jobs group, one repository at most', () => {
    expect(usageType('schedules')).toMatchObject({
      flag: 'use_for_schedules',
      category: 'jobs',
      objects: true,
      oneOnly: true,
    });
    // read from the entries of its schedules: lists, wherever they are : no folder, no file of its own
    expect(usageType('schedules').folder).toBeUndefined();
    expect(usageType('schedules').single).toBeUndefined();
  });

  it('makes a repository one the app pushes back to', () => {
    const push = settings.repositories.actions.find((a) => a.name === 'sync');
    expect(push.dependency).toContain('use_for_schedules');
    const page = readFileSync(join(import.meta.dirname, '../src/pages/admin/repository.vue'), 'utf8');
    expect(page).toContain('...USAGE_FLAGS,');
    expect(page).toContain('const canPush = computed(() => usedFor(repo.value).length > 0);');
  });
});

describe('where a schedule comes from', () => {
  it("this app's own : nothing, the source only says where a schedule from git comes from", () => {
    expect(repositoryBadge(t, { name: 'x', repository: null })).toBe('');
  });

  it('a repository : a Repository badge with its name, its file in the tooltip, escaped', () => {
    const html = repositoryBadge(t, { repository: 'ops<b>', repo_file: 'schedules/a "b".yaml' });
    expect(html).toContain('class="badge af-source-badge"');
    expect(html).toContain('title="schedules/a &quot;b&quot;.yaml"');
    expect(html).toContain('settings.repositories.sourceRepository');
    expect(html).toContain('ops&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('is no column of the list : the schedule page says it', () => {
    const f = field('schedules', 'repository');
    expect(f.noTable).toBe(true);
    expect(f.noInput).toBe(true);
  });

  it('the Schedule column shows the rrule of a repository schedule, escaped', () => {
    const render = field('schedules', 'cron').render;
    expect(render('', { rrule: 'DTSTART:20300101T000000Z RRULE:FREQ=DAILY;INTERVAL=1' })).toBe(
      rruleCell('DTSTART:20300101T000000Z RRULE:FREQ=DAILY;INTERVAL=1'),
    );
    expect(rruleCell('<x>')).toBe('<span class="font-monospace small">&lt;x&gt;</span>');
  });

  it('has the look of the other row badges', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/bootstrap-override.scss'), 'utf8');
    const rule = css.match(/\.af-source-badge \{([^}]*)\}/)?.[1] || '';
    expect(rule).toContain('font-weight: 600');
  });
});

describe('a new schedule : no "where it lives" choice, the server decides', () => {
  it('has no choice of where it lives', () => {
    const fields = settings.schedules.fields;
    expect(fields.some((f) => f.values === 'schedule/repositories')).toBe(false);
    expect(field('schedules', 'repository').noInput).toBe(true);
  });

  it('offers the three timings, whatever the repositories : a cron first, a rrule, a one time run', () => {
    const timing = field('schedules', 'timing');
    expect(timing.type).toBe('radio');
    expect(timing.options.map((o) => o.value)).toEqual(['cron', 'rrule', 'once']);
    // a new schedule starts on a cron, as before ; a record shows its own
    expect(timing.initial({})).toBe('cron');
    expect(timing.initial({ rrule: 'R' })).toBe('rrule');
    expect(timing.initial({ one_time_run: 1, run_at: '2030-01-01' })).toBe('once');
    // each field shown for its timing only, never by the repositories there are
    const shown = (key, item) => field('schedules', key).showWhen(item);
    expect([
      shown('cron', { timing: 'cron' }),
      shown('rrule', { timing: 'cron' }),
      shown('run_at', { timing: 'cron' }),
    ]).toEqual([true, false, false]);
    expect([
      shown('cron', { timing: 'rrule' }),
      shown('rrule', { timing: 'rrule' }),
      shown('run_at', { timing: 'rrule' }),
    ]).toEqual([false, true, false]);
    expect([
      shown('cron', { timing: 'once' }),
      shown('rrule', { timing: 'once' }),
      shown('run_at', { timing: 'once' }),
    ]).toEqual([false, false, true]);
    // the toggle it replaces : no input of its own any more
    expect(field('schedules', 'one_time_run').noInput).toBe(true);
    // the rrule a schedule given one starts with
    expect(field('schedules', 'rrule').type).toBe('rrule');
    expect(field('schedules', 'rrule').initial({})).toMatch(
      /^DTSTART;TZID=.+:\d{8}T000000 RRULE:FREQ=DAILY;INTERVAL=1$/,
    );
  });

  it('saves the timing chosen, the other two emptied, the dialog-only choice left out', () => {
    const item = { name: 'a', cron: '0 2 * * *', rrule: ' R ', run_at: '2030-01-01T00:00:00.000Z' };
    expect(settings.schedules.beforeSave({ ...item, timing: 'cron' })).toEqual({
      name: 'a',
      cron: '0 2 * * *',
      rrule: '',
      run_at: null,
      one_time_run: 0,
    });
    expect(settings.schedules.beforeSave({ ...item, timing: 'rrule' })).toEqual({
      name: 'a',
      cron: '',
      rrule: 'R',
      run_at: null,
      one_time_run: 0,
    });
    expect(settings.schedules.beforeSave({ ...item, timing: 'once' })).toEqual({
      name: 'a',
      cron: '',
      rrule: '',
      run_at: '2030-01-01T00:00:00.000Z',
      one_time_run: 1,
    });
    expect(scheduleTiming('cron', item)).toEqual(settings.schedules.beforeSave({ ...item, timing: 'cron' }));
    expect(timingKind({ one_time_run: 0, cron: '* * * * *' })).toBe('cron');
  });

  it('a new schedule given a rrule starts daily at midnight, in a zone, on one line', () => {
    expect(defaultRrule('Europe/Brussels', new Date('2026-10-20T10:00:00Z'))).toBe(
      'DTSTART;TZID=Europe/Brussels:20261020T000000 RRULE:FREQ=DAILY;INTERVAL=1',
    );
    expect(defaultRrule('Not/AZone', new Date('2026-10-20T10:00:00Z'))).toBe(
      'DTSTART;TZID=UTC:20261020T000000 RRULE:FREQ=DAILY;INTERVAL=1',
    );
  });

  it("a schedule's page offers the same three timings, kept in the app or in a repository", () => {
    const page = readFileSync(join(import.meta.dirname, '../src/pages/schedule.vue'), 'utf8');
    expect(page).not.toContain('usesRrule');
    expect(page).toContain("const TIMINGS = ['cron', 'rrule', 'once'];");
    expect(page).toContain('timing: timingKind(record),');
    expect(page).toMatch(/<input[^>]*v-model="edit\.timing"[^>]*type="radio"/s);
    expect(page).toMatch(/<div v-if="edit\.timing === 'rrule'" v-show="fieldShown\('rrule'\)"/);
    expect(page).toContain('<BsRrule v-model="edit.rrule"');
    expect(page).toContain('const data = scheduleTiming(e.timing,');
    // the list page no longer asks which repository holds the schedules
    const list = readFileSync(join(import.meta.dirname, '../src/pages/admin/schedules.vue'), 'utf8');
    expect(list).not.toContain('loadScheduleRepository');
  });
});

describe('the question before the Schedules usage changes', () => {
  beforeEach(() => {
    toasts.length = 0;
    previewData = {
      written: ['Nightly', 'Weekdays'],
      kept: [{ name: 'Broken', code: 'notWritten', error: 'disk full', reason: 'not written: disk full' }],
      clashes: ['Backup'],
      planned: 1,
      linked: 3,
      file: 'ops/schedules.yml',
      unpushed: true,
    };
  });

  it('turned on : what it will take, git winning on a name, what stays, Cancel / Turn on', async () => {
    const answer = confirmUsageChange(t, 'ops', { use_for_schedules: 0 }, { use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.title).toBe(
      'settings.repositories.usageOnTitle {"type":"settings.repositories.usageTypes.schedules"}',
    );
    expect(confirmPrompt.ok).toBe('settings.repositories.usageOnButton');
    const text = confirmPrompt.details.join('\n');
    expect(text).toContain(
      'settings.repositories.usageOnWrittenList {"type":"settings.repositories.usageTypes.schedules","name":"ops","file":"ops/schedules.yml","count":2}',
    );
    expect(text).toContain('settings.repositories.usageOnClashes {"names":"Backup"}');
    expect(text).toContain('settings.repositories.usageOnKept');
    expect(text).not.toContain('schedulesOnKept');
    expect(text).toContain('settings.repositories.schedulesOnPlanned');
    expect(text).toContain('settings.repositories.usageOnAfter');
    // one type : its own question, no section heading
    expect(confirmPrompt.details.some((d) => d.heading)).toBe(false);
    answerConfirm(false);
    expect(await answer).toBe(false);
  });

  it('no clash : says git wins all the same', () => {
    const lines = activationLines(t, 'schedules', 'ops', { written: [], kept: [], clashes: [] });
    expect(lines).toContain('settings.repositories.usageOnGitWins');
  });

  it('turned off : its schedules stay in the app, the unpushed changes warned of', async () => {
    const answer = confirmUsageChange(t, 'ops', { use_for_schedules: 1 }, { use_for_schedules: 0 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.title).toBe(
      'settings.repositories.usageOffTitle {"type":"settings.repositories.usageTypes.schedules"}',
    );
    const text = confirmPrompt.details.join('\n');
    expect(text).toContain(
      'settings.repositories.usageOffKept {"type":"settings.repositories.usageTypes.schedules","count":3}',
    );
    expect(text).toContain('settings.repositories.usageOffUnpushed');
    answerConfirm(true);
    expect(await answer).toBe(true);
  });

  it('unchanged : nothing is asked', async () => {
    expect(await confirmUsageChange(t, 'ops', { use_for_schedules: 1 }, { use_for_schedules: true })).toBe(true);
    expect(confirmPrompt.open).toBe(false);
  });

  it('deleting a schedules repository asks the same ; another repository the usual question', async () => {
    expect(await confirmUsageDelete(t, { name: 'forms', use_for_schedules: 0, use_for_forms: 1 })).toBeNull();
    const answer = confirmUsageDelete(t, { name: 'ops', use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.ok).toBe('common.delete');
    expect(confirmPrompt.details.join('\n')).toContain('settings.repositories.usageOffKept');
    answerConfirm(true);
    expect(await answer).toBe(true);
  });

  it('the repositories list asks and says the same', () => {
    expect(typeof settings.repositories.confirmSave).toBe('function');
    expect(typeof settings.repositories.confirmDelete).toBe('function');
    expect(typeof settings.repositories.afterSave).toBe('function');
    const multi = readFileSync(join(import.meta.dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
    expect(multi).toContain('await props.settings.confirmSave(body, null)');
    expect(multi).toContain('const answer = await props.settings.confirmDelete(value);');
  });

  it('says what the server did', () => {
    usageToast(t, { schedules: { activated: { pull: 'pulled', written: ['a', 'b'], matched: ['c'], kept: [] } } });
    expect(toasts[0][1]).toBe(
      'settings.repositories.usageOnDone {"type":"settings.repositories.usageTypes.schedules","created":0,"written":2,"matched":1,"kept":0}',
    );
    usageToast(t, { schedules: { deactivated: { pull: 'not pulled: offline', unlinked: 4 } } });
    expect(toasts[1][1]).toContain(
      'settings.repositories.usageOffDone {"type":"settings.repositories.usageTypes.schedules","count":4}',
    );
    expect(toasts[1][1]).toContain('settings.repositories.usageNotPulled');
    expect(usageToast(t, null)).toBe('');
  });
});

describe('a rrule is checked on its text', () => {
  it('takes a valid rrule', () => {
    expect(rruleProblem('DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1')).toBe('');
    expect(
      rruleProblem('DTSTART:20300101T000000Z RRULE:FREQ=WEEKLY;INTERVAL=1 EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU'),
    ).toBe('');
  });

  it.each([
    ['DTSTART:NONSENSE', 'Valid DTSTART required'],
    ['DTSTART:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1', 'naive'],
    ['DTSTART:20300308T050000Z', 'One or more rule'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1 EXDATE:20300401', 'EXDATE'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY', 'INTERVAL required'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=SECONDLY;INTERVAL=5', 'SECONDLY'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=5MO', 'BYDAY with numeric prefix'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2000', 'COUNT > 999'],
    ['DTSTART;TZID=Not/AZone:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1', 'A valid TZID'],
    // the server's rules, whatever the case of the keys or the sign of a number
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=-1', 'INTERVAL must be a positive integer'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;interval=0', 'INTERVAL must be a positive integer'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;count=5000', 'COUNT > 999'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=0', 'COUNT must be a positive integer'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;count=5;until=20310101T000000Z', 'both COUNT and UNTIL'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=+1MO', 'BYDAY with numeric prefix'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1 rdate:20300401T000000Z', 'RDATE'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;FOO=1', "Unknown RRULE property 'FOO'"],
    // a day there is not, a part given twice : as the server refuses them
    ['DTSTART:20300230T050000Z RRULE:FREQ=DAILY;INTERVAL=1', 'invalid DTSTART'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310230T000000', 'invalid UNTIL'],
    ['DTSTART:20300308T050000Z RRULE:FREQ=FOO;INTERVAL=1;FREQ=DAILY', 'a part is given more than once: FREQ'],
  ])('refuses %s', (rrule, reason) => {
    expect(rruleProblem(rrule)).toContain(reason);
    expect(rruleValidationMessage(t, rrule)).toContain('settings.schedules.rruleInvalid');
  });

  it('takes a fixed offset UTC+5 or GMT-3, not the names of the server zone', () => {
    const rrule = (zone) => `DTSTART;TZID=${zone}:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1`;
    for (const zone of ['UTC+5', 'GMT-3', 'UTC+14', 'UTC-12']) expect(rruleProblem(rrule(zone))).toBe('');
    for (const zone of ['local', 'system', 'utc+5', 'UTC+15', 'UTC-13']) {
      expect(rruleProblem(rrule(zone))).toContain('A valid TZID');
    }
    // the runs shown in the Etc/GMT zone of the offset, which counts the other way
    expect(intlZone('UTC+5')).toBe('Etc/GMT-5');
    expect(intlZone('GMT-03')).toBe('Etc/GMT+3');
    expect(intlZone('Europe/Brussels')).toBe('Europe/Brussels');
  });

  it('reads its zone', () => {
    expect(zoneOf('DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1')).toBe('Europe/Brussels');
    expect(zoneOf('DTSTART:20261020T020000Z RRULE:FREQ=DAILY;INTERVAL=1')).toBe('UTC');
  });
});

describe('a refused rrule in the New schedule dialog', () => {
  it('says why once : under the editor (BsRrule), not again among the dialog errors', () => {
    const value = 'DTSTART;TZID=UTC:20261020T020000 RRULE:FREQ=DAILY';
    // the field's validator : the message the editor shows under its box, the same reason
    const reason = rruleProblem(value);
    expect(reason).not.toBe('');
    expect(field('schedules', 'rrule').validator(value)).toBe(
      `settings.schedules.rruleInvalid ${JSON.stringify({ reason })}`,
    );
    const editor = readFileSync(join(import.meta.dirname, '../src/components/BsRrule.vue'), 'utf8');
    expect(editor).toContain('const textProblem = computed(() => rruleProblem(props.modelValue));');
    expect(editor).toMatch(
      /<small v-if="problem" class="text-danger[^"]*">\{\{\s*t\('settings\.schedules\.rruleInvalid', \{ reason: problem \}\)/,
    );
    // the dialog (AppAdminMulti, its rrule field) lists the other errors only : not that validator's
    const multi = readFileSync(join(import.meta.dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
    const block = multi.slice(multi.indexOf('<!-- RRULE FIELD'), multi.indexOf('<!-- USAGE FIELD'));
    expect(block).toContain('<BsRrule');
    expect(block.match(/v-for="error in [^"]+"/g)).toEqual([
      `v-for="error in $v.item[field.key].$errors.filter((e) => e.$validator !== 'custom')"`,
    ]);
  });
});
