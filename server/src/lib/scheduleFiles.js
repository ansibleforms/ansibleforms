// A schedule of a schedules repository (use_for_schedules) : one YAML file under its `schedules`
// folder, in one of three shapes - the export form (its template, inventory and credentials as
// natural keys { name, type, organization }, its credentials under related, its own natural_key),
// the module form (the template and inventory as names, credentials as a list of names,
// organization beside them) or a controller_schedules list of one - read into what AnsibleForms
// runs, refused where it is not a valid schedule, and written back with everything the file says
// kept ; its rrule is checked by lib/scheduleRrule.js. Pure : models/scheduleRepo.model.js reads
// the files and writes the database.
import YAML from "yaml";
import { validateRrule, normalizeRrule } from "./scheduleRrule.js";
import { setKey as setMapKey, same, fileNameFor as objectFileName, YAML_FILE, editedText } from "./repoObjects/yamlFile.js";

// ===========================================================================
// CONSTANTS
// ===========================================================================

// the folder of a schedules repository the schedules are in, one per file ; nothing else in the
// repository is read as a schedule
export const SCHEDULES_FOLDER = "schedules";

// a schedule's file : yaml, as every object file
export const SCHEDULE_FILE = YAML_FILE;

// the keys of a schedule in the export's order (its own fields, its prompts, then
// unified_job_template, enabled and rrule, then related and natural_key) : a new file is written in it, a key added to a file goes to its
// place in it
export const KEY_ORDER = [
  "name",
  "description",
  "extra_data",
  "inventory",
  "credentials",
  "scm_branch",
  "job_type",
  "job_tags",
  "skip_tags",
  "limit",
  "diff_mode",
  "verbosity",
  "execution_environment",
  "instance_groups",
  "forks",
  "job_slice_count",
  "timeout",
  "unified_job_template",
  "enabled",
  "rrule",
  "related",
  "natural_key",
];

// the lists a file may hold its one schedule in : an export's { schedules: [...] }, or
// { controller_schedules: [...] }
export const WRAPPER_KEYS = ["schedules", "controller_schedules"];


// the prompts AnsibleForms has none for : checked, kept in the file, not used
export const UNMAPPED_KEYS = ["forks", "timeout", "job_slice_count", "labels"];

// the longest name the schedule table keeps
export const MAX_NAME = 255;

// the verbosity levels (0 normal to 5) and the job types a schedule may ask for
const VERBOSITY = [0, 1, 2, 3, 4, 5];
const JOB_TYPES = ["run", "check"];


// ===========================================================================
// THE FILE : READ
// ===========================================================================

/**
 * A name given either way a schedule file writes it : a string (the module's) or a map with a name (the
 * export's natural key : { name, type, organization }).
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   string: the name, '' when none.
 */
export function nameOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value.name === null || value.name === undefined ? "" : String(value.name);
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Extra data given either way : a map, or YAML / JSON text.
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   object: the variables ({} when none).
 *
 * Raises:
 *   Error: anything that is not a map.
 */
export function extraDataOf(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = YAML.parse(value);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  throw new Error("extra_data is not a dictionary");
}

/**
 * A yes or no as the module takes it : a boolean, or yes / no, true / false, on / off text.
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   boolean|undefined: the boolean ; undefined when it is none of those.
 */
function boolOf(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(text)) return true;
  if (["false", "no", "off", "0"].includes(text)) return false;
  return undefined;
}

/**
 * The names of a list written as names or natural keys (credentials, instance groups, labels).
 *
 * Args:
 *   value (any): the list.
 *   key (string): its key, for the error.
 *
 * Returns:
 *   string[]: the names.
 *
 * Raises:
 *   Error: it is not a list.
 */
