// Dates in the user's time zone (lib/Time.js), and Helpers.formatServerDate which uses it.
//
// The server sends ISO strings with their zone : 'Z' for database columns, an explicit offset
// for the dates it already put in LOG_TZ (backups). Those convert exactly to whatever zone the
// user picked. A string without a zone cannot be placed in time, so its wall clock is shown as
// written. Neither formatter may ever echo its input : BsDataTable renders a column's render()
// result as HTML.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import Time, { BROWSER } from '@/lib/Time';
import Helpers from '@/lib/Helpers';

// no pinia store in these tests : Time reads the preference from the browser storage, which
// the test environment does not provide - a small in-memory one stands in for it
const storage = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
});

function prefer(zone) {
  localStorage.setItem('af_timezone', zone);
}

describe('Time.format', () => {
  beforeEach(() => localStorage.removeItem('af_timezone'));

  test('shows UTC when nothing is picked', () => {
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('2026-10-06 00:23:03 UTC');
  });

  test('converts to the picked zone', () => {
    prefer('Europe/Madrid'); // UTC+2 in October
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('2026-10-06 02:23:03 CEST');
    prefer('America/New_York'); // UTC-4 in October : the day changes
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('2026-10-05 20:23:03 EDT');
  });

  test('honours an explicit offset in the input', () => {
    // a backup date the server put in LOG_TZ = Europe/Madrid
    expect(Time.format('2026-07-26T02:21:46.000+02:00')).toBe('2026-07-26 00:21:46 UTC');
  });

  test('"browser" follows the browser zone', () => {
    prefer(BROWSER);
    expect(Time.zone()).toBe(Time.browserZone());
  });

  test('takes a pattern, a Date and epoch milliseconds', () => {
    expect(Time.format('2026-10-06T00:23:03Z', 'HH:mm')).toBe('00:23 UTC');
    // a date alone has no zone name
    expect(Time.format('2026-10-06T00:23:03Z', 'YYYY-MM-DD')).toBe('2026-10-06');
    expect(Time.format(new Date('2026-10-06T00:23:03Z'))).toBe('2026-10-06 00:23:03 UTC');
    expect(Time.format(Date.UTC(2026, 9, 6, 0, 23, 3))).toBe('2026-10-06 00:23:03 UTC');
  });

  test('an unknown zone falls back to UTC instead of failing', () => {
    prefer('Not/AZone');
    expect(Time.format('2026-10-06T00:23:03Z')).toBe('2026-10-06 00:23:03 UTC');
  });

  test('names the zone the way its own region does, and its season', () => {
    const d = (iso) => new Date(iso);
    expect(Time.zoneName(d('2026-10-06T12:00:00Z'), 'Europe/Madrid')).toBe('CEST');
    expect(Time.zoneName(d('2026-01-06T12:00:00Z'), 'Europe/Madrid')).toBe('CET');
    expect(Time.zoneName(d('2026-07-06T12:00:00Z'), 'Europe/London')).toBe('BST');
    expect(Time.zoneName(d('2026-10-06T12:00:00Z'), 'Asia/Kolkata')).toBe('IST');
    expect(Time.zoneName(d('2026-01-06T12:00:00Z'), 'America/Los_Angeles')).toBe('PST');
    expect(Time.zoneName(d('2026-01-06T12:00:00Z'), 'Australia/Sydney')).toBe('AEDT');
    // no locale names it : its offset
    expect(Time.zoneName(d('2026-10-06T12:00:00Z'), 'Asia/Tokyo')).toBe('GMT+9');
    expect(Time.zoneName(d('2026-10-06T12:00:00Z'), 'UTC')).toBe('UTC');
  });

  test('never echoes what it cannot read', () => {
    expect(Time.format('')).toBe('');
    expect(Time.format(null)).toBe('');
    expect(Time.format('<img src=x onerror=alert(1)>')).toBe('');
  });
});

