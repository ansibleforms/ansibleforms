<script setup>
/******************************************************************/
/*                                                                */
/*  App Admin Multi component                                     */
/*  Creates a table with CRUD actions for a given object type     */
/*  Optional actions: test, preview, trigger                      */
/*                                                                */
/*  @props:                                                       */
/*      settings: Object                                          */
/*      busyItems: Object                                         */
/*                                                                */
/*  @emits:                                                       */
/*      test: Object                                              */
/*      preview: Object                                           */
/*      trigger: Object                                           */
/*                                                                */
/*  settings.steps: [{ key, label, when }] - the record dialog in */
/*      steps (a wizard) : a field names its step (field.step,    */
/*      the first one when it names none) ; when(item) keeps a    */
/*      step to the records it applies to. Creating walks the     */
/*      steps with Previous / Next and saves on the last ;        */
/*      editing may jump to any step and save from any            */
/*      ; notes(item) gives a step its help, shown above its      */
/*      fields : [{ title, text, items }]                         */
/*  settings.beforeSave: (item) => object - what a create or an   */
/*      update sends, from the dialog's values                    */
/*  settings.defaultPicker: { key, groupBy, groups, title,        */
/*      editLabel } - the default of each group chosen in a       */
/*      dialog : groupBy (a key, or (row) => group) sorts the     */
/*      rows, groups [{ key, label, help, icon, describe }] are   */
/*      its choices ; Save sets them (a runner's : playbooks,     */
/*      templates)                                                */
/*  field.initial: (item) => value - a dialog-only field's value  */
/*      on opening, from the record (not stored ; beforeSave      */
/*      drops it)                                                 */
/*  field.type 'radio' with field.options [{ value, label, hint,  */
/*      icon }] : one choice, radio buttons at the dialog's left  */
/*      edge, each its icon (optional), label and a few words     */
/*  field.nested: a radio group that follows up the one above it  */
/*      (AWX : which product) - indented, with its label as title */
/*  field.flush: a switch at the dialog's left edge, its help the */
/*      full width under it                                       */
/*  field.showWhen: (item) => Boolean - shown by a rule of its    */
/*      own, instead of field.dependency                          */
/*  field.suffix: a fixed text after the input, not in its value  */
/*      (a text, or (item) => text)                               */
/*  field.help / field.placeholder / field.dialogLabel: a text,   */
/*      or (item) => text, following the record shown (its type) */
/*  field.onEdit: a password shown when editing too, as ******** ;*/
/*      left empty it is not sent, so the stored one stays        */
/*  field.keepHelp: the help of an onEdit field when editing      */
/*  field.columnType 'checkbox': a yes / no column, for a field   */
/*      that is no checkbox in the dialog (a radio of true/false) */
/*  field.createWith: a key of config/settings.js - a select gets */
/*      a New button under it (createLabel), the dialog of that   */
/*      list opens over this one and selects what it creates ;   */
/*      createDefaults is what that New presets                   */
/*  field.needsChoicesOf: the key of a dropdown (createWith) - the*/
/*      field is hidden while that one has nothing to choose      */
/*  field.choicesWhen: (choice, item) => Boolean - the choices of */
/*      a dropdown kept (an smtp login : the smtp credentials)    */
/*  field.shortLabel / shortHint: a checkbox at the dialog's left */
/*      edge, its short label and a few grey words on one line ;  */
/*      a step's short checkboxes are alphabetical                */
/*  field.oneOnly: a checkbox the app uses on one record only -    */
/*      greyed out, with who has it, when another record has it   */
/*  dialogOnly (prop): no list, only the record dialogs : another */
/*      dialog opens newItem() (exposed) to create a record, and  */
/*      gets `created` with its name                              */
/*  canCreateChoices (prop): a dialogOnly dialog that keeps its   */
/*      dropdowns' New buttons (a page opens it, not a dialog)    */
/*  field.createDefaults: what a New record is preset with, or    */
/*      (item) => that, from the record being edited              */
/*  field.rows: the lines of a textarea field (3 when not given)  */
/*  field.columnLabel: the column's title, when shorter than the  */
/*      field's label in the dialog                               */
/*  action.to: (item) => route - the action goes to a page        */
/*  action.shownWhen: (item) => boolean - the action is in the    */
/*      menu of the records it returns true for only (an LDAP     */
/*      user's Block sign-in ; a local user's Change password)    */
/*  action.update: (item) => object - the action saves those      */
/*      fields of the record (Use for sign-in), then reloads      */
/*  action.dividerBefore: a line above it in the row menu, apart  */
/*      from the actions before it (Delete always has one)        */
/*  action.enabledWhen: (item) => boolean - the action is off for */
/*      the records it returns false for (greyed out ; a delete's */
/*      also greys the record's checkbox)                         */
/*  settings.listQuery: '?directory=1' - added to the list's read */
/*      (the LDAP and SSO users beside the local ones)            */
/*  settings.openPage: (item) => path - a record has its own page */
/*      (a user's) : its row and its Edit open that page instead  */
/*      of the record dialog ; New still opens the dialog         */
/*  a cell's [data-af-popover] : its text in a popover on hover   */
/*      (a cron's meaning in words, lib/cronCell.js)              */
/*                                                                */
/******************************************************************/

import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import { watch } from 'vue';
import { toast } from 'vue-sonner';
import { useCellPopovers } from '@/composables/useCellPopovers';
import { useRouter } from 'vue-router';
import axios from 'axios';
import Helpers from '@/lib/Helpers';
import { useVuelidate } from '@vuelidate/core';
import yaml from 'yaml';
import { required, requiredIf, helpers, email, sameAs } from '@vuelidate/validators';
import { useI18n } from 'vue-i18n';
import BsDataTable from './BsDataTable.vue';
import getSettings, { noCredentialsText } from '@/config/settings';
import { inSentence } from '@/lib/inSentence';
import { rememberRows } from '@/lib/recordButtons';
import { tableControls } from '@/lib/listControls';
import { askConfirm } from '@/lib/confirmPrompt';

// INIT

// where the table's toolbar goes on the title line (one per instance)
const toolsId = `af-tools-${Math.random().toString(36).slice(2, 10)}`;
// and where its pager goes, under the card (one per instance)
const pagerId = `af-pager-${Math.random().toString(36).slice(2, 10)}`;
const { t, locale } = useI18n();
const router = useRouter();
const emit = defineEmits([
  'test',
  'preview',
  'trigger',
  'reset',
  'sync',
  'created',
  'block_sign_in',
  'allow_sign_in',
  'move_up',
  'move_down',
  'download',
]);

// PROPS

const props = defineProps({
  settings: {
    type: Object,
    required: true,
  },
  // a title in steps (AppSettings' crumbs) : a page that holds the list in one of its tabs
  // (SSO › Providers)
  crumbs: {
    type: Array,
    default: () => [],
  },
  busyItems: {
    type: Object,
    default: () => ({}),
  },
  apiVersion: {
    type: [String, Number],
    default: 2,
  },
  // no list, only the record dialogs : another dialog's New button creates a record with it
  dialogOnly: {
    type: Boolean,
    default: false,
  },
  // a dialogOnly dialog a page opens (the designer's New inventory), not another dialog : its
  // dropdowns keep their New buttons (a repository's New credential). The dialogs those open
  // are dialogOnly without it, so nothing opens without end.
  canCreateChoices: {
    type: Boolean,
    default: false,
  },
  // shown, never changed : no Add, no defaults, no Edit, Delete or Change password (a page
  // whose writes the user's role does not allow, the runners for a non-admin)
  readOnly: {
    type: Boolean,
    default: false,
  },
});

// DATA

const itemList = ref([]);
const parentLists = ref({});
const childLists = ref({});
const loading = ref(false);
const itemId = ref(undefined);
const action = ref('');
const pagination = ref({ currentId: undefined, enabled: true });
const activeChild = ref(0);
const interval = ref(null);
const config = ref({});

// flatten
const isFlat = props.settings.flat || false;
const reloadSeconds = props.settings.reloadSeconds === false ? false : (props.settings.reloadSeconds || 60) * 1000;
const removeDoubles = props.settings.removeDoubles || false;
const idKey = props.settings.idKey || 'id';
const objectType = props.settings.type;
const objectLabel = computed(() => props.settings.label || '');
// in a sentence (Add repository, Edit repository) : lowered, but an acronym or a German noun
// in a sentence (Add runner) : lower case, unless the label is a name the app always writes with
// its capital (settings.properNoun : Runner)
const objectLabelInSentence = computed(() =>
  props.settings.properNoun ? objectLabel.value : inSentence(objectLabel.value, locale.value),
);
const objectLabelPlural = computed(() => props.settings.labelPlural || `${objectLabel.value}s`);
const objectIcon = computed(() => props.settings.icon);
const objectDescription = computed(() => props.settings.description || '');
const children = computed(() => props.settings.children || []);
const actions = computed(() => props.settings.actions || []);
const fields = computed(() => props.settings.fields || []);
const childFields = computed(() => props.settings.childFields || {});
const noCreate = computed(() => props.settings.noCreate === true || props.readOnly);

// VUELIDATE
// the messages are translated, the field's label in them (settings.common.field*), and read
// when shown : a change of language follows without rebuilding the rules

