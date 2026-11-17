'use strict';
// When the config seed is read again (the system task configSeedReload, lib/systemTasks.js) : a
// cron since 7.8.0, CONFIG_SEED_RELOAD_CRON, changed on the task's page as the nightly tasks'.
//
// Before 7.8 it was a number of seconds, CONFIG_SEED_RELOAD_SECONDS. That variable is deprecated,
// removed in 8.0.0 : still read when it is set (in the environment or the settings file) and
// CONFIG_SEED_RELOAD_CRON is not, as the cron below, and said once at start.
//
//   seconds                                   cron
//   0 or less                                 none : the reload is off, as before (startup only)
//   1                                         * * * * * *      (every second, 6 fields)
//   2 3 4 5 6 10 12 15 20 30                  */N * * * * *    (every N seconds, 6 fields)
//   60                                        * * * * *        (every minute)
//   120 to 3540, a multiple of 60             */M * * * *      (M = seconds / 60)
//   3600                                      0 * * * *        (every hour)
//   7200 to 86400, H hours dividing 24        0 */H * * *      (0 0 * * * for 24 hours)
//   any other number                          the nearest of the above, said in the log
//   not a number                              * * * * *        (the default), said in the log

// the old variable and the new one
export const SEED_RELOAD_CRON_ENV = 'CONFIG_SEED_RELOAD_CRON';
export const SEED_RELOAD_SECONDS_ENV = 'CONFIG_SEED_RELOAD_SECONDS';
// the new one's default : every minute, what the old one's 60 seconds were
export const SEED_RELOAD_DEFAULT_CRON = '* * * * *';

// the seconds under a minute a seconds cron repeats evenly (they divide 60)
const SECOND_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
// the hours a cron repeats evenly over a day (they divide 24)
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

/**
 * The step of a list nearest to a value ; the smaller on a tie, so the reload never runs less
 * often than it was asked to by more than the tie itself.
 *
 * Args:
 *   steps (number[]): the steps, ascending.
 *   value (number): the value.
 *
 * Returns:
 *   number: the nearest step.
 */
function nearest(steps, value) {
  return steps.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), steps[0]);
}

/**
 * The cron of a number of minutes from 1 to 60 : every minute for one, every hour for 60, a step
 * of the minutes field else.
 *
 * Args:
 *   minutes (number): the minutes, 1 to 60.
 *
 * Returns:
 *   string: the 5-field cron.
 */
function minutesCron(minutes) {
  if (minutes === 1) return '* * * * *';
  if (minutes === 60) return '0 * * * *';
  return `*/${minutes} * * * *`;
}

/**
 * The cron of a number of hours dividing 24 : a step of the hours field, or midnight for a day.
 *
 * Args:
 *   hours (number): one of HOUR_STEPS.
 *
 * Returns:
 *   string: the 5-field cron.
 */
function hoursCron(hours) {
  if (hours === 1) return '0 * * * *';
  if (hours === 24) return '0 0 * * *';
  return `0 */${hours} * * *`;
}

/**
 * The cron a value of CONFIG_SEED_RELOAD_SECONDS reads as (the table above).
 *
 * Args:
 *   value (string|number): the variable's value.
 *
 * Returns:
 *   object: { cron, off, exact } : the cron (null when off), whether the value turns the reload
 *     off (0 or less), and whether the cron runs at the very same moments (false : the nearest
 *     one, which the log says).
 */