function namesOf(value, key) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be a list`);
  return value.map(nameOf).filter((n) => n.trim());
}

// ===========================================================================
// THE PROMPTS : BOTH WAYS
// ===========================================================================

/**
 * The prompts of a schedule file and the reserved extra vars (launch options) AnsibleForms' job
 * reads them as, one row each, both ways : read turns a file's value into the option (or says why
 * it is refused), write turns an option back into the file's value - undefined when the option
 * has a shape the field cannot give (a credential map whose keys are not the credentials' names),
 * which then stays in the app only. A pull reads with it (launchOptionsOf), the app writes with it
 * (promptsOf), so the two are each other's reverse.
 *
 *   field    the file's key
 *   option   the launch option
 *   read     (value, obj) => { value } | { error }
 *   write    (option value) => the file's value, or undefined
 */
const asText = (field) => (v) => (typeof v === "object" ? { error: `${field} must be text` } : { value: String(v) });
const textOption = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
const nameOption = (v) => (typeof v === "string" && v.trim() ? v : undefined);
export const PROMPTS = [
  { field: "limit", option: "__limit__", read: asText("limit"), write: textOption },
  { field: "job_tags", option: "__tags__", read: asText("job_tags"), write: textOption },
  { field: "skip_tags", option: "__skipTags__", read: asText("skip_tags"), write: textOption },
  { field: "scm_branch", option: "__scmBranch__", read: asText("scm_branch"), write: textOption },
  {
    field: "verbosity",
    option: "__verbosity__",
    read: (v) => (VERBOSITY.includes(Number(v)) && String(v).trim() !== "" ? { value: Number(v) } : { error: `verbosity must be one of ${VERBOSITY.join(", ")}` }),
    write: (v) => (VERBOSITY.includes(Number(v)) ? Number(v) : undefined),
  },
  {
    field: "diff_mode",
    option: "__diff__",
    read: (v) => (boolOf(v) === undefined ? { error: "diff_mode must be true or false" } : { value: boolOf(v) }),
    write: (v) => boolOf(v),
  },
  {
    field: "job_type",
    option: "__check__",
    read: (v) => (JOB_TYPES.includes(v) ? { value: v === "check" } : { error: `job_type must be one of ${JOB_TYPES.join(", ")}` }),
    write: (v) => (boolOf(v) === undefined ? undefined : boolOf(v) ? "check" : "run"),
  },
  // the objects it names : by name, or by natural key
  { field: "inventory", option: "__inventory__", read: (v) => (nameOf(v).trim() ? { value: nameOf(v) } : {}), write: nameOption },
  { field: "execution_environment", option: "__executionEnvironment__", read: (v) => (nameOf(v).trim() ? { value: nameOf(v) } : {}), write: nameOption },
  {
    field: "instance_groups",
    option: "__instanceGroups__",
    read: (v) => listRead(v, "instance_groups", (names) => names),
    write: (v) => (Array.isArray(v) && v.length && v.every((n) => typeof n === "string" && n.trim()) ? [...v] : undefined),
  },
  {
    // each credential under its own name : written by name, as the file names them
    field: "credentials",
    option: "__credentials__",
    read: (v) => listRead(v, "credentials", (names) => Object.fromEntries(names.map((n) => [n, n]))),
    write: (v) => {
      const entries = v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
      return entries.length && entries.every(([k, n]) => typeof n === "string" && n.trim() && k === n) ? entries.map(([, n]) => n) : undefined;
    },
  },
];

// the prompts AnsibleForms has an equivalent for : the reserved extra vars a form's job reads
// (job.model.js pushForminfoToExtravars, the runners)
export const MAPPED_KEYS = PROMPTS.map((p) => p.field);

/**
 * A list prompt read : its names, none when it is empty.
 *
 * Args:
 *   value (any): the list.
 *   key (string): its key, for the error.
 *   to (function): (names) => the option.
 *
 * Returns:
 *   object: { value } | { error } | {} (no names).
 */
function listRead(value, key, to) {
  try {
    const names = namesOf(value, key);
    return names.length ? { value: to(names) } : {};
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Launch options as a schedule file gives them (the reverse of launchOptionsOf) : the prompts
 * they are written as, and the options no prompt can give, kept in the app only.
 *
 * Args:
 *   options (object|string): the launch options (the schedule table's JSON, or an object).
 *
 * Returns:
 *   object: { fields ({ prompt: value }), kept ({ option: value } : none of the prompts gives it) }.
 */
export function promptsOf(options) {
  let opts = options;
  if (typeof opts === "string") {
    try {
      opts = opts.trim() ? JSON.parse(opts) : {};
    } catch {
      opts = {};
    }
  }
  const fields = {};
  const kept = {};
  for (const [option, value] of Object.entries(opts && typeof opts === "object" ? opts : {})) {
    const prompt = PROMPTS.find((p) => p.option === option);
    const written = prompt ? prompt.write(value) : undefined;
    if (written === undefined) kept[option] = value;
    else fields[prompt.field] = written;
  }
  return { fields, kept };
}

/**
 * The prompts of a schedule as the extra vars AnsibleForms' job reads them : limit as
 * __limit__, job_tags as __tags__, skip_tags as __skipTags__, verbosity as __verbosity__,
 * diff_mode as __diff__, job_type check as __check__, inventory as __inventory__, scm_branch as
 * __scmBranch__, execution_environment as __executionEnvironment__, instance_groups as
 * __instanceGroups__, and credentials (the module's list, or the export's related.credentials)
 * each under its own name in __credentials__. forks, timeout, job_slice_count and labels are
 * checked and kept in the file, AnsibleForms has nothing to give them to.
 *
 * Args:
 *   obj (object): the schedule, as read from its file.
 *
 * Returns:
 *   object: { options (the reserved extra vars), errors (string[]), ignored (the keys given and
 *     not used) }.
 */
export function launchOptionsOf(obj) {
  const options = {};
  const errors = [];
  const ignored = [];
  const given = (key) => obj[key] !== undefined && obj[key] !== null && obj[key] !== "";
  for (const prompt of PROMPTS) {
    // the module's credentials, else the export's related.credentials
    const value = prompt.field === "credentials" && !given("credentials") && obj.related && typeof obj.related === "object" ? obj.related.credentials : obj[prompt.field];
    if (value === undefined || value === null || value === "") continue;
    const read = prompt.read(value, obj);
    if (read.error) errors.push(read.error);
    else if (read.value !== undefined) options[prompt.option] = read.value;
  }
  // the prompts AnsibleForms has nothing for : checked, kept, not used
  for (const key of ["forks", "job_slice_count"]) {
    if (!given(key)) continue;
    if (!Number.isInteger(Number(obj[key])) || Number(obj[key]) < 0) errors.push(`${key} must be a whole number of 0 or more`);
    else ignored.push(key);
  }
  if (given("timeout")) {
    if (!Number.isInteger(Number(obj.timeout))) errors.push("timeout must be a whole number");
    else ignored.push("timeout");
  }
  if (given("labels")) {
    try {
      if (namesOf(obj.labels, "labels").length) ignored.push("labels");
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { options, errors, ignored };
}

/**
 * The map of a parsed file that is its schedule : the file itself, or the one item of the list
 * an export ({ schedules: [...] }) or a controller_configuration file ({ controller_schedules:
 * [...] }) holds it in.
 *
 * Args:
 *   doc (YAML.Document): the parsed file.
 *
 * Returns:
 *   object: { node (YAMLMap), wrapper (the list's key, or null) }.
 *
 * Raises:
 *   Error: the file is no map, or its list holds more or less than one schedule.
 */
export function scheduleNodeOf(doc) {
  const top = doc.contents;
  if (!YAML.isMap(top)) throw new Error("the file is not a schedule (a YAML dictionary)");
  if (!top.has("name")) {
    const wrapper = WRAPPER_KEYS.find((key) => top.has(key));
    if (wrapper) {
      const list = top.get(wrapper, true);
      if (!YAML.isSeq(list) || list.items.length !== 1 || !YAML.isMap(list.items[0])) {
        throw new Error(`'${wrapper}' must hold exactly one schedule: one schedule per file`);
      }
      return { node: list.items[0], wrapper };
    }
  }
  return { node: top, wrapper: null };
}

/**
 * Reads a schedule file : what AnsibleForms runs, and why it is refused when it is not a valid
 * schedule - no name, a name longer than the schedule table keeps, no
 * rrule or a refused one, no unified_job_template name, extra_data that are no dictionary, a
 * prompt of the wrong type. Whether its form exists is the caller's to check (it knows the forms).
 * A file with `state: absent` (the module's) holds no schedule.
 *
 * Args:
 *   text (string): the file's text.
 *
 * Returns:
 *   object: { errors (string[]), absent (boolean), schedule: { name, description, rrule,
 *     enabled, form, extraData, launchOptions, ignored }, name (the name a refused one declares,
 *     null when it gives none) } ; schedule is null when refused.
 */
export function parseScheduleFile(text) {
  const doc = YAML.parseDocument(String(text ?? ""), { prettyErrors: false });
  if (doc.errors.length) return { errors: [`not valid YAML: ${doc.errors[0].message}`], absent: false, schedule: null };
  let node;
  try {
    ({ node } = scheduleNodeOf(doc));
  } catch (e) {
    return { errors: [e.message], absent: false, schedule: null };
  }
  const obj = node.toJS(doc) || {};
  if (obj.state === "absent") return { errors: [], absent: true, schedule: null };
  const errors = [];
  // name : required, the schedule table's name
  const name = nameOf(obj.name).trim();
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME) errors.push(`name is longer than ${MAX_NAME} characters`);
  // rrule : required, and valid
  const rrule = typeof obj.rrule === "string" ? normalizeRrule(obj.rrule) : "";
  if (!rrule) errors.push("rrule is required");
  else for (const e of validateRrule(rrule)) errors.push(`rrule: ${e}`);
  // unified_job_template : the form it runs, by name (the module's) or natural key (the export's)
  const form = nameOf(obj.unified_job_template).trim();
  if (!form) errors.push("unified_job_template.name (the form it runs) is required");
  // enabled : a yes or no, on when not said
  let enabled = true;
  if (obj.enabled !== undefined && obj.enabled !== null) {
    const v = boolOf(obj.enabled);
    if (v === undefined) errors.push("enabled must be true or false");
    else enabled = v;
  }
  // extra_data : a dictionary
  let extraData = {};
  try {
    extraData = extraDataOf(obj.extra_data);
  } catch (e) {
    errors.push(e.message);
  }
  const description = obj.description === null || obj.description === undefined ? "" : String(obj.description);
  const { options, errors: promptErrors, ignored } = launchOptionsOf(obj);
  errors.push(...promptErrors);
  // refused, its name still said : no other schedule is written beside it under that name
  if (errors.length) return { errors, absent: false, schedule: null, name: name || null };
  return { errors: [], absent: false, schedule: { name, description, rrule, enabled, form, extraData, launchOptions: options, ignored } };
}

// ===========================================================================
// THE FILE : WRITTEN
// ===========================================================================

/**
 * Sets a key of a schedule's map, a new key put at its place in the export's order (KEY_ORDER) :
 * the shared writer of the object files (lib/repoObjects/yamlFile.js).
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   map (YAMLMap): the map.
 *   key (string): the key.
 *   value (any): the value.
 */
function setKey(doc, map, key, value) {
  setMapKey(doc, map, key, value, KEY_ORDER);
}

/**
 * The fields the app edits written into a schedule's file : the rest of it - the prompts, the
 * keys AnsibleForms does not use, the wrapper list, the comments, the order - kept as the file
 * has them. unified_job_template keeps its shape (a name, or a natural key whose name changes),
 * and the export's natural_key follows the name and the form.
 *
 * Args:
 *   text (string): the file's text.
 *   edits (object): any of { name, description, rrule, enabled, form, extraData, launchOptions
 *     (the launch options : only the prompts whose value changes rewritten, those no longer
 *     given removed) }.
 *
 * Returns:
 *   string: the file's new text.
 *
 * Raises:
 *   Error: the file is not a schedule.
 */
export function updateScheduleFile(text, edits) {
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0].message}`);
  const { node } = scheduleNodeOf(doc);
  const current = node.toJS(doc) || {};
  if (edits.name !== undefined && edits.name !== current.name) setKey(doc, node, "name", edits.name);
  if (edits.description !== undefined && edits.description !== (current.description ?? "")) setKey(doc, node, "description", edits.description);
  if (edits.extraData !== undefined) {
    let before;
    try {
      before = extraDataOf(current.extra_data);
    } catch {
      before = undefined;
    }
    if (!same(before, edits.extraData)) setKey(doc, node, "extra_data", edits.extraData);
  }
  if (edits.form !== undefined && edits.form !== nameOf(current.unified_job_template)) {
    const ujt = node.get("unified_job_template", true);
    if (YAML.isMap(ujt)) setKey(doc, ujt, "name", edits.form);
    else if (ujt !== undefined && ujt !== null && !YAML.isMap(ujt)) setKey(doc, node, "unified_job_template", edits.form);
    else setKey(doc, node, "unified_job_template", { name: edits.form, type: "job_template" });
  }
  if (edits.enabled !== undefined && boolOf(current.enabled ?? true) !== edits.enabled) setKey(doc, node, "enabled", edits.enabled);
  // the rrule compared on one line : a file that writes it on several lines keeps them while it
  // does not change
  if (edits.rrule !== undefined && normalizeRrule(edits.rrule) !== normalizeRrule(current.rrule)) setKey(doc, node, "rrule", edits.rrule);
  // the prompts : compared as the file gives them now, read and written back the same way
  if (edits.launchOptions !== undefined) {
    const now = promptsOf(launchOptionsOf(current).options).fields;
    const next = promptsOf(edits.launchOptions).fields;
    for (const { field } of PROMPTS) {
      if (same(now[field], next[field])) continue;
      if (next[field] === undefined) node.delete(field);
      else setKey(doc, node, field, next[field]);
    }
  }
  // the export's natural key names the schedule and its template : it follows them
  const natural = node.get("natural_key", true);
  if (YAML.isMap(natural)) {
    if (edits.name !== undefined && natural.get("name") !== edits.name) setKey(doc, natural, "name", edits.name);
    const nujt = natural.get("unified_job_template", true);
    if (edits.form !== undefined && YAML.isMap(nujt) && nujt.get("name") !== edits.form) setKey(doc, nujt, "name", edits.form);
  }
  return editedText(doc, text);
}

