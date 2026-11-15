/******************************************************************/
/*                                                                */
/*  The failed hosts of a playbook job, and the limit a re-run on */
/*  them runs with (POST /api/v2/job/:id/relaunch with            */
/*  failedHostsOnly). Read from the job's structured events       */
/*  (job_events, since 7.3.0), else from the PLAY RECAP lines of  */
/*  its output (a job from before the events).                    */
/*                                                                */
/*  The limit of a re-run never goes to ansible-playbook as a     */
/*  comma string : the RTE writes the hosts to a private file,    */
/*  one per line, and passes it as `--limit @file`. A line of     */
/*  that file is never split on a comma or a colon, so a host     */
/*  name holding one cannot become two patterns. A name ansible   */
/*  would still read as a pattern (a wildcard, a regex, a         */
/*  subscript, an operator) is left out of the re-run.            */
/*                                                                */
/******************************************************************/

// ---------------------------------------------------------------------------------------------
// The failed hosts of a job
// ---------------------------------------------------------------------------------------------

// ansible's colours in the stored output (the RTE keeps them, the job page renders them)
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// a recap line : `web07   : ok=3 changed=1 unreachable=0 failed=1 skipped=0 rescued=0 ignored=0`.
// Its counts as one run of `name=number` pairs, each after a blank : no nested quantifier, so a
// crafted line cannot make it backtrack (CodeQL js/redos)
const RECAP_LINE = /^\s*(\S.*?)\s+:\s+(\w+=\d+(?:\s+\w+=\d+)*)\s*$/;

/**
 * A line of output as text : its colour codes and its HTML tags (the output is stored as HTML)
 * gone, stripped again until none is left, so a tag hidden in another (`<scr<b>ipt>`) cannot
 * survive one pass ; a lone angle bracket left is dropped too.
 *
 * Args:
 *   raw (string): the line.
 *
 * Returns:
 *   string: its text.
 */
function plainLine(raw) {
  let line = String(raw).replace(ANSI, "");
  let before;
  do {
    before = line;
    line = line.replace(/<[^<>]*>/g, "");
  } while (line !== before);
  return line.replace(/[<>]/g, "");
}

/**
 * The hosts with failed tasks or that could not be reached, from a job's structured events. The
 * recap (the `stats` event, as ansible counts them) decides when the job has one : a failure
 * that `ignore_errors` let pass, or that a `rescue` handled, is not counted there. Without a
 * recap (a playbook stopped before its end) the `failed` and `unreachable` results count, minus
 * the failures the next event says were ignored.
 *
 * Args:
 *   events (object[]): the job's events, in order : [{ order, type, host, data }] as
 *     JobEvent.findByJob gives them (data parsed).
 *
 * Returns:
 *   string[]: the host names, sorted, each once ; [] when none failed.
 */
export function hostsFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  // step 1 : the last recap, when the playbook got that far
  const stats = [...list].reverse().find((e) => e?.type === "stats" && e.data && typeof e.data === "object");
  if (stats) {
    const failed = [];
    for (const [host, counts] of Object.entries(stats.data)) {
      // the keys the event's summary adds beside the hosts (lib jobEvent.model.js create)
      if (!counts || typeof counts !== "object") continue;
      if (Number(counts.failures) > 0 || Number(counts.unreachable) > 0) failed.push(host);
    }
    return [...new Set(failed)].sort();
  }
  // step 2 : no recap, the host results themselves ; a failure followed by its `ignored` event
  // (the same host, the next event) did not fail the host
  const failed = new Set();
  list.forEach((e, i) => {
    if (!e?.host) return;
    if (e.type === "unreachable") failed.add(e.host);
    if (e.type === "failed") {
      const next = list[i + 1];
      if (next?.type === "ignored" && next.host === e.host) return;
      failed.add(e.host);
    }
  });
  return [...failed].sort();
}

/**
 * The hosts with failed tasks or that could not be reached, from the PLAY RECAP lines of a job's
 * output : a job from before the structured events (7.3.0), or one whose events were not kept.
 * Every recap of the output counts (a playbook importing others prints one each run).
 *
 * Args:
 *   text (string): the job's output, or the part of it from its first PLAY RECAP on.
 *
 * Returns:
 *   string[]: the host names, sorted, each once ; [] when none failed or there is no recap.
 */
