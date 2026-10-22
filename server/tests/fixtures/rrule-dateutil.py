# The rrules of tests/schedule-rrule-dateutil.test.mjs and their next runs as python-dateutil (the
# reference implementation of the iCal rrule) gives them : tests/fixtures/rrule-dateutil.json, so
# the test needs no Python. Seeded : the same file each time it is made with the same dateutil.
#
# The rules : every frequency but SECONDLY, intervals, BYMONTH, BYMONTHDAY, BYDAY, BYWEEKNO,
# BYYEARDAY, BYEASTER, BYHOUR, BYMINUTE, BYSECOND, BYSETPOS and WKST mixed at random, COUNT or
# UNTIL (naive or in UTC), an EXRULE now and then, DTSTARTs in zones with and without DST. Half of
# them are asked their runs a few hours before a DST change, their DTSTART at the hours it moves.
#
# Each run is the moment its wall clock time is in its zone, as lib/scheduleRrule.js documents it :
# a time the clock skips is moved forward by the jump, a time it shows twice is the first (Python's
# fold=0 does both). A naive UNTIL is read in the DTSTART's zone (dateutil wants it in UTC : it is
# written so). A rule dateutil walks for more than two seconds is left out.
#
# After the random rules come the rules of FIXED, each asked its runs after a moment of its own :
# cases a review found where the runs once differed from dateutil's. The random rules depend on how
# fast dateutil walks (the two seconds), so a fixed case can be added to the file without making it
# again : `tests/fixtures/rrule-dateutil.py --fixed` writes the fixed cases alone.
#
# To make the fixture again (from the server folder) :
#
#   python3 -m venv /tmp/rrule-venv && /tmp/rrule-venv/bin/pip install python-dateutil
#   /tmp/rrule-venv/bin/python tests/fixtures/rrule-dateutil.py > tests/fixtures/rrule-dateutil.json
import json
import random
import re
import signal
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import dateutil
from dateutil.rrule import rrulestr

# ===========================================================================
# SETTINGS
# ===========================================================================

# the seed, and how many rules of each half
SEED = 20261022
PER_HALF = 150

# the zones : UTC, and zones with DST of an hour, of half an hour (Lord Howe), in the south
ZONES = ["UTC", "Europe/Brussels", "America/New_York", "Australia/Sydney", "Australia/Lord_Howe", "America/Santiago", "Asia/Kolkata", "Pacific/Chatham", "Europe/London", "America/Sao_Paulo"]
FREQS = ["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY"]
DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

# how far back a DTSTART may be, by frequency (dateutil walks from it)
BACK_DAYS = {"YEARLY": 20 * 365, "MONTHLY": 10 * 365, "WEEKLY": 5 * 365, "DAILY": 3 * 365, "HOURLY": 200, "MINUTELY": 5}

# the first moment the runs are asked after
EPOCH = datetime(2026, 10, 22, tzinfo=timezone.utc)

# the rules always in the file, each with the moment its runs are asked after and how many
FIXED = [
    # a COUNT rule whose runs go on more than 50 years after its DTSTART
    ("DTSTART;TZID=Europe/Brussels:19750101T090000 RRULE:FREQ=YEARLY;INTERVAL=1;COUNT=100", "2026-10-22T07:00:00", 3),
    ("DTSTART;TZID=Europe/Brussels:19750101T090000 RRULE:FREQ=YEARLY;INTERVAL=1;COUNT=100", "2073-06-01T00:00:00", 3),
    ("DTSTART;TZID=Europe/Brussels:19760301T090000 RRULE:FREQ=MONTHLY;INTERVAL=1;COUNT=999", "2049-12-31T00:00:00", 3),
    ("DTSTART;TZID=America/New_York:19700105T060000 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=999", "2007-12-20T00:00:00", 3),
]


class TooSlow(Exception):
    """A rule dateutil walks for too long."""


def too_slow(*_):
    """Raises TooSlow : the alarm's handler.

    Raises:
        TooSlow: always.
    """
    raise TooSlow()


# ===========================================================================
# THE RULES
# ===========================================================================