describe('Helpers.formatServerDate', () => {
  beforeEach(() => prefer('Europe/Madrid'));

  test('converts zoned timestamps to the user zone', () => {
    expect(Helpers.formatServerDate('2026-10-06T00:23:03.000Z')).toBe('2026-10-06 02:23:03 CEST');
    expect(Helpers.formatServerDate('2026-07-26T02:21:46.000+02:00')).toBe('2026-07-26 02:21:46 CEST');
  });

  test('keeps the wall clock of a timestamp without a zone', () => {
    expect(Helpers.formatServerDate('2026-07-26 00:21:46')).toBe('2026-07-26 00:21:46');
  });

  test('never echoes its input', () => {
    expect(Helpers.formatServerDate('<img src=x onerror=alert(1)>')).toBe('');
    expect(Helpers.formatServerDate('')).toBe('');
  });
});

describe('the date format', () => {
  beforeEach(() => {
    localStorage.removeItem('af_timezone');
    localStorage.removeItem('af_date_format');
  });

  test('is ISO when nothing is picked', () => {
    expect(Time.datePattern()).toBe('YYYY-MM-DD');
    expect(Time.hasOwnDateFormat()).toBe(false);
  });

  test('writes the date part of every date in the format picked, the time as before', () => {
    localStorage.setItem('af_date_format', 'DD/MM/YYYY');
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('06/10/2026 00:23:03 UTC');
    // a pattern of its own keeps its own date part in the format too
    expect(Time.format('2026-10-06T00:23:03.000Z', 'YYYY-MM-DD HH:mm')).toBe('06/10/2026 00:23 UTC');
    localStorage.setItem('af_date_format', 'MM/DD/YYYY');
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('10/06/2026 00:23:03 UTC');
    localStorage.setItem('af_date_format', 'DD.MM.YYYY');
    expect(Helpers.formatServerDate('2026-07-26 00:21:46')).toBe('26.07.2026 00:21:46');
  });

  test('an unknown format is ISO, never written as given', () => {
    localStorage.setItem('af_date_format', '<b>YYYY</b>');
    expect(Time.datePattern()).toBe('YYYY-MM-DD');
    expect(Time.format('2026-10-06T00:23:03.000Z')).toBe('2026-10-06 00:23:03 UTC');
  });
});

describe('Time.toWallClock / fromWallClock', () => {
  test('reads a moment on the clock of a zone', () => {
    const wall = Time.toWallClock('2026-10-15T09:00:00.000Z', 'Europe/Madrid');
    expect([wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()]).toEqual([
      2026, 9, 15, 11, 0,
    ]);
    const utc = Time.toWallClock('2026-10-15T09:00:00.000Z', 'UTC');
    expect(utc.getHours()).toBe(9);
  });

  test('the day changes with the zone', () => {
    const wall = Time.toWallClock('2026-10-06T00:23:00.000Z', 'America/New_York');
    expect([wall.getDate(), wall.getHours(), wall.getMinutes()]).toEqual([5, 20, 23]);
  });

  test('a wall clock picked in a zone is the moment in that zone', () => {
    expect(Time.fromWallClock(new Date(2026, 9, 15, 9, 0, 0), 'UTC')).toBe('2026-10-15T09:00:00.000Z');
    expect(Time.fromWallClock(new Date(2026, 9, 15, 9, 0, 0), 'Europe/Madrid')).toBe('2026-10-15T07:00:00.000Z');
    // winter : CET is UTC+1
    expect(Time.fromWallClock(new Date(2026, 0, 15, 9, 0, 0), 'Europe/Madrid')).toBe('2026-01-15T08:00:00.000Z');
  });

  test('switching zones keeps the moment', () => {
    const moment = '2026-10-15T09:00:00.000Z';
    for (const zone of ['UTC', 'Europe/Madrid', 'Asia/Tokyo', 'America/New_York']) {
      expect(Time.fromWallClock(Time.toWallClock(moment, zone), zone)).toBe(moment);
    }
  });

  test('not a date gives nothing', () => {
    expect(Time.toWallClock('nope', 'UTC')).toBeNull();
    expect(Time.fromWallClock(new Date('nope'), 'UTC')).toBe('');
    expect(Time.fromWallClock(null, 'UTC')).toBe('');
  });
});