function getRules() {
  const ruleObj = { item: {} };
  fields.value.forEach((field) => {
    var rule = {};
    if (field.required && field.dependency && Array.isArray(field.dependencyValues)) {
      // a field of some types only (an Entra ID credential's tenant) : required while it is shown
      rule.required = helpers.withMessage(
        () => t('settings.common.fieldRequired', { field: field.label }),
        requiredIf(() => field.dependencyValues.includes(item.value[field.dependency])),
      );
    } else if (field.requiredWhen) {
      // required by a rule of its own (an smtp credential's host : its mail server)
      rule.required = helpers.withMessage(
        () => t('settings.common.fieldRequired', { field: field.label }),
        requiredIf(() => !!field.requiredWhen(item.value)),
      );
    } else if (field.required) {
      rule.required = helpers.withMessage(() => t('settings.common.fieldRequired', { field: field.label }), required);
    }
    if (field.type == 'email') {
      rule.email = helpers.withMessage(() => t('settings.common.fieldEmail', { field: field.label }), email);
    }
    if (field.type == 'checkbox' && field.required) {
      rule.checkboxRequired = helpers.withMessage(
        () => t('settings.common.fieldRequired', { field: field.label }),
        sameAs(computed(() => true)),
      );
    }
    // regex validation
    if (field.regex && field.regex.expression) {
      // a malformed pattern must not throw out of the rules builder and take the
      // whole form down - report it and skip the rule, as AppForm does
      var regexObj = null;
      try {
        regexObj = new RegExp(field.regex.expression);
      } catch (e) {
        console.error(
          `Field '${field.key || field.label}': invalid regex '${field.regex.expression}' (${e.message}); the rule is ignored.`,
        );
      }
      var description = field.regex.description;
      // only when there is a usable pattern - otherwise regexObj.test would
      // throw at validation time instead
      if (regexObj) {
        rule.regex = helpers.withMessage(description, (value) => !helpers.req(value) || regexObj.test(value));
      }
    }
    // A field can also carry a FUNCTION validator, returning the reason it is
    // invalid or '' when it is fine. A regex cannot express every rule - the cron
    // fields need "the start of a range must not exceed its end", which is why
    // they saved values croner then refused, leaving the job unregistered and the
    // page reporting success. The message is dynamic, so it rides on $response
    // rather than being fixed when the rule is built.
    if (typeof field.validator === 'function') {
      const check = field.validator;
      rule.custom = helpers.withMessage(
        ({ $response }) => $response || t('settings.common.fieldInvalid', { field: field.label }),
        (value) => {
          if (!helpers.req(value)) return true;
          let message;
          try {
            message = check(value) || '';
          } catch (e) {
            // a throwing validator must not take the whole form down, as
            // the regex branch above already guards against
            console.error(`Field '${field.key || field.label}': validator threw (${e.message}); the rule is ignored.`);
            return true;
          }
          return message ? { $valid: false, $response: message } : true;
        },
      );
    }
    if (field.type == 'editor' && field.lang == 'yaml') {
      rule.editorType = helpers.withMessage(
        () => t('settings.common.fieldYaml', { field: field.label }),
        (value) => {
          if (!helpers.req(value)) return true;
          try {
            const parsed = yaml.parse(value);
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
          } catch (e) {
            return false;
          }
        },
      );
    }
    ruleObj.item[field.key] = rule;
    // if (field.type == 'password') {
    //     rule = {}
    //     rule.password_comfirmation = sameAs(computed(() => item.value.password))
    //     ruleObj.item["password2"] = rule
    // }
  });
  return ruleObj;
}
const item = ref({});
const rules = computed(() => getRules());
const $v = useVuelidate(rules, { item });

// METHODS

function objectTitle(prefix = '', suffix = '') {
  return `${prefix} ${objectLabel.value} ${suffix}`.trim();
}
// Selection state only - see loadItems for why the list is no longer blanked here.
function resetSelection() {
  itemId.value = undefined;
  pagination.value.currentId = undefined; // reset selected item
  action.value = '';
}
// Keep only ids that still exist in the loaded list. Assigning a new Set rather than
// mutating, because BsDataTable takes selectedIds as a prop and compares by identity.
function pruneSelection() {
  if (!selectedIds.value.size) return;
  const present = new Set((itemList.value || []).map((r) => r[idKey]));
  const kept = [...selectedIds.value].filter((id) => present.has(id));
  if (kept.length !== selectedIds.value.size) selectedIds.value = new Set(kept);
}
async function loadItems(force = true) {
  // if the offcanvas or a confirmation is open, do not load items.
  // 'delete' belongs here too: it was missing, so the 60 second auto-reload ran
  // resetItems(), which clears action - and the delete confirmation simply vanished
  // with nothing deleted and no message, on a timer, while the user was reading it.
  if (['select', 'edit', 'new', 'change_password', 'delete'].includes(action.value) && !force) {
    return;
  }
  // Clear the SELECTION, not the list.
  //
  // resetItems() blanked itemList before the request, so on every 60 second refresh
  // BsPagination briefly saw an empty dataList: its clamp watcher then called
  // setPage(1) and the reader was thrown back to page 1 mid-read. (BsDataTable
  // already stopped re-keying the paginator on a data change for this same reason;
  // this was the other half.) Assigning the new list when it arrives also removes
  // the "no data" flicker.
  resetSelection();
  // the rows the list shows : all, or those settings.rowFilter keeps (the runners waiting for
  // approval are in a table of their own above it)
  const rows = await loadList(objectType, isFlat, undefined, props.settings.listQuery || '');
  itemList.value =
    typeof props.settings.rowFilter === 'function' && Array.isArray(rows)
      ? rows.filter(props.settings.rowFilter)
      : rows;
  // kept for the records' pages : which buttons a record has, before it is read (lib/recordButtons.js)
  rememberRows(objectType, itemList.value);
  // Drop selected rows that are no longer there. resetSelection() clears the SINGLE
  // item selection (the offcanvas), not the multi-select set, so without this the
  // toolbar kept counting rows that had been deleted - by this admin elsewhere, by
  // another one, or by whatever writes the underlying file - and a bulk action was
  // sized off a number that no longer described anything on screen. Ids are stable
  // (see flatRow), so a row that is still there keeps its selection across the
  // 60 second reload, which is the point of not simply clearing it.
  pruneSelection();
  for (const field of fields.value) {
    if (field.parent && field.values && typeof field.values == 'string') {
      // a dropdown source can live on another api version than the page
      // itself
      const list = await loadList(field.values, false, field.valuesApiVersion);
      // an optional reference (a credential's secret store) must be clearable : a
      // select has no way back to "nothing" without an empty option
      parentLists.value[field.parent] = field.clearable
        ? [{ [field.valueKey]: '', [field.labelKey]: '' }, ...list]
        : list;
    }
    if (field.parent && field.values && Array.isArray(field.values)) {
      parentLists.value[field.parent] = field.values;
    }
  }
}
/**
 * A row for a FLAT list, whose records are bare values (known hosts are ssh key lines).
 *
 * The id is the VALUE, not the array index. An index is positional, and this list is
 * reloaded every 60 seconds while `selectedIds` survives that reload - so once anything
 * added or removed an entry, every selected index pointed at a DIFFERENT row and bulk
 * delete removed the wrong host keys, behind a confirmation that only says
 * "Delete N item(s)?". The known_hosts file changes exactly when this page is in use
 * (a repository clone or pull over ssh adds to it), so that was not a rare race.
 *
 * The value is also what the delete endpoint takes (`?name=`), so id and name being the
 * same thing is the honest model here rather than a coincidence.
 */
function flatRow(value) {
  const name = String(value);
  return { id: name, name };
}
async function loadList(type, isFlat = false, version = undefined, query = '') {
  const apiVersion = version || props.apiVersion;
  try {
    const result = await axios.get(`/api/v${apiVersion}/${type}/${query}`);
    if (apiVersion == 2) {
      if (isFlat) {
        const records = Array.isArray(result.data.records) ? result.data.records : [];
        if (records.length === 0) return [];
        // If primitives (strings/numbers)
        if (typeof records[0] !== 'object' || records[0] === null) {
          const deduped = removeDoubles ? Array.from(new Set(records)) : records;
          return deduped.map((val) => flatRow(val));
        }
        // Objects: ensure id & name exist generically
        return records.map((obj, idx) => {
          const out = { ...obj };
          // establish id
          if (out[idKey] === undefined && out.id === undefined) {
            out.id = idx;
          } else if (out.id === undefined) {
            out.id = out[idKey];
          }
          // establish name fallback (used in selection/delete modals)
          if (out.name === undefined) {
            const fallback = out[idKey] ?? out.id ?? out.label ?? `item_${idx}`;
            out.name = String(fallback);
          }
          return out;
        });
      }
      return result.data.records;
    } else {
      throw new Error('Unsupported API version');
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to load data'));
    // an empty list, never undefined : every caller spreads or filters it, so a list the user
    // may not read (a 403) threw "is not iterable" on top of the message above
    return [];
  }
}
// set while a record is being read into `item`, so the dependency watchers above do
// not mistake the load for a user edit
const loadingItem = ref(false);
async function loadItem() {
  if (itemId.value) {
    loadingItem.value = true;
    try {
      var result;
      if (isFlat) {
        // find by id, NOT itemList[itemId] : that indexed the array by the id,
        // which only worked while a flat id happened to BE the array index. It
        // is the value now (see flatRow), and it was already wrong for a flat
        // list of objects, where loadList sets id from the record's own idKey.
        item.value = itemList.value.find((r) => r[idKey] === itemId.value);
      } else {
        result = await axios.get(`/api/v${props.apiVersion}/${objectType}/${itemId.value}`);
        item.value = result.data;
        for (const field of fields.value) {
          if (field.type == 'checkbox') {
            item.value[field.key] = !!item.value[field.key];
          }
          if (field.type == 'editor' && item.value[field.key] === null) {
            item.value[field.key] = '';
          }
          // if (field.isKey) {
          //     itemPassword.value[field.key] = item.value[field.key]
          // }
        }
        // the dialog-only fields (a radio of what the record is) : their value from the record
        setInitialValues();
        delete item.value.password; // remove password ; updates don't need password
        delete item.value.token; // remove token, update don't need token
        delete item.value.client_secret; // do not return client_secret in the API
        // TODO : in de future, do not return passwords in the api

        for (const childList of children.value) {
          childLists.value[childList.type] = (await loadList(childList.type)).filter(
            // a list key (a user's group_ids) : the record is one of them
            (child) =>
              Array.isArray(child[childList.key])
                ? child[childList.key].includes(itemId.value)
                : child[childList.key] == itemId.value,
          );
        }
      }
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, 'Failed to load item'));
    } finally {
      // released on the error path too, or every later dependency change on
      // this page would be ignored
      await nextTick();
      loadingItem.value = false;
    }
  }
}
// What to call the record in the delete confirmation.
//
// `selectedItem.name` alone rendered an empty bold span for anything without a `name`
// column - backups are keyed by `folder` (describeBackup returns no name at all), so
// the prompt read "Are you sure you want to delete ?" and you could not tell which
// backup you were about to destroy. Falls back through the page's own key.
const deleteLabel = computed(() => {
  const it = selectedItem.value;
  if (!it) return '';
  return it.name ?? it.title ?? it.username ?? it[idKey] ?? it.id ?? '';
});

