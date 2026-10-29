// The rrule editor's early answer (client/src/lib/rruleRules.js) and the server's check
// (lib/scheduleRrule.js validateRrule) apply the same rules : each rrule below gets the same
// verdict, with the same reason, from both - whatever the case of the keys or the sign of a
// number. Only what the client cannot say on the text (a rule that never fires) is the server's.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { validateRrule } from "../src/lib/scheduleRrule.js";
import { rruleProblem } from "../../client/src/lib/rruleRules.js";

// the zones the browser knows : Intl's, as the client checks them
const validZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const D = "DTSTART:20300308T050000Z";
const RRULES = [
  // taken
  `DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1`,
  `${D} RRULE:freq=daily;interval=2`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=+2`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;count=5`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;until=20310101T000000Z`,
  `${D} RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE`,
  // the text
  "DTSTART:NONSENSE",
  "DTSTART:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1",
  "DTSTART:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1 ",
  `${D} DTSTART:20310308T050000Z RRULE:FREQ=DAILY;INTERVAL=1`,
  D,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 EXDATE:20300401T000000Z`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 exdate:20300401T000000Z`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 rdate:20300401T000000Z`,
  `${D} RRULE:FREQ=DAILY`,
  // INTERVAL of 1 or more
  `${D} RRULE:FREQ=DAILY;INTERVAL=0`,
  `${D} RRULE:FREQ=DAILY;interval=0`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=-1`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1.5`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=abc`,
  // COUNT between 1 and 999, not with UNTIL
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2000`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;count=5000`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;COUNT=0`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;COUNT=-3`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5;UNTIL=20310101T000000Z`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;count=5;until=20310101T000000Z`,
  // SECONDLY
  `${D} RRULE:FREQ=SECONDLY;INTERVAL=5`,
  `${D} RRULE:freq=secondly;interval=5`,
  // BYDAY with a number, a weekday that is not one
  `${D} RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=5MO`,
  `${D} RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=+1MO`,
  `${D} RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR`,
  `${D} RRULE:FREQ=MONTHLY;INTERVAL=1;byday=1mo`,
  `${D} RRULE:FREQ=WEEKLY;INTERVAL=1;byday=mo`,
  // what reading it says
  `${D} RRULE:FREQ=REGULARLY;INTERVAL=1`,
  `${D} RRULE:INTERVAL=1`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;FOO=1`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310101`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 NONSENSE`,
  "DTSTART;TZID=America/New_York:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1",
  "DTSTART;TZID=Not/AZone:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1",
  // an IANA zone or a fixed offset UTC+5 / GMT-3 (capitals, UTC-12 to UTC+14) : not luxon's names
  // for the server's zone
  ...["local", "system", "default", "UTC+5", "GMT-3", "UTC+05", "UTC+14", "UTC-12", "UTC+15", "UTC-13", "utc+5", "GMT", "Etc/GMT+5"].map(
    (zone) => `DTSTART;TZID=${zone}:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1`,
  ),
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 EXRULE:FREQ=WEEKLY;INTERVAL=-2`,
  // a DTSTART or an UNTIL that is no day and time there are
  "DTSTART:20300230T050000Z RRULE:FREQ=DAILY;INTERVAL=1",
  "DTSTART;TZID=Europe/Brussels:20301301T050000 RRULE:FREQ=DAILY;INTERVAL=1",
  "DTSTART;TZID=Europe/Brussels:20300308T250000 RRULE:FREQ=DAILY;INTERVAL=1",
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310230T000000`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20311340T000000Z`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310101T250000`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310230T000000;BYHOUR=24`,
  // a part given twice, whichever comes first (BYDAY and BYWEEKDAY are one part)
  `${D} RRULE:FREQ=FOO;INTERVAL=1;FREQ=DAILY`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;FREQ=FOO`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;interval=2`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;BYDAY=MO;BYDAY=1MO`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;BYWEEKDAY=MO;BYDAY=XX`,
  `${D} RRULE:BYSETPOS=0;INTERVAL=2;until=20310101T000000;UNTIL=20310101`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYDAY=TU`,
  // each BYxxx number in its range, a WKST that is a weekday
  ...[
    "BYSETPOS=0",
    "BYSETPOS=1",
    "BYSETPOS=-1",
    // the last position there is, in a month that has that many runs
    `BYSETPOS=366;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${[...Array(24).keys()].join(",")}`,
    "BYSETPOS=367",
    "BYSETPOS=-367",
    "bysetpos=0",
    "BYMONTHDAY=0",
    "BYMONTHDAY=32",
    "BYMONTHDAY=-31",
    "BYMONTHDAY=-32",
    "BYMONTHDAY=1,,2",
    "BYHOUR=24",
    "BYHOUR=-1",
    "BYHOUR=+5",
    "BYHOUR=",
    "BYHOUR=a",
    "BYHOUR=1.5",
    "BYMINUTE=60",
    "BYSECOND=60",
    "BYMONTH=0",
    "BYMONTH=13",
    "BYWEEKNO=0",
    "BYWEEKNO=53",
    "BYWEEKNO=54",
    "BYYEARDAY=0",
    "BYYEARDAY=-366",
    "BYYEARDAY=367",
    "BYEASTER=0",
    "BYEASTER=abc",
    "BYEASTER=-80",
    "BYEASTER=-81",
    "BYEASTER=250",
    "BYEASTER=251",
    "BYEASTER=-229",
    "WKST=SU",
    "WKST=su",
    "WKST=XX",
    "BYDAY=",
    "BYDAY=MO,,TU",
    "BYSETPOS=1;BYDAY=MO",
    "BYHOUR=24;FOO=1",
    "FOO=1;BYHOUR=24",
    "BYMONTHDAY=2;BYMONTHDAY=0",
  ].map((part) => `${D} RRULE:FREQ=MONTHLY;INTERVAL=1;${part}`),
  `${D} RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20310101;BYHOUR=24`,
  `${D} RRULE:FREQ=REGULARLY;INTERVAL=1;BYHOUR=24`,
  `${D} RRULE:BYHOUR=24;INTERVAL=1`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=0;BYHOUR=24`,
  `${D} RRULE:FREQ=DAILY;INTERVAL=1 EXRULE:FREQ=WEEKLY;INTERVAL=1;BYSETPOS=0`,
  `DTSTART;TZID=Europe/Brussels:20261024T000000 RRULE:FREQ=MINUTELY;INTERVAL=5;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16,17`,
];

describe("the client and the server refuse the same rrules, saying the same", () => {
  for (const rrule of RRULES) {
    test(rrule, () => {
      assert.equal(rruleProblem(rrule, validZone), validateRrule(rrule)[0] ?? "");
    });
  }
});