describe('Time.momentOf', () => {
  test('a moment nobody changed stays itself, across the clock changes', () => {
    // every quarter of an hour of the two days the clocks change in Madrid and New York, on
    // several zones : the hour that comes twice, and the one the browser skips, included
    const days = ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01'];
    for (const zone of ['UTC', 'Europe/Madrid', 'America/New_York', 'Asia/Kolkata']) {
      for (const day of days) {
        const start = Date.parse(`${day}T00:00:00.000Z`) - 12 * 3600e3;
        for (let t = start; t < start + 48 * 3600e3; t += 15 * 60e3) {
          const iso = new Date(t).toISOString();
          expect(Time.momentOf(Time.toWallClock(iso, zone), zone, iso)).toBe(iso);
        }
      }
    }
    // some three thousand moments, each through Intl : about a second alone, but a busy
    // runner (the whole suite in parallel) took it past the 5 s default
  }, 30000);

  test('the second 02:30 of an autumn night in Madrid is kept, not read as the first', () => {
    const second = '2026-10-25T01:30:00.000Z'; // 02:30 CET
    const wall = Time.toWallClock(second, 'Europe/Madrid');
    expect(wall.getHours()).toBe(2);
    expect(Time.fromWallClock(wall, 'Europe/Madrid')).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST
    expect(Time.momentOf(wall, 'Europe/Madrid', second)).toBe(second);
  });

  test('reads the hour that comes twice the same in summer as in winter', () => {
    for (const now of ['2026-07-01T12:00:00Z', '2026-12-01T12:00:00Z']) {
      vi.useFakeTimers({ now: new Date(now), toFake: ['Date'] });
      try {
        expect(Time.fromWallClock(new Date(2026, 9, 25, 2, 30), 'Europe/Madrid')).toBe('2026-10-25T00:30:00.000Z');
        expect(Time.fromWallClock(new Date(2026, 9, 25, 2, 30), 'UTC')).toBe('2026-10-25T02:30:00.000Z');
        expect(Time.fromWallClock(new Date(2026, 6, 1, 9, 0), 'America/New_York')).toBe('2026-07-01T13:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test('keeps the milliseconds', () => {
    const iso = '2026-10-15T09:00:00.123Z';
    expect(Time.momentOf(Time.toWallClock(iso, 'Europe/Madrid'), 'Europe/Madrid', iso)).toBe(iso);
    expect(Time.fromWallClock(Time.toWallClock(iso, 'Europe/Madrid'), 'Europe/Madrid')).toBe(iso);
  });

  test('a wall clock changed is read on the zone', () => {
    expect(Time.momentOf(new Date(2026, 9, 15, 13, 30), 'Europe/Madrid', '2026-10-15T09:00:00.000Z')).toBe(
      '2026-10-15T11:30:00.000Z',
    );
    expect(Time.momentOf(new Date(2026, 9, 15, 13, 30), 'UTC', '')).toBe('2026-10-15T13:30:00.000Z');
    expect(Time.momentOf(null, 'UTC', '2026-10-15T09:00:00.000Z')).toBe('');
  });
});

describe('Time.wallText', () => {
  test('writes a moment on the clock of a zone, from the moment itself', () => {
    expect(Time.wallText('2026-10-15T09:00:00.000Z', 'Europe/Madrid')).toBe('2026-10-15 11:00');
    // in the hour Madrid skips in spring, as UTC : a local Date in Madrid could not hold it
    expect(Time.wallText('2027-03-28T02:30:00.000Z', 'UTC')).toBe('2027-03-28 02:30');
    expect(Time.wallText('', 'UTC')).toBe('');
    expect(Time.wallText('nope', 'UTC')).toBe('');
  });
});
