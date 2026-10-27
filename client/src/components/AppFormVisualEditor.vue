<script setup>
/******************************************************************/
/*                                                                */
/*  A form's Visual tab in the designer, on the same YAML as its  */
/*  YAML tab (saved with the designer's Save) :                   */
/*    Form : every setting of the form settings, edited in place, */
/*      only those its type allows (the schema refuses others).   */
/*    Fields : an outline, as the categories' : a field's name,   */
/*      type, label and required in its row, ↑ ↓ to move it,      */
/*      Delete, the toolbar's + to add one ; its row unfolds its  */
/*      help, default, output and values.                         */
/*                                                                */
/*  Every edit changes only the keys it touches, in the YAML      */
/*  document itself (lib/formDoc.js) : comments, quoting, the     */
/*  jobs and whatever else the form holds stay as written. What   */
/*  cannot be rewritten safely (an alias) is shown, not edited.   */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the form's YAML                      */
/*      readOnly: Boolean - shown, not editable                   */
/*      categoryOptions: String[] - the categories' paths         */
/*      roleOptions: String[] - the roles' names                  */
/*  @emits:                                                       */
/*      update:modelValue - the YAML, edited                      */
/*                                                                */
/******************************************************************/
import { ref, shallowRef, computed, watch, onMounted } from 'vue';
import axios from 'axios';
import { useI18n } from 'vue-i18n';
import { toast } from 'vue-sonner';
import YAML from 'yaml';
import {
  fieldTypes,
  formTypes,
  forbiddenFormKeys,
  fieldTypeAllows,
  TEMPLATE_FORM_TYPES,
  JOB_FORM_TYPES,
  RUNNER_TYPE_OF,
} from '@/config/formFields';
import { fieldProperties } from '@/config/fieldProperties';
import { availableIcons } from '@/config/icons';
import {
  fieldsState,
  readFields,
  setFieldText,
  setFieldRequired,
  setFieldType,
  moveField,
  removeField,
  addField,
  setFormText,
  setFormType,
  formList,
  setFormList,
  setFormValue,
  fieldDefaultText,
  setFieldDefault,
  setFieldOutput,
  fieldValuesText,
  setFieldValues,
  fieldPropValue,
  setFieldProp,
  addFieldProp,
  formObject,
  setFormObject,
  setFormIn,
  renameFormCredential,
  EMAIL,
  orderedForms,
  placeOf,
  orderFor,
} from '@/lib/formDoc';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  categoryOptions: { type: Array, default: () => [] },
  roleOptions: { type: Array, default: () => [] },
  // the other forms of the forms list, { name, order } : the places this one can go
  otherForms: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

// ─── the YAML as a document ───────────────────────────────────────────────────
// a shallow ref : the yaml library's nodes are not made reactive ; rev says they changed
const doc = shallowRef(null);
const rev = ref(0);
const error = ref('');
// the text last written : our own edit coming back from the parent is not read again
let lastText = null;

/**
 * Reads the form's YAML into a document ; an error leaves nothing to edit.
 *
 * Args:
 *   text (string): the YAML.
 */
function read(text) {
  lastText = text;
  try {
    const parsed = YAML.parseDocument(text || '');
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    if (!YAML.isMap(parsed.contents)) throw new Error(t('designer.visualNotAMap'));
    doc.value = parsed;
    error.value = '';
  } catch (e) {
    doc.value = null;
    error.value = e?.message || String(e);
  }
  rev.value++;
}
watch(
  () => props.modelValue,
  (text) => {
    if (text !== lastText) read(text);
  },
  { immediate: true },
);

/**
 * Applies an edit to the document, then writes it back as the form's YAML.
 *
 * Args:
 *   edit (Function): doc => what it returns.
 *
 * Returns:
 *   any: what the edit returned ; nothing when the tab cannot edit.
 */
function change(edit) {
  if (locked.value || !doc.value) return undefined;
  const result = edit(doc.value);
  lastText = doc.value.toString();
  rev.value++;
  emit('update:modelValue', lastText);
  return result;
}

const locked = computed(() => props.readOnly || !!error.value);

// ─── Form : edited in place ───────────────────────────────────────────────────
const form = computed(() => {
  rev.value;
  if (!doc.value) return null;
  const d = doc.value;
  const str = (key) => {
    const v = d.get(key);
    return v === undefined || v === null ? '' : String(v);
  };
  const type = str('type') || 'ansible';
  return {
    name: str('name'),
    type,
    description: str('description'),
    playbook: str('playbook'),
    workflow: str('workflow'),
    template: str('template'),
    icon: str('icon'),
    multistep: type === 'multistep',
    categories: formList(d, 'categories'),
    roles: formList(d, 'roles'),
  };
});
// what a type allows, as the schema : a subform has no categories, roles or icon ; what runs is
// a playbook (ansible) or an AWX template (awx), a multistep's steps are in the YAML
const isSubform = computed(() => form.value?.type === 'subform');

/**
 * Sets a text of the form (name, description, playbook, template, icon).
 *
 * Args:
 *   key (string): the key.
 *   value (string): the text.
 */
function setText(key, value) {
  change((d) => setFormText(d, key, value));
}

/**
 * Changes the form's type, telling which keys the new type made it drop.
 *
 * Args:
 *   type (string): the new type.
 */
function setType(type) {
  const removed = change((d) => setFormType(d, type));
  if (removed?.length) toast.warning(t('designer.typeKeysRemoved', { type, keys: removed.join(', ') }));
}

/**
 * Adds a category or a role to the form.
 *
 * Args:
 *   key (string): 'categories' or 'roles'.
 *   value (string): the category's path, the role's name.
 */
function addTo(key, value) {
  const list = form.value?.[key];
  if (!value || !list || list.includes(value)) return;
  change((d) => setFormList(d, key, [...list, value]));
}

/**
 * Removes a category or a role from the form.
 *
 * Args:
 *   key (string): 'categories' or 'roles'.
 *   value (string): the category's path, the role's name.
 */
function removeFrom(key, value) {
  const list = form.value?.[key];
  if (!list) return;
  change((d) =>
    setFormList(
      d,
      key,
      list.filter((x) => x !== value),
    ),
  );
}

// ─── the rest of the settings : as the form settings show them, what the type allows ────────
/**
 * Whether the form's type allows a key (the schema refuses the form with a forbidden one).
 *
 * Args:
 *   key (string): the key.
 *
 * Returns:
 *   boolean: true when it does.
 */
function allows(key) {
  return !(forbiddenFormKeys[form.value?.type] || []).includes(key);
}
// a form that runs a template or job on a runner (awx, aap, ascender, semaphore, rundeck, jenkins)
const awx = computed(() => TEMPLATE_FORM_TYPES.includes(form.value?.type));
// a Rundeck or a Jenkins form says `job:` for what it runs, the others `template:` ; a form
// written with the other word keeps it
const saysJob = computed(() => JOB_FORM_TYPES.includes(form.value?.type));
const whatKey = computed(() => {
  if (form.value?.template !== undefined) return 'template';
  if (form.value?.job !== undefined) return 'job';
  return saysJob.value ? 'job' : 'template';
});
const runs = computed(() => form.value?.type === 'ansible' || awx.value);
// the text settings : the key, its label, its icon, when it shows, its help
const textSettings = computed(() =>
  [
    {
      key: 'inventory',
      label: 'designer.formInventory',
      icon: 'list',
      show: allows('inventory'),
      help: 'designer.helpInventory',
      // an ansible form's : one of the designer's inventories ; a template's is the runner's, typed
      choices: form.value?.type === 'ansible' ? 'inventories' : null,
    },
    {
      key: 'scm_branch',
      label: 'designer.formScmBranch',
      icon: 'code-branch',
      show: awx.value,
      help: 'designer.helpScmBranch',
    },
    {
      key: 'executionEnvironment',
      label: 'designer.formExecEnv',
      icon: 'cube',
      show: awx.value,
      help: 'designer.helpExecEnv',
    },
    {
      key: 'ansibleCredentials',
      label: 'designer.formAnsibleCreds',
      icon: 'key',
      show: allows('ansibleCredentials'),
      help: 'designer.helpAnsibleCreds',
      choices: 'credentials',
    },
    {
      key: 'vaultCredentials',
      label: 'designer.formVaultCreds',
      icon: 'lock',
      show: allows('vaultCredentials'),
      help: 'designer.helpVaultCreds',
      choices: 'credentials',
    },
    { key: 'tags', label: 'designer.formTags', icon: 'tags', show: allows('tags'), help: 'designer.helpTags' },
    { key: 'limit', label: 'designer.formLimit', icon: 'filter', show: allows('limit'), help: 'designer.helpLimit' },
  ].filter((x) => x.show),
);
// ─── the user in the extravars : the instance's default, all, none, or only some keys ───
// (server/src/lib/common.js, userForExtravars) ; empty follows EXTRAVARS_USER_FIELDS
const userKeysChosen = ref(false);
const userMode = computed(() => {
  const v = String(setting('userExtravars') || '').trim();
  if (!v) return userKeysChosen.value ? 'keys' : '';
  if (v.toLowerCase() === 'all') return 'all';
  if (v.toLowerCase() === 'none') return 'none';
  return 'keys';
});

