// Dates and times in the time zone the user picked (Profile > Preferences).
//
// Every server timestamp arrives as an ISO string with its zone - 'Z' for the database
// columns, an explicit offset for the dates the server already put in LOG_TZ (backups) -
// so it can be converted to any zone without guessing. The preference is 'UTC' (the
// default, how the jobs page always showed its times), 'browser' (this browser's own zone)
// or an IANA zone name ('Europe/Madrid').
//
// The date part follows the date format picked (Profile > Preferences, else Settings >
// Appearance > Defaults) : 2026-10-11, 11/10/2026, 10/11/2026 or 11.10.2026.
//
// A time is shown with its zone's short name after it (2026-10-12 09:00:00 CEST), so a date
// on any page says which clock it is on. A date alone (a pattern without hours) has none.
//
// format() only ever returns a formatted date string or '' : never its input. BsDataTable
// renders a column's render() result as HTML, so a formatter that echoed a value back would
// be an injection sink there.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { useAppStore } from '@/stores/app';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BROWSER = 'browser';
const STORAGE_KEY = 'af_timezone';
const DEFAULT_FORMAT = 'YYYY-MM-DD HH:mm:ss';
const DATE_STORAGE_KEY = 'af_date_format';
const ISO_DATE = 'YYYY-MM-DD';
// the date formats offered (the server keeps the same, models/settings.model.js) : digits and
// separators only, so a formatted date never carries markup
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'];
// The locales asked for a zone's short name, in order : each knows the names of its own
// region only (en-US says EDT but GMT+2 for Madrid, en-GB says CEST, en-IN IST, en-AU AEDT).
// The first real name wins ; a zone none of them names (Tokyo, Sao Paulo) keeps its offset.
const ZONE_NAME_LOCALES = ['en-US', 'en-GB', 'en-IN', 'en-AU'];
const zoneNames = new Map();