async function selectItem(value) {
  itemId.value = value[idKey];
  pagination.value.currentId = value[idKey];
  await loadItem();
  action.value = 'select';
  removeUnwantedProperties();
  // Set defaults for all fields with defaultMap
  fields.value.forEach((field) => {
    if (field.defaultMap && field.dependency && item.value[field.dependency] && !item.value[field.key]) {
      console.log('Setting default');
      setFieldDefaults(field.dependency);
    }
  });
}
async function editItem(value) {
  itemId.value = value[idKey];
  pagination.value.currentId = value[idKey];
  await loadItem();
  action.value = 'edit';
  removeUnwantedProperties();
  // Set defaults for all fields with defaultMap
  fields.value.forEach((field) => {
    if (field.defaultMap && field.dependency && item.value[field.dependency] && !item.value[field.key]) {
      console.log('Setting default');
      setFieldDefaults(field.dependency);
    }
  });
}
function setItemProperty(setting) {
  // to set a property of an item (example status for repos)
  const founditem = itemList.value.find((x) => {
    return x[idKey] == setting.id;
  });
  if (founditem) {
    founditem[setting.key] = setting.value;
  }
}
async function changePasswordItem(value) {
  itemId.value = value[idKey];
  await loadItem();
  action.value = 'change_password';
  item.value.password = '';
  item.value.client_secret = ''; // reset client secret
  item.value.token = '';
  pagination.value.currentId = value[idKey];
  removeUnwantedProperties();
}
async function deleteItem(value) {
  itemId.value = value[idKey];
  await loadItem();
  action.value = 'delete';
  pagination.value.currentId = value[idKey];
}
function unselectItem() {
  itemId.value = undefined;
  pagination.value.currentId = undefined;
  action.value = '';
}
/**
 * Gives the dialog-only fields (field.initial) their value from the record shown.
 */
function setInitialValues() {
  for (const field of fields.value) {
    if (typeof field.initial === 'function') item.value[field.key] = field.initial(item.value);
  }
}

/**
 * What a create or an update sends : the dialog's values, shaped by settings.beforeSave.
 *
 * Returns:
 *   object: the request body.
 */
function savePayload() {
  const body =
    typeof props.settings.beforeSave === 'function' ? props.settings.beforeSave({ ...item.value }) : { ...item.value };
  // a password shown when editing (onEdit) and left empty : the stored one stays
  for (const field of fields.value) {
    if (field.onEdit && field.type == 'password' && !body[field.key]) delete body[field.key];
  }
  return body;
}

function newItem(defaults = {}) {
  item.value = {};
  setInitialValues();
  // what the dialog that asked for it presets (a git credential, from a repository's dialog)
  Object.assign(item.value, defaults);
  fields.value.forEach((field) => {
    if (field.type === 'editor' && item.value[field.key] === undefined) {
      item.value[field.key] = '';
    }
    if (field.type === 'select' && field.parent && field.valueKey) {
      const list = parentLists.value[field.parent] || [];
      if (list.length > 0 && item.value[field.key] === undefined) {
        item.value[field.key] = list[0][field.valueKey];
      }
    }
  });
  // the defaults of a field that follows another set from the start (an SSO provider is Entra ID
  // at first : its redirect URL, on the first step, from the app's address)
  fields.value.forEach((field) => {
    if (field.defaultMap && field.dependency && item.value[field.dependency] && !item.value[field.key]) {
      setFieldDefaults(field.dependency);
    }
  });
  action.value = 'new';
}
async function createItem() {
  var invalid = isInvalid.value;
  if (!invalid) {
    try {
      await axios.post(`/api/v${props.apiVersion}/${objectType}/`, savePayload());
      toast.success(t('settings.common.nameCreated', { name: objectTitle('') }));
      // the dialog that asked for it (a dropdown's New button) selects what was created
      emit('created', item.value.name ?? item.value[idKey]);
      if (props.dialogOnly) unselectItem();
      loadItems();
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, 'Failed to save item'));
    }
  } else {
    $v.value.item.$touch();
  }
}
async function updateItem(passwordOnly = false) {
  var invalid;
  if (passwordOnly) {
    invalid = isInvalidPassword.value;
  } else {
    invalid = isInvalid.value;
  }
  if (!invalid) {
    try {
      await axios.put(
        `/api/v${props.apiVersion}/${objectType}/${itemId.value}`,
        passwordOnly ? item.value : savePayload(),
      );
      toast.success(t('settings.common.nameUpdated', { name: objectTitle('') }));
      loadItems();
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, 'Failed to update item'));
    }
  } else {
    $v.value.item.$touch();
  }
}
async function removeItem() {
  try {
    if (isFlat) {
      await axios.delete(`/api/v${props.apiVersion}/${objectType}?name=${encodeURIComponent(item.value.name)}`);
    } else {
      await axios.delete(`/api/v${props.apiVersion}/${objectType}/${itemId.value}`);
    }
    toast.success(t('settings.common.nameDeleted', { name: objectTitle('') }));
    unselectItem();
    loadItems();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to delete item'));
  }
}
function testItem(value) {
  emit('test', value);
}
function previewItem(value) {
  emit('preview', value);
}
function triggerItem(value) {
  emit('trigger', value);
}
function resetItem(value) {
  emit('reset', value);
}
function getParentValues(key) {
  if (!key) return [];
  if (Array.isArray(key)) return key;
  if (!parentLists.value) return [];
  return parentLists.value[key] || [];
}

/**
 * The choices of a dropdown : its list's records, those field.choicesWhen keeps (the smtp
 * credentials only, for a mail server's login).
 *
 * Args:
 *   field (object): the field.
 *
 * Returns:
 *   object[]: the choices.
 */
function choicesOf(field) {
  const all = getParentValues(field.parent);
  return typeof field.choicesWhen === 'function' ? all.filter((c) => field.choicesWhen(c, item.value || {})) : all;
}

function showField(field) {
  // Only hide if noInput is set, not readonly
  if (field.noInput) return false;
  // a field that means nothing until another dropdown has a choice (a secret's reference,
  // with no secret store yet) : hidden until then
  if (field.needsChoicesOf) {
    const other = fields.value.find((f) => f.key === field.needsChoicesOf);
    if (other && noChoices(other)) return false;
  }
  let depShow = true;
  // a field shown by a rule of its own (field.showWhen(item)) : the user of a Jenkins runner,
  // or of an AWX signing in with a user and password
  if (field.showWhen) {
    depShow = !!field.showWhen(item.value);
  } else if (field.dependency) {
    const depValue = item.value[field.dependency];
    if (Array.isArray(field.dependencyValues)) {
      depShow = field.dependencyValues.includes(depValue);
    } else if (field.negateDependency) {
      depShow = !depValue;
    } else {
      depShow = depValue;
    }
  }
  if (field.type == 'password' && ['new', 'change_password'].includes(action.value)) return depShow;
  // a password the record's dialog may change (onEdit) : empty, kept as it is
  if (field.type == 'password' && field.onEdit && action.value == 'edit') return depShow;
  if (field.type != 'password' && action.value == 'change_password') return false;
  if (field.type == 'password' && action.value != 'change_password') return false;
  return depShow;
}

// Set dynamic defaults for fields with defaultMap when dependency changes
function setFieldDefaults(depKey) {
  fields.value.forEach((field) => {
    if (field.defaultMap && field.dependency === depKey) {
      const depValue = item.value[depKey];
      const def = field.defaultMap[depValue];
      if (typeof def === 'function') {
        item.value[field.key] = def(config.value);
      } else if (def !== undefined) {
        item.value[field.key] = def;
      }
    }
  });
}

// Recompute a dependent default only when the USER changed the dependency.
//
// loadItem replaces item.value wholesale, so loading an existing record moves e.g.
// `provider` from undefined to 'azuread' and this watcher fired - and
// setFieldDefaults has no "only when empty" guard, unlike the loops in
// selectItem/editItem that spell that rule out. So opening an OAuth2 provider whose
// redirect_uri had been customised replaced it with the computed default, and Save
// then persisted that: the custom callback URL was lost by merely looking at it.
//
// The watcher cannot tell a load from an edit by itself, so the load says so.
fields.value.forEach((field) => {
  if (field.dependency) {
    watch(
      () => item.value[field.dependency],
      () => {
        if (loadingItem.value) return;
        setFieldDefaults(field.dependency);
      },
    );
  }
});

// Load config (AnsibleForms URL) on mount
onMounted(async () => {
  try {
    const result = await axios.get(`/api/v2/settings`);
    config.value = result.data;
  } catch (err) {
    // fallback: leave config empty
  }
});
function removeUnwantedProperties() {
  for (const field of fields.value) {
    if (field.type == 'password' && !['new', 'change_password'].includes(action.value)) {
      delete item.value[field.key];
    }
    if (
      field.type != 'password' &&
      field.key != idKey &&
      !field.password_related &&
      action.value == 'change_password'
    ) {
      delete item.value[field.key];
    }
  }
}

// COMPUTED

const selectedItem = computed(() => {
  return itemList.value.find((item) => item[idKey] == itemId.value);
});
const title = computed(() => {
  if (action.value == 'change_password') {
    return t('settings.common.changePassword');
  }
  if (action.value == 'new') {
    return t('settings.common.newItem', { item: objectLabelInSentence.value });
  } else if (action.value == 'edit') {
    return `${t('settings.common.edit')} ${objectLabelInSentence.value}`;
  } else {
    return objectLabel.value;
  }
});

/**
 * A field's help, placeholder or dialog label : a text, or a function of the record shown (a
 * runner's address help, by its type).
 *
 * Args:
 *   value (string|function): the text, or (item) => text.
 *
 * Returns:
 *   string: the text for the record shown.
 */