def pick(rng, lo, hi, k, signed=False):
    """Up to k numbers from lo to hi, some negative when signed, as a BYxxx value.

    Args:
        rng (random.Random): the generator.
        lo (int): the smallest.
        hi (int): the largest.
        k (int): how many to draw.
        signed (bool): whether some are made negative.

    Returns:
        str: the numbers, sorted, apart by commas.
    """
    values = set()
    for _ in range(k):
        v = rng.randint(lo, hi)
        if signed and rng.random() < 0.3:
            v = -v
        values.add(v)
    return ",".join(str(v) for v in sorted(values))


def rule_parts(rng, freq):
    """The parts of a random rule of a frequency.

    Args:
        rng (random.Random): the generator.
        freq (str): the frequency.

    Returns:
        list: the parts (FREQ=...).
    """
    parts = [f"FREQ={freq}", f"INTERVAL={rng.choice([1, 1, 1, 2, 3, 5, 7, 15]) if freq != 'YEARLY' else rng.choice([1, 1, 2])}"]
    p = rng.random
    if p() < 0.3:
        parts.append("BYMONTH=" + pick(rng, 1, 12, rng.randint(1, 4)))
    if p() < 0.25:
        parts.append("BYMONTHDAY=" + pick(rng, 1, 31, rng.randint(1, 3), True))
    if p() < 0.35:
        parts.append("BYDAY=" + ",".join(sorted({rng.choice(DAYS) for _ in range(rng.randint(1, 4))}, key=DAYS.index)))
    if p() < (0.15 if freq == "YEARLY" else 0.05):
        parts.append("BYWEEKNO=" + pick(rng, 1, 53, 2, True))
    if p() < (0.1 if freq == "YEARLY" else 0.05):
        parts.append("BYYEARDAY=" + pick(rng, 1, 366, 2, True))
    if p() < 0.03:
        parts.append(f"BYEASTER={rng.randint(-3, 3)}")
    if p() < 0.35:
        parts.append("BYHOUR=" + pick(rng, 0, 23, rng.randint(1, 4)))
    if p() < 0.35:
        parts.append("BYMINUTE=" + pick(rng, 0, 59, rng.randint(1, 3)))
    if p() < 0.05:
        parts.append("BYSECOND=" + pick(rng, 0, 59, 2))
    if p() < 0.15:
        parts.append("BYSETPOS=" + pick(rng, 1, 3, 1, True))
    if p() < 0.1:
        parts.append("WKST=" + rng.choice(DAYS))
    return parts


def before_dst_change(now, zone):
    """A moment a few hours before the next DST change of a zone after now (now when it has none
    within the year).

    Args:
        now (datetime): the moment.
        zone (ZoneInfo): the zone.

    Returns:
        datetime: the moment, before the change.
    """
    t = now
    for _ in range(400 * 24):
        if (t + timedelta(hours=1)).astimezone(zone).utcoffset() != t.astimezone(zone).utcoffset():
            return t
        t += timedelta(hours=1)
    return now


def make_case(rng, near_dst):
    """A random rule, the moment its runs are asked after and how many.

    Args:
        rng (random.Random): the generator.
        near_dst (bool): asked a few hours before a DST change, its DTSTART at the hours it moves.

    Returns:
        tuple: (rrule text, zone name, after (datetime), count).
    """
    zone_name = rng.choice(ZONES[1:] if near_dst else ZONES)
    zone = ZoneInfo(zone_name)
    freq = rng.choice(FREQS)
    now = EPOCH + timedelta(seconds=rng.randint(0, 3 * 365 * 86400))
    if near_dst:
        now = before_dst_change(now, zone) - timedelta(minutes=rng.randint(0, 6 * 60))
    back = BACK_DAYS[freq]
    start = (now.astimezone(zone).replace(tzinfo=None) - timedelta(days=rng.uniform(0, back))).replace(microsecond=0)
    if rng.random() < 0.5:
        start = start.replace(second=0)
    if rng.random() < 0.3:
        start = start.replace(minute=rng.choice([0, 30]))
    if rng.random() < (0.6 if near_dst else 0.2):
        start = start.replace(hour=rng.choice([0, 1, 2, 3]), minute=rng.choice([0, 15, 30, 45]))
    if zone_name == "UTC" and rng.random() < 0.5:
        dtstart = "DTSTART:" + start.strftime("%Y%m%dT%H%M%S") + "Z"
    else:
        dtstart = f"DTSTART;TZID={zone_name}:" + start.strftime("%Y%m%dT%H%M%S")
    parts = rule_parts(rng, freq)
    r = rng.random()
    if r < 0.15:
        parts.append(f"COUNT={rng.randint(1, 300)}")
    elif r < 0.3:
        until = start + timedelta(days=rng.uniform(0, back * 1.5 + 30))
        parts.append("UNTIL=" + until.strftime("%Y%m%dT%H%M%S") + ("Z" if rng.random() < 0.5 else ""))
    text = dtstart + " RRULE:" + ";".join(parts)
    if rng.random() < 0.15:
        text += " EXRULE:" + ";".join(rule_parts(rng, rng.choice(FREQS)))
    return text, zone_name, now, rng.choice([1, 3, 10])


