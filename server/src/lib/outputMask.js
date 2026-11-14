/******************************************************************/
/*                                                                */
/*  The secrets of a running job, masked in its output : a        */
/*  playbook that prints a credential (a debug of the extravars,  */
/*  -vvv, a failing module echoing its arguments) does not store  */
/*  it in job_output or jobs.job_log.                             */
/*                                                                */
/*  The runner that resolves a job's credentials (an RTE, the     */
/*  awx runner) registers their values here, in its own process,  */
/*  and every output write of that job goes through maskOutput.   */
/*  A job nobody registered (the app's own lines) is written as   */
/*  it is.                                                        */
/*                                                                */
/******************************************************************/

// what a secret is shown as
export const MASK = "********";

// shorter values are not masked : masking every "1" or "yes" in the output would wreck it
const MIN_SECRET_LENGTH = 4;

// the keys of a resolved credential that hold a secret
const SECRET_KEY = /pass(word)?|secret|token|private_?key|client_?key|api_?key/i;

// the jobs this process runs, with their secret values (longest first)
const registry = new Map();

// a bound on the registry : a runner that never says a job ended cannot grow it for ever
const MAX_JOBS = 1000;

/**
 * The secret strings in a value : every string under a key that names a secret, at any
 * depth (a credential map holds one object per credential).
 *
 * Args:
 *   value (any): a resolved credential, a credential map, or any object.
 *   underSecretKey (boolean): the value sits under a secret key already.
 *
 * Returns:
 *   string[]: the secret strings found.
 */
export function collectSecrets(value, underSecretKey = false) {
  if (typeof value === "string") return underSecretKey ? [value] : [];
  if (typeof value === "number") return underSecretKey ? [String(value)] : [];
  if (Array.isArray(value)) return value.flatMap((v) => collectSecrets(v, underSecretKey));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => collectSecrets(v, underSecretKey || SECRET_KEY.test(k)));
  }
  return [];
}

/**
 * The forms a secret takes in the output : as it is, and as JSON writes it inside a string
 * (ansible prints the extravars and module arguments as JSON, so a quote or a backslash in a
 * password is escaped there).
 *
 * Args:
 *   secret (string): the secret.
 *
 * Returns:
 *   string[]: its spellings, without duplicates.
 */
function spellings(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  return json === secret ? [secret] : [secret, json];
}

// a line of a multi-line secret this long or longer is masked on its own too
const MIN_SECRET_LINE_LENGTH = 16;

/**
 * The lines of a multi-line secret (a private key) that are masked on their own : a playbook
 * that prints the key line by line, or a tool that wraps it, shows its lines apart. The
 * armour lines (-----BEGIN ... PRIVATE KEY-----) say nothing secret and are left out, and so
 * are lines too short to be worth masking.
 *
 * Args:
 *   secret (string): the secret.
 *
 * Returns:
 *   string[]: its secret lines, trimmed ; none for a one-line secret.
 */
export function secretLines(secret) {
  if (typeof secret !== "string" || !/[\r\n]/.test(secret)) return [];
  return secret
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_SECRET_LINE_LENGTH && !line.startsWith("-----"));
}

/**
 * Registers the secrets of a job, for maskOutput. Registering again adds to them.
 *
 * Args:
 *   jobId (number|string): the job.
 *   secrets (string[]): the secret values ; short and empty ones are left out, and a
 *     multi-line one (a private key) is masked line by line as well (secretLines).
 */
export function registerJobSecrets(jobId, secrets) {
  if (jobId === undefined || jobId === null) return;
  const key = String(jobId);
  const set = new Set(registry.get(key) || []);
  for (const s of secrets || []) {
    if (typeof s !== "string" || s.length < MIN_SECRET_LENGTH) continue;
    for (const spelling of spellings(s)) set.add(spelling);
    // a multi-line one (a private key) : each of its lines as well
    for (const line of secretLines(s)) set.add(line);
  }
  if (!set.size) return;
  if (!registry.has(key) && registry.size >= MAX_JOBS) registry.delete(registry.keys().next().value);
  // longest first : a secret that contains another is masked whole
  registry.set(key, [...set].sort((a, b) => b.length - a.length));
}

/**
 * Forgets the secrets of a job that ended.
 *
 * Args:
 *   jobId (number|string): the job.
 */
export function forgetJobSecrets(jobId) {
  registry.delete(String(jobId));
}

/**
 * A job's output with its registered secrets masked.
 *
 * Args:
 *   jobId (number|string): the job.
 *   text (string): the output.
 *
 * Returns:
 *   string: the output, every secret replaced by MASK ; as it was when the job has none.
 */
export function maskOutput(jobId, text) {
  if (typeof text !== "string" || !text) return text;
  const secrets = registry.get(String(jobId));
  if (!secrets) return text;
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK);
  return out;
}

export default { MASK, collectSecrets, secretLines, registerJobSecrets, forgetJobSecrets, maskOutput };