function textOf(value) {
  // a rule gets the record and the app's settings (its URL : an SSO credential's redirect URL)
  return typeof value === 'function' ? value(item.value || {}, config.value || {}) : value;
}

// ─── create from a dropdown ──────────────────────────────────────────────────
// A select field with `createWith` (a key of config/settings.js) gets a New button under it :
// the dialog of that list opens over this one, and what it creates is selected here.
const allSettings = computed(() => getSettings(t));
// A dialog opened from another one (dialogOnly) creates nothing itself : two lists that can
// create each other's records (a credential its secret store, a secret store its credential)
// would otherwise mount each other's dialogs without end, and the page would never render.
const createsChoices = computed(() => !props.dialogOnly || props.canCreateChoices);
const createFields = computed(() =>
  createsChoices.value ? fields.value.filter((f) => f.createWith && allSettings.value[f.createWith]) : [],
);
const creators = {};

/**
 * A dropdown that can create its choice (createWith) with nothing to choose yet : its list
 * empty, or only the blank entry of a clearable one.
 *
 * Args:
 *   field (object): the dropdown field.
 *
 * Returns:
 *   boolean: true when only its New button is worth showing.
 */
function noChoices(field) {
  if (!createsChoices.value || !field.createWith || !allSettings.value[field.createWith] || !field.parent) return false;
  // what it offers : its choicesWhen applied (a runner's credentials of its kind only)
  return !choicesOf(field).some((v) => v?.[field.valueKey]);
}

/**
 * What a credential dropdown with nothing to choose says, disabled : no credential of the type its
 * New button makes yet. Another dropdown with nothing to choose shows its New button only.
 *
 * Args:
 *   field (object): the select field.
 *
 * Returns:
 *   string: the message, or '' when it is not a credential dropdown of one type.
 */
function emptyTextOf(field) {
  if (field.createWith !== 'credentials') return '';
  const type = textOf(field.createDefaults)?.credential_type;
  return type ? noCredentialsText(t, type) : '';
}

/**
 * Reloads a dropdown's choices and selects the record just created through its New button.
 *
 * Args:
 *   field (object): the select field.
 *   name (string): the name of the record created.
 */
async function onCreated(field, name) {
  const list = await loadList(field.values, false, field.valuesApiVersion);
  parentLists.value[field.parent] = field.clearable ? [{ [field.valueKey]: '', [field.labelKey]: '' }, ...list] : list;
  if (name !== undefined && name !== null) item.value[field.key] = name;
}

// ─── wizard ───────────────────────────────────────────────────────────────────
// A long record dialog in steps : settings.steps lists them ({ key, label }) and a field names
// its step (`step`, the first step when it names none). Creating walks the steps with Previous
// / Next and saves on the last ; editing may jump to any step and save from any. Viewing a
// record and changing its password stay one page.
// the steps that apply to the record (a step's when(item))
const steps = computed(() =>
  (props.settings.steps || []).filter((step) => typeof step.when !== 'function' || step.when(item.value || {})),
);
const wizardActive = computed(() => steps.value.length > 0 && ['new', 'edit'].includes(action.value));
const stepIndex = ref(0);
// the furthest step reached while creating : the step strip goes back to those, not past them
const stepReached = ref(0);
watch(action, () => {
  stepIndex.value = 0;
  stepReached.value = 0;
});

// ─── Change password : the shared dialog ──────────────────────────────────────
// a record's password (a user's, a credential's) changes in AppChangePasswordDialog, typed twice ;
// an SSO provider's client secret too, asked once (pasted from the provider's console) and named
// by its row menu's title (Change secret). A token keeps the record dialog.
const secretField = computed(() => fields.value.find((f) => ['password', 'client_secret'].includes(f.key)) || null);
const usesPasswordDialog = computed(() => action.value === 'change_password' && !!secretField.value);
const changePasswordTitle = computed(() => actions.value.find((a) => a.name === 'change_password')?.title || '');

/**
 * Saves the password or the secret the shared dialog hands over.
 *
 * Args:
 *   secret (string): the new password (typed twice) or client secret.
 */
function savePasswordFromDialog(secret) {
  item.value[secretField.value.key] = secret;
  updateItem(true);
}
const isLastStep = computed(() => stepIndex.value === steps.value.length - 1);
// the help of the step shown (a step's notes(item)) : what to know before filling it in, as
// the permissions a provider needs
const stepNotes = computed(() => {
  const step = wizardActive.value ? steps.value[stepIndex.value] : null;
  return step && typeof step.notes === 'function' ? step.notes(item.value || {}).filter(Boolean) : [];
});

/**
 * Whether a field is on the step shown (every field when the dialog is no wizard).
 *
 * Args:
 *   field (object): the field definition.
 *
 * Returns:
 *   boolean: true when it is shown on this step.
 */
function onStep(field) {
  if (!wizardActive.value) return true;
  return (field.step || steps.value[0].key) === steps.value[stepIndex.value]?.key;
}

/**
 * The other record that already has a one-only checkbox ticked (`oneOnly` : the app uses a
 * single one, a repository's config.yaml for instance) ; this one may then not tick it.
 *
 * Args:
 *   field (object): the checkbox field.
 *
 * Returns:
 *   string|null: that record's name, or null when no other record has it.
 */
function takenBy(field) {
  if (!field.oneOnly || item.value[field.key]) return null;
  const other = (itemList.value || []).find(
    (r) => r[field.key] && r[idKey] !== item.value[idKey] && (r.name ?? r[idKey]) !== item.value.name,
  );
  return other ? (other.name ?? other[idKey]) : null;
}

// the fields of the dialog, in their order : those of the step shown in a wizard. The short
// checkboxes (shortLabel) of a step are alphabetical in the language shown, in the places they
// hold among the other fields.
const dialogFields = computed(() => {
  const list = fields.value.filter(onStep);
  const isShort = (f) => f.type === 'checkbox' && f.shortLabel;
  const sorted = list.filter(isShort).sort((a, b) => a.shortLabel.localeCompare(b.shortLabel, locale.value));
  return list.map((f) => (isShort(f) ? sorted.shift() : f));
});

/**
 * The fields of the step shown that fail their rules (a secret is checked by its own action).
 *
 * Returns:
 *   Array: the invalid fields.
 */
function stepErrors() {
  return dialogFields.value.filter(
    (field) =>
      showField(field) &&
      (!['password', 'token', 'client_secret'].includes(field.key) || action.value === 'new') &&
      $v.value.item[field.key]?.$invalid,
  );
}

/**
 * Moves to a step : forward only when the step shown is valid (its errors are then shown),
 * back always ; while creating, not past the furthest step reached.
 *
 * Args:
 *   index (number): the step to show.
 */
function goToStep(index) {
  if (index < 0 || index >= steps.value.length || index === stepIndex.value) return;
  if (index > stepIndex.value) {
    const errors = stepErrors();
    if (errors.length) {
      errors.forEach((field) => $v.value.item[field.key].$touch());
      return;
    }
    if (action.value === 'new' && index > stepReached.value + 1) return;
  }
  stepIndex.value = index;
  stepReached.value = Math.max(stepReached.value, index);
}

const isInvalid = computed(() => {
  // check if any field is invalid, but only check the ones that are not disabled
  for (const field of fields.value) {
    if (
      showField(field) &&
      // a secret is checked by Change password, and when creating : a required one is needed then
      (!['password', 'token', 'client_secret'].includes(field.key) || action.value === 'new') &&
      $v.value.item[field.key]?.$invalid
    ) {
      return true;
    }
  }
  return false;
});
const isInvalidPassword = computed(() => {
  // check if any field is invalid, but only check the ones that are not disabled
  for (const field of fields.value) {
    if (
      showField(field) &&
      (['password', 'token', 'client_secret'].includes(field.key) || field.key == idKey) &&
      $v.value.item[field.key]?.$invalid
    ) {
      return true;
    }
  }
  return false;
});

// BsDataTable mode (always on — BsDataTable is the only table renderer)
// the list's delete action : with one, the rows get checkboxes, to delete several at once
const deleteAction = computed(() => actions.value.find((a) => a.name === 'delete') || null);
// checkboxes : a list that is selectable (the default), one whose rows can be deleted, or one that
// asks for them (checkboxes : a read-only list, the rows ticked exported)
const dataTableSelectable = computed(
  () => props.settings.selectable !== false || !!deleteAction.value || !!props.settings.checkboxes,
);
// the table's controls on the title line (BsDataTable's toolbar), their widths in pixels as their
// labels make them : the search, Select all on a list whose rows can be ticked, the columns, the
// export (lib/listControls.js)
const toolbarRoom = computed(() => tableControls(dataTableSelectable.value));
// a click on a row selects it only on a selectable list ; a list that opens its rows on a
// click (selectable: false) keeps doing so, its checkboxes alone selecting
const rowClickSelects = computed(() => props.settings.selectable !== false);
const selectedIds = ref(new Set());
const activeRowId = ref(null);

// the column in the link blue : the record's name (settings.linkColumn, else its name or
// username field) - not whichever column happens to be shown first
const linkColumn = computed(
  () => props.settings.linkColumn || ['name', 'username'].find((k) => fields.value.some((f) => f.key === k)) || null,
);
const hasEditAction = computed(() => actions.value.some((a) => a.name === 'edit'));
const dataTableShowRowMenu = computed(() => actions.value.length > 0);

