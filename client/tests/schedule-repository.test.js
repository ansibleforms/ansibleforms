// Schedules kept in a git repository : the repository's Schedules usage (use_for_schedules, one
// repository at most), the questions asked before it is turned on or off, the Source column and
// badge of Jobs > Scheduled, and the rrule editor : for a new recurring schedule while a schedules
// repository is used, and for every schedule that has a rrule, linked or not. No "where it lives"
// choice : the server decides.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// the server's preview of the usage, and the toasts said after
let previewData = {};
vi.mock('axios', () => ({
  default: {
    get: vi.fn(async (url) => {
      if (url.endsWith('/schedules-preview')) return { data: previewData };
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
import {
  rruleProblem,
  rruleValidationMessage,
  defaultRrule,
  zoneOf,
  scheduleSource,
  rruleCell,
  scheduleRepository,
  loadScheduleRepository,
} from '../src/config/rrule.js';
import { confirmPrompt, answerConfirm } from '../src/lib/confirmPrompt.js';
import {
  confirmScheduleUsage,
  confirmScheduleDelete,
  scheduleUsageToast,
  activationLines,
} from '../src/lib/scheduleUsage.js';

// the key, with its values, as the text : what reaches the page is checked, not a translation
const t = (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key);
const settings = getSettings(t);
const field = (list, key) => settings[list].fields.find((f) => f.key === key);

describe('the Schedules usage of a repository', () => {
  it('is a short checkbox of the Usage step, its own column, as the other usages', () => {
    const f = field('repositories', 'use_for_schedules');
    expect(f).toMatchObject({
      step: 'usage',
      type: 'checkbox',
      shortLabel: 'settings.repositories.useSchedulesShort',
      columnLabel: 'settings.repositories.useSchedulesShort',
      help: 'settings.repositories.helpUseForSchedules',
    });
    // one repository holds the schedules : greyed out, with who has it, on the others
    expect(f.oneOnly).toBe(true);
  });

  it('makes a repository one the app pushes back to', () => {
    const push = settings.repositories.actions.find((a) => a.name === 'sync');
    expect(push.dependency).toContain('use_for_schedules');
    const page = readFileSync(join(import.meta.dirname, '../src/pages/admin/repository.vue'), 'utf8');
    expect(page).toMatch(/key: 'use_for_schedules',\s*label: t\('settings\.repositories\.useSchedulesShort'\)/);
    expect(page).toContain('repo.value?.use_for_schedules');
  });
});

describe('where a schedule comes from', () => {
  it("this app's own : nothing, the source only says where a schedule from git comes from", () => {
    expect(scheduleSource(t, { name: 'x', repository: null })).toBe('');
  });

  it('a repository : a Repository badge with its name, its file in the tooltip, escaped', () => {
    const html = scheduleSource(t, { repository: 'ops<b>', repo_file: 'schedules/a "b".yaml' });
    expect(html).toContain('class="badge af-source-badge"');
    expect(html).toContain('title="schedules/a &quot;b&quot;.yaml"');
    expect(html).toContain('settings.schedules.sourceRepository');
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
  beforeEach(() => {
    scheduleRepository.value = null;
  });

  it('has no choice of where it lives', () => {
    const fields = settings.schedules.fields;
    expect(fields.some((f) => f.values === 'schedule/repositories')).toBe(false);
    expect(field('schedules', 'repository').noInput).toBe(true);
  });

  it('without a schedules repository : a cron, or a one time run', () => {
    const shown = (key, item) => field('schedules', key).showWhen(item);
    expect(shown('cron', {})).toBe(true);
    expect(shown('rrule', {})).toBe(false);
    expect(shown('run_at', { one_time_run: true })).toBe(true);
    const app = settings.schedules.beforeSave({ name: 'a', rrule: 'R', cron: '0 2 * * *' });
    expect(app.rrule).toBeUndefined();
    expect(app.cron).toBe('0 2 * * *');
  });

  it('with a schedules repository : the rrule editor for a recurring one, a sensible default', async () => {
    previewData = { active: 'ops' };
    await loadScheduleRepository();
    expect(scheduleRepository.value).toBe('ops');
    const shown = (key, item) => field('schedules', key).showWhen(item);
    expect(shown('rrule', {})).toBe(true);
    expect(shown('cron', {})).toBe(false);
    // a one time run stays a one time run, in the app
    expect(shown('rrule', { one_time_run: true })).toBe(false);
    expect(field('schedules', 'rrule').type).toBe('rrule');
    expect(field('schedules', 'rrule').initial({})).toMatch(
      /^DTSTART;TZID=.+:\d{8}T000000 RRULE:FREQ=DAILY;INTERVAL=1$/,
    );
    expect(settings.schedules.beforeSave({ name: 'a', rrule: 'R', cron: '* * * * *' })).toMatchObject({
      rrule: 'R',
      cron: '',
    });
    expect(settings.schedules.beforeSave({ name: 'a', rrule: 'R', one_time_run: true }).rrule).toBeUndefined();
  });

  it('a new repository schedule starts daily at midnight, in a zone, on one line', () => {
    expect(defaultRrule('Europe/Brussels', new Date('2026-10-20T10:00:00Z'))).toBe(
      'DTSTART;TZID=Europe/Brussels:20261020T000000 RRULE:FREQ=DAILY;INTERVAL=1',
    );
    expect(defaultRrule('Not/AZone', new Date('2026-10-20T10:00:00Z'))).toBe(
      'DTSTART;TZID=UTC:20261020T000000 RRULE:FREQ=DAILY;INTERVAL=1',
    );
  });

  it('a schedule with a rrule and no repository is edited with the rrule editor on its page', () => {
    const page = readFileSync(join(import.meta.dirname, '../src/pages/schedule.vue'), 'utf8');
    expect(page).toContain('const usesRrule = computed(() => !!schedule.value?.rrule);');
    expect(page).toMatch(/<div v-if="usesRrule" v-show="fieldShown\('rrule'\)"/);
    expect(page).toContain('<BsRrule v-model="edit.rrule"');
  });
});

describe('the questions before the Schedules usage changes', () => {
  beforeEach(() => {
    toasts.length = 0;
    previewData = {
      written: ['Nightly', 'Weekdays'],
      kept: [{ name: 'First or Monday', cron: '0 0 1 * 1', reason: 'both' }],
      clashes: ['Backup'],
      planned: 1,
      linked: 3,
      unpushed: true,
    };
  });

  it('turned on : what it will take, git winning on a name, the crons kept, Cancel / Use for schedules', async () => {
    const answer = confirmScheduleUsage(t, 'ops', false, true);
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.title).toBe('settings.repositories.schedulesOnTitle');
    expect(confirmPrompt.ok).toBe('settings.repositories.schedulesOnButton');
    const text = confirmPrompt.details.join('\n');
    expect(text).toContain('settings.repositories.schedulesOnWritten {"count":2,"name":"ops"}');
    expect(text).toContain('settings.repositories.schedulesOnClashes {"names":"Backup"}');
    expect(text).toContain('settings.repositories.schedulesOnKept {"names":"First or Monday (0 0 1 * 1)"}');
    expect(text).toContain('settings.repositories.schedulesOnPlanned');
    expect(text).toContain('settings.repositories.schedulesOnAfter');
    answerConfirm(false);
    expect(await answer).toBe(false);
  });

  it('no clash : says git wins all the same', () => {
    const lines = activationLines(t, 'ops', { written: [], kept: [], clashes: [] });
    expect(lines).toContain('settings.repositories.schedulesOnGitWins');
  });

  it('turned off : its schedules stay in the app, the unpushed changes warned of', async () => {
    const answer = confirmScheduleUsage(t, 'ops', true, false);
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.title).toBe('settings.repositories.schedulesOffTitle');
    const text = confirmPrompt.details.join('\n');
    expect(text).toContain('settings.repositories.schedulesOffKept {"count":3,"name":"ops"}');
    expect(text).toContain('settings.repositories.schedulesOffUnpushed');
    answerConfirm(true);
    expect(await answer).toBe(true);
  });

  it('unchanged : nothing is asked', async () => {
    expect(await confirmScheduleUsage(t, 'ops', true, true)).toBe(true);
    expect(confirmPrompt.open).toBe(false);
  });

  it('deleting a schedules repository asks the same ; another repository the usual question', async () => {
    expect(await confirmScheduleDelete(t, { name: 'forms', use_for_schedules: 0 })).toBeNull();
    const answer = confirmScheduleDelete(t, { name: 'ops', use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(confirmPrompt.ok).toBe('common.delete');
    expect(confirmPrompt.details.join('\n')).toContain('settings.repositories.schedulesOffKept');
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
    scheduleUsageToast(t, {
      schedules: { activated: { pull: 'pulled', written: ['a', 'b'], matched: ['c'], kept: [] } },
    });
    expect(toasts[0][1]).toBe('settings.repositories.schedulesOnDone {"written":2,"matched":1,"kept":0}');
    scheduleUsageToast(t, { schedules: { deactivated: { pull: 'not pulled: offline', unlinked: 4 } } });
    expect(toasts[1][1]).toContain('settings.repositories.schedulesOffDone {"count":4}');
    expect(toasts[1][1]).toContain('settings.repositories.schedulesNotPulled');
    expect(scheduleUsageToast(t, null)).toBe('');
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
  ])('refuses %s', (rrule, reason) => {
    expect(rruleProblem(rrule)).toContain(reason);
    expect(rruleValidationMessage(t, rrule)).toContain('settings.schedules.rruleInvalid');
  });

  it('reads its zone', () => {
    expect(zoneOf('DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1')).toBe('Europe/Brussels');
    expect(zoneOf('DTSTART:20261020T020000Z RRULE:FREQ=DAILY;INTERVAL=1')).toBe('UTC');
  });
});
