/******************************************************************/
/*                                                                */
/*  A year, a month and a day picked from three dropdowns         */
/*  (AppDatePick) : the days a month has, the months' names in    */
/*  the page's language, and the period a pick is, as instants    */
/*  of the browser's own calendar (the Audit log's [from, to)) or */
/*  as the day a server log file is named after (YYYY-MM-DD).     */
/*                                                                */
/*  A pick is { year, month, day } : numbers, month 1 to 12, or   */
/*  null for "All" (a finer one is null when a coarser one is).   */
/*                                                                */
/******************************************************************/

/**
 * The days a month has : February 29 in a leap year (2024, 2000), 28 otherwise (2026, 1900).
 *
 * Args:
 *   year (number): the year.
 *   month (number): the month, 1 to 12.
 *
 * Returns:
 *   number: 28 to 31.
 */
export function daysInMonth(year, month) {
  // day 0 of the next month is the last day of this one
  return new Date(year, month, 0).getDate();
}

/**
 * A pick made whole : a day beyond its month's length becomes the month's last day (March 31,
 * then February : the 28th, or the 29th in a leap year), and a finer part goes with a coarser
 * one that is All (no month without a year, no day without a month).
 *
 * Args:
 *   pick (object): { year, month, day }, each a number or null.
 *
 * Returns:
 *   object: a new pick.
 */
export function clampPick(pick) {
  const year = pick?.year ?? null;
  const month = year === null ? null : (pick?.month ?? null);
  let day = month === null ? null : (pick?.day ?? null);
  if (day !== null) day = Math.min(Math.max(day, 1), daysInMonth(year, month));
  return { year, month, day };
}

/**
 * The months' names in a language, January first : Intl's long names (novembre, 11月).
 *
 * Args:
 *   locale (string): the language, en or ja for example.
 *
 * Returns:
 *   string[]: the 12 names.
 */
export function monthNames(locale) {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
  // the 15th, so no zone can move the date into another month
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2021, i, 15)));
}

/**
 * Today in the browser's calendar, as a pick.
 *
 * Args:
 *   now (Date): the moment, now by default.
 *
 * Returns:
 *   object: { year, month, day }.
 */
export function todayPick(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * Whether two picks are the same year, month and day.
 *
 * Args:
 *   a (object): a pick.
 *   b (object): another.
 *
 * Returns:
 *   boolean: true when they are.
 */
export function samePick(a, b) {
  return (
    (a?.year ?? null) === (b?.year ?? null) &&
    (a?.month ?? null) === (b?.month ?? null) &&
    (a?.day ?? null) === (b?.day ?? null)
  );
}

/**
 * A whole pick as the day a log file is named after.
 *
 * Args:
 *   pick (object): { year, month, day }, all three set.
 *
 * Returns:
 *   string: YYYY-MM-DD.
 */
export function isoDay(pick) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(pick.year).padStart(4, '0')}-${pad(pick.month)}-${pad(pick.day)}`;
}

/**
 * The period of a pick in the browser's calendar : a year, a month or a day from its first
 * moment to the first moment of the next one, as the instants the server filters on
 * ([from, to)), and its name for a file (2026, 2026-11, 2026-11-14). The local midnights are
 * what the person means by "14 November", whatever zone the server is in.
 *
 * Args:
 *   pick (object): { year, month, day }.
 *
 * Returns:
 *   object|null: { from, to, name }, the instants as ISO strings ; null for All years.
 */
export function periodOf(pick) {
  const p = clampPick(pick);
  if (p.year === null) return null;
  let start;
  let end;
  if (p.month === null) {
    start = new Date(p.year, 0, 1);
    end = new Date(p.year + 1, 0, 1);
  } else if (p.day === null) {
    start = new Date(p.year, p.month - 1, 1);
    end = new Date(p.year, p.month, 1);
  } else {
    start = new Date(p.year, p.month - 1, p.day);
    end = new Date(p.year, p.month - 1, p.day + 1);
  }
  // a year below 100 : Date's constructor reads it as 19xx, so set it again
  if (p.year < 100) {
    start.setFullYear(start.getFullYear() - 1900);
    end.setFullYear(end.getFullYear() - 1900);
  }
  const name = p.month === null ? String(p.year) : p.day === null ? isoDay({ ...p, day: 1 }).slice(0, 7) : isoDay(p);
  return { from: start.toISOString(), to: end.toISOString(), name };
}

/**
 * A pick in words, in a language : 2026, November 2026, 14 November 2026 (Intl's order and
 * names : 14 novembre 2026, 2026年11月14日).
 *
 * Args:
 *   pick (object): { year, month, day } ; year set.
 *   locale (string): the language.
 *
 * Returns:
 *   string: the words ; '' for All years.
 */
export function pickLabel(pick, locale) {
  const p = clampPick(pick);
  if (p.year === null) return '';
  const date = new Date(p.year, (p.month ?? 1) - 1, p.day ?? 1);
  if (p.year < 100) date.setFullYear(p.year);
  const options =
    p.month === null
      ? { year: 'numeric' }
      : p.day === null
        ? { year: 'numeric', month: 'long' }
        : { year: 'numeric', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * The years to offer, the newest first : from the oldest to the newest asked, each once.
 *
 * Args:
 *   years (number[]): the years known (from the log files' days, or the oldest audit entry's
 *     year with the current one).
 *
 * Returns:
 *   number[]: every year from the smallest to the largest, the largest first.
 */
export function yearRange(years) {
  const known = (years || []).filter((y) => Number.isInteger(y));
  if (!known.length) return [];
  const first = Math.min(...known);
  const last = Math.max(...known);
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}