const dataTableColumns = computed(() => {
  // Include every field as a possible column (so the user can opt any of
  // them in via the column picker). Skip explicit `noTable` opt-outs and
  // password-like fields whose values are never returned by the API. A field with no label
  // (a record's output, kept for a dialog) is no column : the picker would list it blank.
  const SECRET_KEYS = new Set(['password', 'token', 'client_secret']);
  return fields.value
    .filter((f) => !f.noTable && !SECRET_KEYS.has(f.key) && f.type !== 'password' && (f.columnLabel || f.label))
    .map((f) => {
      const col = {
        key: f.key,
        // a column may have a shorter title than its field in the dialog (Forms, not Use for forms ?)
        label: f.columnLabel || f.label,
        sortable: f.sortable !== false,
        filterable: f.filterable || false,
        mobileHidden: f.mobileHidden || false,
        // Fields previously flagged `hidden: true` keep that as the
        // default visibility but remain available in the column
        // picker so users can show them when wanted.
        defaultHidden: !!f.hidden,
      };
      // a field may set its column's width (a yes / no column as wide as its header)
      if (f.width) col.width = f.width;
      // and the table width it needs to be shown (a short column left out on a narrow screen)
      if (f.hideBelow) col.hideBelow = f.hideBelow;
      // and its alignment (a count : to the right)
      if (f.align) col.align = f.align;
      // how the column filters and sorts : a field can say so itself, and a
      // checkbox or number field gets the matching filter by default
      const filterType =
        f.filterType || (f.type === 'checkbox' ? 'boolean' : f.type === 'number' ? 'number' : undefined);
      if (filterType) col.filterType = filterType;
      if (typeof f.sortValue === 'function') col.sortValue = f.sortValue;
      // a field may bring its own cell renderer (see config/settings.js) :
      // without this a `datetime` column shows the raw value it was sent
      if (typeof f.render === 'function') {
        col.render = f.render;
      }
      // a field-level render wins : the select branch below would otherwise
      // silently overwrite one the config deliberately supplied
      if (f.type === 'select' && f.parent && typeof f.render !== 'function') {
        col.render = (val) => {
          const list = parentLists.value[f.parent] || [];
          const found = list.find((itm) => itm[f.valueKey] == val);
          // ESCAPED. BsDataTable escapes a plain cell value but passes
          // render() output to v-html verbatim, and both branches here are
          // server data: found[labelKey] is e.g. a GROUP NAME, shown in the
          // Group column of Admin > Users. A group named `<img src=x
          // onerror=...>` therefore executed in the browser of everyone who
          // opened that page. The seed badge below already follows the rule
          // this codebase states - nothing reaches v-html unescaped,
          // whatever its provenance - this renderer did not.
          return escapeHtml(found ? found[f.labelKey] : (val ?? ''));
        };
      }
      // a yes / no column : a checkbox's, or a field's that says so (a radio of true / false)
      if (f.type === 'checkbox' || f.columnType === 'checkbox') {
        col.type = 'checkbox';
      }
      return col;
    });
});

// Records the declarative config seed owns (https://ansibleforms.com/seed). The API answers 403 on
// them, so offering Edit and Delete would only produce an error - and the seed
// re-applies on every start, so even a successful change would be reverted.
// Read-only actions (test, preview, trigger) stay available.
// Every action that ends in a write the guard refuses. 'change_password' goes
// through changePasswordItem -> updateItem(true) -> the SAME PUT /:id as Edit, so
// leaving it out offered a form whose Save answered 403. test/preview/trigger/
// reset/sync are deliberately absent : they are read-only or write only runtime
// status, which the seed does not own.
// turning a record on or off is a write too : the seed declares it (a runner's enabled)
const MANAGED_BLOCKS = new Set(['edit', 'delete', 'change_password', 'enable', 'disable']);
const isManaged = (item) => !!(item && item.managed);
// The badge below is built as markup because BsDataTable passes render() output to
// v-html. Only a locale string goes in, but it is escaped anyway : the rule in this
// codebase is that nothing reaches v-html unescaped, whatever its provenance.
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Whether a per-row action should be enabled. Honours `dependency`,
// `dependencyValues`, and `negateDependency` from the action definition.
/**
 * The in-progress label for a row, from the `busyItems` prop.
 *
 * That prop was declared and documented, and credentials.vue and runners.vue both pass a
 * map of "testing..." strings into it - but nothing in this component ever read it,
 * so pressing Test gave no per-row feedback at all and a second click fired another
 * request. The parents key that map by the record id.
 */
// Only the action that is actually running wears the label - swapping every entry in
// the menu to "Testing..." would say Edit and Delete were testing something too. Both
// pages that pass busyItems populate it from their `test` handler.
function busyAction(action, item) {
  return !!busyLabel(item) && action?.name === 'test';
}

function busyLabel(item) {
  if (!item) return '';
  return props.busyItems?.[item.id] ?? props.busyItems?.[item[idKey]] ?? '';
}

/**
 * The actions of a record's menu : those it has (action.shownWhen), in their order.
 *
 * Args:
 *   item (object): the record.
 *
 * Returns:
 *   object[]: the actions.
 */
function actionsFor(item) {
  return actions.value.filter((a) => typeof a.shownWhen !== 'function' || a.shownWhen(item));
}

function isActionEnabled(action, item) {
  if (isManaged(item) && MANAGED_BLOCKS.has(action.name)) return false;
  // read only : nothing that ends in a write, the change_* actions (their page's forms) too
  if (props.readOnly && (MANAGED_BLOCKS.has(action.name) || String(action.name).startsWith('change'))) return false;
  // a record the action may never touch (the admin user's delete)
  if (typeof action.enabledWhen === 'function' && !action.enabledWhen(item)) return false;
  if (!action.dependency) return true;
  // an array dependency means "enabled if ANY of these fields is truthy"
  if (Array.isArray(action.dependency)) {
    return action.dependency.some((dep) => !!item[dep]);
  }
  const v = item[action.dependency];
  if (Array.isArray(action.dependencyValues)) {
    return action.dependencyValues.includes(v);
  }
  if (action.negateDependency) return !v;
  return !!v;
}

// Map child-list `fields` (settings.js → childFields) to BsDataTable
// column defs so the read-only child tables get the same sort / filter /
// column-picker behaviour as the main table.
function childTableColumns(fieldList) {
  if (!Array.isArray(fieldList)) return [];
  return fieldList.map((f) => ({
    key: f.key,
    label: f.label,
    sortable: f.sortable !== false,
    filterable: f.filterable !== false,
    defaultHidden: !!f.hidden,
    type: f.type === 'checkbox' || f.columnType === 'checkbox' ? 'checkbox' : undefined,
  }));
}

function dispatchAction(action, item) {
  if (!isActionEnabled(action, item)) return;
  // a row that is already running its action must not start it again
  if (busyLabel(item)) return;
  // an action that goes to a page (action.to : the user's Groups tab, its Add group open)
  if (typeof action.to === 'function') return router.push(action.to(item));
  // an action that saves a few fields of the record (action.update : an SSO provider's Use for
  // sign-in), then shows the list again
  if (typeof action.update === 'function') return quickUpdate(item, action.update(item));
  // an action that runs on its own (action.run : a disclaimer version restored), as on the rows
  // ticked
  if (typeof action.run === 'function') return runAction(action, [item]);
  switch (action.name) {
    case 'edit':
      // a record with its own page is edited there
      if (openRecordPage(item)) return;
      return editItem(item);
    case 'delete':
      return deleteItem(item);
    case 'change_password':
      return changePasswordItem(item);
    case 'select':
      return selectItem(item);
    case 'preview':
      return previewItem(item);
    case 'test':
      return testItem(item);
    case 'trigger':
      return triggerItem(item);
    case 'reset':
      return resetItem(item);
    default:
      return emit(action.name, item);
  }
}

// ─── the default of each group, chosen in a dialog (settings.defaultPicker) ─────────────
const defaultPicker = computed(() => (props.readOnly ? null : props.settings.defaultPicker || null));
// the dialog open, and the default each group would get there (group -> row id)
const defaultsOpen = ref(false);
const defaultDraft = ref({});

/**
 * The group of a row : its groupBy key's value, or what groupBy says of it.
 *
 * Args:
 *   row (object): the row.
 *
 * Returns:
 *   string: the group.
 */
function defaultGroup(row) {
  const { groupBy } = defaultPicker.value;
  return typeof groupBy === 'function' ? groupBy(row) : row?.[groupBy];
}

/**
 * The rows a group's default may be, by name.
 *
 * Args:
 *   group (string): the group.
 *
 * Returns:
 *   Array: its rows.
 */
function groupRows(group) {
  return (itemList.value || [])
    .filter((row) => defaultGroup(row) === group)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * The default of each group now : group -> the id of its default row.
 *
 * Returns:
 *   object: e.g. { playbook: 3, template: 5 }.
 */
function currentDefaults() {
  const { key } = defaultPicker.value;
  const map = {};
  for (const row of itemList.value || []) if (row[key]) map[defaultGroup(row)] = row[idKey];
  return map;
}

// a group given another default than it has : Save can be pressed
const defaultDirty = computed(() => {
  if (!defaultsOpen.value) return false;
  const now = currentDefaults();
  return Object.keys(defaultDraft.value).some((group) => defaultDraft.value[group] !== now[group]);
});

/**
 * A group whose default the seed set : the server keeps it, so its choice is locked.
 *
 * Args:
 *   group (string): the group.
 *
 * Returns:
 *   boolean: true when its default is a seeded row.
 */
function groupLocked(group) {
  const { key } = defaultPicker.value;
  return groupRows(group).some((row) => row[key] && isManaged(row));
}

/** Opens the defaults dialog, with the defaults as they are. */
function editDefaults() {
  defaultDraft.value = currentDefaults();
  defaultsOpen.value = true;
}

/**
 * A group's choice in the dialog : the row of that id (the select gives it as text).
 *
 * Args:
 *   group (string): the group.
 *   value (string): the chosen row's id.
 */
function pickDefault(group, value) {
  const row = groupRows(group).find((r) => String(r[idKey]) === String(value));
  if (row) defaultDraft.value = { ...defaultDraft.value, [group]: row[idKey] };
}

/** Closes the dialog without saving : the defaults as they were. */
function cancelDefaults() {
  defaultsOpen.value = false;
  defaultDraft.value = {};
}

/**
 * Saves the defaults chosen : each group given another one is updated (the server clears the
 * group's other defaults), then the dialog closes.
 */
async function saveDefaults() {
  const now = currentDefaults();
  const changed = Object.entries(defaultDraft.value).filter(([group, id]) => id !== now[group]);
  for (const [, id] of changed) {
    const row = (itemList.value || []).find((r) => r[idKey] === id);
    try {
      await axios.put(`/api/v${props.apiVersion}/${objectType}/${id}`, { [defaultPicker.value.key]: true });
      toast.success(t('settings.common.defaultSaved', { name: row?.name ?? id }));
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, 'Failed to set the default'));
    }
  }
  cancelDefaults();
  if (changed.length) await loadItems();
}