export function secondsToCron(value) {
  const text = String(value ?? '').trim();
  const seconds = /^-?\d+$/.test(text) ? parseInt(text, 10) : NaN;
  // step 1 : not a number : the default ; 0 or less : off, as 0 always was
  if (Number.isNaN(seconds)) return { cron: SEED_RELOAD_DEFAULT_CRON, off: false, exact: false };
  if (seconds <= 0) return { cron: null, off: true, exact: true };
  // step 2 : under a minute : a seconds cron, at the nearest step dividing 60 (or a minute)
  if (seconds < 60) {
    const step = nearest([...SECOND_STEPS, 60], seconds);
    const cron = step === 60 ? minutesCron(1) : step === 1 ? '* * * * * *' : `*/${step} * * * * *`;
    return { cron, off: false, exact: step === seconds };
  }
  // step 3 : up to an hour : whole minutes, the nearest when it is not a multiple of 60 (the
  // smaller on a tie : 90 seconds is every minute)
  if (seconds <= 3600) {
    const minutes = Math.min(60, Math.max(1, Math.ceil(seconds / 60 - 0.5)));
    return { cron: minutesCron(minutes), off: false, exact: minutes * 60 === seconds };
  }
  // step 4 : over an hour : whole hours dividing a day, a day at most
  const hours = nearest(HOUR_STEPS, seconds / 3600);
  return { cron: hoursCron(hours), off: false, exact: hours * 3600 === seconds };
}

/**
 * Whether a variable is set : present and not blank.
 *
 * Args:
 *   env (object): the environment.
 *   name (string): the variable.
 *
 * Returns:
 *   boolean: true when it is set.
 */
const isSet = (env, name) => env[name] !== undefined && String(env[name]).trim() !== '';

/**
 * The deprecated CONFIG_SEED_RELOAD_SECONDS when it is in force : set, and CONFIG_SEED_RELOAD_CRON
 * not set (which always wins).
 *
 * Args:
 *   env (object): the environment, process.env by default (the settings file is in it : load-env.js).
 *
 * Returns:
 *   object|null: { env, value, cron, off, exact } (secondsToCron), or null when it is not in force.
 */
export function deprecatedSeedReload(env = process.env) {
  if (isSet(env, SEED_RELOAD_CRON_ENV) || !isSet(env, SEED_RELOAD_SECONDS_ENV)) return null;
  const value = String(env[SEED_RELOAD_SECONDS_ENV]).trim();
  return { env: SEED_RELOAD_SECONDS_ENV, value, ...secondsToCron(value) };
}

/**
 * What a deprecated value reads as, in words for the log : the cron it runs on (the nearest one
 * when no cron runs at the same moments), or that it turns the reload off.
 *
 * Args:
 *   deprecated (object): deprecatedSeedReload's answer.
 *
 * Returns:
 *   string: the sentence.
 */
export function deprecatedSeedReloadReading(deprecated) {
  const name = `${deprecated.env}=${deprecated.value}`;
  if (deprecated.off) return `${name} turns the config seed reload off`;
  if (deprecated.exact) return `${name} is read as ${SEED_RELOAD_CRON_ENV}=${deprecated.cron}`;
  return `${name} has no cron of the same timing, it is read as the nearest one, ${SEED_RELOAD_CRON_ENV}=${deprecated.cron}`;
}

/**
 * The warnings for CONFIG_SEED_RELOAD_SECONDS still set, logged once at start (app-start.js) : that
 * it is deprecated, and what it is read as, or that CONFIG_SEED_RELOAD_CRON is set too and wins.
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string[]: none when it is not set, else one.
 */
export function seedReloadWarnings(env = process.env) {
  if (!isSet(env, SEED_RELOAD_SECONDS_ENV)) return [];
  const head = `${SEED_RELOAD_SECONDS_ENV} is deprecated, use ${SEED_RELOAD_CRON_ENV} (removed in 8.0)`;
  const deprecated = deprecatedSeedReload(env);
  if (!deprecated) return [`${head} : ${SEED_RELOAD_CRON_ENV} is set too and wins, ${SEED_RELOAD_SECONDS_ENV} is ignored`];
  return [`${head} : ${deprecatedSeedReloadReading(deprecated)}`];
}

export default {
  SEED_RELOAD_CRON_ENV,
  SEED_RELOAD_SECONDS_ENV,
  SEED_RELOAD_DEFAULT_CRON,
  secondsToCron,
  deprecatedSeedReload,
  deprecatedSeedReloadReading,
  seedReloadWarnings,
};
