// The year, month and day dropdowns of the Server log and the Audit log (AppDatePick, with
// lib/datePick.js) : the days a month has (February 29 in a leap year only), a day beyond a new
// month's length clamped to its last day, the months named in the page's language, and the
// period of a pick as the browser's own [from, to) instants. And the two pages wired to them :
// the Server log without its Clear button and with a reset back to today, the Audit log's
// headers sorting on the server and its reset clearing the period and the order too.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  daysInMonth,
  clampPick,
  monthNames,
  todayPick,
  samePick,
  isoDay,
  periodOf,
  pickLabel,
  yearRange,
} from '@/lib/datePick';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', 'src', f), 'utf8');

describe('the days of a month', () => {
  it('has February 29 in a leap year only', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('clamps a day beyond the new month to its last day', () => {
    expect(clampPick({ year: 2026, month: 2, day: 31 })).toEqual({ year: 2026, month: 2, day: 28 });
    expect(clampPick({ year: 2024, month: 2, day: 31 })).toEqual({ year: 2024, month: 2, day: 29 });
    // February 29 of a leap year, the year changed to one that is not
    expect(clampPick({ year: 2025, month: 2, day: 29 })).toEqual({ year: 2025, month: 2, day: 28 });
    expect(clampPick({ year: 2026, month: 4, day: 31 })).toEqual({ year: 2026, month: 4, day: 30 });
    expect(clampPick({ year: 2026, month: 3, day: 15 })).toEqual({ year: 2026, month: 3, day: 15 });
  });

  it('drops a finer part with a coarser All', () => {
    expect(clampPick({ year: null, month: 3, day: 4 })).toEqual({ year: null, month: null, day: null });
    expect(clampPick({ year: 2026, month: null, day: 4 })).toEqual({ year: 2026, month: null, day: null });
    expect(clampPick(undefined)).toEqual({ year: null, month: null, day: null });
  });
});

describe('the months', () => {
  it('are named in the page language, January first', () => {
    const en = monthNames('en');
    expect(en).toHaveLength(12);
    expect(en[0]).toBe('January');
    expect(en[10]).toBe('November');
    expect(monthNames('fr')[10]).toBe('novembre');
    expect(monthNames('de')[2]).toBe('März');
  });
});

describe('a pick', () => {
  it('today is the browser calendar day', () => {
    expect(todayPick(new Date(2026, 10, 14, 23, 59))).toEqual({ year: 2026, month: 11, day: 14 });
  });

  it('compares by its year, month and day', () => {
    expect(samePick({ year: 2026, month: 11, day: 14 }, { year: 2026, month: 11, day: 14 })).toBe(true);
    expect(samePick({ year: 2026, month: 11, day: 14 }, { year: 2026, month: 11, day: 15 })).toBe(false);
    expect(samePick({ year: null, month: null, day: null }, {})).toBe(true);
  });

  it('names the day of a log file', () => {
    expect(isoDay({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05');
  });

  it('is a period of the browser calendar, [from, to)', () => {
    const day = periodOf({ year: 2026, month: 11, day: 14 });
    expect(day.from).toBe(new Date(2026, 10, 14).toISOString());
    expect(day.to).toBe(new Date(2026, 10, 15).toISOString());
    expect(day.name).toBe('2026-11-14');
    const month = periodOf({ year: 2026, month: 12, day: null });
    expect(month.from).toBe(new Date(2026, 11, 1).toISOString());
    expect(month.to).toBe(new Date(2027, 0, 1).toISOString());
    expect(month.name).toBe('2026-12');
    const year = periodOf({ year: 2026, month: null, day: null });
    expect(year.from).toBe(new Date(2026, 0, 1).toISOString());
    expect(year.to).toBe(new Date(2027, 0, 1).toISOString());
    expect(year.name).toBe('2026');
    // the last day of a month runs to the first of the next
    expect(periodOf({ year: 2024, month: 2, day: 29 }).to).toBe(new Date(2024, 2, 1).toISOString());
    expect(periodOf({ year: null, month: null, day: null })).toBe(null);
  });

  it('is said in words of the page language', () => {
    expect(pickLabel({ year: 2026, month: 11, day: 14 }, 'en-GB')).toBe('14 November 2026');
    expect(pickLabel({ year: 2026, month: 11, day: null }, 'en')).toBe('November 2026');
    expect(pickLabel({ year: 2026, month: null, day: null }, 'en')).toBe('2026');
    expect(pickLabel({ year: null, month: null, day: null }, 'en')).toBe('');
  });

  it('offers every year from the oldest to the newest, the newest first', () => {
    expect(yearRange([2023, 2026])).toEqual([2026, 2025, 2024, 2023]);
    expect(yearRange([2026, 2026])).toEqual([2026]);
    expect(yearRange([])).toEqual([]);
  });
});

describe('the pages', () => {
  const logs = read('pages/logs.vue');
  const audit = read('pages/admin/audit.vue');
  const picker = read('components/AppDatePick.vue');

  it('put the date dropdowns first in their filter row', () => {
    const logsRow = logs.slice(logs.indexOf('<template #headerActions>'));
    expect(logsRow.indexOf('<AppDatePick')).toBeLessThan(logsRow.indexOf('<BsSearch'));
    const auditRow = audit.slice(audit.indexOf('<template #headerActions>'));
    expect(auditRow.indexOf('<AppDatePick')).toBeLessThan(auditRow.indexOf('v-model="filterActor"'));
    expect(audit).toMatch(/<AppDatePick[^>]*allow-all/);
    expect(logs).not.toMatch(/<AppDatePick[^>]*allow-all/);
  });

  it('label the dropdowns for a screen reader', () => {
    for (const key of ['datePick.year', 'datePick.month', 'datePick.day']) expect(picker).toContain(`t('${key}')`);
  });

  it('the Server log has no Clear any more, and a reset back to today', () => {
    expect(logs).not.toMatch(/clearView|clearedAfter|logs\.clear/);
    expect(logs).toMatch(/icon="filter-circle-xmark"[\s\S]*@click="resetView\(\)"/);
    expect(logs).toMatch(/function resetView\(\)[\s\S]*filter\.value = ''[\s\S]*todayPick\(\)/);
  });

  it('the Audit log sorts its headers on the server, as the Job history does', () => {
    for (const key of ['time', 'actor', 'action', 'target', 'outcome', 'ip']) {
      expect(audit).toContain(`@click="toggleSort('${key}')"`);
      expect(audit).toContain(`:aria-sort="ariaSort('${key}')"`);
    }
    expect(audit).toMatch(/params\.set\('sort', sortKey\.value\)/);
    expect(audit).toMatch(/params\.set\('dir', sortDir\.value === 1 \? 'asc' : 'desc'\)/);
  });

  it('the Audit log reset clears the period and the order too', () => {
    const reset = audit.slice(audit.indexOf('async function resetFilters()'));
    expect(reset).toMatch(/period\.value = \{ year: null, month: null, day: null \}/);
    expect(reset).toMatch(/sortKey\.value = null/);
  });

  it('the Audit log downloads with the filters of its table', () => {
    expect(audit).toMatch(/\/api\/v2\/audit\/download\?/);
    expect(audit).toMatch(/icon="download"/);
  });
});