/**
 * Picks what the playbook gets of the user : the keys are typed next, nothing is written until
 * then (empty would mean the instance's default).
 *
 * Args:
 *   mode (string): '', 'all', 'none' or 'keys'.
 */
function setUserMode(mode) {
  userKeysChosen.value = mode === 'keys';
  if (mode === 'keys') {
    // keys already there stay ; 'all' or 'none' make room for the keys to type
    if (['all', 'none'].includes(String(setting('userExtravars')).toLowerCase())) setText('userExtravars', '');
    return;
  }
  setText('userExtravars', mode);
}

// ─── the runner : one of the instance's, of the type the form needs ───────────
// (an ansible form's jobs run on an rte, an awx form's on an awx : server/src/lib/formLinks.js) ;
// the list needs the settings' permission : without it, the name is typed
const runners = ref(null);
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/runner/');
    runners.value = (res.data?.records || res.data || [])
      .filter((r) => r && r.name)
      .map((r) => ({ name: String(r.name), type: String(r.type || '') }));
  } catch {
    runners.value = null;
  }
});
const runnerChoices = computed(() => {
  if (!runners.value) return null;
  // the runners of the type the form's type runs on (an aap form : the awx runners)
  const needs = RUNNER_TYPE_OF[form.value?.type];
  if (!needs) return [];
  return runners.value.filter((r) => r.type === needs).map((r) => r.name);
});

// ─── notifications, approval, credentials : nested, each edited a key at a time ───
const STATUSES = ['any', 'success', 'failed', 'aborted', 'warning'];
const EVENTS = ['any', 'launch', 'relaunch', 'delete', 'approve', 'reject'];
/**
 * A nested setting as data (undefined : not there ; null : not a map, in the YAML).
 *
 * Args:
 *   key (string): 'notifications', 'approval' or 'credentials'.
 *
 * Returns:
 *   object|null|undefined: its keys.
 */
function nested(key) {
  rev.value;
  return doc.value ? formObject(doc.value, key) : undefined;
}
/**
 * Switches a nested setting on (as it starts : what the schema requires of it) or off.
 *
 * Args:
 *   key (string): the setting.
 *   on (boolean): on or off.
 */
function toggleNested(key, on) {
  const start = { notifications: { recipients: [] }, approval: { message: '', roles: [] }, credentials: {} }[key];
  change((d) => setFormObject(d, key, on ? start : undefined));
}
/**
 * Sets one key of a nested setting : an empty list or text removes it, but what the schema
 * requires (the recipients, the approval's message and roles).
 *
 * Args:
 *   key (string): the setting.
 *   sub (string): the key in it.
 *   value (any): its value.
 */
function setNested(key, sub, value) {
  const required = { notifications: ['recipients'], approval: ['message', 'roles'] }[key] || [];
  const empty = value === '' || (Array.isArray(value) && !value.length);
  change((d) => setFormIn(d, key, sub, empty && !required.includes(sub) ? undefined : value));
}
// an email typed that the schema would refuse : said, not added
const emailError = ref('');
/**
 * Adds an email to a list of a nested setting (the notifications' recipients, the approval's).
 *
 * Args:
 *   key (string): the setting.
 *   sub (string): the list.
 *   input (HTMLInputElement): the field it was typed in, emptied once added.
 */
function addEmail(key, sub, input) {
  const email = input.value.trim();
  if (!email) return;
  if (!EMAIL.test(email)) {
    emailError.value = key + sub;
    return;
  }
  emailError.value = '';
  const list = nested(key)?.[sub] || [];
  if (!list.includes(email)) setNested(key, sub, [...list, email]);
  input.value = '';
}
/**
 * Adds a credential under a name not taken yet (credential, credential2...).
 */
function addCredential() {
  const taken = Object.keys(nested('credentials') || {});
  let name = 'credential';
  for (let i = 2; taken.includes(name); i++) name = `credential${i}`;
  change((d) => {
    if (!d.has('credentials')) setFormObject(d, 'credentials', {});
    setFormIn(d, 'credentials', name, '');
  });
}
// the notification channels' names (Connections > Notifications), offered in the notifications'
// and the approval's Channels (the list needs the settings' permission : without it, none offered)
const channelNames = ref([]);
// name -> its type (mail, slack, teams, telegram, webhook) : whether mail is among those picked
const channelTypes = ref({});
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/notificationchannel/');
    const list = (res.data?.records || res.data || []).filter((c) => c?.name);
    channelNames.value = list.map((c) => c.name);
    channelTypes.value = Object.fromEntries(list.map((c) => [c.name, c.type]));
  } catch {
    channelNames.value = [];
    channelTypes.value = {};
  }
});

/**
 * Whether the mail's recipients are asked, under the channels : no channel picked (mail goes
 * through the default mail channel, as before channels), a mail channel among them, or
 * recipients already there (never hidden with addresses in them).
 *
 * Args:
 *   key (string): 'notifications' or 'approval'.
 *   list (string): the recipients' key : recipients, or the approval's notifications.
 *
 * Returns:
 *   boolean: true when they are asked.
 */
function sendsMail(key, list) {
  const block = nested(key) || {};
  const picked = block.channels || [];
  return !picked.length || picked.some((n) => channelTypes.value[n] === 'mail') || (block[list] || []).length > 0;
}
// the credentials' names the instance keeps, offered as the values (the list needs the
// settings' permission : without it, typed)
const credentialNames = ref([]);
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/credential/');
    credentialNames.value = (res.data?.records || res.data || []).map((c) => c?.name).filter(Boolean);
  } catch {
    credentialNames.value = [];
  }
});

// the inventories' names (the designer's Inventories : a folder with an inventory.yaml or
// hosts.yaml, a repository's or a local one), offered as an ansible form's inventory
const inventoryNames = ref([]);
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/files/inventories');
    const names = (res.data?.files || [])
      .map((f) => String(f.path || '').split('/'))
      .filter((parts) => parts.length === 2 && /^(inventory|hosts)\.ya?ml$/i.test(parts[1]))
      .map((parts) => parts[0]);
    inventoryNames.value = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch {
    inventoryNames.value = [];
  }
});
// the playbooks (the designer's Playbooks section : its YAML files), offered as an ansible form's
// playbook ; none (the list needs the designer's permission) : the name is typed
const playbookNames = ref([]);
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/files/playbooks');
    playbookNames.value = (res.data?.files || [])
      .map((f) => String(f.path || ''))
      .filter((p) => /\.ya?ml$/i.test(p))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    playbookNames.value = [];
  }
});
// the designer's workflows (Designer > Workflows), offered as a workflow form's workflow : its file
// (a workflow's name still works) ; none (the list needs the designer's permission) : it is typed
const workflowNames = ref([]);
onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/files/workflows/names');
    // each workflow by its file, as a playbook is named (team/deploy.yml) ; one of a file holding
    // several by its name
    const list = (res.data?.records || res.data || []).filter((w) => w?.name);
    const perFile = list.reduce((m, w) => m.set(w.file, (m.get(w.file) || 0) + 1), new Map());
    workflowNames.value = list.map((w) => (w.file && perFile.get(w.file) === 1 ? w.file : w.name));
  } catch {
    workflowNames.value = [];
  }
});
// a setting's choices, by its kind ; none (an empty list) means it is typed
const choicesOf = (kind) => ({ credentials: credentialNames.value, inventories: inventoryNames.value })[kind] || [];

