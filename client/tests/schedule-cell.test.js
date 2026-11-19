// A schedule in a table cell (lib/scheduleCell.js), one function for every table : a cron or an
// iCal rrule said in words, the cron or rule itself in the popover on hover. The schedules list,
// a user's Schedules tab and Jobs > System use it, and the lists call the column Schedule.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scheduleCell, scheduleWords, isRrule } from '../src/lib/scheduleCell.js';
import { taskTimingCell, taskTiming } from '../src/lib/systemTasks.js';
import { rruleToCron } from '../src/config/rrule.js';
import { describeCron } from '../src/config/cronDescribe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const at = (time, rule) => `DTSTART;TZID=Europe/Brussels:20261119T${time} RRULE:${rule}`;

describe('a cron in a table cell', () => {
  it('shows the words, the cron on hover', () => {
    expect(scheduleCell('0 2 * * *')).toBe(
      '<span class="af-has-popover" data-af-popover="0 2 * * *">At 02:00 AM, every day</span>',
    );
  });

  it('shows the cron alone when it cannot be said in words', () => {
    expect(scheduleCell('not a cron')).toBe('not a cron');
    expect(scheduleCell(null)).toBe('');
  });

  it('escapes what it shows', () => {
    expect(scheduleCell('<b>')).toBe('&lt;b&gt;');
  });
});

describe('one function for every schedule table', () => {
  it('is the schedules list column and the user page tab', () => {
    expect(read('src/config/settings.js')).toMatch(/: scheduleCell\(row\?\.rrule \|\| v\),/);
    expect(read('src/composables/useUserLinks.js')).toMatch(/scheduleCell\(s\.rrule \|\| s\.cron\)/);
    // the old helpers are gone : one place says a schedule
    for (const file of ['src/config/settings.js', 'src/config/rrule.js', 'src/lib/systemTasks.js']) {
      expect(read(file)).not.toMatch(/cronCell|rruleCell/);
    }
  });

  it("is Jobs > System's cell and words too, for a task's cron", () => {
    const t = (key) => key;
    expect(taskTimingCell(t, { cron: '0 2 * * *', enabled: true })).toBe(scheduleCell('0 2 * * *'));
    expect(taskTiming(t, { cron: '0 2 * * *', enabled: true }, 'en')).toBe(scheduleWords('0 2 * * *', 'en'));
    // what only a task has stays its own : Off, a runner hub loop's seconds
    expect(taskTimingCell(t, { cron: '0 2 * * *', enabled: false })).toBe('jobs.system.off');
    expect(taskTimingCell(t, { cron: null, interval_seconds: 2, enabled: true })).toBe('jobs.system.everySeconds');
  });
});

describe('the Schedule column', () => {
  it('has one name on the schedules list and on Jobs > System, in every language', async () => {
    for (const lang of LANGS) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      expect(m.jobs.system.timing, lang).toBe(m.settings.schedules.stepSchedule);
    }
  });
});

describe('an rrule in a table cell', () => {
  it('is told from a cron by its RRULE part', () => {
    expect(isRrule(at('080000', 'FREQ=DAILY'))).toBe(true);
    expect(isRrule('0 8 * * *')).toBe(false);
  });

  it('is the cron that runs at the same times', () => {
    expect(rruleToCron(at('000000', 'FREQ=DAILY;INTERVAL=1'))).toBe('0 0 * * *');
    expect(rruleToCron(at('093000', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'))).toBe('30 9 * * 1,3,5');
    // no BYDAY : the day of its start (19 November 2026 is a Thursday)
    expect(rruleToCron(at('080000', 'FREQ=WEEKLY'))).toBe('0 8 * * 4');
    expect(rruleToCron(at('080000', 'FREQ=MONTHLY;BYDAY=2TU'))).toBe('0 8 * * 2#2');
    expect(rruleToCron(at('080000', 'FREQ=MONTHLY;BYDAY=-1FR'))).toBe('0 8 * * 5L');
    expect(rruleToCron(at('080000', 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1'))).toBe('0 8 * * 5L');
    expect(rruleToCron(at('080000', 'FREQ=MONTHLY;BYMONTHDAY=-1'))).toBe('0 8 L * *');
    expect(rruleToCron(at('180000', 'FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'))).toBe('0 18 LW * *');
    expect(rruleToCron(at('080000', 'FREQ=YEARLY'))).toBe('0 8 19 11 *');
    expect(rruleToCron(at('000000', 'FREQ=HOURLY;INTERVAL=6;BYMINUTE=15'))).toBe('15 */6 * * *');
    expect(rruleToCron(at('000000', 'FREQ=MINUTELY;INTERVAL=15'))).toBe('*/15 * * * *');
  });

  it('is none when no cron says the same : the rule stays as code', () => {
    // a cron counts no weeks, nor days across months
    expect(rruleToCron(at('080000', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'))).toBeNull();
    expect(rruleToCron(at('080000', 'FREQ=DAILY;INTERVAL=3'))).toBeNull();
    // every 5 hours does not divide the day, every 7 minutes not the hour
    expect(rruleToCron(at('000000', 'FREQ=HOURLY;INTERVAL=5'))).toBeNull();
    expect(rruleToCron(at('000000', 'FREQ=MINUTELY;INTERVAL=7'))).toBeNull();
    expect(rruleToCron(at('080000', 'FREQ=YEARLY;BYWEEKNO=20'))).toBeNull();
    expect(rruleToCron('not a rule')).toBeNull();
    const rule = at('080000', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    expect(scheduleCell(rule)).toBe(`<span class="font-monospace small">${rule}</span>`);
  });

  it('shows the words, the rule on hover', () => {
    const rule = at('180000', 'FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
    expect(scheduleCell(rule)).toBe(
      `<span class="af-has-popover" data-af-popover="${rule}">At 06:00 PM, on the last weekday of the month</span>`,
    );
  });

  it('is said in every language', () => {
    for (const lang of LANGS) {
      for (const cron of ['0 18 LW * *', '0 8 * * 2#2', '0 8 * * 5L', '0 8 L * *']) {
        expect(describeCron(cron, lang, { built: true }), `${lang} ${cron}`).not.toBe('');
      }
    }
  });

  it('a schedule typed with such a cron is still refused its words', () => {
    // the schedules' own crons keep their rules (config/cron.js) : only a built one skips them
    expect(describeCron('0 18 LW * *', 'en')).toBe('');
  });
});
