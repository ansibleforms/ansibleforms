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
import { setKey as setMapKey, same, fileNameFor as objectFileName, YAML_FILE } from "./repoObjects/yamlFile.js";

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
  "scm_branch",
  "job_type",
  "job_tags",
  "skip_tags",
  "limit",
  "diff_mode",
  "verbosity",
  "execution_environment",
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

// the prompts AnsibleForms has an equivalent for : the reserved extra vars a form's job reads
// (job.model.js pushForminfoToExtravars, the runners)
export const MAPPED_KEYS = [
  "inventory",
  "credentials",
  "limit",
  "job_tags",
  "skip_tags",
  "verbosity",
  "diff_mode",
  "job_type",
  "scm_branch",
  "execution_environment",
  "instance_groups",
];

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
  const text = (key, to) => {
    if (!given(key)) return;
    if (typeof obj[key] === "object") errors.push(`${key} must be text`);
    else options[to] = String(obj[key]);
  };
  // text prompts
  text("limit", "__limit__");
  text("job_tags", "__tags__");
  text("skip_tags", "__skipTags__");
  text("scm_branch", "__scmBranch__");
  // verbosity : 0 to 5
  if (given("verbosity")) {
    const v = Number(obj.verbosity);
    if (!Number.isInteger(v) || !VERBOSITY.includes(v)) errors.push(`verbosity must be one of ${VERBOSITY.join(", ")}`);
    else options.__verbosity__ = v;
  }
  // diff mode : a yes or no
  if (given("diff_mode")) {
    const v = boolOf(obj.diff_mode);
    if (v === undefined) errors.push("diff_mode must be true or false");
    else options.__diff__ = v;
  }
  // job type : run or check
  if (given("job_type")) {
    if (!JOB_TYPES.includes(obj.job_type)) errors.push(`job_type must be one of ${JOB_TYPES.join(", ")}`);
    else options.__check__ = obj.job_type === "check";
  }
  // the objects it names : by name, or by natural key
  if (given("inventory")) {
    const name = nameOf(obj.inventory);
    if (name.trim()) options.__inventory__ = name;
  }
  if (given("execution_environment")) {
    const name = nameOf(obj.execution_environment);
    if (name.trim()) options.__executionEnvironment__ = name;
  }
  try {
    const groups = namesOf(obj.instance_groups, "instance_groups");
    if (groups.length) options.__instanceGroups__ = groups;
  } catch (e) {
    errors.push(e.message);
  }
  try {
    // the module's credentials, else the export's related.credentials
    const listed = given("credentials") ? obj.credentials : obj.related && typeof obj.related === "object" ? obj.related.credentials : undefined;
    const credentials = namesOf(listed, "credentials");
    if (credentials.length) options.__credentials__ = Object.fromEntries(credentials.map((n) => [n, n]));
  } catch (e) {
    errors.push(e.message);
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
 *     enabled, form, extraData, launchOptions, ignored } } ; schedule is null when refused.
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
  if (errors.length) return { errors, absent: false, schedule: null };
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
 *   edits (object): any of { name, description, rrule, enabled, form, extraData }.
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
  if (edits.rrule !== undefined && edits.rrule !== current.rrule) setKey(doc, node, "rrule", edits.rrule);
  // the export's natural key names the schedule and its template : it follows them
  const natural = node.get("natural_key", true);
  if (YAML.isMap(natural)) {
    if (edits.name !== undefined && natural.get("name") !== edits.name) setKey(doc, natural, "name", edits.name);
    const nujt = natural.get("unified_job_template", true);
    if (edits.form !== undefined && YAML.isMap(nujt) && nujt.get("name") !== edits.form) setKey(doc, nujt, "name", edits.form);
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * A new schedule file, in the export form of one schedule : its keys in the export's order, its
 * template as a natural key, and its own natural key (what an import finds it by). No
 * AnsibleForms field in it.
 *
 * Args:
 *   values (object): { name, description, rrule, enabled, form, extraData }.
 *
 * Returns:
 *   string: the file's text.
 */
export function newScheduleFile({ name, description = "", rrule, enabled = true, form, extraData = {} }) {
  const ujt = { name: form, type: "job_template" };
  const obj = {
    name,
    description: description || "",
    extra_data: extraData || {},
    unified_job_template: ujt,
    enabled: enabled !== false,
    rrule: normalizeRrule(rrule),
    natural_key: { name, type: "schedule", unified_job_template: { ...ujt } },
  };
  return YAML.stringify(obj, { lineWidth: 0 });
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