// the switches : true, or no key ; in the order of their columns (two to a column, the long
// labels together, the short ones together)
const flagSettings = computed(() =>
  [
    { key: 'showHelp', label: 'designer.showHelpByDefault', show: true },
    { key: 'enableForChat', label: 'designer.formChat', show: allows('enableForChat') },
    { key: 'allowRelaunch', label: 'designer.formAllowRelaunch', show: allows('allowRelaunch') },
    { key: 'keepExtravars', label: 'designer.formKeepExtravars', show: allows('keepExtravars') },
    { key: 'check', label: 'designer.formCheck', show: allows('check') },
    { key: 'diff', label: 'designer.formDiff', show: allows('diff') },
    { key: 'abortable', label: 'designer.formAbortable', show: allows('abortable') },
    { key: 'verbose', label: 'designer.formVerbose', show: allows('verbose') },
  ].filter((x) => x.show),
);
const hasWizard = computed(() => {
  rev.value;
  const w = doc.value?.get('wizard');
  return !!w && (YAML.isSeq(w) ? w.items.length > 0 : true);
});

/**
 * A setting as the page shows it : its text, '' without.
 *
 * Args:
 *   key (string): the key.
 *
 * Returns:
 *   any: the value.
 */
function setting(key) {
  rev.value;
  const v = doc.value?.get(key);
  if (v === undefined || v === null) return '';
  return YAML.isNode(v) ? v.toJSON() : v;
}

/**
 * Sets a flag of the form : true, or no key.
 *
 * Args:
 *   key (string): the key.
 *   on (boolean): on or off.
 */
function setFlag(key, on) {
  change((d) => setFormValue(d, key, on ? true : undefined));
}

/**
 * Puts a dropdown's chosen text in its tooltip as the pointer enters it : a long one ends in
 * '...' in the box, and is read in full there.
 *
 * Args:
 *   event (MouseEvent): the pointer entering the dropdown.
 */
function fullTitle(event) {
  const el = event.target;
  el.title = el.selectedOptions?.[0]?.text?.trim() || '';
}

// ─── its place in the forms list : picked, its order worked out (lib/formDoc.js) ───
const placesAfter = computed(() => orderedForms(props.otherForms));
const place = computed(() =>
  placeOf(setting('order') === '' ? undefined : setting('order'), form.value?.name, props.otherForms),
);

/**
 * Puts the form at a place in the forms list : first, after another, or none (last,
 * alphabetically) ; only its own order changes.
 *
 * Args:
 *   where (string): 'first', 'after:<name>' or ''.
 */
function setPlace(where) {
  change((d) => setFormValue(d, 'order', orderFor(where, props.otherForms)));
}

/**
 * Sets the AWX instance groups from a list typed with commas.
 *
 * Args:
 *   text (string): the groups, comma separated.
 */
function setInstanceGroups(text) {
  const list = String(text)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  change((d) => setFormValue(d, 'instanceGroups', list.length ? list : undefined));
}

// what each list may still add : the categories' paths and the roles' names not in it yet
const categoryChoices = computed(() => props.categoryOptions.filter((c) => !form.value?.categories?.includes(c)));
const roleChoices = computed(() => props.roleOptions.filter((r) => !form.value?.roles?.includes(r)));

// ─── Fields : an outline ──────────────────────────────────────────────────────
// a field's row keeps its identity across edits (its node) : the inputs keep their focus
const uids = new WeakMap();
let nextUid = 0;
const uidOf = (node) => {
  if (!uids.has(node)) uids.set(node, ++nextUid);
  return uids.get(node);
};

const fieldsMode = computed(() => {
  rev.value;
  return fieldsState(doc.value);
});
const fields = computed(() => {
  rev.value;
  return readFields(doc.value).map((f) => ({ ...f, uid: uidOf(f.node) }));
});
const fieldsEditable = computed(() => !locked.value && ['list', 'none'].includes(fieldsMode.value));

/**
 * Changes a field's type, telling what the new type made it drop and what it lacks.
 *
 * Args:
 *   row (object): the field's row.
 *   type (string): the new type.
 */
function setRowType(row, type) {
  const result = change(() => setFieldType(row.node, type));
  if (!result) return;
  const name = row.name || '?';
  if (result.removed.length)
    toast.warning(t('designer.fieldKeysRemoved', { details: `${name}: ${result.removed.join(', ')}` }));
  if (result.needs)
    toast.warning(
      t('designer.fieldKeysMissing', {
        details: `${name} (${type}): ${result.needs.map((s) => s.join(' + ')).join(' | ')}`,
      }),
    );
}

// the fields unfolded (their help, default, output, values), by their row's identity
const open = ref(new Set());
const toggle = (uid) => {
  const next = new Set(open.value);
  if (next.has(uid)) next.delete(uid);
  else next.add(uid);
  open.value = next;
};
// a values text that is not a list : said under it, not written
const valuesError = ref({});

/**
 * Sets a field's values from the YAML typed : refused (said) when not a list.
 *
 * Args:
 *   row (object): the field's row.
 *   text (string): the YAML.
 */
// why a value was refused, in the user's language (a YAML parse error stays as the parser
// wrote it, as in the YAML tab)
function problemText(problem) {
  if (problem === 'not a list') return t('designer.visualNotAList');
  if (problem === 'not a number') return t('designer.visualNotANumber');
  return problem;
}

function setRowValues(row, text) {
  let problem = '';
  change((d) => {
    problem = setFieldValues(d, row.node, text);
  });
  valuesError.value = { ...valuesError.value, [row.uid]: problemText(problem) };
}

// ─── a field's properties of its type ─────────────────────────────────────────
// what its type allows (the schema refuses the form with another), set or not
const typeProps = (f) => fieldProperties.filter((p) => fieldTypeAllows(f.type, p.key));
const setProps = (f) => typeProps(f).filter((p) => f.node.has(p.key));
const addableProps = (f) => typeProps(f).filter((p) => !f.node.has(p.key));
// a value refused (YAML that does not parse, not a number) : said under it, not written
const propError = ref({});

/**
 * Sets a property of a field from its input.
 *
 * Args:
 *   f (object): the field's row.
 *   prop (object): the property.
 *   input (any): what was typed or picked.
 */
function setProp(f, prop, input) {
  let problem = '';
  change((d) => {
    problem = setFieldProp(d, f.node, prop, input);
  });
  propError.value = { ...propError.value, [f.uid + prop.key]: problemText(problem) };
}

/**
 * Adds a property of its type to a field.
 *
 * Args:
 *   f (object): the field's row.
 *   key (string): the property.
 */
function addProp(f, key) {
  const prop = fieldProperties.find((p) => p.key === key);
  if (prop) change((d) => addFieldProp(d, f.node, prop));
}

/**
 * Removes a field, after asking : its other properties go with it.
 *
 * Args:
 *   row (object): the field's row.
 *   index (number): its position.
 */
// a field deleted after the designer's own confirmation (its modal, below)
const rowToDelete = ref(null);
function removeRow(row, index) {
  rowToDelete.value = { name: row.name, index };
}
function confirmRemoveRow() {
  const { index } = rowToDelete.value;
  rowToDelete.value = null;
  change((d) => removeField(d, index));
}