const Time = {
  // this browser's own zone, e.g. Europe/Madrid
  browserZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  },
  // the preference as stored : 'UTC', 'browser' or a zone name. From the store, so a change
  // re-renders the pages ; without an active store (unit tests, code that runs before the
  // app is mounted) from the browser storage, and else UTC
  preference() {
    try {
      return useAppStore().timezone || 'UTC';
    } catch {
      try {
        return localStorage.getItem(STORAGE_KEY) || 'UTC';
      } catch {
        return 'UTC';
      }
    }
  },
  // the zone the preference stands for
  zone() {
    const pref = Time.preference();
    return pref === BROWSER ? Time.browserZone() : pref;
  },
  // the date format picked : the store's (the profile's, else the app's default), else ISO
  datePattern() {
    let pattern;
    try {
      pattern = useAppStore().dateFormat;
    } catch {
      try {
        pattern = localStorage.getItem(DATE_STORAGE_KEY);
      } catch {
        pattern = null;
      }
    }
    return DATE_FORMATS.includes(pattern) ? pattern : ISO_DATE;
  },
  // whether this browser chose its date format (the profile) : else the app's default applies
  hasOwnDateFormat() {
    try {
      return DATE_FORMATS.includes(localStorage.getItem(DATE_STORAGE_KEY));
    } catch {
      return false;
    }
  },
  setDateFormat(value) {
    const pattern = DATE_FORMATS.includes(value) ? value : ISO_DATE;
    try {
      useAppStore().dateFormat = pattern;
    } catch {
      // no active store : the stored value below is read instead
    }
    try {
      localStorage.setItem(DATE_STORAGE_KEY, pattern);
    } catch {
      // storage unavailable : the choice holds for this visit
    }
  },
  /**
   * A wall clock written without a zone (2026-07-26 00:21:46), its date in the picked format.
   *
   * Args:
   *   date (string): YYYY-MM-DD.
   *   time (string): HH:mm:ss.
   *
   * Returns:
   *   string: the date and time, or '' when the date is not one.
   */
  wallClock(date, time) {
    const d = dayjs(date);
    return d.isValid() ? `${d.format(Time.datePattern())} ${time}` : '';
  },
  // whether this browser chose its zone (the profile) : else the app's default applies
  hasOwnPreference() {
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  },
  setPreference(value) {
    try {
      useAppStore().timezone = value;
    } catch {
      // no active store : the stored value below is read instead
    }
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // storage unavailable : the choice holds for this visit
    }
  },
  // every zone this browser knows, for the picker
  zones() {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  },
  /**
   * The short name of a zone at a moment : CEST, BST, IST, EDT, UTC, or GMT+9 for a zone no
   * locale names. The moment matters : summer and winter have different names.
   *
   * Args:
   *   date (Date): the moment.
   *   zone (string): an IANA zone name.
   *
   * Returns:
   *   string: the short name, or '' when the zone is unknown.
   */
  zoneName(date, zone) {
    if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
    // the offset at that moment, so a zone is asked once per season, not once per date
    const key = `${zone}|${dayjs(date).tz(zone).utcOffset()}`;
    if (zoneNames.has(key)) return zoneNames.get(key);
    let name = '';
    for (const locale of ZONE_NAME_LOCALES) {
      try {
        const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
          .formatToParts(date)
          .find((p) => p.type === 'timeZoneName');
        if (!part) continue;
        if (!name) name = part.value;
        if (!/^GMT[+-]/.test(part.value)) {
          name = part.value;
          break;
        }
      } catch {
        // an unknown zone : no name
        break;
      }
    }
    zoneNames.set(key, name);
    return name;
  },
  /**
   * A zone as a field names it : its short name, then its name (CEST (Europe/Madrid)). A zone
   * whose short name is its name (UTC) or that has none is named once.
   *
   * Args:
   *   date (Date): the moment, as summer and winter names differ.
   *   zone (string): an IANA zone name.
   *
   * Returns:
   *   string: the label.
   */
  zoneLabel(date, zone) {
    const name = Time.zoneName(date, zone);
    return !name || name === zone ? zone : `${name} (${zone})`;
  },
  /**
   * A moment as the wall clock of a zone, held in a local Date : the date picker works on the
   * browser's local Date, so 09:00 UTC picked on the UTC clock is a Date whose local hours are 9.
   *
   * Args:
   *   value (string|Date|number): the moment, an ISO string with its zone, a Date or epoch ms.
   *   zone (string): an IANA zone name.
   *
   * Returns:
   *   Date|null: the wall clock, or null when the value is not a date.
   */
  toWallClock(value, zone) {
    const d = dayjs(value);
    if (!d.isValid()) return null;
    const w = d.tz(zone);
    return new Date(w.year(), w.month(), w.date(), w.hour(), w.minute(), w.second(), w.millisecond());
  },
  /**
   * The moment a wall clock stands for in a zone : the reverse of toWallClock. The hour the
   * clocks go back comes twice and is read as the first (02:30 CEST, not CET); a wall clock in
   * the spring gap is read on the offset before it. dayjs.tz would guess both from the offset
   * of today, so the same wall clock gave another moment in summer than in winter.
   *
   * Args:
   *   wall (Date): the wall clock, in the Date's local fields.
   *   zone (string): an IANA zone name.
   *
   * Returns:
   *   string: the moment as a UTC ISO string, or '' when the wall clock is not a date.
   */
  fromWallClock(wall, zone) {
    if (!(wall instanceof Date) || isNaN(wall.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    const text =
      `${wall.getFullYear()}-${p(wall.getMonth() + 1)}-${p(wall.getDate())}` +
      `T${p(wall.getHours())}:${p(wall.getMinutes())}:${p(wall.getSeconds())}`;
    const local = dayjs.utc(text).valueOf() + wall.getMilliseconds();
    // the offsets of the zone half a day either side : every wall clock is on one of the two
    const before = dayjs(local - 12 * 3600000)
      .tz(zone)
      .utcOffset();
    const after = dayjs(local + 12 * 3600000)
      .tz(zone)
      .utcOffset();
    const moments = [...new Set([before, after])]
      .map((offset) => local - offset * 60000)
      .filter((ts) => Time.toWallClock(ts, zone).getTime() === wall.getTime())
      .sort((a, b) => a - b);
    return new Date(moments.length ? moments[0] : local - before * 60000).toISOString();
  },
  /**
   * A moment on the clock of a zone, as the date and time picker writes it (2026-10-15 11:00).
   *
   * Args:
   *   value (string|Date|number): the moment.
   *   zone (string): an IANA zone name.
   *
   * Returns:
   *   string: the wall clock, or '' when the value is not a date.
   */
  wallText(value, zone) {
    if (value === null || value === undefined || value === '') return '';
    const d = dayjs(value);
    return d.isValid() ? d.tz(zone).format('YYYY-MM-DD HH:mm') : '';
  },
  /**
   * The moment a wall clock picked on a zone stands for, keeping the current one when the wall
   * clock is still its own. A wall clock does not always say which moment it was : the hour the
   * clocks go back comes twice (02:30 CET or CEST), and a wall clock in the browser's spring
   * gap moves an hour on in a local Date. Read back, either would shift a moment nobody touched.
   *
   * Args:
   *   wall (Date): the wall clock, in the Date's local fields.
   *   zone (string): an IANA zone name.
   *   current (string): the moment held now, a UTC ISO string, or nothing.
   *
   * Returns:
   *   string: the moment as a UTC ISO string, or '' when the wall clock is not a date.
   */
  momentOf(wall, zone, current) {
    if (!(wall instanceof Date) || isNaN(wall.getTime())) return '';
    if (current && Time.toWallClock(current, zone)?.getTime() === wall.getTime()) return current;
    return Time.fromWallClock(wall, zone);
  },
  /**
   * A server timestamp in the user's zone, with the zone's short name after a time.
   *
   * Args:
   *   value (string|Date|number): an ISO string with its zone, a Date or epoch ms.
   *   pattern (string): the dayjs pattern ; one with hours gets the zone's name.
   *
   * Returns:
   *   string: the formatted date, or '' (never the input).
   */
  format(value, pattern = DEFAULT_FORMAT) {
    if (value === null || value === undefined || value === '') return '';
    const d = dayjs(value);
    if (!d.isValid()) return '';
    // the date part in the picked format
    pattern = pattern.replace(ISO_DATE, Time.datePattern());
    const withZone = /[Hh]/.test(pattern);
    try {
      const zone = Time.zone();
      const text = d.tz(zone).format(pattern);
      const name = withZone ? Time.zoneName(d.toDate(), zone) : '';
      return name ? `${text} ${name}` : text;
    } catch {
      // an unknown zone name (hand-edited storage) : fall back to UTC rather than nothing
      return d.utc().format(pattern) + (withZone ? ' UTC' : '');
    }
  },
};

export default Time;