export function hostsFromRecap(text) {
  const failed = new Set();
  let inRecap = false;
  for (const raw of String(text || "").replace(/<br\s*\/?>/gi, "\n").split(/\r?\n/)) {
    const line = plainLine(raw);
    if (/^PLAY RECAP\b/.test(line.trim())) {
      inRecap = true;
      continue;
    }
    if (!inRecap) continue;
    const m = line.match(RECAP_LINE);
    if (!m) {
      // the recap ends at its first line that is not a host's counts (an empty line, the next
      // part of the output)
      if (line.trim()) inRecap = false;
      continue;
    }
    const counts = Object.fromEntries(m[2].trim().split(/\s+/).map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
    if (counts.failed > 0 || counts.unreachable > 0) failed.add(m[1].trim());
  }
  return [...failed].sort();
}

/**
 * Every host a job ran on, from its PLAY RECAP lines : failed or not. With the failed ones, it
 * tells a job that failed on some hosts from one that failed on all it had (one host, or every
 * one) : re-running the failed hosts of the latter is a full relaunch.
 *
 * Args:
 *   text (string): the job's output, or the part of it from its first PLAY RECAP on.
 *
 * Returns:
 *   string[]: the host names, sorted, each once ; [] when there is no recap.
 */
export function ranHostsFromRecap(text) {
  const hosts = new Set();
  let inRecap = false;
  for (const raw of String(text || "").replace(/<br\s*\/?>/gi, "\n").split(/\r?\n/)) {
    const line = plainLine(raw);
    if (/^PLAY RECAP\b/.test(line.trim())) {
      inRecap = true;
      continue;
    }
    if (!inRecap) continue;
    const m = line.match(RECAP_LINE);
    if (!m) {
      if (line.trim()) inRecap = false;
      continue;
    }
    hosts.add(m[1].trim());
  }
  return [...hosts].sort();
}

/**
 * Whether a re-run on the failed hosts differs from a full relaunch : some hosts failed, and not
 * every host the job ran on. A job that ran on one host, or failed on all of them, re-runs them all
 * either way, so its Relaunch offers no "on failed hosts". Hosts it ran on not known : the failed
 * ones decide alone.
 *
 * Args:
 *   failed (string[]|null): the failed hosts.
 *   all (string[]|number|null): every host it ran on, or how many there were.
 *
 * Returns:
 *   boolean: true when "on failed hosts" is a choice of its own.
 */
export function rerunDiffers(failed, all) {
  const n = Array.isArray(failed) ? failed.length : 0;
  if (!n) return false;
  const total = Array.isArray(all) ? new Set(all).size : Number(all);
  if (!Number.isFinite(total) || total <= 0) return true;
  return n < total;
}

// ---------------------------------------------------------------------------------------------
// The limit of a re-run
// ---------------------------------------------------------------------------------------------

/**
 * Whether a host name is matched by ansible as that name only, written as a line of a limit
 * file. A line is not split (no comma or colon is special in it) but it is still a pattern :
 * `~` makes it a regex, `!` and `&` operators, `*`, `?` and `[` a wildcard or a subscript, and
 * `@` reads a file. A name with one of those, a blank or a control character is not literal.
 *
 * Args:
 *   name (any): the host name.
 *
 * Returns:
 *   boolean: true when the name, as a line, matches that host only.
 */
export function isLiteralHost(name) {
  if (typeof name !== "string") return false;
  if (!name || name.length > 250) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(name)) return false;
  if (/^[~!&@]/.test(name)) return false;
  return !/[*?[\]]/.test(name);
}

/**
 * A limit pattern split as ansible splits it (inventory/manager.py split_host_pattern) : on its
 * commas when it has any, else on its colons outside of a [subscript] - unless it is one address
 * (an IPv6 address has colons of its own).
 *
 * Args:
 *   limit (string|string[]): the limit, as a form or a field gave it.
 *
 * Returns:
 *   string[]: its patterns, trimmed, the empty ones left out.
 */