// the designer's toolbar adds a field (its + button)
defineExpose({
  add: () => fieldsEditable.value && change((d) => addField(d)),
  locked: computed(() => !fieldsEditable.value),
});
</script>
<template>
  <div class="af-visual-editor af-form-visual">
    <div v-if="error" class="alert alert-danger py-2 mb-3" role="alert">
      <FaIcon icon="triangle-exclamation" class="me-2" />{{ t('designer.visualYamlError') }} : {{ error }}
    </div>
    <template v-else-if="form">
      <!-- ─── Form : edited in place ─── -->
      <div class="af-form-grid">
        <!-- the name : a row of its own -->
        <div class="af-form-span2">
          <label class="form-label fw-bold">{{ t('designer.formName') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
            <input
              class="form-control"
              :class="{ 'is-invalid': !form.name.trim() }"
              :value="form.name"
              :disabled="locked"
              @change="setText('name', $event.target.value)"
            />
          </div>
        </div>
        <!-- the type : a row of its own, below the name, as wide -->
        <div class="af-form-span2 af-form-newrow">
          <label class="form-label fw-bold">{{ t('designer.formType') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="shapes" /></span>
            <select class="form-select" :value="form.type" :disabled="locked" @change="setType($event.target.value)">
              <option v-if="!formTypes.includes(form.type)" :value="form.type">{{ form.type }}</option>
              <option v-for="ft in formTypes" :key="ft" :value="ft">
                {{ ft === 'multistep' ? t('designer.typeDeprecated', { type: ft }) : ft }}
              </option>
            </select>
          </div>
        </div>
        <div class="af-form-span2 af-form-newrow">
          <label class="form-label fw-bold">{{ t('designer.formDescription') }}</label>
          <!-- a sentence or two : as tall as two lines, as the help below -->
          <textarea
            class="form-control af-text-box"
            rows="3"
            :value="form.description"
            :disabled="locked"
            @change="setText('description', $event.target.value)"
          ></textarea>
        </div>
        <div class="af-form-span2">
          <label class="form-label fw-bold">{{ t('designer.helpText') }}</label>
          <textarea
            class="form-control af-text-box"
            rows="3"
            :value="setting('help')"
            :disabled="locked"
            @change="setText('help', $event.target.value)"
          ></textarea>
        </div>
        <!-- its categories and roles : what it has, as pills to remove, and a list to add from -->
        <div v-for="key in isSubform ? [] : ['categories', 'roles']" :key="key" class="af-form-wide">
          <label class="form-label fw-bold">{{
            key === 'categories' ? t('designer.visualCategories') : t('designer.visualRoles')
          }}</label>
          <div v-if="form[key] === null" class="text-body-secondary fst-italic">{{ t('designer.visualInYaml') }}</div>
          <div v-else class="d-flex align-items-center flex-wrap gap-2">
            <span v-for="v in form[key]" :key="v" class="badge rounded-pill af-form-pill">
              {{ v }}
              <button
                type="button"
                class="btn-close ms-1"
                :disabled="locked"
                :aria-label="t('common.delete')"
                @click="removeFrom(key, v)"
              ></button>
            </span>
            <span v-if="!form[key].length && key === 'categories'" class="text-body-secondary">Default</span>
            <select
              @mouseenter="fullTitle"
              class="form-select form-select-sm af-form-add"
              :disabled="locked || !(key === 'categories' ? categoryChoices : roleChoices).length"
              :value="''"
              @change="
                addTo(key, $event.target.value);
                $event.target.value = '';
              "
            >
              <option value="">{{ t('designer.visualAdd') }}</option>
              <option v-for="o in key === 'categories' ? categoryChoices : roleChoices" :key="o" :value="o">
                {{ o }}
              </option>
            </select>
          </div>
        </div>
        <div v-if="!isSubform">
          <label class="form-label fw-bold">{{ t('designer.visualIcon') }}</label>
          <div class="input-group">
            <span class="input-group-text"
              ><FaIcon :fixedwidth="true" :icon="form.icon || 'square'" :class="{ 'opacity-25': !form.icon }"
            /></span>
            <select
              @mouseenter="fullTitle"
              class="form-select"
              :value="form.icon"
              :disabled="locked"
              @change="setText('icon', $event.target.value)"
            >
              <option value="">{{ t('designer.visualNoIcon') }}</option>
              <option v-if="form.icon && !availableIcons.includes(form.icon)" :value="form.icon">
                {{ form.icon }}
              </option>
              <option v-for="ic in availableIcons" :key="ic" :value="ic">{{ ic }}</option>
            </select>
          </div>
          <div class="form-text">{{ t('designer.helpIcon') }}</div>
        </div>
        <div v-if="form.type === 'ansible'">
          <label class="form-label fw-bold">{{ t('designer.formPlaybook') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="file-code" /></span>
            <!-- one of the designer's playbooks ; a name typed before stays offered -->
            <select
              v-if="playbookNames.length"
              class="form-select"
              :class="{ 'is-invalid': !form.playbook.trim() }"
              :value="form.playbook"
              :disabled="locked"
              @mouseenter="fullTitle"
              @change="setText('playbook', $event.target.value)"
            >
              <option value="">-</option>
              <option v-if="form.playbook && !playbookNames.includes(form.playbook)" :value="form.playbook">
                {{ form.playbook }}
              </option>
              <option v-for="p in playbookNames" :key="p" :value="p">{{ p }}</option>
            </select>
            <input
              v-else
              class="form-control"
              :class="{ 'is-invalid': !form.playbook.trim() }"
              :value="form.playbook"
              :disabled="locked"
              spellcheck="false"
              @change="setText('playbook', $event.target.value)"
            />
          </div>
          <div class="form-text">{{ t('designer.helpPlaybook') }}</div>
        </div>
        <!-- a workflow form : the workflow it runs, one of the designer's -->
        <div v-if="form.type === 'workflow'">
          <label class="form-label fw-bold">{{ t('designer.formWorkflow') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="diagram-project" /></span>
            <select
              v-if="workflowNames.length"
              class="form-select"
              :class="{ 'is-invalid': !form.workflow.trim() }"
              :value="form.workflow"
              :disabled="locked"
              @mouseenter="fullTitle"
              @change="setText('workflow', $event.target.value)"
            >
              <option value="">-</option>
              <option v-if="form.workflow && !workflowNames.includes(form.workflow)" :value="form.workflow">
                {{ form.workflow }}
              </option>
              <option v-for="w in workflowNames" :key="w" :value="w">{{ w }}</option>
            </select>
            <input
              v-else
              class="form-control"
              :class="{ 'is-invalid': !form.workflow.trim() }"
              :value="form.workflow"
              :disabled="locked"
              spellcheck="false"
              @change="setText('workflow', $event.target.value)"
            />
          </div>
          <div class="form-text">{{ t('designer.helpWorkflow') }}</div>
        </div>
        <div v-if="awx">
          <label class="form-label fw-bold">{{
            t(whatKey === 'job' ? 'designer.formJob' : 'designer.formTemplate')
          }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="file-code" /></span>
            <input
              class="form-control"
              :class="{ 'is-invalid': !String(form[whatKey] || '').trim() }"
              :value="form[whatKey] || ''"
              :disabled="locked"
              @change="setText(whatKey, $event.target.value)"
            />
          </div>
          <div class="form-text">{{ t(whatKey === 'job' ? 'designer.helpJob' : 'designer.helpTemplate') }}</div>
        </div>
        <!-- the runner : picked from the instance's, of the type the form needs ; typed when the
             list cannot be read -->
        <div v-if="runs">
          <label class="form-label fw-bold">{{ t('designer.formRunner') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="server" /></span>
            <select
              @mouseenter="fullTitle"
              v-if="runnerChoices"
              class="form-select"
              :value="setting('runner')"
              :disabled="locked"
              @change="setText('runner', $event.target.value)"
            >
              <option value="">{{ t('designer.runnerDefault') }}</option>
              <!-- a runner the list does not have (another type, or gone) : offered, so it shows -->
              <option v-if="setting('runner') && !runnerChoices.includes(setting('runner'))" :value="setting('runner')">
                {{ setting('runner') }}
              </option>
              <option v-for="r in runnerChoices" :key="r" :value="r">{{ r }}</option>
            </select>
            <input
              v-else
              class="form-control"
              :value="setting('runner')"
              :disabled="locked"
              spellcheck="false"
              @change="setText('runner', $event.target.value)"
            />
          </div>
          <div class="form-text">{{ t('designer.formRunnerHelp') }}</div>
        </div>
        <div v-for="x in textSettings" :key="x.key">
          <label class="form-label fw-bold">{{ t(x.label) }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" :icon="x.icon" /></span>
            <!-- a credential's or an inventory's name : picked from those the instance keeps, when
                 it may read them ; a name typed before stays offered -->
            <select
              @mouseenter="fullTitle"
              v-if="x.choices && choicesOf(x.choices).length"
              class="form-select"
              :value="setting(x.key)"
              :disabled="locked"
              @change="setText(x.key, $event.target.value)"
            >
              <option value="">
                {{ x.choices === 'inventories' ? t('designer.visualNoInventory') : t('designer.visualNoCredential') }}
              </option>
              <option v-if="setting(x.key) && !choicesOf(x.choices).includes(setting(x.key))" :value="setting(x.key)">
                {{ setting(x.key) }}
              </option>
              <option v-for="c in choicesOf(x.choices)" :key="c" :value="c">{{ c }}</option>
            </select>
            <input
              v-else
              class="form-control"
              :value="setting(x.key)"
              :disabled="locked"
              spellcheck="false"
              @change="setText(x.key, $event.target.value)"
            />
          </div>
          <div v-if="x.help" class="form-text">{{ t(x.help) }}</div>
        </div>
        <!-- the user in the extravars : a choice, and the keys when only some -->
        <div v-if="allows('userExtravars')">
          <label class="form-label fw-bold">{{ t('designer.formUserExtravars') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="user" /></span>
            <select class="form-select" :value="userMode" :disabled="locked" @change="setUserMode($event.target.value)">
              <option value="">{{ t('designer.userExtravarsDefault') }}</option>
              <option value="all">{{ t('designer.userExtravarsAll') }}</option>
              <option value="none">{{ t('designer.userExtravarsNone') }}</option>
              <option value="keys">{{ t('designer.userExtravarsKeys') }}</option>
            </select>
          </div>
          <div v-if="userMode === 'keys'" class="input-group mt-2">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
            <input
              class="form-control"
              :value="userMode === 'keys' ? setting('userExtravars') : ''"
              :disabled="locked"
              placeholder="username,email,type"
              spellcheck="false"
              @change="
                setText(
                  'userExtravars',
                  $event.target.value
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean)
                    .join(','),
                )
              "
            />
          </div>
          <div class="form-text">{{ t('designer.formUserExtravarsHelp') }}</div>
        </div>
        <div v-if="awx">
          <label class="form-label fw-bold">{{ t('designer.formInstanceGroups') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="layer-group" /></span>
            <input
              class="form-control"
              :value="
                Array.isArray(setting('instanceGroups'))
                  ? setting('instanceGroups').join(', ')
                  : setting('instanceGroups')
              "
              :disabled="locked"
              @change="setInstanceGroups($event.target.value)"
            />
          </div>
          <div class="form-text">{{ t('designer.helpInstanceGroups') }}</div>
        </div>
        <div v-if="allows('order')">
          <label class="form-label fw-bold">{{ t('designer.formOrder') }}</label>
          <!-- a place among the other forms : the order is worked out from it -->
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="arrow-down-1-9" /></span>
            <select class="form-select" :value="place" :disabled="locked" @change="setPlace($event.target.value)">
              <option value="first">{{ t('designer.orderFirst') }}</option>
              <option v-for="f in placesAfter" :key="f.name" :value="'after:' + f.name">
                {{ t('designer.orderAfter', { name: f.name }) }}
              </option>
              <option value="">{{ t('designer.orderNone') }}</option>
            </select>
          </div>
          <div class="form-text">
            {{
              typeof setting('order') === 'number'
                ? t('designer.helpOrderAt', { order: setting('order') })
                : t('designer.helpOrderNone')
            }}
          </div>
        </div>
        <div v-if="allows('launchValidation')">
          <label class="form-label fw-bold">{{ t('designer.formLaunchValidation') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="shield-halved" /></span>
            <select
              @mouseenter="fullTitle"
              class="form-select"
              :value="setting('launchValidation')"
              :disabled="locked"
              @change="setText('launchValidation', $event.target.value)"
            >
              <option value="">{{ t('designer.formLaunchValidationDefault') }}</option>
              <option value="log">log</option>
              <option value="enforce">enforce</option>
            </select>
          </div>
          <div class="form-text">{{ t('designer.formLaunchValidationHelp') }}</div>
        </div>
        <!-- notifications : on or off ; on, who gets them, on which statuses and events -->
        <div v-if="allows('notifications')" class="af-form-span2">
          <label class="form-label fw-bold af-switch-title" for="af-notif">{{
            t('designer.visualNotifications')
          }}</label>
          <div class="form-check form-switch mb-0">
            <input
              id="af-notif"
              class="form-check-input"
              type="checkbox"
              role="switch"
              :checked="nested('notifications') !== undefined"
              :disabled="locked || nested('notifications') === null"
              @change="toggleNested('notifications', $event.target.checked)"
            />
          </div>
          <div class="form-text">{{ t('designer.visualNotificationsHelp') }}</div>
          <div v-if="nested('notifications') === null" class="text-body-secondary fst-italic">
            {{ t('designer.visualInYaml') }}
          </div>
          <div v-else-if="nested('notifications')" class="af-nested">
            <!-- the channels it goes to first (mail, Slack, Teams, Telegram, a webhook), then the mail's
                 recipients when mail is among them -->
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualChannels') }}</label>
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span
                  v-for="c in nested('notifications').channels || []"
                  :key="c"
                  class="badge rounded-pill af-form-pill"
                >
                  {{ c }}
                  <button
                    type="button"
                    class="btn-close ms-1"
                    :disabled="locked"
                    :aria-label="t('common.delete')"
                    @click="
                      setNested(
                        'notifications',
                        'channels',
                        nested('notifications').channels.filter((x) => x !== c),
                      )
                    "
                  ></button>
                </span>
                <select
                  @mouseenter="fullTitle"
                  class="form-select form-select-sm af-form-add"
                  :disabled="locked"
                  :value="''"
                  @change="
                    setNested('notifications', 'channels', [
                      ...(nested('notifications').channels || []),
                      $event.target.value,
                    ]);
                    $event.target.value = '';
                  "
                >
                  <option value="">{{ t('designer.visualAdd') }}</option>
                  <option
                    v-for="o in channelNames.filter((x) => !(nested('notifications').channels || []).includes(x))"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
              <div class="form-text">{{ t('designer.visualChannelsHelp') }}</div>
            </div>
            <div v-if="sendsMail('notifications', 'recipients')">
              <label class="form-label fw-bold">{{ t('designer.visualRecipients') }}</label>
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span
                  v-for="r in nested('notifications').recipients || []"
                  :key="r"
                  class="badge rounded-pill af-form-pill"
                >
                  {{ r }}
                  <button
                    type="button"
                    class="btn-close ms-1"
                    :disabled="locked"
                    :aria-label="t('common.delete')"
                    @click="
                      setNested(
                        'notifications',
                        'recipients',
                        nested('notifications').recipients.filter((x) => x !== r),
                      )
                    "
                  ></button>
                </span>
                <input
                  type="email"
                  class="form-control form-control-sm af-form-add"
                  :class="{ 'is-invalid': emailError === 'notificationsrecipients' }"
                  :placeholder="t('designer.visualAddEmail')"
                  :disabled="locked"
                  @keydown.enter.prevent="addEmail('notifications', 'recipients', $event.target)"
                  @change="addEmail('notifications', 'recipients', $event.target)"
                />
              </div>
            </div>
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualOnStatus') }}</label>
              <div class="d-flex flex-wrap gap-3">
                <div v-for="st in STATUSES" :key="st" class="form-check mb-0">
                  <input
                    :id="'af-st-' + st"
                    class="form-check-input"
                    type="checkbox"
                    :checked="(nested('notifications').onStatus || []).includes(st)"
                    :disabled="locked"
                    @change="
                      setNested(
                        'notifications',
                        'onStatus',
                        STATUSES.filter((x) =>
                          x === st ? $event.target.checked : (nested('notifications').onStatus || []).includes(x),
                        ),
                      )
                    "
                  />
                  <label class="form-check-label" :for="'af-st-' + st">{{ st }}</label>
                </div>
              </div>
            </div>
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualOnEvent') }}</label>
              <div class="d-flex flex-wrap gap-3">
                <div v-for="ev in EVENTS" :key="ev" class="form-check mb-0">
                  <input
                    :id="'af-ev-' + ev"
                    class="form-check-input"
                    type="checkbox"
                    :checked="(nested('notifications').onEvent || []).includes(ev)"
                    :disabled="locked"
                    @change="
                      setNested(
                        'notifications',
                        'onEvent',
                        EVENTS.filter((x) =>
                          x === ev ? $event.target.checked : (nested('notifications').onEvent || []).includes(x),
                        ),
                      )
                    "
                  />
                  <label class="form-check-label" :for="'af-ev-' + ev">{{ ev }}</label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- approval : on or off ; on, its title, message, the roles that approve, who is told -->
        <div v-if="allows('approval')" class="af-form-span2">
          <label class="form-label fw-bold af-switch-title" for="af-appr">{{ t('designer.visualApproval') }}</label>
          <div class="form-check form-switch mb-0">
            <input
              id="af-appr"
              class="form-check-input"
              type="checkbox"
              role="switch"
              :checked="nested('approval') !== undefined"
              :disabled="locked || nested('approval') === null"
              @change="toggleNested('approval', $event.target.checked)"
            />
          </div>
          <div class="form-text">{{ t('designer.visualApprovalHelp') }}</div>
          <div v-if="nested('approval') === null" class="text-body-secondary fst-italic">
            {{ t('designer.visualInYaml') }}
          </div>
          <div v-else-if="nested('approval')" class="af-nested">
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualApprovalTitle') }}</label>
              <input
                class="form-control"
                :value="nested('approval').title || ''"
                :disabled="locked"
                @change="setNested('approval', 'title', $event.target.value.trim())"
              />
            </div>
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualApprovalMessage') }}</label>
              <textarea
                class="form-control"
                rows="2"
                :class="{ 'is-invalid': !String(nested('approval').message || '').trim() }"
                :value="nested('approval').message || ''"
                :disabled="locked"
                @change="setNested('approval', 'message', $event.target.value)"
              ></textarea>
            </div>
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualApprovers') }}</label>
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span v-for="r in nested('approval').roles || []" :key="r" class="badge rounded-pill af-form-pill">
                  {{ r }}
                  <button
                    type="button"
                    class="btn-close ms-1"
                    :disabled="locked"
                    :aria-label="t('common.delete')"
                    @click="
                      setNested(
                        'approval',
                        'roles',
                        nested('approval').roles.filter((x) => x !== r),
                      )
                    "
                  ></button>
                </span>
                <select
                  @mouseenter="fullTitle"
                  class="form-select form-select-sm af-form-add"
                  :disabled="locked"
                  :value="''"
                  @change="
                    setNested('approval', 'roles', [...(nested('approval').roles || []), $event.target.value]);
                    $event.target.value = '';
                  "
                >
                  <option value="">{{ t('designer.visualAdd') }}</option>
                  <option
                    v-for="o in roleOptions.filter((x) => !(nested('approval').roles || []).includes(x))"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
            </div>
            <!-- whether the requester may approve their own job (allowSelf) : off, another approver
                 must ; an admin always may -->
            <div>
              <div class="form-check form-switch mb-0">
                <input
                  id="af-appr-self"
                  class="form-check-input"
                  type="checkbox"
                  role="switch"
                  :checked="nested('approval').allowSelf === true"
                  :disabled="locked"
                  @change="setNested('approval', 'allowSelf', $event.target.checked || undefined)"
                />
                <label class="form-check-label" for="af-appr-self">{{ t('designer.visualApprovalAllowSelf') }}</label>
              </div>
              <div class="form-text">{{ t('designer.visualApprovalAllowSelfHelp') }}</div>
            </div>
            <!-- the channels it is asked in first, then the mail's recipients when mail is among them -->
            <div>
              <label class="form-label fw-bold">{{ t('designer.visualChannels') }}</label>
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span v-for="c in nested('approval').channels || []" :key="c" class="badge rounded-pill af-form-pill">
                  {{ c }}
                  <button
                    type="button"
                    class="btn-close ms-1"
                    :disabled="locked"
                    :aria-label="t('common.delete')"
                    @click="
                      setNested(
                        'approval',
                        'channels',
                        nested('approval').channels.filter((x) => x !== c),
                      )
                    "
                  ></button>
                </span>
                <select
                  @mouseenter="fullTitle"
                  class="form-select form-select-sm af-form-add"
                  :disabled="locked"
                  :value="''"
                  @change="
                    setNested('approval', 'channels', [...(nested('approval').channels || []), $event.target.value]);
                    $event.target.value = '';
                  "
                >
                  <option value="">{{ t('designer.visualAdd') }}</option>
                  <option
                    v-for="o in channelNames.filter((x) => !(nested('approval').channels || []).includes(x))"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
              <div class="form-text">{{ t('designer.visualChannelsHelp') }}</div>
            </div>
            <div v-if="sendsMail('approval', 'notifications')">
              <label class="form-label fw-bold">{{ t('designer.visualApprovalNotify') }}</label>
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span
                  v-for="r in nested('approval').notifications || []"
                  :key="r"
                  class="badge rounded-pill af-form-pill"
                >
                  {{ r }}
                  <button
                    type="button"
                    class="btn-close ms-1"
                    :disabled="locked"
                    :aria-label="t('common.delete')"
                    @click="
                      setNested(
                        'approval',
                        'notifications',
                        nested('approval').notifications.filter((x) => x !== r),
                      )
                    "
                  ></button>
                </span>
                <input
                  type="email"
                  class="form-control form-control-sm af-form-add"
                  :class="{ 'is-invalid': emailError === 'approvalnotifications' }"
                  :placeholder="t('designer.visualAddEmail')"
                  :disabled="locked"
                  @keydown.enter.prevent="addEmail('approval', 'notifications', $event.target)"
                  @change="addEmail('approval', 'notifications', $event.target)"
                />
              </div>
            </div>
          </div>
        </div>
        <!-- credentials : an extravar's name, the credential it gets -->
        <div v-if="allows('credentials')" class="af-form-span2">
          <label class="form-label fw-bold">{{ t('designer.visualCredentials') }}</label>
          <div class="form-text mt-0 mb-2">{{ t('designer.visualCredentialsHelp') }}</div>
          <div v-if="nested('credentials') === null" class="text-body-secondary fst-italic">
            {{ t('designer.visualInYaml') }}
          </div>
          <template v-else>
            <div v-for="(cred, name) in nested('credentials') || {}" :key="name" class="af-cred-row">
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="code" /></span>
                <input
                  class="form-control"
                  :value="name"
                  :disabled="locked"
                  spellcheck="false"
                  :aria-label="t('designer.visualCredentialVar')"
                  @change="
                    $event.target.value.trim() &&
                    !Object.keys(nested('credentials')).includes($event.target.value.trim()) &&
                    change((d) => renameFormCredential(d, name, $event.target.value.trim()))
                  "
                />
              </div>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
                <select
                  @mouseenter="fullTitle"
                  v-if="credentialNames.length"
                  class="form-select"
                  :value="cred"
                  :disabled="locked"
                  :aria-label="t('designer.visualCredentialName')"
                  @change="setNested('credentials', name, $event.target.value)"
                >
                  <option value="">{{ t('designer.visualNoCredential') }}</option>
                  <option v-if="cred && !credentialNames.includes(cred)" :value="cred">{{ cred }}</option>
                  <option v-for="c in credentialNames" :key="c" :value="c">{{ c }}</option>
                </select>
                <input
                  v-else
                  class="form-control"
                  :value="cred"
                  :disabled="locked"
                  list="af-credential-names"
                  spellcheck="false"
                  :aria-label="t('designer.visualCredentialName')"
                  @change="setNested('credentials', name, $event.target.value.trim())"
                />
              </div>
              <button
                type="button"
                class="btn af-row-btn"
                :class="locked ? 'btn-outline-secondary' : 'btn-outline-danger'"
                :disabled="locked"
                :title="t('common.delete')"
                @click="change((d) => renameFormCredential(d, name, undefined))"
              >
                <FaIcon icon="trash" />
              </button>
            </div>
            <datalist id="af-credential-names">
              <option v-for="c in credentialNames" :key="c" :value="c"></option>
            </datalist>
            <BsButton icon="plus" :disabled="locked" @click="addCredential()">{{
              t('designer.visualAddCredential')
            }}</BsButton>
          </template>
        </div>
        <!-- the switches, under a title of their own as every field has -->
        <label class="form-label fw-bold af-form-wide mb-0">{{ t('designer.visualOptions') }}</label>
        <div class="af-form-wide af-form-flags">
          <div v-for="x in flagSettings" :key="x.key" class="form-check form-switch">
            <input
              :id="'af-flag-' + x.key"
              class="form-check-input"
              type="checkbox"
              role="switch"
              :checked="setting(x.key) === true"
              :disabled="locked"
              @change="setFlag(x.key, $event.target.checked)"
            />
            <label class="form-check-label" :for="'af-flag-' + x.key">{{ t(x.label) }}</label>
          </div>
        </div>
      </div>

      <!-- ─── Fields : an outline ─── -->
      <h6 class="fw-bold mt-4 mb-2">{{ t('designer.visualFields') }}</h6>
      <!-- what is edited here, and where the rest is -->
      <p class="form-text mt-0 mb-2">{{ t('designer.visualFieldsHint') }}</p>
      <!-- a multistep : deprecated since 7, a workflow does what it does -->
      <div v-if="form.multistep" class="alert alert-warning py-2" role="alert">
        <FaIcon icon="triangle-exclamation" class="me-2" />{{ t('designer.multistepDeprecated') }}
      </div>
      <!-- a multistep form's steps, a wizard's : only in the YAML, said rather than left looking empty -->
      <div v-if="form.multistep || hasWizard" class="alert alert-info py-2" role="alert">
        <FaIcon icon="circle-info" class="me-2" />{{ t('designer.visualStepsInYaml') }}
      </div>
      <div v-if="fieldsMode === 'alias' || fieldsMode === 'unreadable'" class="alert alert-info py-2" role="alert">
        <FaIcon icon="circle-info" class="me-2" />{{ t('designer.visualFieldsInYaml') }}
      </div>
      <div v-else-if="!fields.length" class="empty-state">
        <FaIcon icon="list" class="empty-state-icon" />
        <span>{{ t('designer.visualNoFields') }}</span>
      </div>
      <div v-else class="af-cats">
        <div class="af-cats-row af-cats-head">
          <span></span>
          <span>{{ t('designer.fieldName') }}</span>
          <span>{{ t('designer.fieldType') }}</span>
          <span>{{ t('designer.fieldLabel') }}</span>
          <span class="text-center">{{ t('designer.visualRequired') }}</span>
          <span></span>
        </div>
        <template v-for="(f, i) in fields" :key="f.uid">
          <div class="af-cats-row">
            <!-- its other properties : unfolded under it -->
            <button
              type="button"
              class="btn btn-link px-1 af-field-caret"
              :aria-expanded="open.has(f.uid)"
              :title="t('designer.visualFieldDetails')"
              @click="toggle(f.uid)"
            >
              <FaIcon icon="caret-right" :class="{ 'fa-rotate-90': open.has(f.uid) }" />
            </button>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="i-cursor" /></span>
              <input
                class="form-control"
                :class="{ 'is-invalid': f.noName || f.duplicate }"
                :value="f.name"
                :disabled="!fieldsEditable"
                :title="f.duplicate ? t('designer.visualDuplicateField') : f.noName ? t('designer.visualNoName') : ''"
                :aria-label="t('designer.fieldName')"
                spellcheck="false"
                @change="change(() => setFieldText(f.node, 'name', $event.target.value.trim()))"
              />
            </div>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="shapes" /></span>
              <select
                @mouseenter="fullTitle"
                class="form-select"
                :value="f.type"
                :disabled="!fieldsEditable"
                :aria-label="t('designer.fieldType')"
                @change="setRowType(f, $event.target.value)"
              >
                <!-- a type not in the list (a typo in the YAML) : offered, so it stays visible -->
                <option v-if="!fieldTypes.includes(f.type)" :value="f.type">{{ f.type }}</option>
                <option v-for="ft in fieldTypes" :key="ft" :value="ft">{{ ft }}</option>
              </select>
            </div>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
              <input
                class="form-control"
                :value="f.label"
                :disabled="!fieldsEditable"
                :aria-label="t('designer.fieldLabel')"
                @change="change(() => setFieldText(f.node, 'label', $event.target.value))"
              />
            </div>
            <div class="form-check form-switch d-flex justify-content-center mb-0">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="f.required"
                :disabled="!fieldsEditable"
                :aria-label="t('designer.visualRequired')"
                @change="change(() => setFieldRequired(f.node, $event.target.checked))"
              />
            </div>
            <div class="d-flex gap-2 justify-content-end">
              <div class="btn-group" role="group" :aria-label="t('settings.interface.linkMoves')">
                <button
                  type="button"
                  class="btn af-row-btn"
                  :class="fieldsEditable && i > 0 ? 'btn-outline-primary' : 'btn-outline-secondary'"
                  :disabled="!fieldsEditable || i === 0"
                  :title="t('settings.settingsPage.moveUp')"
                  @click="change((d) => moveField(d, i, -1))"
                >
                  <FaIcon icon="arrow-up" />
                </button>
                <button
                  type="button"
                  class="btn af-row-btn"
                  :class="fieldsEditable && i < fields.length - 1 ? 'btn-outline-primary' : 'btn-outline-secondary'"
                  :disabled="!fieldsEditable || i === fields.length - 1"
                  :title="t('settings.settingsPage.moveDown')"
                  @click="change((d) => moveField(d, i, 1))"
                >
                  <FaIcon icon="arrow-down" />
                </button>
              </div>
              <button
                type="button"
                class="btn af-row-btn"
                :class="fieldsEditable ? 'btn-outline-danger' : 'btn-outline-secondary'"
                :disabled="!fieldsEditable"
                :title="t('common.delete')"
                @click="removeRow(f, i)"
              >
                <FaIcon icon="trash" />
              </button>
            </div>
          </div>
          <!-- the field's other properties : help, default, output, values (when its type has them),
               then the properties of its type it has, and those it may add -->
          <div v-if="open.has(f.uid)" class="af-field-details">
            <div>
              <label class="form-label fw-bold">{{ t('designer.fieldHelp') }}</label>
              <input
                class="form-control"
                :value="String(f.node.get('help') ?? '')"
                :disabled="!fieldsEditable"
                @change="change(() => setFieldText(f.node, 'help', $event.target.value))"
              />
            </div>
            <div>
              <label class="form-label fw-bold">{{ t('designer.fieldDefault') }}</label>
              <input
                v-if="fieldDefaultText(f.node) !== null"
                class="form-control"
                :value="fieldDefaultText(f.node)"
                :disabled="!fieldsEditable"
                spellcheck="false"
                @change="change(() => setFieldDefault(f.node, $event.target.value))"
              />
              <div v-else class="text-body-secondary fst-italic">{{ t('designer.visualInYaml') }}</div>
            </div>
            <div class="form-check form-switch align-self-end mb-2">
              <input
                :id="'af-out-' + f.uid"
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="f.node.get('output') !== false"
                :disabled="!fieldsEditable"
                @change="change(() => setFieldOutput(f.node, $event.target.checked))"
              />
              <label class="form-check-label" :for="'af-out-' + f.uid">{{ t('designer.fieldOutput') }}</label>
            </div>
            <div v-if="fieldTypeAllows(f.type, 'values')" class="af-field-values">
              <label class="form-label fw-bold">{{ t('designer.fieldValues') }}</label>
              <textarea
                v-if="fieldValuesText(f.node) !== null"
                class="form-control font-monospace"
                :class="{ 'is-invalid': valuesError[f.uid] }"
                rows="4"
                :value="fieldValuesText(f.node)"
                :disabled="!fieldsEditable"
                spellcheck="false"
                placeholder="- dev
- prod"
                @change="setRowValues(f, $event.target.value)"
              ></textarea>
              <div v-else class="text-body-secondary fst-italic">{{ t('designer.visualInYaml') }}</div>
              <div v-if="valuesError[f.uid]" class="invalid-feedback d-block">{{ valuesError[f.uid] }}</div>
              <div class="form-text">{{ t('designer.visualValuesHelp') }}</div>
            </div>
            <!-- the properties of its type it has : each its input, its description, a cross -->
            <div v-for="pr in setProps(f)" :key="pr.key" :class="{ 'af-field-values': pr.kind === 'yaml' }">
              <label class="form-label fw-bold d-flex align-items-center">
                <code class="af-prop-key">{{ pr.key }}</code>
                <button
                  type="button"
                  class="btn-close ms-auto af-prop-remove"
                  :disabled="!fieldsEditable"
                  :title="t('designer.visualRemoveProperty')"
                  @click="change(() => f.node.delete(pr.key))"
                ></button>
              </label>
              <div v-if="pr.kind === 'switch'" class="form-check form-switch">
                <input
                  class="form-check-input"
                  type="checkbox"
                  role="switch"
                  :checked="fieldPropValue(f.node, pr)"
                  :disabled="!fieldsEditable"
                  @change="setProp(f, pr, $event.target.checked)"
                />
              </div>
              <select
                @mouseenter="fullTitle"
                v-else-if="pr.kind === 'select'"
                class="form-select"
                :value="fieldPropValue(f.node, pr)"
                :disabled="!fieldsEditable"
                @change="setProp(f, pr, $event.target.value)"
              >
                <option v-if="!pr.options.includes(fieldPropValue(f.node, pr))" :value="fieldPropValue(f.node, pr)">
                  {{ fieldPropValue(f.node, pr) }}
                </option>
                <option v-for="o in pr.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <textarea
                v-else-if="pr.kind === 'yaml'"
                class="form-control font-monospace"
                :class="{ 'is-invalid': propError[f.uid + pr.key] }"
                rows="3"
                :value="fieldPropValue(f.node, pr)"
                :disabled="!fieldsEditable"
                spellcheck="false"
                @change="setProp(f, pr, $event.target.value)"
              ></textarea>
              <input
                v-else
                class="form-control"
                :class="{ 'is-invalid': propError[f.uid + pr.key] }"
                :type="pr.kind === 'number' ? 'number' : 'text'"
                :value="fieldPropValue(f.node, pr)"
                :disabled="!fieldsEditable"
                spellcheck="false"
                @change="setProp(f, pr, $event.target.value)"
              />
              <div v-if="propError[f.uid + pr.key]" class="invalid-feedback d-block">
                {{ propError[f.uid + pr.key] }}
              </div>
              <div class="form-text">{{ t(`designer.fieldProp.${pr.key}`) }}</div>
            </div>
            <!-- what else its type takes : added from a list, its description beside each -->
            <div v-if="fieldsEditable && addableProps(f).length" class="af-field-values">
              <select
                @mouseenter="fullTitle"
                class="form-select af-form-add"
                :value="''"
                @change="
                  addProp(f, $event.target.value);
                  $event.target.value = '';
                "
              >
                <option value="">{{ t('designer.visualAddProperty') }}</option>
                <option v-for="pr in addableProps(f)" :key="pr.key" :value="pr.key">
                  {{ pr.key }} - {{ t(`designer.fieldProp.${pr.key}`) }}
                </option>
              </select>
            </div>
          </div>
        </template>
      </div>
    </template>
    <!-- Modal - delete field verify -->
    <BsModal v-if="rowToDelete" @close="rowToDelete = null" icon="trash">
      <template #title> {{ t('designer.visualDeleteField') }} </template>
      <template #default>
        <p class="mt-3 fs-6 user-select-none">
          {{ t('designer.deleteConfirm') }} <strong>{{ rowToDelete.name || '?' }}</strong
          >?
        </p>
      </template>
      <template #footer>
        <BsButton icon="trash" @click="confirmRemoveRow()">{{ t('common.delete') }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>
<style scoped lang="scss">
/* the form's fields : three short ones per line, sharing the pane's width ; a wide one
   (description, help, lists, options) on a line of its own */
.af-form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem 1.5rem;
}
.af-form-wide {
  grid-column: 1 / -1;
}
.af-form-span2 {
  grid-column: span 2;
}
/* starts a row of its own (the type under the name, the description under the type) ;
   'span 2' alone is a start, so a wide one says both */
.af-form-newrow {
  grid-column: 1;
}
.af-form-span2.af-form-newrow {
  grid-column: 1 / span 2;
}
/* a category or a role it has : a pill, its cross removes it */
.af-form-pill {
  display: inline-flex;
  align-items: center;
  padding: 0.35em 0.6em;
  font-weight: 500;
  color: var(--bs-body-color);
  background-color: var(--bs-tertiary-bg);
  border: 1px solid var(--af-field-border);
  .btn-close {
    font-size: 0.55rem;
  }
}
/* the list to add from : as small as the pills beside it */
.af-form-add {
  width: auto;
  min-width: 10rem;
}
/* the fields : one row each, the same columns for the header line, as the categories' ; a pane
   narrower than them scrolls sideways rather than squeezing the fields */
.af-cats {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.af-cats-row {
  display: grid;
  /* name and label share the room ; the last as wide as its buttons (two moves, the gap, Delete) */
  grid-template-columns: 1.75rem minmax(10rem, 1fr) 11rem minmax(10rem, 1fr) 6.5rem 8rem;
  gap: 0.75rem;
  align-items: center;
  min-width: 52rem;
}
.af-cats-head {
  font-weight: 700;
}
/* a field's caret : its other properties folded or not */
.af-field-caret {
  color: var(--bs-secondary-color);
  text-decoration: none;
}
/* a field's other properties : under its row, past its caret, framed as a sub-part of it */
.af-field-details {
  display: grid;
  /* its help and default, then the output switch ; a wide one (values, YAML) on its own */
  grid-template-columns: repeat(2, minmax(10rem, 1fr)) auto;
  gap: 0.75rem 1rem;
  margin: 0 0 0.5rem 2.5rem;
  padding: 0.75rem 1rem;
  border-left: 2px solid var(--af-field-border);
}
.af-field-values {
  grid-column: 1 / -1;
}
/* a property's name as the YAML writes it, and its cross */
.af-prop-key {
  font-weight: 600;
  color: var(--bs-body-color);
}
/* a nested setting on (notifications, approval) : its keys under its switch, framed as a part
   of it */
.af-nested {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  border-left: 2px solid var(--af-field-border);
}
/* a credential : its extravar's name, the credential, Delete */
.af-cred-row {
  display: grid;
  grid-template-columns: minmax(10rem, 1fr) minmax(10rem, 1fr) auto;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.af-prop-remove {
  font-size: 0.55rem;
}
/* the description and the help : the same height, three lines at the start, at most ten when
   dragged taller (a line : 1.5em ; the box : its padding and border) */
.af-text-box {
  min-height: calc(3 * 1.5em + 0.75rem + 2px);
  max-height: calc(10 * 1.5em + 0.75rem + 2px);
  resize: vertical;
}
/* the form's switches : four columns of two, filled column by column, each column as wide as
   its longer label */
.af-form-flags {
  display: grid;
  grid-template-rows: repeat(2, auto);
  grid-auto-flow: column;
  grid-auto-columns: max-content;
  gap: 0.5rem 2.5rem;
}
</style>
