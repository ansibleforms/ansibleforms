// The cron validator must agree with croner, because croner is what actually runs the
// schedule. When they disagreed, the two directions failed differently:
//
//   - validator accepts / croner refuses -> the row SAVES and the job is never registered.
//     cron.service.js logs 'Invalid cron expression' and returns, so a repository just
//     stops syncing with nothing on any page to say so. The hand written regex this
//     replaced let exactly one shape through: an inverted range (`0 0 * * 5-1`).
//   - validator refuses / croner accepts -> the editor draws a description and next-run
//     badges for an expression the form then refuses to save. That was every month and
//     weekday NAME, which BsCron normalises on purpose so it can preview them.
//
// The first direction is the dangerous one and is asserted exhaustively over a generated
// corpus. The second is asserted for the shapes that are deliberately refused.
//
// It lives on the SERVER side because croner does, and because the server's own
// lib/cronValidate.js has to agree with it too - the client answer is the early,
// explanatory one and the server's is the authority. config/cron.js is deliberately pure
// (no vue, no vue-i18n), which is what makes importing it across the boundary possible.
import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import { cronError } from '../../client/src/config/cron.js';
import { cronError as serverCronError } from '../src/lib/cronValidate.js';

const croner = (e) => { try { new Cron(e, { paused: true }).stop(); return true; } catch { return false; } };
const ok = (e) => cronError(e) === null;

// Deliberately refused even though croner accepts them: BsCron cannot reproduce these, so
// previewing them would mean rendering a confident wrong answer. Refusing to SAVE them is
// what the old regex did too, so this is not a new restriction.
//
// The nth-weekday modifier ('1#2') is NOT in this list any more: BsCron both validates and
// describes it (see the '#' branches in fieldError and the dow describer), and croner runs
// it - only the regex refused it, which is the second half of the bug this replaced.
const DELIBERATELY_UNSUPPORTED = [
  '0 0 15W * *',        // nearest weekday
  '0 0 * * ?',          // '?' wildcard
  '@daily',             // nickname
  '0 0 0 * * * 2030',   // 7 fields (seconds + year)
];

// every token shape the fields take, including the inverted ranges that were the bug
const TOKENS = ['*', '0', '5', '59', '23', '31', '12', '7', 'L', '5L', '*/2', '*/15',
  '1-5', '9-17/2', '5-1', '23-1', '31-1', '12-1', '7-1', '0-0', '*/60', '1,2',
  '1-3,5', '15L', '1/5', '0-7', 'MON', 'JAN', 'mon-fri', 'jan-mar', '1#2', '1#9'];

describe('anything the validator accepts, croner must accept', () => {
  // the dangerous direction: we accept, croner refuses -> the row saves and the job is
  // never registered
  const dangerous = (expr) => ok(expr) && !croner(expr);

  it('agrees when each field is varied over every token shape', () => {
    const bad = [];
    for (let pos = 0; pos < 5; pos++) {
      for (const token of TOKENS) {
        const parts = ['*', '*', '*', '*', '*'];
        parts[pos] = token;
        const expr = parts.join(' ');
        if (dangerous(expr)) bad.push(expr);
      }
    }
    expect(bad).toEqual([]);
  });

  it('agrees across a deterministic sample of full combinations', () => {
    // a seeded LCG rather than Math.random, so a failure is reproducible
    let seed = 20260731;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const bad = [];
    let accepted = 0;
    const N = 200000;
    for (let i = 0; i < N; i++) {
      const expr = Array.from({ length: 5 }, () => TOKENS[Math.floor(next() * TOKENS.length)]).join(' ');
      if (ok(expr)) accepted++;
      if (dangerous(expr)) bad.push(expr);
    }
    // `dangerous` short-circuits on a rejected expression, so a validator that refused
    // EVERYTHING would pass this test without croner ever being consulted once. The
    // acceptance rate is low by construction - the token list is shared across all five
    // fields, so most tokens are out of range for most positions - but it must not be
    // zero. Measured at ~1600 of 200000; the floor is well under that so a legitimate
    // tightening does not fail the build, while a validator gone blind does.
    expect(accepted).toBeGreaterThan(500);
    expect(bad.slice(0, 10)).toEqual([]);
  }, 60000);

  it('the inverted range that used to slip through is refused', () => {
    for (const expr of ['0 0 * * 5-1', '23-1 * * * *', '0 0 31-1 * *', '0 0 * 12-1 *', '* 23-1 * * *']) {
      expect(croner(expr), `croner should refuse ${expr}`).toBe(false);
      expect(cronError(expr), `validator should refuse ${expr}`).not.toBeNull();
      expect(cronError(expr).key).toBe('invalidRange');
    }
  });
});