/**
 * A new schedule file, in the export form of one schedule : its keys in the export's order, its
 * template as a natural key, and its own natural key (what an import finds it by). No
 * AnsibleForms field in it.
 *
 * Args:
 *   values (object): { name, description, rrule, enabled, form, extraData, launchOptions (the
 *     launch options, written as the prompts that give them : promptsOf) }.
 *
 * Returns:
 *   string: the file's text.
 */
export function newScheduleFile({ name, description = "", rrule, enabled = true, form, extraData = {}, launchOptions = {} }) {
  const ujt = { name: form, type: "job_template" };
  const obj = {
    name,
    description: description || "",
    extra_data: extraData || {},
    ...promptsOf(launchOptions).fields,
    unified_job_template: ujt,
    enabled: enabled !== false,
    rrule: normalizeRrule(rrule),
    natural_key: { name, type: "schedule", unified_job_template: { ...ujt } },
  };
  const rank = (k) => (KEY_ORDER.includes(k) ? KEY_ORDER.indexOf(k) : KEY_ORDER.length);
  return YAML.stringify(Object.fromEntries(Object.entries(obj).sort(([a], [b]) => rank(a) - rank(b))), { lineWidth: 0 });
}

/**
 * The file name a new schedule gets in the schedules folder : its name in lower case, letters
 * and digits apart by dashes, a number added when a file has it already (the shared namer of the
 * object files, lib/repoObjects/yamlFile.js).
 *
 * Args:
 *   name (string): the schedule's name.
 *   taken (function): (fileName) => true when a file has that name.
 *
 * Returns:
 *   string: the file name (nightly-log-rotation.yaml).
 */
export function fileNameFor(name, taken = () => false) {
  return objectFileName(name, taken, "schedule");
}