# ===========================================================================
# THEIR RUNS
# ===========================================================================


def reference_runs(text, zone_name, now, count):
    """The next runs of a rule after a moment, as dateutil gives them, as moments.

    Args:
        text (str): the rrule.
        zone_name (str): its zone.
        now (datetime): the moment.
        count (int): how many.

    Returns:
        list: the runs, ms since the epoch, in order.

    Raises:
        TooSlow: dateutil took too long.
        ValueError: dateutil refuses the rule.
    """
    zone = ZoneInfo(zone_name)
    # a naive UNTIL, read in the DTSTART's zone, given to dateutil in UTC
    m = re.search(r"UNTIL=(\d{8}T\d{6})(;|$| )", text)
    if m:
        until = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=zone).astimezone(timezone.utc)
        text = text.replace("UNTIL=" + m.group(1), "UNTIL=" + until.strftime("%Y%m%dT%H%M%S") + "Z")
    try:
        rules = rrulestr(text.replace(" ", "\n"), forceset=True)
    except ValueError as e:
        # an EXRULE that never fires takes nothing out
        if "empty set" not in str(e) or "EXRULE" not in text:
            raise
        rules = rrulestr(text.split(" EXRULE")[0].replace(" ", "\n"), forceset=True)
    floating_now = now.astimezone(zone).replace(tzinfo=None)
    # a little before : a skipped time moved forward may come after the moment
    lo = floating_now - timedelta(hours=4)
    horizon = floating_now + timedelta(days=50 * 366)
    runs = []
    enough_at = None
    for occurrence in rules:
        floating = occurrence.replace(tzinfo=None)
        if floating <= lo:
            continue
        if floating > horizon:
            break
        moment = floating.replace(tzinfo=zone).timestamp()
        if moment <= now.timestamp():
            continue
        runs.append(moment)
        if len(runs) >= count and enough_at is None:
            enough_at = floating
        # a little further still, for a skipped time moved forward past a later run
        if enough_at and floating > enough_at + timedelta(hours=3):
            break
    return [int(round(t * 1000)) for t in sorted(set(runs))[:count]]


def fixed_cases():
    """The cases of FIXED, their runs as dateutil gives them.

    Returns:
        list: the cases ({rrule, after, count, runs}).
    """
    cases = []
    for text, after, count in FIXED:
        zone_name = re.search(r"TZID=([^:]+):", text).group(1) if "TZID=" in text else "UTC"
        now = datetime.fromisoformat(after).replace(tzinfo=timezone.utc)
        runs = reference_runs(text, zone_name, now, count)
        cases.append({"rrule": text, "after": int(now.timestamp() * 1000), "count": count, "runs": runs})
    return cases


def main():
    """Writes the fixture : the cases, as JSON, to the standard output (the fixed cases alone
    with --fixed)."""
    if "--fixed" in sys.argv[1:]:
        json.dump(fixed_cases(), sys.stdout, indent=1)
        sys.stdout.write("\n")
        return
    rng = random.Random(SEED)
    signal.signal(signal.SIGALRM, too_slow)
    cases = []
    for near_dst in (False, True):
        made = 0
        while made < PER_HALF:
            text, zone_name, now, count = make_case(rng, near_dst)
            try:
                signal.alarm(2)
                runs = reference_runs(text, zone_name, now, count)
            except TooSlow:
                continue
            except ValueError as e:
                # a rule whose BYxxx never meet : no run
                if "empty set" not in str(e):
                    continue
                runs = []
            finally:
                signal.alarm(0)
            cases.append({"rrule": text, "after": int(now.timestamp() * 1000), "count": count, "runs": runs})
            made += 1
    cases += fixed_cases()
    json.dump({"dateutil": dateutil.__version__, "seed": SEED, "cases": cases}, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