describe('what croner accepts, the validator accepts too', () => {
  it('month and weekday names, which the editor already previews', () => {
    for (const expr of ['0 8 * * MON', '0 8 * * mon-fri', '0 0 * JAN *', '0 0 * jan-mar *', '0 8 * * WED']) {
      expect(croner(expr), `croner should accept ${expr}`).toBe(true);
      expect(cronError(expr), `validator should accept ${expr}`).toBeNull();
    }
  });

  it('the ordinary shapes people actually write', () => {
    for (const expr of ['0 0 * * *', '*/5 * * * *', '0 8 * * 1-5', '0 08 * * *', '9-17/2 * * * *',
      '0 0 1 * *', '0 0 L * *', '0 0 * * 5L', '15,45 * * * *', '* * * * *', '30 2 * * *',
      '0 0 * * 0', '0 0 * * 7', '0 */2 * * *', '0 0 1-15/3 * *', '0 0 * * * ']) {
      expect(croner(expr), `croner should accept ${expr}`).toBe(true);
      expect(cronError(expr), `validator should accept ${expr}`).toBeNull();
    }
  });

  it("the last day of the month is 'L' on its own, never glued to a day ('5L', which croner 11.0.1 refuses)", () => {
    for (const expr of ['0 0 L * *', '0 0 1,L * *']) expect(cronError(expr), `${expr} should be accepted`).toBeNull();
    for (const expr of ['0 0 5L * *', '0 0 15L * *', '0 0 1,5L * *']) {
      expect(cronError(expr), `${expr} should be refused`).not.toBeNull();
    }
  });

  it('and refuses only what it means to refuse', () => {
    for (const expr of DELIBERATELY_UNSUPPORTED) {
      expect(cronError(expr), `${expr} should be refused`).not.toBeNull();
      expect(cronError(expr).key).toBe('unsupported');
    }
  });
});

describe('an empty expression is not an error', () => {
  it('because "no schedule" is legitimate; required is a separate rule', () => {
    for (const v of ['', '   ', null, undefined]) expect(cronError(v)).toBeNull();
    for (const v of ['', '   ', null, undefined]) expect(serverCronError(v)).toBeNull();
  });
});

describe('the server refuses what the client refuses', () => {
  // the client is the explanation, the server is the decision - an API caller that never
  // loads the page must not be able to store what the page would not let through
  it('rejects the inverted range', () => {
    for (const expr of ['0 0 * * 5-1', '23-1 * * * *', '0 0 31-1 * *']) {
      expect(serverCronError(expr), `server should refuse ${expr}`).not.toBeNull();
    }
  });

  it('accepts what croner accepts, names included', () => {
    for (const expr of ['0 0 * * *', '0 8 * * MON', '0 0 * JAN *', '*/5 * * * *', '0 0 L * *']) {
      expect(serverCronError(expr), `server should accept ${expr}`).toBeNull();
    }
  });

  it('rejects a pattern that compiles but can never occur again', () => {
    // croner parses '0 0 30 2 *' happily and then never fires it
    expect(new Cron('0 0 30 2 *', { paused: true }).nextRun()).toBeNull();
    expect(serverCronError('0 0 30 2 *')).not.toBeNull();
  });
});