export function splitLimit(limit) {
  if (Array.isArray(limit)) return limit.flatMap(splitLimit);
  const text = String(limit ?? "").trim();
  if (!text) return [];
  if (text.includes(",")) return text.split(",").map((p) => p.trim()).filter(Boolean);
  // one IPv6 address (two colons or more, hexadecimal digits, dots for an embedded IPv4)
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) || []).length >= 2) return [text];
  return (text.match(/(?:[^\s:[\]]|\[[^\]]*\])+/g) || []).map((p) => p.trim()).filter(Boolean);
}

/**
 * The limit of a re-run of a job on its failed hosts : the hosts, each as a line of the limit
 * file, within the job's own limit. ansible reads the lines of a limit file as patterns it
 * unites, except for the ones starting with `&` (intersected with the others) and `!` (taken
 * out) ; so the job's limit is kept as such lines :
 *   - each `&x` and `!x` of it as it is ;
 *   - its one plain pattern (a group, a host) as `&x` ;
 *   - several plain patterns cannot be written as an intersection : the failed hosts ran under
 *     that very limit, so they are within it already, and are taken as they are.
 * A re-run of a re-run is within the hosts of the one before (its `previousHosts`) : the
 * failed hosts are kept only when they were among them.
 *
 * Args:
 *   failed (string[]): the job's failed hosts (hostsFromEvents, hostsFromRecap, AWX's summaries).
 *   originalLimit (string|string[]): the job's limit (__limit__), when it had one.
 *   previousHosts (string[]): the hosts of the job when it was a re-run itself (__limitHosts__).
 *
 * Returns:
 *   object: { hosts (the literal names re-run, sorted), within (the lines of the job's limit),
 *     skipped (the names left out : ansible would read them as patterns) }.
 */
export function rerunLimit(failed, originalLimit = "", previousHosts = null) {
  const unique = [...new Set((Array.isArray(failed) ? failed : []).map((h) => String(h ?? "").trim()).filter(Boolean))].sort();
  // step 1 : a name ansible would read as a pattern is never written
  const skipped = unique.filter((h) => !isLiteralHost(h));
  let hosts = unique.filter(isLiteralHost);
  // step 2 : a re-run of a re-run stays within the hosts of the one before
  if (Array.isArray(previousHosts) && previousHosts.length) {
    const before = new Set(previousHosts.map(String));
    hosts = hosts.filter((h) => before.has(h));
  }
  // step 3 : the job's own limit, as lines ansible intersects with the hosts
  const patterns = splitLimit(originalLimit);
  const within = patterns.filter((p) => p.startsWith("&") || p.startsWith("!"));
  const plain = patterns.filter((p) => !p.startsWith("&") && !p.startsWith("!"));
  if (plain.length === 1 && plain[0] !== "all" && plain[0] !== "*") within.unshift(`&${plain[0]}`);
  return { hosts, within, skipped };
}

/**
 * The lines of a re-run's limit file : the hosts, then the job's limit (rerunLimit).
 *
 * Args:
 *   hosts (string[]): the hosts.
 *   within (string[]): the job's limit as `&x` and `!x` lines.
 *
 * Returns:
 *   string: the file's content, a line each, ending with a newline.
 */
export function limitFileContent(hosts, within = []) {
  const lines = [...(hosts || []).filter(isLiteralHost), ...(within || []).map((l) => String(l).replace(/[\r\n]/g, "")).filter(Boolean)];
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * The limit an RTE of an earlier release runs a re-run with : it does not know the limit file
 * and passes __limit__ as it is. As a comma string, so it is read as a list of patterns : the
 * names with a comma are left out of it (it would split them in two), and it always ends with a
 * comma (one name alone is split on its colons otherwise). With no name left it excludes every
 * host : such an RTE then runs on none rather than on all.
 *
 * Args:
 *   hosts (string[]): the hosts (rerunLimit).
 *   within (string[]): the job's limit as `&x` and `!x` lines.
 *
 * Returns:
 *   string: the limit.
 */
export function fallbackLimit(hosts, within = []) {
  const names = (hosts || []).filter((h) => isLiteralHost(h) && !h.includes(","));
  if (!names.length) return "!all,";
  return `${[...names, ...(within || []).filter((l) => !String(l).includes(","))].join(",")},`;
}

export default { hostsFromEvents, hostsFromRecap, isLiteralHost, splitLimit, rerunLimit, limitFileContent, fallbackLimit };