/**
 * Saves a few fields of a record, then reloads the list.
 *
 * Args:
 *   item (object): the record.
 *   data (object): the fields to save.
 */
async function quickUpdate(item, data) {
  try {
    await axios.put(`/api/v${props.apiVersion}/${objectType}/${item[idKey]}`, data);
    toast.success(t('settings.common.nameUpdated', { name: objectTitle(item.name || '') }));
    await loadItems();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to update item'));
  }
}

/**
 * Opens a record's own page, when it has one (settings.openPage).
 *
 * Args:
 *   item (object): the record.
 *
 * Returns:
 *   boolean: whether a page was opened.
 */
function openRecordPage(item) {
  if (typeof props.settings.openPage !== 'function') return false;
  router.push(props.settings.openPage(item));
  return true;
}

function onDataTableRowClick(item) {
  if (openRecordPage(item)) return;
  if (!rowClickSelects.value) {
    activeRowId.value = item[idKey];
    // A seed-managed row must open READ-ONLY here too. Clicking the row is the
    // normal way to edit on these pages (selectable:false + an edit action), and
    // it bypasses isActionEnabled entirely - so greying out the menu's Edit was
    // decorative: the click still opened a live form whose Save answered 403.
    if (hasEditAction.value && !isManaged(item) && !props.readOnly) {
      editItem(item);
    } else {
      // No edit action defined → open the read-only "show" offcanvas
      // (used by pages like groups that have children to display).
      selectItem(item);
      emit('row-select', item);
    }
  }
}

async function bulkDelete() {
  // only what is still on screen : a selected row that has since disappeared must not
  // be guessed at, and the count in the confirmation has to be the count acted on
  const present = new Map(itemList.value.map((r) => [r[idKey], r]));
  // and only what may be deleted : a row the config seed manages, or whose delete is off
  // (its dependency), is left alone - its delete in the row menu is greyed out too
  const deletable = (row) => !deleteAction.value || isActionEnabled(deleteAction.value, row);
  const ids = [...selectedIds.value].filter((id) => present.has(id) && deletable(present.get(id)));
  const skipped = [...selectedIds.value].filter((id) => present.has(id)).length - ids.length;
  if (!ids.length) {
    if (skipped) toast.warning(t('settings.common.bulkDeleteNone'));
    return;
  }
  const question = skipped
    ? t('settings.common.bulkDeleteConfirmSkip', { count: ids.length, skipped })
    : t('settings.common.bulkDeleteConfirm', { count: ids.length });
  if (!(await askConfirm(question, { title: t('common.delete'), icon: 'trash' }))) return;
  // each delete on its own : one refused (a 403, a row in use) must not hide that the others
  // went, nor leave the list showing rows that are gone and the selection still ticked
  const results = await Promise.allSettled(
    ids.map((id) => {
      if (isFlat) {
        // `?? id` used to stand in here. With an index-based id that sent
        // `?name=3` and asked the server to delete an entry literally named
        // "3" - a wrong request rather than an error. The row is guaranteed
        // present now, so there is nothing to fall back to.
        const name = present.get(id).name;
        return axios.delete(`/api/v${props.apiVersion}/${objectType}?name=${encodeURIComponent(name)}`);
      }
      return axios.delete(`/api/v${props.apiVersion}/${objectType}/${id}`);
    }),
  );
  // what went is said, what failed too (the first reason : they are usually the same)
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length < results.length) {
    toast.success(t('settings.common.countDeleted', { n: results.length - failed.length }));
  }
  if (failed.length) toast.error(Helpers.parseAxiosResponseError(failed[0].reason, t('common.delete')));
  // either way the selection is cleared and the list read again
  selectedIds.value = new Set();
  await loadItems();
}

// ─── the list's own actions that run (action.run) : on a row, and on the rows ticked ────
// each { name, title, icon, enabledWhen?(row), confirm?(count, rows), done?(n, rows) or false,
// run(ids, rows), bulk? } : in the row menu, and - bulk - a button beside Delete while rows are
// ticked, acting on those it is enabled for ; asking first when it says how
const bulkActions = computed(() => actions.value.filter((a) => a.bulk && typeof a.run === 'function'));

/**
 * The rows ticked that a list action applies to, among those still on screen.
 *
 * Args:
 *   action (object): the action (settings.bulkActions).
 *
 * Returns:
 *   object[]: the rows.
 */
function bulkRows(action) {
  return itemList.value.filter(
    (r) => selectedIds.value.has(r[idKey]) && (!action.enabledWhen || action.enabledWhen(r)),
  );
}

/**
 * Runs a list action on rows, after asking when it asks, then reads the list again.
 *
 * Args:
 *   action (object): the action (action.run).
 *   rows (object[]): the rows : a row's menu's one, or those ticked it is enabled for.
 */
async function runAction(action, rows) {
  if (!rows.length) return;
  if (
    action.confirm &&
    !(await askConfirm(action.confirm(rows.length, rows), {
      title: action.title,
      icon: action.icon || 'circle-question',
    }))
  )
    return;
  try {
    const n = await action.run(
      rows.map((r) => r[idKey]),
      rows,
    );
    // done : false says nothing (a row moved shows it), else its words or its title
    if (action.done !== false) {
      toast.success(action.done ? action.done(typeof n === 'number' ? n : rows.length, rows) : action.title);
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, action.title));
  } finally {
    // a failure may still have acted on some rows : the selection cleared and the list read
    // again either way, so what is shown is what the server has
    selectedIds.value = new Set();
    await loadItems();
  }
}

// HOOKS

onMounted(async () => {
  loading.value = true;
  await loadItems();
  loading.value = false;
  // set interval await (only if reloadSeconds is not explicitly disabled)
  if (reloadSeconds !== false) {
    interval.value = setInterval(async () => {
      await loadItems(false);
    }, reloadSeconds);
  }
});

// ─── cell popovers ─────────────────────────────────────────────────────────────
// a cell that has more to say (data-af-popover, a cron's meaning) : its text on hover
const { onCellHover } = useCellPopovers();

onBeforeUnmount(() => {
  if (interval.value) {
    clearInterval(interval.value);
    interval.value = null;
  }
});

defineExpose({
  loadItems,
  setItemProperty,
  // another dialog's New button creates a record with this one's dialog (dialogOnly)
  newItem,
});
</script>
<template>
  <BsModal v-if="action == 'delete'" size="md" @close="unselectItem" icon="trash">
    <template #title> {{ t('common.delete') }} {{ objectLabelInSentence }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ deleteLabel }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="removeItem()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettings
    v-if="!dialogOnly"
    :icon="objectIcon"
    :title="settings.pageTitle || objectLabelPlural"
    :crumbs="crumbs"
    :description="objectDescription"
  >
    <!-- the table's search and columns, on the title line as the Forms page has its search -->
    <template #headerActions>
      <div :id="toolsId" class="af-title-flow"></div>
      <!-- the first load : the table's controls as grey placeholders, so the title line has their
           room before they come (the search, Select all, the columns, the export) -->
      <AppSkeleton v-if="loading" shape="buttons" :widths="toolbarRoom" />
    </template>
    <template #default>
      <BsDataTable
        v-if="!loading && itemList != undefined"
        framed
        @mouseover="onCellHover"
        :toolbarTo="'#' + toolsId"
        :pagerTo="'#' + pagerId"
        :items="itemList"
        :columns="dataTableColumns"
        :idKey="idKey"
        :selectedIds="selectedIds"
        :selectable="dataTableSelectable"
        :rowSelectable="deleteAction?.enabledWhen ? (row) => isActionEnabled(deleteAction, row) : null"
        :linkColumn="linkColumn"
        :activeId="!rowClickSelects ? activeRowId : null"
        :rowClickSelects="rowClickSelects"
        :name="Helpers.cleanupString(objectLabelPlural)"
        :exportName="Helpers.cleanupString(objectLabelPlural)"
        @update:selectedIds="selectedIds = $event"
        @row-click="onDataTableRowClick"
      >
        <template v-if="dataTableSelectable" #bulk-actions="{ count }">
          <!-- in the style of the toolbar's other buttons -->
          <!-- the list's own actions on them (settings.bulkActions), then Delete -->
          <template v-for="action in bulkActions" :key="'bulk-' + action.name">
            <BsButton
              v-if="count"
              :icon="action.icon"
              :disabled="!bulkRows(action).length"
              @click="runAction(action, bulkRows(action))"
              >{{ action.title }} ({{ bulkRows(action).length }})</BsButton
            >
          </template>
          <BsButton v-if="count && deleteAction" icon="trash" @click="bulkDelete">
            {{ t('common.delete') }} ({{ count }})
          </BsButton>
        </template>
        <template v-if="dataTableShowRowMenu" #row-actions="{ item }">
          <div class="dropdown">
            <!-- fixed, so the menu opens over the table's frame instead of being cut by it (the
                 frame hides its overflow, for its rounded corners) -->
            <button
              type="button"
              class="bs-dt-row-menu px-2"
              data-bs-toggle="dropdown"
              data-bs-popper-config='{"strategy":"fixed"}'
              :aria-label="t('common.actions')"
            >
              <font-awesome-icon icon="ellipsis-vertical" />
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
              <template v-for="(action, idx) in actionsFor(item)" :key="action.name + idx">
                <li v-if="(action.name === 'delete' || action.dividerBefore) && idx > 0">
                  <hr class="dropdown-divider" />
                </li>
                <li>
                  <a
                    class="dropdown-item"
                    :class="{
                      'disabled text-muted': !isActionEnabled(action, item) || !!busyLabel(item),
                      'text-danger': action.name === 'delete' && isActionEnabled(action, item),
                    }"
                    href="#"
                    @click.prevent="dispatchAction(action, item)"
                  >
                    <font-awesome-icon
                      :icon="busyAction(action, item) ? 'spinner' : action.icon || 'circle'"
                      :spin="busyAction(action, item)"
                      class="me-2"
                    />{{ busyAction(action, item) ? busyLabel(item) : action.title }}
                  </a>
                </li>
              </template>
            </ul>
          </div>
        </template>
      </BsDataTable>
      <!-- the first load (a reload keeps the rows shown) : the table's rows as grey placeholders -->
      <AppSkeleton v-if="loading" shape="table" :count="8" />
    </template>
    <template #footer>
      <!-- the table's pager, under the card -->
      <div :id="pagerId"></div>
      <slot></slot>
    </template>
    <!-- the page's own card above the list's (the runners waiting for approval) -->
    <template v-if="$slots.aboveCard" #aboveCard><slot name="aboveCard"></slot></template>
    <!-- the page's own tabs (the SSO page : General, Providers), above the card -->
    <template v-if="$slots.tabs" #tabs><slot name="tabs"></slot></template>
    <!-- action buttons go BELOW the card, never in the header : see AppSettings -->
    <template v-if="!noCreate || defaultPicker || $slots.actionsBefore" #actions>
      <!-- the page's own actions, before the defaults and Add (the repositories' Pull all) -->
      <slot name="actionsBefore"></slot>
      <!-- the defaults : a dialog to choose them -->
      <BsButton v-if="defaultPicker" cssClass="text-nowrap" icon="pencil" @click="editDefaults()">{{
        defaultPicker.editLabel
      }}</BsButton>
      <!-- Add : the page's main action, last on the right -->
      <BsButton v-if="!noCreate" icon="plus" @click="newItem()">{{
        t('settings.common.addItem', { item: objectLabelInSentence })
      }}</BsButton>
    </template>
  </AppSettings>
  <!-- the defaults (settings.defaultPicker) : a choice per group, Save sets them -->
  <BsModal v-if="defaultPicker && defaultsOpen" size="lg" @close="cancelDefaults" :icon="objectIcon">
    <template #title> {{ defaultPicker.title }} </template>
    <template #default>
      <!-- 16px between two groups, none after the last : the dialog's padding ends it -->
      <div
        v-for="(group, i) in defaultPicker.groups"
        :key="group.key"
        class="row"
        :class="i < defaultPicker.groups.length - 1 ? 'mb-3' : 'mb-0'"
      >
        <label class="col-sm-3 col-form-label fw-bold" :for="'af-default-' + group.key">{{ group.label }}</label>
        <div class="col-sm-9">
          <div class="input-group">
            <span class="input-group-text"
              ><FaIcon :icon="groupLocked(group.key) ? 'lock' : group.icon || objectIcon"
            /></span>
            <select
              :id="'af-default-' + group.key"
              class="form-select"
              :value="defaultDraft[group.key] ?? ''"
              :disabled="groupLocked(group.key) || !groupRows(group.key).length"
              @change="pickDefault(group.key, $event.target.value)"
            >
              <!-- none yet : no row of the group, or none of them chosen -->
              <option v-if="defaultDraft[group.key] === undefined" value="">
                {{ groupRows(group.key).length ? t('settings.common.noDefault') : t('settings.common.noneYet') }}
              </option>
              <option
                v-for="row in groupRows(group.key)"
                :key="row[idKey]"
                :value="row[idKey]"
                :disabled="isManaged(row)"
              >
                {{ row.name }}{{ group.describe ? ` · ${group.describe(row)}` : '' }}
              </option>
            </select>
          </div>
          <div class="form-text">
            {{ groupLocked(group.key) ? t('settings.common.seedManagedField') : group.help }}
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <BsButton icon="save" :disabled="!defaultDirty" @click="saveDefaults()">{{ t('settings.common.save') }}</BsButton>
    </template>
  </BsModal>
  <!-- a password (typed twice) or a client secret (once) : the shared Change password dialog -->
  <AppChangePasswordDialog
    v-if="usesPasswordDialog"
    :icon="objectIcon"
    :title="changePasswordTitle"
    :label="secretField.key === 'password' ? '' : secretField.label"
    :repeat="secretField.key === 'password'"
    @save="savePasswordFromDialog"
    @close="unselectItem"
  />
  <BsOffCanvas
    v-if="!loading"
    :show="['select', 'edit', 'new', 'change_password'].includes(action) && !usesPasswordDialog"
    :icon="objectIcon"
    :title="title"
    @close="unselectItem"
  >
    <template #actions>
      <!-- a wizard : Previous / Next, and Save on the last step (editing : on every step) -->
      <template v-if="wizardActive">
        <BsButton v-if="stepIndex > 0" icon="arrow-left" @click="goToStep(stepIndex - 1)">{{
          t('common.previous')
        }}</BsButton>
        <BsButton v-if="!isLastStep" icon="arrow-right" @click="goToStep(stepIndex + 1)">{{
          t('common.next')
        }}</BsButton>
      </template>
      <BsButton v-if="action == 'new' && (!wizardActive || isLastStep)" icon="save" @click="createItem()">{{
        t('settings.common.save')
      }}</BsButton>
      <BsButton v-if="action == 'edit'" icon="save" @click="updateItem()">{{ t('settings.common.save') }}</BsButton>
      <BsButton v-if="action == 'change_password'" icon="lock" @click="updateItem(true)">{{
        t('settings.common.changePassword')
      }}</BsButton>
    </template>
    <template v-if="wizardActive" #top>
      <!-- the steps of a wizard : where you are, and the way back (editing : to any step) ; above
           the fields, out of their scroll -->
      <ol v-if="wizardActive" class="af-wizard-steps mb-0">
        <li
          v-for="(step, i) in steps"
          :key="step.key"
          :class="{
            active: i === stepIndex,
            done: i < stepIndex,
            reachable: action === 'edit' || i <= stepReached + 1,
          }"
          @click="goToStep(i)"
        >
          <span class="af-wizard-n"
            ><FaIcon v-if="i < stepIndex" icon="check" /><template v-else>{{ i + 1 }}</template></span
          >
          <span class="af-wizard-label">{{ step.label }}</span>
        </li>
      </ol>
    </template>
    <template #default>
      <!-- the help of the step shown -->
      <div v-for="(note, n) in stepNotes" :key="'note-' + n" class="alert alert-info af-wizard-note">
        <div v-if="note.title" class="fw-bold">{{ note.title }}</div>
        <div v-if="note.text">{{ note.text }}</div>
        <ul v-if="note.items && note.items.length" class="mb-0">
          <li v-for="(line, l) in note.items" :key="l">{{ line }}</li>
        </ul>
      </div>
      <template v-for="field in dialogFields" :key="field.key">
        <!-- DATETIME FIELD -->
        <div v-if="showField(field) && field.type === 'datetime'" class="row mb-3">
          <label class="col-sm-2 col-form-label fw-bold">
            {{ field.label }}
            <span v-if="field.required" class="text-danger">*</span>
          </label>
          <div class="col-sm-10">
            <BsDateTime
              v-model="$v.item[field.key].$model"
              :icon="field.icon || 'calendar'"
              :placeholder="field.placeholder"
              :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty"
              :convertToUtc="field.convertToUtc !== undefined ? field.convertToUtc : true"
              dateType="datetime"
              teleport
            />
            <small v-if="field.help" class="form-text text-muted d-block mt-1">{{ field.help }}</small>
            <div v-if="$v.item[field.key].$invalid && $v.item[field.key].$dirty" class="invalid-feedback d-block">
              <div v-for="error in $v.item[field.key].$errors" :key="error.$uid">
                {{ error.$message }}
              </div>
            </div>
          </div>
        </div>

        <!-- CRON FIELD -->
        <div v-if="showField(field) && field.type === 'cron'" class="row mb-3">
          <label class="col-sm-2 col-form-label fw-bold">
            {{ field.label }}
            <span v-if="field.required" class="text-danger">*</span>
          </label>
          <div class="col-sm-10">
            <BsCron
              v-model="$v.item[field.key].$model"
              :icon="field.icon || 'stopwatch'"
              :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty"
            />
            <div v-if="$v.item[field.key].$invalid && $v.item[field.key].$dirty" class="invalid-feedback d-block">
              <div v-for="error in $v.item[field.key].$errors" :key="error.$uid">
                {{ error.$message }}
              </div>
            </div>
          </div>
        </div>

        <!-- A SHORT CHECKBOX (shortLabel) : at the left edge, its label and a few grey words
             (shortHint) on one line ; one only (oneOnly) and already ticked on another record :
             greyed out, and who has it in the tooltip -->
        <div
          v-if="showField(field) && field.type === 'checkbox' && field.shortLabel"
          class="form-check af-short-check"
          :class="{ 'af-taken': takenBy(field) }"
          :title="takenBy(field) ? t('settings.common.takenBy', { name: takenBy(field) }) : null"
        >
          <input
            :id="'af-check-' + field.key"
            v-model="$v.item[field.key].$model"
            class="form-check-input"
            type="checkbox"
            :disabled="field.readonly || !!takenBy(field)"
          />
          <label class="form-check-label" :for="'af-check-' + field.key">
            <span class="af-short-label">{{ field.shortLabel }}</span>
            <span v-if="field.shortHint" class="text-body-secondary small">{{ field.shortHint }}</span>
          </label>
        </div>

        <!-- RADIO BUTTONS (type radio) : one choice of field.options, at the dialog's left edge,
             each its label and a few grey words (hint) on one line -->
        <div
          v-else-if="showField(field) && field.type === 'radio'"
          class="mb-3 af-radio-group"
          :class="{ 'af-radio-nested': field.nested }"
          role="radiogroup"
          :aria-label="field.label"
        >
          <!-- a follow-up choice (nested) : under the option it follows, with its own title -->
          <div v-if="field.nested" class="af-radio-title">{{ field.label }}</div>
          <div v-for="opt in field.options" :key="String(opt.value)" class="form-check af-short-check">
            <input
              :id="'af-radio-' + field.key + '-' + opt.value"
              v-model="$v.item[field.key].$model"
              class="form-check-input"
              type="radio"
              :name="'af-radio-' + field.key"
              :value="opt.value"
              :disabled="field.readonly"
            />
            <label class="form-check-label" :for="'af-radio-' + field.key + '-' + opt.value">
              <FaIcon v-if="opt.icon" :icon="opt.icon" class="af-radio-icon me-2" fixedwidth />
              <span class="af-short-label">{{ opt.label }}</span>
              <span v-if="opt.hint" class="text-body-secondary small">{{ opt.hint }}</span>
            </label>
          </div>
        </div>

        <!-- A COMPONENT (type component) : something to see while the record is made (the labels'
             preview), field.component with the props field.props(item, items) gives ; its title in
             the label column, as the other fields -->
        <div v-else-if="showField(field) && field.type === 'component'" class="row mb-3">
          <label class="form-label fw-bold col-form-label col-sm-2">{{ field.label }}</label>
          <div class="col-sm-10">
            <component :is="field.component" v-bind="field.props ? field.props($v.item.$model, itemList) : {}" />
            <div v-if="field.help" class="form-text">{{ field.help }}</div>
          </div>
        </div>

        <!-- COLOUR SWATCHES (type swatches) : one choice of field.options, round buttons in their
             colour (opt.cls), the chosen one ringed and ticked, as a label's page (label.vue) -->
        <div v-else-if="showField(field) && field.type === 'swatches'" class="row mb-3">
          <!-- its title in the label column, the circles and the help beside it, as the other fields -->
          <label class="form-label fw-bold col-form-label col-sm-2"
            >{{ field.label }}<span v-if="field.required" class="text-danger ms-1">*</span></label
          >
          <div class="col-sm-10">
            <div class="d-flex flex-wrap gap-2 ms-1 af-swatch-row" role="radiogroup" :aria-label="field.label">
              <button
                v-for="opt in field.options"
                :key="String(opt.value)"
                type="button"
                class="settings-color-swatch"
                :class="[opt.cls, { 'af-swatch-active': $v.item[field.key].$model === opt.value }]"
                :title="opt.label"
                role="radio"
                :aria-checked="$v.item[field.key].$model === opt.value"
                :disabled="field.readonly"
                @click="$v.item[field.key].$model = opt.value"
              >
                <FaIcon v-if="$v.item[field.key].$model === opt.value" icon="check" class="settings-swatch-check" />
              </button>
            </div>
            <div v-if="field.help" class="form-text">{{ field.help }}</div>
          </div>
        </div>

        <!-- A SWITCH AT THE LEFT EDGE (flush) : no label column before it, its help the full
             width of the dialog under it -->
        <div
          v-else-if="showField(field) && field.type === 'checkbox' && field.flush"
          class="form-check form-switch af-flush-switch mb-3"
        >
          <input
            :id="'af-switch-' + field.key"
            v-model="$v.item[field.key].$model"
            class="form-check-input"
            type="checkbox"
            role="switch"
            :disabled="field.readonly"
          />
          <label class="form-check-label" :for="'af-switch-' + field.key">{{ field.label }}</label>
          <div v-if="textOf(field.help)" class="form-text mt-1">{{ textOf(field.help) }}</div>
        </div>

        <!-- A DROPDOWN WITH NOTHING TO CHOOSE YET (createWith, an empty list) : only its New
             button, where the dropdown would be -->
        <div
          v-else-if="showField(field) && noChoices(field) && !emptyTextOf(field) && action !== 'select'"
          class="row mb-3"
        >
          <label class="col-sm-2 col-form-label fw-bold">{{ field.label }}</label>
          <div class="col-sm-10 d-flex align-items-center">
            <BsButton icon="plus" @click="creators[field.key]?.newItem(textOf(field.createDefaults))">{{
              field.createLabel
            }}</BsButton>
          </div>
        </div>

        <!-- SEVERAL VALUES, ONE PER INPUT (an LDAP directory's servers ; listWhen : a field that is
             a list for some records only, an ldap credential's servers) -->
        <BsInputList
          v-else-if="showField(field) && (field.type === 'list' || field.listWhen?.(item))"
          v-model="$v.item[field.key].$model"
          :isHorizontal="true"
          :label="textOf(field.dialogLabel) || field.label"
          :help="textOf(field.help)"
          :icon="field.icon"
          :placeholder="textOf(field.placeholder)"
          :required="field.required || !!field.requiredWhen?.(item)"
          :addLabel="field.addLabel"
          :disabled="!!field.readonly"
          :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty"
          :errors="$v.item[field.key].$errors"
        />

        <!-- ALL OTHER FIELD TYPES -->
        <BsInput
          v-else-if="showField(field) && field.type !== 'datetime' && field.type !== 'cron' && !field.listWhen?.(item)"
          :isHorizontal="true"
          :type="field.type"
          :placeholder="action == 'edit' && field.onEdit ? '********' : textOf(field.placeholder)"
          :suffix="textOf(field.suffix)"
          :icon="field.icon"
          :help="
            action == 'edit' && field.onEdit ? field.keepHelp || t('settings.common.passwordKeep') : textOf(field.help)
          "
          :readonly="field.readonly"
          :disabled="!!field.readonly"
          :rows="field.rows || 3"
          v-model="$v.item[field.key].$model"
          :isFloating="false"
          :required="field.required || !!field.requiredWhen?.(item)"
          :label="textOf(field.dialogLabel) || field.label"
          :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty"
          :errors="$v.item[field.key].$errors"
          :valueKey="field.valueKey"
          :labelKey="field.labelKey"
          :style="field.style"
          :lang="field.lang"
          :values="choicesOf(field)"
          :emptyText="field.type === 'select' ? emptyTextOf(field) : ''"
        />
        <!-- a dropdown that can create its choice : the dialog of that list, over this one -->
        <div
          v-if="
            showField(field) &&
            createsChoices &&
            field.createWith &&
            allSettings[field.createWith] &&
            action !== 'select' &&
            (!noChoices(field) || emptyTextOf(field))
          "
          class="row mb-3 mt-n2"
        >
          <div class="offset-sm-2 col-sm-10">
            <BsButton icon="plus" @click="creators[field.key]?.newItem(textOf(field.createDefaults))">{{
              field.createLabel
            }}</BsButton>
          </div>
        </div>
      </template>
      <div v-if="action == 'select' && childLists">
        <ul class="nav nav-tabs">
          <li class="nav-item" v-for="(childList, index) in children" :key="childList.type">
            <a role="button" class="nav-link" @click="activeChild = index" :class="{ active: index == activeChild }"
              ><span class="me-2"> <FaIcon :icon="childList.icon" /> </span>{{ childList.labelPlural }}</a
            >
          </li>
        </ul>
        <div v-for="(childList, index) in children" :key="childList.type">
          <div class="p-2 border border-top-0" v-if="index == activeChild">
            <BsDataTable
              :items="childLists[childList.type] || []"
              :columns="childTableColumns(childFields[childList.type])"
              :selectable="false"
              :name="`child_${objectType}_${childList.type}`"
            />
          </div>
        </div>
      </div>
    </template>
  </BsOffCanvas>
  <!-- the lists a dropdown can create its choice with (createWith) : their dialogs only, over
       this one's (af-nested-dialogs) -->
  <div v-if="createFields.length" class="af-nested-dialogs">
    <AppAdminMulti
      v-for="field in createFields"
      :key="'create-' + field.key"
      :ref="(el) => (creators[field.key] = el)"
      dialogOnly
      :apiVersion="2"
      :settings="allSettings[field.createWith]"
      @created="(name) => onCreated(field, name)"
    />
  </div>
</template>
<style scoped>
/* the colour circles as tall as a field's input, so they sit on the line of their title */
.af-swatch-row {
  min-height: calc(1.5em + 0.75rem + 2px);
  align-items: center;
}
/* a dialog opened from this one's (a New button under a dropdown) : above it, its backdrop
   dimming this dialog as this one's dims the page (Bootstrap's modal is 1055, its backdrop 1050) */
.af-nested-dialogs :deep(.modal) {
  z-index: 1065;
}
.af-nested-dialogs :deep(.modal-backdrop) {
  z-index: 1060;
}
/* the help of a wizard step : compact, its list close to its title */
.af-wizard-note {
  padding: 0.5rem 0.75rem;
}
.af-wizard-note ul {
  padding-left: 1.25rem;
}
/* the steps of a wizard dialog : numbered, joined by a line, the one shown in the primary
   colour, those passed with a check */
.af-wizard-steps {
  display: flex;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin-left: 0;
}
.af-wizard-steps li {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 3px solid var(--bs-border-color);
  color: var(--bs-secondary-color);
  white-space: nowrap;
  min-width: 0;
}
.af-wizard-steps li.reachable {
  cursor: pointer;
}
.af-wizard-steps li.done {
  border-bottom-color: rgba(var(--bs-primary-rgb), 0.45);
  color: var(--bs-body-color);
}
.af-wizard-steps li.active {
  border-bottom-color: var(--bs-primary);
  color: var(--bs-primary);
  font-weight: 600;
}
.af-wizard-n {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 0.8rem;
}
.af-wizard-steps li.active .af-wizard-n {
  background: var(--bs-primary);
  border-color: var(--bs-primary);
  color: #fff;
}
.af-wizard-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* a one-only checkbox another record already has : the whole line greyed */
.af-taken .form-check-label,
.af-taken .form-check-label span {
  color: var(--bs-secondary-color) !important;
  opacity: 0.6;
}
/* a radio of a group, or a short checkbox : at the left edge, the list tight */
.af-short-check {
  margin-bottom: 0.6rem;
}
/* the labels one width, so their grey hints line up in a column */
.af-short-label {
  display: inline-block;
  min-width: 12rem;
}
/* a follow-up radio group : indented to the labels of the group above, its title small and
   bold, a line at its left joining it to the option it follows */
.af-radio-nested {
  margin-left: 0.6rem;
  padding-left: 1rem;
  border-left: 2px solid var(--af-field-border);
}
.af-radio-title {
  margin-bottom: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--bs-secondary-color);
}
.af-radio-nested .af-short-label {
  /* its hints in line with those above : the indent and the line taken off */
  min-width: calc(12rem - 1.6rem - 2px);
}
</style>
