<script setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue';
import Form from '@/lib/Form';
import { slugOf, slugMatches, findBySlug } from '@/lib/formsPath';
import { DESIGNER_TABS } from '@/config/designerTabs';
import { designerViews } from '@/config/designerViews';
import getSettings from '@/config/settings';
import { EXPLORER_WIDTH, explorerWidthAfterDrag, explorerFolded, explorerColumns } from '@/config/fileExplorer';
import Lock from '@/lib/Lock';
import { useAppStore } from '@/stores/app';
import { useLiveEvent } from '@/composables/useLiveEvent';
import Backup from '@/lib/Backup';
import Profile from '@/lib/Profile';
import YAML from 'yaml';
import { toBlock, putKey, dropKey, yamlText } from '@/lib/yamlBlock';
import { toast } from 'vue-sonner';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import Helpers from '@/lib/Helpers';
import BaseUrl from '@/lib/BaseUrl';
import axios from 'axios';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { availableIcons } from '@/config/icons';
import { editorStyle } from '@/config/editorStyle';
import {
  coerceConstantValue,
  constantValueError,
  constantValueRows,
  constantsToArray,
  arrayToConstants,
  flattenConstants,
} from '@/config/constants';
import {
  isDefaultCategory,
  flattenCategories,
  canMoveUp,
  canMoveDown,
  canIndent,
  canOutdent,
  moveCategoryUp,
  moveCategoryDown,
  indentCategory,
  outdentCategory,
  movedCategoryPaths,
  categoryPaths,
} from '@/config/categories';
import { formPath } from '@/lib/formsPath';
import { skippedPulls } from '@/lib/pullResults';
import { EVERYONE_ROLES } from '@/composables/useRoleSupport';
import { mayOpen } from '@/lib/routePermission';

dayjs.extend(relativeTime);

const { t, locale } = useI18n();

const categories = ref('');
const roles = ref('');
const constants = ref('');
const forms = ref({});
const formMeta = ref({});
const loaded = ref(false);
// the last load of the configuration failed : a Retry is offered instead of the placeholders,
// which otherwise stayed on screen for ever
const loadFailed = ref(false);
const lockLoading = ref(false);
const currentForm = ref(null);
// the views (config/designerViews.js) : name is the internal key (warnings and the editors switch
// on it), label what the menu shows, description the line under the page title
const tabs = designerViews(t);
// the sections still to build : every section but the ones built
const BUILT_SECTIONS = ['Categories', 'Constants', 'Forms', 'Inventories', 'Playbooks', 'VarsFiles', 'Workflows'];
const draftSections = tabs.map((x) => x.name).filter((name) => !BUILT_SECTIONS.includes(name));
// the views in the menu, alphabetically by their (translated) label
const sortedTabs = computed(() => [...tabs].sort((a, b) => a.label().localeCompare(b.label(), locale.value)));
// The designer's addresses : a view at /designer/<view> (/designer/categories), the form being
// edited at /designer/forms/<form> (/designer/forms/approval-demo), then the editor shown
// (/designer/categories/yaml, /designer/categories/visual, /designer/forms/approval-demo/preview),
// names written as in every address (lib/formsPath.js). The designer opens on what its address
// names, else on the first view of the menu, in its YAML.
const tabOfSlug = (slug) => tabs.find((x) => slugOf(x.name) === slugOf(slug))?.name;
// the editors, by their name in the address
const EDITORS = ['yaml', 'visual', 'preview'];
/**
 * What an address of the designer names.
 *
 * Args:
 *   params (object): the route's params : view, item, editor (/designer/:view?/:item?/:editor?).
 *
 * Returns:
 *   object: { view (Categories, Forms ...) or undefined, form (its name in the address) or
 *     undefined, editor ('yaml', 'visual' or 'preview') }.
 */
function addressOf(params) {
  const view = tabOfSlug(params.view);
  const rest = [params.item, params.editor].filter(Boolean);
  // the forms view : the form, then the editor ; the other views : the editor
  const form = view === 'Forms' && rest[0] && !EDITORS.includes(rest[0]) ? rest[0] : undefined;
  const editor = (form ? rest[1] : rest[0]) || 'yaml';
  return { view, form, editor: EDITORS.includes(editor) ? editor : 'yaml' };
}
/**
 * The address of a view, of a form in the forms view, and of the editor shown.
 *
 * Args:
 *   tab (string): the view (Categories, Roles, Constants, Forms).
 *   formName (string): the form being edited, in the forms view.
 *   editor (string): the editor shown : 'yaml', 'visual' or 'preview' ; none, the view itself
 *     (it opens on its YAML).
 *
 * Returns:
 *   string: /designer/<view>[/<form>][/<editor>].
 */
function designerPath(tab, formName, editor) {
  let path = `/designer/${slugOf(tab)}`;
  if (tab === 'Forms' && formName) path += `/${slugOf(formName)}`;
  if (EDITORS.includes(editor)) path += `/${editor}`;
  return path;
}
// The address the designer itself last wrote (the address following the view, form and editor
// shown, a form picked in the explorer) until the route watcher has seen it : that address
// changes nothing in the designer, it already shows what it names.
let designerAddress = null;
/**
 * Remembers an address the designer is about to write itself, for the route watcher.
 *
 * Args:
 *   path (string): the address (/designer/forms/<form>[/<editor>]).
 */
function markDesignerAddress(path) {
  designerAddress = path;
}
/**
 * Forgets the address the designer wrote when the router did not go there (a guard said no,
 * another navigation came first) : the next visit of it is the user's, not the designer's.
 *
 * Args:
 *   failure (object|undefined): the router's navigation failure, undefined when it went there.
 */
function clearFailedDesignerAddress(failure) {
  if (failure) designerAddress = null;
}
const startRoute = useRoute();
const currentTab = ref(addressOf(startRoute.params).view || sortedTabs.value[0].name);
const showWarnings = ref(false);
const action = ref(null);
const lock = ref(false);
// the lock read once (or its read failed) : until then the editor's lines as grey placeholders
const lockRead = ref(false);
const lockError = ref('');
const nextAction = ref(false);
const lockInterval = ref(null);
// set by onBeforeUnmount ; onMounted is async and checks it before arming the lock poll
const unmounted = ref(false);
const backups = ref([]);
const backupToRestore = ref(null);
const backupBeforeRestore = ref(false);
const authenticated = ref(false);

// ytt templating : any line starting (after optional whitespace) with '#@' is a ytt
// directive, so the stored config is a TEMPLATE. The test itself now lives on the server
// (GET /api/v2/config/templated) because only the raw stored text still carries the
// directives and this page cannot read it - see loadConfigTemplated.
const configTemplated = ref(false);

const editorTheme = ref(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'monokai' : 'chrome');
const themeObserver = new MutationObserver(() => {
  editorTheme.value = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'monokai' : 'chrome';
});

// the playbooks, the vars files, the inventories and the workflows : their files
// (AppProjectFiles), driven by the toolbar
const FILE_SECTIONS = { Inventories: 'inventories', Playbooks: 'playbooks', VarsFiles: 'vars', Workflows: 'workflows' };
const projectFiles = ref(null);
// each kind of file is changed only with its own role option (else shown read-only)
const FILE_DESIGN_OPTIONS = {
  playbooks: 'allowPlaybookDesign',
  workflows: 'allowWorkflowDesign',
  inventories: 'allowInventoryDesign',
  vars: 'allowVarsFileDesign',
};
/**
 * Whether the user may change a kind of file in the designer.
 *
 * Args:
 *   kind (string): 'playbooks', 'workflows', 'inventories' or 'vars'.
 *
 * Returns:
 *   boolean: true unless the user's role option for it is off.
 */
function canDesignFiles(kind) {
  const option = FILE_DESIGN_OPTIONS[kind];
  return !option || store.profile?.options?.[option] !== false;
}

// a new inventory is a new repository : the repositories' New dialog (Settings > Repositories),
// used for inventories - ticked, and its usage not to change here
const inventoryRepoDialog = ref(null);
// a new inventory needs the inventories' role option AND the repositories (the connections
// settings, the route's own option) : without them the dialog's lists answer 403, so it is
// neither mounted nor offered ; the existing inventories stay open to edit
const canCreateInventories = computed(
  () => canDesignFiles('inventories') && mayOpen('/settings/repositories', store.profile?.options),
);
const inventoryRepoSettings = computed(() => {
  const repositories = getSettings(t).repositories;
  return {
    ...repositories,
    // the dialog says what it makes here : a new inventory (a repository, but named as the section)
    label: t('designer.formInventory'),
    labelPlural: t('designer.inventories'),
    fields: repositories.fields.map((f) => (f.step === 'usage' ? { ...f, readonly: true } : f)),
  };
});
function newInventory() {
  inventoryRepoDialog.value?.newItem({ use_for_inventories: true });
}
/**
 * The new inventory's repository is created : once cloned, its first files are added and it opens
 * (seedInventory) ; a clone that failed is said.
 *
 * Args:
 *   name (string): the repository's name.
 */
async function onInventoryRepoCreated(name) {
  for (let i = 0; i < 60; i++) {
    let status;
    try {
      status = (await axios.get(`/api/v2/repository/${encodeURIComponent(name)}`)).data?.status;
    } catch {
      status = null;
    }
    if (status === 'success') return projectFiles.value?.seedInventory(name);
    if (status === 'failed') {
      toast.error(t('designer.files.inventoryCloneFailed', { name }));
      return projectFiles.value?.reload();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const activeEditor = ref(null);
function onEditorInit(editor) {
  activeEditor.value = editor;
}
function editorUndo() {
  activeEditor.value?.undo();
}
function editorRedo() {
  activeEditor.value?.redo();
}
function editorFind() {
  activeEditor.value?.execCommand('replace');
}
function editorCut() {
  if (!activeEditor.value) return;
  const text = activeEditor.value.getSelectedText();
  if (text) {
    // removed once it is really on the clipboard : a refused copy no longer loses the text
    const editor = activeEditor.value;
    const range = editor.getSelectionRange();
    Helpers.copyToClipboard(text)
      .then(() => editor.session.remove(range))
      .catch(() => {});
  }
}
function editorCopy() {
  if (!activeEditor.value) return;
  const text = activeEditor.value.getSelectedText();
  if (text) Helpers.copyToClipboard(text).catch(() => {});
}
async function editorPaste() {
  if (!activeEditor.value) return;
  // the browser may refuse to read the clipboard (permission denied, not a secure page, an
  // older Firefox without the API) : say so, rather than an unhandled rejection and a button
  // that silently does nothing - Ctrl+V in the editor still works there
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast.warning(t('designer.pasteNotAllowed'));
    return;
  }
  if (text) activeEditor.value.insert(text);
}
function editorFormat() {
  const fmt = (val) => {
    try {
      return YAML.stringify(YAML.parse(val));
    } catch {
      return null;
    }
  };
  if (currentTab.value === 'Categories') {
    const r = fmt(categories.value);
    if (r) categories.value = r;
  } else if (currentTab.value === 'Constants') {
    const r = fmt(constants.value);
    if (r) constants.value = r;
  } else if (currentTab.value === 'Forms' && currentForm.value) {
    const r = fmt(forms.value[currentForm.value]);
    if (r) forms.value[currentForm.value] = r;
  } else if (FILE_SECTIONS[currentTab.value] && projectFiles.value?.selected) {
    // a playbook, a vars file, an inventory's : its YAML laid out the same way
    const r = fmt(projectFiles.value.getText());
    if (r) projectFiles.value.setText(r);
  }
}

const route = useRoute();
const router = useRouter();
const store = useAppStore();

const treeWidthPct = ref(EXPLORER_WIDTH.start);
function startResize(e) {
  e.preventDefault();
  const layout = e.target.closest('.designer-layout');
  if (!layout) return;
  const startX = e.clientX;
  const layoutRect = layout.getBoundingClientRect();
  const startPct = treeWidthPct.value;
  function onMove(ev) {
    const dx = ev.clientX - startX;
    treeWidthPct.value = explorerWidthAfterDrag(startPct, dx, layoutRect.width);
    layout.style.gridTemplateColumns = `1fr 1rem ${treeWidthPct.value}%`;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

const isValid = computed(() => {
  return warnings.value.length == 0;
});

// change detection : the designer is "dirty" when the parsed content differs
// from the last saved/loaded baseline. Comparing the PARSED content (not the
// raw text) is robust to whitespace/newline noise from the editor and matches
// what a save persists, so reverting an edit (eg type a char then erase it)
// clears the dirty state. The ace editor live-syncs its v-model on every edit,
// so this computed re-evaluates as you type.
const dirtyBaseline = ref(null);
function contentSnapshot() {
  return JSON.stringify({ c: categoriesObj.value, r: rolesObj.value, k: constantsObj.value, f: formsObj.value });
}
const baselineRaw = ref({ categories: '', roles: '', constants: '', forms: {} });
// The baseline as the buffers are RIGHT NOW. Split from applying it so a save can take
// the snapshot before it awaits - see saveForms.
function captureBaseline() {
  return {
    snapshot: contentSnapshot(),
    raw: {
      categories: categories.value,
      roles: roles.value,
      constants: constants.value,
      forms: { ...forms.value },
    },
  };
}
function applyBaseline(b) {
  dirtyBaseline.value = b.snapshot;
  baselineRaw.value = b.raw;
}
function setDirtyBaseline() {
  applyBaseline(captureBaseline());
}
const isDirty = computed(() => dirtyBaseline.value !== null && contentSnapshot() !== dirtyBaseline.value);

// PARSED content, the same comparison isDirty uses.
//
// This compared the raw text, so the two disagreed: pressing Enter at the end of a form,
// reindenting a block or typing a `# comment` changed forms[id] and painted the tree
// entry blue and italic ("unsaved"), while isDirty - which parses - stayed false, so
// Save, Diff and Revert were all disabled and neither the reload guard nor the route
// guard warned. The UI claimed an unsaved change and offered no way to act on it, then
// dropped it without a prompt.
//
// Parsed is the honest side: assembleForms() serializes the PARSED objects, so a
// whitespace or comment-only edit can never reach the server anyway - marking it unsaved
// promises something the save path cannot deliver.
function parsedForm(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.stringify(YAML.parse(raw));
  } catch {
    // unparsable: fall back to the text
    return raw;
  }
}
function isFormDirty(id) {
  if (!baselineRaw.value.forms[id] && forms.value[id]) return true;
  if (!forms.value[id]) return false;
  return parsedForm(forms.value[id]) !== parsedForm(baselineRaw.value.forms[id]);
}

function editorRevert() {
  if (currentTab.value === 'Categories') {
    categories.value = baselineRaw.value.categories;
  } else if (currentTab.value === 'Constants') {
    constants.value = baselineRaw.value.constants;
  } else if (currentTab.value === 'Forms' && currentForm.value) {
    if (baselineRaw.value.forms[currentForm.value] !== undefined) {
      forms.value[currentForm.value] = baselineRaw.value.forms[currentForm.value];
    }
  }
}

const showDiffModal = ref(false);
const diffSaved = ref('');
const diffCurrent = ref('');

// Read-modify-write the currently selected form through the yaml document API,
// so comments and formatting survive an edit made in one of the modals (a plain
// parse + stringify strips every comment the author typed). Same contract as
// the raw section helpers : a buffer that can't be parsed as a mapping aborts
// with a warning instead of being silently replaced. A list or a map the edit
// changes or creates is written one item per line (lib/yamlBlock.js).
function editCurrentFormDoc(mutate) {
  if (!currentForm.value || !forms.value[currentForm.value]) return false;
  try {
    const doc = YAML.parseDocument(forms.value[currentForm.value]);
    if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
    if (!YAML.isMap(doc.contents)) throw new Error('form is not a mapping');
    mutate(doc);
    forms.value[currentForm.value] = yamlText(doc);
    return true;
  } catch {
    toast.error(t('designer.badYamlUpdate'));
    return false;
  }
}

// Set or remove a key on a yaml map/document node, keeping the position (and
// any trailing comment) of a key that is already there. The map, changed, is
// written one key per line.
function setDocValue(node, key, value) {
  const map = YAML.isDocument(node) ? node.contents : node;
  if (value === undefined) dropKey(map, key);
  else putKey(map, key, value);
}

// Same, but a value that did not change is left alone : node.set() REPLACES the
// value node, which drops its quoting style and any comment written next to it.
// Used by the editors that rewrite every property of a node they reuse, so an
// apply without edits is a real no-op.
function setDocValueIfChanged(node, key, value) {
  if (node.get(key) === value) return;
  setDocValue(node, key, value);
}

// A comment written between a key and the first '-' of its sequence belongs to
// the SEQUENCE, not to the first item (yaml puts it in seq.commentBefore). Any
// editor that rebuilds the item list would leave it pinned to the top, where it
// then documents whatever item ends up first (or survives the deletion of the
// item it described). Moving it onto the first item keeps it with that item :
// it travels along on a reorder and disappears with a delete.
function hoistSeqComment(seq) {
  if (!YAML.isSeq(seq) || !seq.commentBefore) return;
  const first = seq.items[0];
  if (!first || typeof first !== 'object') return;
  first.commentBefore = first.commentBefore ? `${seq.commentBefore}\n${first.commentBefore}` : seq.commentBefore;
  seq.commentBefore = null;
}

// A subform can only hold a small subset of the form properties (see the
// 'subform' branch of server/schema/form_schema.json) : icon/image/tileClass/
// categories/roles/order are all forbidden, so the modals that write them are
// disabled for a subform instead of producing an unsaveable config.
const currentFormIsSubform = computed(() => {
  if (currentTab.value !== 'Forms' || !currentForm.value) return false;
  try {
    return YAML.parse(forms.value[currentForm.value])?.type === 'subform';
  } catch {
    return false;
  }
});

// Icon picker
const showIconPicker = ref(false);
const iconSearch = ref('');
const iconColorOptions = computed(() => [
  { value: '', label: t('designer.colorDefault') },
  { value: 'primary', label: t('designer.colorPrimary') },
  { value: 'secondary', label: t('designer.colorSecondary') },
  { value: 'success', label: t('designer.colorSuccess') },
  { value: 'danger', label: t('designer.colorDanger') },
  { value: 'warning', label: t('designer.colorWarning') },
  { value: 'info', label: t('designer.colorInfo') },
  { value: 'dark', label: t('designer.colorDark') },
  { value: 'white', label: t('designer.colorWhite') },
]);

const iconSizeOptions = computed(() => [
  { value: '', label: t('designer.sizeDefault') },
  { value: 'xs', label: 'XS' },
  { value: 'sm', label: 'SM' },
  { value: 'lg', label: 'LG' },
  { value: '2x', label: '2x' },
  { value: '3x', label: '3x' },
  { value: '5x', label: '5x' },
  { value: '7x', label: '7x' },
  { value: '10x', label: '10x' },
]);

const overlayPositionOptions = computed(() => [
  { value: 'top-left', label: t('designer.posTopLeft') },
  { value: 'top-right', label: t('designer.posTopRight') },
  { value: 'bottom-left', label: t('designer.posBottomLeft') },
  { value: 'bottom-right', label: t('designer.posBottomRight') },
]);

const iconForm = ref({
  icon: '',
  iconColor: '',
  iconSize: '',
  overlayIcon: '',
  overlayIconColor: 'success',
  overlayIconCircle: true,
  overlayIconText: '',
  overlayIconTextPosition: 'bottom-left',
  overlayIconTextColor: 'success',
});

const iconSections = ref({ icons: true, style: false, overlay: false });

const filteredIcons = computed(() => {
  if (!iconSearch.value) return availableIcons;
  const q = iconSearch.value.toLowerCase();
  return availableIcons.filter((i) => i.includes(q));
});

function openIconPicker() {
  if (currentTab.value !== 'Forms' || !currentForm.value) {
    toast.warning(t('designer.selectFormFirst'));
    return;
  }
  if (currentFormIsSubform.value) {
    toast.warning(t('designer.notForSubforms'));
    return;
  }
  try {
    const parsed = YAML.parse(forms.value[currentForm.value]);
    iconForm.value = {
      icon: parsed.icon || '',
      iconColor: parsed.iconColor || '',
      iconSize: parsed.iconSize || '',
      overlayIcon: parsed.overlayIcon || '',
      overlayIconColor: parsed.overlayIconColor || 'success',
      overlayIconCircle: parsed.overlayIconCircle !== false,
      overlayIconText: parsed.overlayIconText || '',
      overlayIconTextPosition: parsed.overlayIconTextPosition || 'bottom-left',
      overlayIconTextColor: parsed.overlayIconTextColor || 'success',
    };
  } catch {
    /* defaults are fine */
  }
  iconSearch.value = '';
  showIconPicker.value = true;
}

function pickIcon(iconName) {
  iconForm.value.icon = iconName;
}

function applyIconForm() {
  editCurrentFormDoc((doc) => {
    const props = [
      'icon',
      'iconColor',
      'iconSize',
      'overlayIcon',
      'overlayIconColor',
      'overlayIconCircle',
      'overlayIconText',
      'overlayIconTextPosition',
      'overlayIconTextColor',
    ];
    const defaults = {
      overlayIconColor: 'success',
      overlayIconCircle: true,
      overlayIconTextPosition: 'bottom-left',
      overlayIconTextColor: 'success',
    };
    for (const p of props) {
      const v = iconForm.value[p];
      if (v === '' || v === undefined || v === null) {
        setDocValue(doc, p, undefined);
      } else if (p === 'overlayIconCircle') {
        setDocValue(doc, p, v === true ? undefined : v);
      } else if (defaults[p] && v === defaults[p] && !doc.get('overlayIcon') && !doc.get('overlayIconText')) {
        setDocValue(doc, p, undefined);
      } else {
        setDocValueIfChanged(doc, p, v);
      }
    }
    if (!doc.get('overlayIcon') && !doc.get('overlayIconText')) {
      setDocValue(doc, 'overlayIconColor', undefined);
      setDocValue(doc, 'overlayIconCircle', undefined);
      setDocValue(doc, 'overlayIconTransform', undefined);
      setDocValue(doc, 'overlayIconTextPosition', undefined);
      setDocValue(doc, 'overlayIconTextColor', undefined);
    }
  });
  showIconPicker.value = false;
}

// Add category
const showAddCategory = ref(false);
const newCatName = ref('');
const newCatIcon = ref('bars');
const newCatParent = ref('');
const catIconSearch = ref('');

const filteredCatIcons = computed(() => {
  if (!catIconSearch.value) return availableIcons;
  const q = catIconSearch.value.toLowerCase();
  return availableIcons.filter((i) => i.includes(q));
});

function flattenCatNames(cats, prefix) {
  const result = [];
  for (const c of cats) {
    if (!c || !c.name) continue;
    const path = prefix ? prefix + '/' + c.name : c.name;
    result.push({ label: path, value: path });
    if (c.items && c.items.length > 0) {
      result.push(...flattenCatNames(c.items, path));
    }
  }
  return result;
}

const parentCatOptions = computed(() => {
  const cats = parseSeqYaml(categories.value);
  if (!cats) return [];
  return [{ label: t('designer.topLevel'), value: '' }, ...flattenCatNames(cats, '')];
});

function openAddCategory() {
  newCatName.value = '';
  newCatIcon.value = 'bars';
  newCatParent.value = '';
  catIconSearch.value = '';
  showAddCategory.value = true;
}

function findCatByPath(cats, path) {
  const parts = path.split('/');
  let current = cats;
  let target = null;
  for (const part of parts) {
    target = current.find((c) => c && c.name === part);
    if (!target) return null;
    current = target.items || [];
  }
  return target;
}

function doAddCategory() {
  const name = newCatName.value.trim();
  if (!name) {
    toast.warning(t('designer.categoryNameRequired'));
    return;
  }
  const icon = newCatIcon.value || 'bars';
  const cats = parseSeqYaml(categories.value);
  if (cats === null) {
    toast.error(t('designer.badYamlUpdate'));
    return;
  }

  if (newCatParent.value) {
    const parent = findCatByPath(cats, newCatParent.value);
    if (!parent) {
      toast.error(t('designer.badYamlUpdate'));
      return;
    }
    const siblings = parent.items || [];
    if (siblings.some((c) => c && c.name === name)) {
      toast.warning(t('designer.categoryExists'));
      return;
    }
    if (!parent.items) parent.items = [];
    parent.items.push({ name, icon });
    categories.value = YAML.stringify(cats);
  } else {
    if (cats.some((c) => c && c.name === name)) {
      toast.warning(t('designer.categoryExists'));
      return;
    }
    categories.value = appendToSeqYaml(categories.value, { name, icon });
  }
  showAddCategory.value = false;
}

// Edit categories
const showEditCategories = ref(false);
const editCats = ref([]);
const editCatIconIdx = ref(null);
const editCatIconSearch = ref('');

const filteredEditCatIcons = computed(() => {
  if (!editCatIconSearch.value) return availableIcons;
  const q = editCatIconSearch.value.toLowerCase();
  return availableIcons.filter((i) => i.includes(q));
});

// `_path` is the index path of the yaml node the row was cloned from, so the
// apply can write back into that very node (and keep its comments) even after
// the name was changed or the row was dragged to another position.
function cloneCats(cats, path = []) {
  return cats.map((c, i) => {
    const clone = { name: c.name || '', icon: c.icon || 'bars', _path: [...path, i] };
    if (c.items && c.items.length > 0) clone.items = cloneCats(c.items, [...path, i, 'items']);
    return clone;
  });
}

const flatEditCats = computed(() => flattenCategories(editCats.value));

// Reorganizing the tree : nesting could be built but never changed, so moving a
// category under another one meant deleting it and typing the subtree back.
// The icon picker is keyed on a FLAT index, which every one of these shifts -
// it would end up writing into a different category (same reason as
// editCatRemove).
function editCatMove(op, cat) {
  if (editCatIconIdx.value !== null) editCatIconIdx.value = null;
  op(editCats.value, cat);
}

// Paths that the edit has moved or renamed away. A form points at a category by
// path, so those forms stop appearing under it - said out loud rather than
// refused, because reorganizing on purpose is the normal case.
const editCatMovedPaths = computed(() => {
  let before;
  try {
    before = YAML.parse(categories.value) || [];
  } catch {
    before = [];
  }
  if (!Array.isArray(before)) before = [];
  return movedCategoryPaths(before, editCats.value);
});

// base_schema.json pins one entry : `categories` must CONTAIN exactly
// {name: Default, icon: bars}. Renaming that row, restyling it, deleting it or
// giving it subcategories makes EVERY save fail on a raw schema error, so the
// row is locked here the same way the settings categories page locks it
// (config/categories.js, isDefaultCategory - which the move rules also apply).
function isDefaultEditCat(cat, depth) {
  return isDefaultCategory(cat, depth);
}

function openEditCategories() {
  // an alias can't be written back (see catsHaveAlias) : refuse before the
  // modal shows the resolved content as if it were editable
  const doc = parseDocOrNull(categories.value);
  if (doc && catsHaveAlias(doc.contents)) {
    toast.warning(t('designer.aliasNotSupported'));
    return;
  }
  let cats = [];
  if (categories.value) {
    try {
      cats = YAML.parse(categories.value) || [];
    } catch {
      cats = [];
    }
  }
  if (!Array.isArray(cats)) cats = [];
  editCats.value = cloneCats(cats);
  editCatIconIdx.value = null;
  editCatIconSearch.value = '';
  showEditCategories.value = true;
}

function editCatPickIcon(flatIdx) {
  const row = flatEditCats.value[flatIdx];
  // the icon of the Default category is part of what the schema pins
  if (row && isDefaultEditCat(row.cat, row.depth)) return;
  editCatIconIdx.value = editCatIconIdx.value === flatIdx ? null : flatIdx;
  editCatIconSearch.value = '';
}

function editCatSelectIcon(flatIdx, icon) {
  flatEditCats.value[flatIdx].cat.icon = icon;
  editCatIconIdx.value = null;
}

function editCatAddSub(cat) {
  // the flat indices shift as soon as a row is inserted, so an open icon picker
  // would end up writing into another category (same reason as editCatRemove)
  if (editCatIconIdx.value !== null) editCatIconIdx.value = null;
  if (!cat.items) cat.items = [];
  cat.items.push({ name: '', icon: 'bars' });
}

function editCatRemove(cat) {
  if (editCatIconIdx.value !== null) editCatIconIdx.value = null;
  function removeFrom(list) {
    const idx = list.indexOf(cat);
    if (idx >= 0) {
      list.splice(idx, 1);
      return true;
    }
    for (const item of list) {
      if (item.items && removeFrom(item.items)) return true;
    }
    return false;
  }
  removeFrom(editCats.value);
}

// An Alias ('- *catA', 'items: *subs') is neither a Map nor a Seq, so the
// rebuild below cannot address it : it would create a brand new node from the
// few properties the modal shows, dropping everything else the anchor carries
// and expanding the alias. Refuse the edit instead.
function catsHaveAlias(node) {
  if (YAML.isAlias(node)) return true;
  if (!YAML.isSeq(node)) return false;
  for (const item of node.items) {
    if (YAML.isAlias(item)) return true;
    if (YAML.isMap(item) && catsHaveAlias(item.get('items'))) return true;
  }
  return false;
}

// Rebuild the category sequence on top of the nodes it was cloned from, so the
// comments of the entries that were not touched survive the edit.
function buildCleanCatNodes(doc, cats) {
  const nodes = [];
  for (const c of cats) {
    const name = (c.name || '').trim();
    if (!name) continue;
    let node = Array.isArray(c._path) ? doc.getIn(c._path) : null;
    if (YAML.isMap(node)) {
      setDocValueIfChanged(node, 'name', name);
      setDocValueIfChanged(node, 'icon', c.icon);
    } else {
      node = doc.createNode({ name, icon: c.icon });
    }
    const children = c.items && c.items.length > 0 ? buildCleanCatNodes(doc, c.items) : [];
    if (children.length > 0) {
      const sub = node.get('items');
      if (YAML.isSeq(sub)) {
        hoistSeqComment(sub);
        sub.items = children;
        toBlock(sub);
      } else putKey(node, 'items', doc.createNode(children));
    } else {
      dropKey(node, 'items');
    }
    nodes.push(node);
  }
  return nodes;
}

function applyEditCategories() {
  const doc = parseDocOrNull(categories.value);
  if (!doc) {
    toast.error(t('designer.badYamlUpdate'));
    return;
  }
  // the buffer could have changed since the modal opened : an alias must never
  // reach the rebuild
  if (catsHaveAlias(doc.contents)) {
    toast.warning(t('designer.aliasNotSupported'));
    return;
  }
  hoistSeqComment(doc.contents);
  const nodes = buildCleanCatNodes(doc, editCats.value);
  if (YAML.isSeq(doc.contents)) toBlock(doc.contents).items = nodes;
  else doc.contents = doc.createNode(nodes);
  categories.value = yamlText(doc);
  showEditCategories.value = false;
}

// Parse a raw yaml sequence: [] when empty, null when unparsable or not a
// sequence (callers must abort then instead of silently wiping the section).
function parseSeqYaml(raw) {
  if (!raw || !raw.trim()) return [];
  try {
    const v = YAML.parse(raw);
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Parse a raw section as a yaml document (the node tree, comments included).
// null when it can't be parsed, so callers abort instead of replacing content.
function parseDocOrNull(raw) {
  try {
    const doc = YAML.parseDocument(raw || '');
    return doc.errors.length > 0 ? null : doc;
  } catch {
    return null;
  }
}

// Append one item to a raw yaml sequence, preserving comments/formatting of
// the existing content via the document API (a plain parse+stringify would
// strip in-session hand-typed comments).
function appendToSeqYaml(raw, item) {
  if (!raw || !raw.trim()) return YAML.stringify([item]);
  const doc = YAML.parseDocument(raw);
  toBlock(doc.contents).add(doc.createNode(item));
  return yamlText(doc);
}

// the edit modals only make sense when the raw yaml actually holds content ;
// (categoriesObj/rolesObj/constantsObj can't be used here : they inject
// defaults for an empty editor). Bad yaml also disables : the raw editor is
// the recovery tool then.
function parsedOrNull(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return YAML.parse(raw);
  } catch {
    return null;
  }
}
// the Add modals can only append to a parsable section (empty is fine) ;
// bad yaml disables Add so the modal can never wipe hand-edited content
const canAddCategories = computed(() => parseSeqYaml(categories.value) !== null);
const canAddConstants = computed(() => parseConstantsYaml() !== null);

const hasEditableCategories = computed(() => {
  const v = parsedOrNull(categories.value);
  return Array.isArray(v) && v.length > 0;
});
const hasEditableConstants = computed(() => {
  const v = parsedOrNull(constants.value);
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
});

// Constants : add / edit modals that read-modify-write the raw `constants` YAML
// string (a free-form key -> value object). Values round-trip through the same
// display/coerce rules as the admin constants page: objects/arrays show as
// JSON, unchanged values are preserved verbatim, edited/new values are coerced.

// {} when empty, null when unparsable or not a map (callers must abort then
// instead of silently wiping the section).
function parseConstantsYaml() {
  if (!constants.value || !constants.value.trim()) return {};
  try {
    const v = YAML.parse(constants.value);
    if (v === null || v === undefined) return {};
    return typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Add constant
const showAddConstant = ref(false);
const newConstKey = ref('');
const newConstValue = ref('');
const newConstParent = ref('');

// The parent picker must NOT identify a constant by a dotted path : a key can
// itself contain a dot ('app.url'), and splitting that path apart invents a
// nested map instead of finding the parent the user picked. Each option
// therefore holds a direct reference to the map that owns it (the same row
// reference approach the settings constants page uses), and the select only
// carries its index. Both are captured when the modal opens, so the reference
// and the object the apply writes into are the same tree.
const addConstRoot = ref(null);
const addConstParents = ref([]);

function collectConstantParents(obj, prefix, result) {
  for (const [k, v] of Object.entries(obj)) {
    const label = prefix ? `${prefix}.${k}` : k;
    result.push({ label, owner: obj, key: k });
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      collectConstantParents(v, label, result);
    }
  }
  return result;
}

const hasAnyConstants = computed(() => {
  const obj = parseConstantsYaml();
  return obj && Object.keys(obj).length > 0;
});

// Forms reference a constant as $(path); nested ones use a dotted path, which the
// server resolves with Helpers.findExtravar (svm.lif.ip => data.svm.lif.ip). Only
// leaves are offered : inserting a reference to a whole map is never what a field
// wants.
function collectConstantLeaves(obj, prefix, result) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      collectConstantLeaves(v, path, result);
    } else {
      result.push({ path, value: v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '') });
    }
  }
  return result;
}
const insertableConstants = computed(() => {
  const obj = parseConstantsYaml();
  return obj ? collectConstantLeaves(obj, '', []) : [];
});
const showInsertConstant = ref(false);

function openInsertConstant() {
  showInsertConstant.value = true;
}
function insertConstant(path) {
  showInsertConstant.value = false;
  const editor = activeEditor.value;
  if (!editor) return;
  editor.insert(`$(${path})`);
  editor.focus();
}
// creating one is the same flow the Constants tab uses : it edits the constants
// section, not the current form, so it works from here unchanged.
function newConstantFromInsert() {
  showInsertConstant.value = false;
  openAddConstant();
}

function openAddConstant() {
  newConstKey.value = '';
  newConstValue.value = '';
  newConstParent.value = '';
  const obj = parseConstantsYaml();
  addConstRoot.value = obj;
  addConstParents.value = obj ? collectConstantParents(obj, '', []) : [];
  showAddConstant.value = true;
}

function doAddConstant() {
  const key = newConstKey.value.trim();
  if (!key) {
    toast.warning(t('designer.constantKeyRequired'));
    return;
  }
  const root = addConstRoot.value;
  if (!root) {
    toast.error(t('designer.badYamlUpdate'));
    return;
  }

  // a list or a map that cannot be parsed would be stored as its own yaml source
  // text, so `$(KEY)` would hand a form a string that merely looks like a list
  const valueError = constantValueError(newConstValue.value);
  if (valueError) {
    toast.warning(t('designer.constantValueInvalid', { key, error: valueError }));
    return;
  }

  const value = coerceConstantValue(newConstValue.value);
  const parent = newConstParent.value === '' ? null : addConstParents.value[Number(newConstParent.value)];
  if (newConstParent.value !== '' && !parent) {
    toast.error(t('designer.badYamlUpdate'));
    return;
  }

  let target = root;
  let dropped = '';
  if (parent) {
    const existing = parent.owner[parent.key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      // a constant holds either a value or subkeys : the parent becomes a map, so
      // tell the user its value goes away instead of dropping it silently
      if (existing !== undefined && existing !== null) dropped = parent.label;
      target = {};
      parent.owner[parent.key] = target;
    } else {
      target = existing;
    }
  }
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    toast.warning(t('designer.constantExists'));
    return;
  }
  target[key] = value;

  constants.value = YAML.stringify(root);
  if (dropped) toast.warning(t('designer.constantParentValueDropped', { key: dropped }));
  showAddConstant.value = false;
}

// Edit constants
const showEditConstants = ref(false);
const editConsts = ref([]);

// stable identity per row : the flat list is re-derived on every change, so an
// index key would make vue reuse an input for another row when one is inserted
// or removed
let editConstUid = 0;
function stampConstUids(rows) {
  for (const row of rows) {
    row._uid = ++editConstUid;
    if (row.children) stampConstUids(row.children);
  }
  return rows;
}

function openEditConstants() {
  editConsts.value = stampConstUids(constantsToArray(parseConstantsYaml() || {}));
  showEditConstants.value = true;
}

const flatEditConsts = computed(() => flattenConstants(editConsts.value));

function editConstAddSub(row) {
  if (!row.children) row.children = [];
  // a constant holds either a value or subkeys : the tree is serialized
  // children-first, so a value left on a row that just gained subkeys would be
  // dropped on apply. Clear it so the table shows what will actually persist.
  row.value = '';
  row.children.push({ _uid: ++editConstUid, key: '', value: '', children: [] });
}

function editConstRemove(target, list) {
  if (!list) list = editConsts.value;
  const idx = list.indexOf(target);
  if (idx !== -1) {
    list.splice(idx, 1);
    return true;
  }
  for (const item of list) {
    if (item.children && editConstRemove(target, item.children)) return true;
  }
  return false;
}

function validateConstKeys(arr) {
  const keys = arr.map((c) => c.key.trim());
  if (keys.some((k) => !k)) return false;
  if (new Set(keys).size !== keys.length) return 'duplicate';
  for (const row of arr) {
    if (row.children && row.children.length > 0) {
      const sub = validateConstKeys(row.children);
      if (sub !== true) return sub;
    }
  }
  return true;
}

function trimConstKeys(arr) {
  return arr.map((r) => ({
    ...r,
    key: r.key.trim(),
    children: r.children ? trimConstKeys(r.children) : [],
  }));
}

// The first row whose value is meant to be a list or a map but cannot be parsed.
// Stored as-is it would be its own yaml SOURCE, which reads back as a string.
function findInvalidConstValue(arr) {
  for (const row of arr) {
    if (!(row.children && row.children.length > 0)) {
      const error = constantValueError(row.value);
      if (error) return { key: (row.key || '').trim(), error };
    }
    if (row.children && row.children.length > 0) {
      const invalid = findInvalidConstValue(row.children);
      if (invalid) return invalid;
    }
  }
  return null;
}

function applyEditConstants() {
  const valid = validateConstKeys(editConsts.value);
  if (valid === false) {
    toast.warning(t('designer.constantKeyRequired'));
    return;
  }
  if (valid === 'duplicate') {
    toast.warning(t('designer.constantExists'));
    return;
  }
  const invalid = findInvalidConstValue(editConsts.value);
  if (invalid) {
    toast.warning(t('designer.constantValueInvalid', invalid));
    return;
  }
  constants.value = YAML.stringify(arrayToConstants(trimConstKeys(editConsts.value)));
  showEditConstants.value = false;
}

// Tile background picker
const showTilePicker = ref(false);
const tileOptions = computed(() => [
  // 'none' is what makes a background removable again : without it a tileClass
  // could be set but never cleared from the ui
  { label: t('designer.tileNone'), value: '', color: 'transparent' },
  { label: t('designer.tileBlue'), value: 'bg-primary-subtle', color: '#cfe2ff' },
  { label: t('designer.tileGreen'), value: 'bg-success-subtle', color: '#d1e7dd' },
  { label: t('designer.tileRed'), value: 'bg-danger-subtle', color: '#f8d7da' },
  { label: t('designer.tileYellow'), value: 'bg-warning-subtle', color: '#fff3cd' },
  { label: t('designer.tileCyan'), value: 'bg-info-subtle', color: '#cff4fc' },
  { label: t('designer.tileGray'), value: 'bg-secondary-subtle', color: '#e2e3e5' },
  { label: t('designer.tileLight'), value: 'bg-light-subtle', color: '#fcfcfd' },
  { label: t('designer.tileDark'), value: 'bg-dark-subtle', color: '#ced4da' },
  { label: t('designer.tilePrimary'), value: 'bg-primary', color: '#0d6efd' },
  { label: t('designer.tileSuccess'), value: 'bg-success', color: '#198754' },
  { label: t('designer.tileDanger'), value: 'bg-danger', color: '#dc3545' },
  { label: t('designer.tileWarning'), value: 'bg-warning', color: '#ffc107' },
  { label: t('designer.tileInfo'), value: 'bg-info', color: '#0dcaf0' },
  { label: t('designer.tileInfoLight'), value: 'has-background-info-light', color: '#d0ecf5' },
]);

const currentFormTile = computed(() => {
  if (!currentForm.value || !forms.value[currentForm.value]) return null;
  try {
    return YAML.parse(forms.value[currentForm.value])?.tileClass || null;
  } catch {
    return null;
  }
});

const selectedTile = ref('');

function openTilePicker() {
  if (currentTab.value !== 'Forms' || !currentForm.value) {
    toast.warning(t('designer.selectFormFirst'));
    return;
  }
  if (currentFormIsSubform.value) {
    toast.warning(t('designer.notForSubforms'));
    return;
  }
  selectedTile.value = currentFormTile.value || '';
  showTilePicker.value = true;
}

function applyTile() {
  editCurrentFormDoc((doc) => {
    setDocValue(doc, 'tileClass', selectedTile.value || undefined);
  });
  showTilePicker.value = false;
}

// Image picker
const showImagePicker = ref(false);
const imageUrl = ref('');

function openImagePicker() {
  if (currentTab.value !== 'Forms' || !currentForm.value) {
    toast.warning(t('designer.selectFormFirst'));
    return;
  }
  if (currentFormIsSubform.value) {
    toast.warning(t('designer.notForSubforms'));
    return;
  }
  try {
    imageUrl.value = YAML.parse(forms.value[currentForm.value])?.image || '';
  } catch {
    imageUrl.value = '';
  }
  showImagePicker.value = true;
}

function applyImage() {
  editCurrentFormDoc((doc) => {
    setDocValue(doc, 'image', imageUrl.value.trim() || undefined);
  });
  showImagePicker.value = false;
}

// Categories picker
const showCatPicker = ref(false);
const selectedCats = ref([]);

function openCatPicker() {
  if (currentTab.value !== 'Forms' || !currentForm.value) {
    toast.warning(t('designer.selectFormFirst'));
    return;
  }
  if (currentFormIsSubform.value) {
    toast.warning(t('designer.notForSubforms'));
    return;
  }
  try {
    selectedCats.value = [...(YAML.parse(forms.value[currentForm.value])?.categories || [])];
  } catch {
    selectedCats.value = [];
  }
  showCatPicker.value = true;
}

function toggleCat(name) {
  const idx = selectedCats.value.indexOf(name);
  if (idx >= 0) selectedCats.value.splice(idx, 1);
  else selectedCats.value.push(name);
}

function applyCats() {
  editCurrentFormDoc((doc) => {
    setDocValue(doc, 'categories', selectedCats.value.length > 0 ? [...selectedCats.value] : undefined);
  });
  showCatPicker.value = false;
}

// Roles picker
const showRolePicker = ref(false);
const selectedRoles = ref([]);

function openRolePicker() {
  if (currentTab.value !== 'Forms' || !currentForm.value) {
    toast.warning(t('designer.selectFormFirst'));
    return;
  }
  if (currentFormIsSubform.value) {
    toast.warning(t('designer.notForSubforms'));
    return;
  }
  try {
    selectedRoles.value = [...(YAML.parse(forms.value[currentForm.value])?.roles || [])];
  } catch {
    selectedRoles.value = [];
  }
  showRolePicker.value = true;
}

function toggleRole(name) {
  const idx = selectedRoles.value.indexOf(name);
  if (idx >= 0) selectedRoles.value.splice(idx, 1);
  else selectedRoles.value.push(name);
}

function applyRoles() {
  editCurrentFormDoc((doc) => {
    setDocValue(doc, 'roles', selectedRoles.value.length > 0 ? [...selectedRoles.value] : undefined);
  });
  showRolePicker.value = false;
}

// Download YAML
function downloadYaml() {
  let content = '';
  let filename = 'config.yaml';
  if (currentTab.value === 'Categories') {
    content = categories.value;
    filename = 'categories.yaml';
  } else if (currentTab.value === 'Constants') {
    content = constants.value;
    filename = 'constants.yaml';
  } else if (currentTab.value === 'Forms' && currentForm.value) {
    content = forms.value[currentForm.value] || '';
    const mapping = idmapping.value.find((x) => x.id === currentForm.value);
    filename = mapping?.source || 'form.yaml';
  } else if (FILE_SECTIONS[currentTab.value] && projectFiles.value?.selected) {
    // the file open, by its own name
    content = projectFiles.value.getText();
    filename = projectFiles.value.selected.split('/').pop();
  }
  if (!content) return;
  const blob = new Blob([content], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Import YAML : the counterpart of the three downloads above. There is no server
// side import, so the forms are brought into the editor BUFFERS and the normal
// validate/save path applies to them like to anything else typed here. Nothing
// is touched before the whole file parses, and an existing form or file is never
// overwritten : a name that is taken is renamed, and the target file is picked
// in the modal.
const importInput = ref(null);
const showImportModal = ref(false);
const importFileName = ref('');
const importCandidates = ref([]);
const importTarget = ref('');
const importSkipped = ref(0);

// the files the import can go into. The base config is deliberately absent : since
// 7.0.0 every form lives in a file of its own.
const importFileOptions = computed(() => {
  const opts = files.value.filter(Boolean).map((f) => ({ value: f, label: f }));
  if (importFileName.value && !files.value.includes(importFileName.value)) {
    opts.unshift({ value: importFileName.value, label: `${importFileName.value} (${t('designer.importNewFile')})` });
  }
  return opts;
});

// the uploaded filename as a forms file the designer would accept (addFile uses
// the same shape) : anything else becomes a '-', an unusable result falls back
function importFileNameFrom(name) {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-.]+/, '');
  return /^[A-Za-z0-9._-]+\.(yaml|yml)$/.test(cleaned) ? cleaned : 'imported.yaml';
}

// Every form a yaml file holds, whatever shape it was downloaded in : one form
// per document (a single form download), several documents separated by '---' (a
// whole file), a full config with a `forms` list, or a bare list of forms.
function collectImportForms(docs) {
  const found = [];
  let skipped = 0;
  const push = (node) => {
    if (!YAML.isMap(node)) {
      skipped++;
      return;
    }
    const name = node.get('name');
    // a form without a name has nothing to be identified by, and the designer
    // would only flag it as a warning right after the import
    if (typeof name !== 'string' || !name.trim()) {
      skipped++;
      return;
    }
    found.push({ name: name.trim(), yaml: YAML.stringify(node) });
  };
  for (const doc of docs) {
    const contents = doc.contents;
    if (contents === null || contents === undefined) continue;
    if (YAML.isMap(contents)) {
      const list = contents.get('forms');
      if (YAML.isSeq(list)) {
        hoistSeqComment(list);
        list.items.forEach(push);
        continue;
      }
      push(contents);
    } else if (YAML.isSeq(contents)) {
      hoistSeqComment(contents);
      contents.items.forEach(push);
    } else {
      skipped++;
    }
  }
  return { found, skipped };
}

function openImport() {
  if (busyOrTemplated.value) {
    toast.warning(t('designer.readOnly'));
    return;
  }
  importInput.value?.click();
}

async function onImportFile(event) {
  const file = event.target.files?.[0];
  // clear the input, otherwise picking the very same file again fires no change
  event.target.value = '';
  if (!file) return;
  if (!/\.(yaml|yml)$/i.test(file.name)) {
    toast.error(t('designer.importNotYaml'));
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    toast.error(t('designer.importReadFailed'));
    return;
  }
  let docs;
  try {
    docs = YAML.parseAllDocuments(text);
  } catch {
    docs = [];
  }
  // it must parse as a whole before anything is offered : a half-read file would
  // import the forms it managed to read and silently drop the rest
  if (docs.length === 0 || docs.some((d) => d.errors.length > 0)) {
    toast.error(t('designer.importBadYaml'));
    return;
  }
  // the documents parse, but their SHAPE is still whatever was in the file :
  // walking it can throw on anything unexpected, and an uncaught throw here
  // leaves the file input half-consumed with no message at all
  let found, skipped;
  try {
    ({ found, skipped } = collectImportForms(docs));
  } catch {
    toast.error(t('designer.importBadYaml'));
    return;
  }
  if (found.length === 0) {
    toast.warning(t('designer.importNoForms'));
    return;
  }
  // a name that already exists (in the config or earlier in this same file) is
  // renamed, never merged onto the form that holds it
  const taken = idmapping.value.map((x) => x.name);
  const suffix = t('designer.importedSuffix');
  for (const entry of found) {
    entry.include = true;
    entry.finalName = entry.name;
    if (taken.includes(entry.finalName)) {
      entry.finalName = `${entry.name} (${suffix})`;
      let counter = 2;
      while (taken.includes(entry.finalName)) entry.finalName = `${entry.name} (${suffix} ${counter++})`;
    }
    taken.push(entry.finalName);
  }
  importFileName.value = importFileNameFrom(file.name);
  importCandidates.value = found;
  importSkipped.value = skipped;
  // the file the forms came from : an existing one to append to, otherwise a new
  // file of that name. Either way it is an option of the select.
  importTarget.value = importFileName.value;
  showImportModal.value = true;
}

// a file belongs to exactly one repository, so an imported form has to inherit
// it from the forms already in the target file. The save groups by source AND
// repository (see idmapping), so leaving it undefined splits the file in two
// and writes the imported forms outside the repository the file lives in.
function repositoryForSource(source) {
  return Object.values(formMeta.value).find((m) => m?.source === source && m?.repository)?.repository;
}

function doImport() {
  if (busyOrTemplated.value) {
    toast.warning(t('designer.readOnly'));
    return;
  }
  const selected = importCandidates.value.filter((x) => x.include);
  if (selected.length === 0) {
    toast.warning(t('designer.importNothingSelected'));
    return;
  }
  const target = importTarget.value;
  if (!target) {
    toast.warning(t('designer.importNoTarget'));
    return;
  }
  const targetRepo = repositoryForSource(target);
  const renamed = [];
  let firstId = null;
  for (const entry of selected) {
    const id = nextFormId();
    // the rename is written through the document api, so the comments the
    // imported form carries survive it
    let yaml = entry.yaml;
    if (entry.finalName !== entry.name) {
      const doc = YAML.parseDocument(entry.yaml);
      if (YAML.isMap(doc.contents)) {
        doc.set('name', entry.finalName);
        yaml = doc.toString();
      }
      renamed.push(`${entry.name} -> ${entry.finalName}`);
    }
    formMeta.value[id] = targetRepo ? { source: target, repository: targetRepo } : { source: target };
    forms.value[id] = yaml;
    if (!firstId) firstId = id;
  }
  collapsedPaths.value.delete(`file:${target}`);
  if (firstId) selectForm(firstId);
  showImportModal.value = false;
  toast.success(t('designer.importDone', { file: target }, selected.length));
  if (renamed.length > 0) toast.warning(t('designer.importRenamed', { details: renamed.join(', ') }));
}

// Collect every subform name a form references : "list" and "yaml" fields point
// at one by name, wizard steps do too, and both nest (a subform's own list
// fields). `visited` guards against cycles (A -> B -> A). This mirrors the
// server side resolution (form.model.js, collectSubformsForForm), which the
// normal /form load relies on but a designer preview has to do itself.
function collectSubformNames(fields, byName, collected, visited) {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if ((field?.type === 'list' || field?.type === 'yaml') && field?.subform && !visited.has(field.subform)) {
      visited.add(field.subform);
      collected.add(field.subform);
      collectSubformNames(byName.get(field.subform)?.fields, byName, collected, visited);
    }
    // multistep forms nest their fields under step objects
    if (Array.isArray(field?.fields)) collectSubformNames(field.fields, byName, collected, visited);
  }
}

// Resolve the subforms of a form from the (possibly unsaved) designer buffers,
// the way the server inlines them on a normal load. A subform that is missing
// or has bad yaml is reported back instead of throwing, so the preview still
// opens (with a placeholder for that field, like the server does).
function resolveSubforms(form) {
  const byName = new Map();
  for (const f of formsObj.value) {
    if (f && f.type === 'subform' && f.name && !byName.has(f.name)) byName.set(f.name, f);
  }
  const names = new Set();
  const visited = new Set();
  collectSubformNames(form?.fields, byName, names, visited);
  if (Array.isArray(form?.wizard)) {
    for (const step of form.wizard) {
      if (step?.subform && !visited.has(step.subform)) {
        visited.add(step.subform);
        names.add(step.subform);
        collectSubformNames(byName.get(step.subform)?.fields, byName, names, visited);
      }
    }
  }
  const subforms = [];
  const missing = [];
  for (const name of names) {
    const sub = byName.get(name);
    if (sub) subforms.push(sub);
    else missing.push(name);
  }
  return { subforms, missing };
}

/**
 * Hands the form being edited to the form page for a preview, unsaved edits included : its
 * YAML, the subforms it uses and the constants, in the session (the form page reads them once).
 *
 * Returns:
 *   string|null: the preview's address, or null when there is nothing to preview (a toast says
 *   why).
 */
function preparePreview() {
  if (!currentFormName.value || !currentForm.value) return null;
  const yaml = forms.value[currentForm.value];
  if (!yaml) return null;
  let parsed;
  try {
    parsed = YAML.parse(yaml);
  } catch {
    parsed = null;
  }
  // a comment-only / '---' buffer parses to null : there is nothing to preview
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    toast.error(t('designer.badYamlUpdate'));
    return null;
  }
  const { subforms, missing } = resolveSubforms(parsed);
  if (missing.length > 0) {
    toast.warning(`${t('designer.previewMissingSubforms')}: ${missing.join(', ')}`);
  }
  sessionStorage.setItem(
    'designer-preview',
    JSON.stringify({ form: yaml, subforms, constants: constantsObj.value || {} }),
  );
  // the app can be hosted under a subpath (BASE_URL), like the router does
  return `${BaseUrl}${formPath(currentFormName.value)}?preview=1`;
}

/**
 * Opens the preview in a new window (beside the designer, on another screen).
 */
function previewForm() {
  const url = preparePreview();
  if (!url) return;
  window.open(url, '_blank');
  // the new window copied the session as it opened : the designer's own copy goes, so a
  // preview frame reloading later never reads it
  sessionStorage.removeItem('designer-preview');
}

// ─── the card's tabs : the item's YAML, the categories' and constants' tables, a form's preview
// the visual tab's table, for the toolbar's + button
const visualEditor = ref(null);
// which tab shows : 'yaml' (the editor and its toolbar), 'visual' (the categories, the constants
// or a form, as an outline) or 'preview' (the form, rendered) ; a link may open the visual one
// a section still to build has its Visual tab too, empty for now
// the tabs of each section (config/designerTabs.js, the router's list as well)
const hasVisual = (view) => !!DESIGNER_TABS[slugOf(view)]?.includes('visual');
// the editor shown : the YAML until the designer has read its config, then what the address
// names (applyEditor)
const editorView = ref('yaml');
// a preview : a form as users see it, the categories as the forms list ; and, still to build, a
// workflow drawn, an inventory as its tree of groups and hosts, the schedules' next runs in time
const hasPreview = (view) => !!DESIGNER_TABS[slugOf(view)]?.includes('preview');
// the preview's address, and its key : a new key reloads it with the YAML as it is now
const previewUrl = ref('');
const previewKey = ref(0);

/**
 * Renders the form being edited in the Preview tab, as it is now (unsaved edits included).
 */
function refreshPreview() {
  const url = preparePreview();
  // nothing to preview (the YAML is broken) : no frame, rather than the form shown before
  previewUrl.value = url ? `${url}&embed=1` : '';
  previewKey.value++;
}

/**
 * Shows a tab of the card : the preview renders the form afresh each time it opens.
 *
 * Args:
 *   view (string): 'yaml' or 'preview'.
 */
function showView(view) {
  // the playbooks or the vars files : a file with changes is asked about first when it would close
  // (their YAML and Visual tabs show the same file : no question between them)
  if (projectFiles.value?.dirty && view !== editorView.value && !FILE_SECTIONS[currentTab.value]) {
    projectFiles.value.leave(() => showView(view));
    return;
  }
  editorView.value = view;
  if (view === 'preview' && currentTab.value === 'Forms') refreshPreview();
}

// the categories' preview : the Forms page's menu, from the categories as they are now and the
// forms (no subforms : they are not in the menu) ; a click highlights a category, as there
const previewCategory = ref('');
/**
 * Categories as the menu can show them, whatever the YAML holds : only objects, at every
 * depth, their name a string, their items a list (a bare '-', 'items: foo' or a number as a
 * name would make the menu throw, and with it the whole designer).
 *
 * Args:
 *   list (any): the categories, or anything.
 *
 * Returns:
 *   object[]: the categories.
 */
function menuCategories(list) {
  if (!Array.isArray(list)) return [];
  return (
    list
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => {
        const cat = { name: String(c.name ?? '').trim(), icon: typeof c.icon === 'string' && c.icon ? c.icon : 'bars' };
        const items = menuCategories(c.items);
        if (items.length) cat.items = items;
        return cat;
      })
      .filter((c) => c.name)
      // one entry per name at a level : the menu keys them by name, and two would be one path
      .filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i)
  );
}
const menuPreview = computed(() => ({
  categories: menuCategories(categoriesObj.value),
  // the forms as the menu reads them : their categories paths only (a half-typed '- ' parses to
  // null, a number is no path - the menu would throw on them) ; none at all stays none, which
  // the menu counts as Default
  forms: formsObj.value
    .filter((f) => f && typeof f === 'object' && f.name && f.type !== 'subform')
    .map((f) =>
      f.categories === undefined
        ? f
        : { ...f, categories: Array.isArray(f.categories) ? f.categories.filter((c) => typeof c === 'string') : [] },
    ),
}));

/**
 * Shows the editor an address names, when the view has it ; else the YAML.
 *
 * Args:
 *   editor (string): 'yaml', 'visual' or 'preview'.
 */
function applyEditor(editor) {
  const view = currentTab.value;
  const want = (editor === 'visual' && hasVisual(view)) || (editor === 'preview' && hasPreview(view)) ? editor : 'yaml';
  if (want !== editorView.value) showView(want);
}
// another designer address while it is open (the header search, a link, Back) : its view, then
// its editor once that view is shown (another view resets the editor to the YAML first)
watch(
  () => route.path,
  () => {
    const address = addressOf(route.params);
    // through selectTab : a project file with unsaved changes asks first (and stays when the
    // answer is no - the address watcher below then puts the address back)
    if (address.view && address.view !== currentTab.value) selectTab(address.view);
    // and the form the address names. Back/Forward between two forms changed the address
    // only : the form shown stayed, so the address and the editor disagreed, and the next
    // switch of editor rewrote the address back to the form shown. Set directly, not through
    // selectForm (that pushes an address of its own) ; switching forms loses nothing, every
    // form's buffer is kept until saved.
    //
    // Only for an address the designer did not write itself : renaming a form rewrote the
    // address to the new name's slug, and this then opened the first form of that slug,
    // another form when two read the same in an address ('Test 1', 'test-1').
    const ownAddress = designerAddress === route.path;
    designerAddress = null;
    if (address.form && currentTab.value === 'Forms' && loaded.value && !ownAddress) {
      // the form shown already has this address : it stays (another of the same slug would not)
      const shown = currentFormName.value;
      if (!(shown && slugMatches(shown, address.form))) {
        // its exact name first, then the first of that slug, then its 7.2 address (a bookmark)
        const f = findBySlug(address.form, idmapping.value);
        if (f && f.id !== currentForm.value) currentForm.value = f.id;
      }
    }
    nextTick(() => {
      if (loaded.value) applyEditor(address.editor);
    });
  },
);
// another view opens on its YAML ; the preview and the visual tab are a form's : no form goes
// back to the YAML, another form is previewed (or shown in the visual tab) in its place
watch(currentTab, () => (editorView.value = 'yaml'));
watch(currentForm, (form) => {
  if (currentTab.value !== 'Forms' || editorView.value === 'yaml') return;
  if (!form) editorView.value = 'yaml';
  else if (editorView.value === 'preview') refreshPreview();
});

// what a form's Visual tab may add : the categories' paths, the roles' names, as they are now
const visualCategoryOptions = computed(() =>
  categoryPaths(Array.isArray(categoriesObj.value) ? categoriesObj.value : []),
);
// the other forms of the forms list (not the subforms), for the place of this one
const visualOtherForms = computed(() =>
  formsObj.value
    .filter((f) => f && f.type !== 'subform' && f.name && f.name !== currentFormName.value)
    .map((f) => ({ name: String(f.name), order: typeof f.order === 'number' ? f.order : undefined })),
);
// the roles a form or its approval may list : not default, every user's role holds no one to
// give a form to (a form listing it already keeps it)
const visualRoleOptions = computed(() =>
  (Array.isArray(rolesObj.value) ? rolesObj.value : [])
    .map((r) => (r && typeof r === 'object' ? String(r.name ?? '').trim() : ''))
    .filter((name) => name && !EVERYONE_ROLES.includes(name)),
);

function editorDiff() {
  if (currentTab.value === 'Categories') {
    diffSaved.value = baselineRaw.value.categories || '';
    diffCurrent.value = categories.value;
  } else if (currentTab.value === 'Constants') {
    diffSaved.value = baselineRaw.value.constants || '';
    diffCurrent.value = constants.value;
  } else if (currentTab.value === 'Forms' && currentForm.value) {
    diffSaved.value = baselineRaw.value.forms[currentForm.value] || '';
    diffCurrent.value = forms.value[currentForm.value] || '';
  } else if (FILE_SECTIONS[currentTab.value] && projectFiles.value?.selected) {
    diffSaved.value = projectFiles.value.savedText() || '';
    diffCurrent.value = projectFiles.value.getText() || '';
  } else {
    return;
  }
  showDiffModal.value = true;
}

const diffLines = computed(() => {
  if (!showDiffModal.value) return [];
  const oldLines = diffSaved.value.split('\n');
  const newLines = diffCurrent.value.split('\n');
  const result = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = i < oldLines.length ? oldLines[i] : undefined;
    const n = i < newLines.length ? newLines[i] : undefined;
    if (o === n) {
      result.push({ type: 'same', text: o });
    } else {
      if (o !== undefined) result.push({ type: 'removed', text: o });
      if (n !== undefined) result.push({ type: 'added', text: n });
    }
  }
  return result;
});

const formTemplate = {
  name: 'New Form',
  type: 'ansible',
  playbook: 'dummy.yaml',
  description: '',
  // admins only until it is given a role : default is no role to give a form to
  roles: [],
  categories: [],
  tileClass: 'has-background-info-light',
  fields: [
    {
      name: 'field1',
      type: 'text',
      label: 'field1',
    },
  ],
};

// computed values

const files = computed(() => {
  return formsObj.value.map((x) => x.source).filter((v, i, a) => a.indexOf(v) === i);
});

const folders = computed(() => {
  const set = new Set();
  for (const source of files.value) {
    if (source && source.includes('/')) {
      const parts = source.split('/');
      let path = '';
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        set.add(path);
      }
    }
  }
  return [...set].sort();
});

const fileTreeFlat = computed(() => {
  const result = [];
  const tree = {};

  for (const source of files.value) {
    const filePath = source || '';
    const parts = filePath ? filePath.split('/') : [''];
    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = { __children: {} };
      current = current[parts[i]].__children;
    }
    current[parts[parts.length - 1]] = { __file: true, source };
  }

  function walk(obj, depth, parentPath) {
    const keys = Object.keys(obj).sort((a, b) => {
      const aIsFolder = obj[a].__children && !obj[a].__file;
      const bIsFolder = obj[b].__children && !obj[b].__file;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const key of keys) {
      const node = obj[key];
      const nodePath = parentPath ? `${parentPath}/${key}` : key;
      if (node.__file) {
        result.push({
          type: 'file',
          name: key || null,
          source: node.source,
          depth,
          key: `file:${node.source || '__base__'}`,
        });
      } else {
        result.push({ type: 'folder', name: key, path: nodePath, depth, key: `folder:${nodePath}` });
        if (!collapsedPaths.value.has(`folder:${nodePath}`)) {
          walk(node.__children, depth + 1, nodePath);
        }
      }
    }
  }

  walk(tree, 0, '');
  if (treeFilter.value) {
    const q = treeFilter.value.toLowerCase();
    const matchingFiles = new Set();
    for (const m of idmapping.value) {
      if ((m.name || '').toLowerCase().includes(q)) {
        matchingFiles.add(m.source);
      }
    }
    return result.filter((item) => {
      if (item.type === 'folder') return true;
      return (item.name || '').toLowerCase().includes(q) || matchingFiles.has(item.source);
    });
  }
  return result;
});

const formsObj = computed(() => {
  // Assemble the saved forms in per-file DISPLAY order, so drag-to-reorder
  // (which only updates formOrderMap) is persisted in the saved file. The
  // ordered source list is derived from idmapping (which depends only on
  // forms/formMeta) rather than from `files` (which is derived from this
  // computed), to avoid a circular computed dependency.
  const sources = [];
  for (const m of idmapping.value) {
    if (!sources.includes(m.source)) sources.push(m.source);
  }
  const orderedIds = sources.flatMap((s) => formIdsForSave(s));
  // safety net : keep any ids not covered by formnames (eg unparsable forms)
  for (const id of Object.keys(forms.value)) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  return orderedIds.map((x) => {
    try {
      var result = YAML.parse(forms.value[x]);
      if (result.name) {
        const meta = formMeta.value[x];
        if (meta?.source) result.source = meta.source;
        if (meta?.repository) result.repository = meta.repository;
        return result;
      } else {
        throw new Error('parsing issue');
      }
    } catch {
      // same as idmapping : the file a form belongs to is known from formMeta and does
      // not depend on its yaml parsing. It also keeps the plain-assembly fallback from
      // writing an unparsable form out under a "Parsing issues" source.
      return { name: x, source: formMeta.value[x]?.source };
    }
  });
});

function flattenCatsForPicker(cats, parentPath, depth) {
  const result = [];
  for (const c of cats) {
    if (!c || !c.name) continue;
    const path = parentPath ? parentPath + '/' + c.name : c.name;
    result.push({ name: c.name, icon: c.icon, path, depth });
    if (c.items && c.items.length > 0) {
      result.push(...flattenCatsForPicker(c.items, path, depth + 1));
    }
  }
  return result;
}

const flatCategoriesForPicker = computed(() => {
  const cats = categoriesObj.value;
  if (!cats) return [];
  return flattenCatsForPicker(cats, '', 0);
});

// Only a shape the server would reject outright is refused here : the section
// must be a yaml sequence. Anything beyond that (an entry without an icon, an
// entry the designer did not write, ...) is the schema's business - the base
// schema accepts an empty icon, which the settings categories page legitimately
// writes, and refusing it here blocked EVERY save of the whole designer.
const categoriesObj = computed(() => {
  if (!categories.value) {
    return [{ name: 'Default', icon: 'bars' }];
  }
  try {
    var result = YAML.parse(categories.value);
    if (Array.isArray(result)) {
      return result;
    } else {
      throw new Error('parsing issue');
    }
  } catch {
    return undefined;
  }
});

const rolesObj = computed(() => {
  if (!roles.value) {
    return [
      { name: 'admin', groups: ['local/admins'] },
      { name: 'default', groups: [] },
    ];
  }
  try {
    var result = YAML.parse(roles.value);
    // same contract as categoriesObj : a sequence is all that is checked. The
    // base schema lets a role carry `users` INSTEAD of `groups`, so demanding
    // groups on the first role refused a perfectly valid configuration.
    if (Array.isArray(result)) {
      return result;
    } else {
      throw new Error('parsing issue');
    }
  } catch {
    return undefined;
  }
});

const constantsObj = computed(() => {
  if (!constants.value) {
    return {};
  }
  try {
    var result = YAML.parse(constants.value);
    return result;
  } catch {
    return undefined;
  }
});

const idmapping = computed(() => {
  if (!forms.value) {
    return {};
  }
  return Object.keys(forms.value).map((x) => {
    try {
      var tmp = YAML.parse(forms.value[x]);
      if (tmp && tmp.name) {
        return { id: x, source: formMeta.value[x]?.source, name: tmp.name, icon: tmp.icon };
      } else {
        throw new Error("A form must have a few basic properties, like 'name'");
      }
    } catch (err) {
      // Which FILE a form lives in is metadata (formMeta), not something read out of
      // its yaml - so keep it even when the yaml does not parse. Reporting the source
      // as "Parsing issues" moved the form into a group of that name in the tree on
      // every keystroke that left the document invalid, which is every keystroke
      // halfway through a line. The parse failure is carried by `issue` instead, and
      // the warnings panel reports it from there.
      return { id: x, source: formMeta.value[x]?.source, name: x, issue: err.message };
    }
  });
});

const currentFormName = computed(() => {
  return idmapping.value.find((x) => x.id == currentForm.value)?.name || null;
});

// the forms as the Previews read them : their names, their YAML as it is now
const formsForPreview = computed(() =>
  (idmapping.value || []).map((m) => ({ name: m.name, text: forms.value[m.id] || '' })),
);

const lockAge = computed(() => {
  if (lock.value?.lock) {
    return dayjs(lock.value.lock.created).fromNow();
  } else {
    return '';
  }
});

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A warning is rendered with v-html (two lines : a title and an explanation), so
// build it from translated text here instead of hardcoding english markup. Every
// value that comes from the config is escaped before it goes in ; the translated
// text itself is ours and carries no markup.
function warning(title, ...details) {
  return `<span class="text-danger fw-bold">${title}</span><br><span>${details.join('<br>')}</span>`;
}

// A warning carries where it was raised, so the panel can take you there :
// `formId` for anything about one form, `tab` for the config sections that have
// no form of their own (bad categories/roles/constants).
function formWarning(html, formId) {
  return { html, formId, tab: 'Forms' };
}
function tabWarning(html, tab) {
  return { html, formId: null, tab };
}

// The form a warning names, by name : the field-duplicate check runs on the
// parsed forms, which carry no designer id of their own.
function formIdByName(name) {
  return idmapping.value.find((x) => x.name === name)?.id || null;
}

// Take the user to what a warning is about : the form (switching to the Forms
// tab and expanding the file that holds it, which the tree may have collapsed),
// or the section it belongs to.
function goToWarning(w) {
  if (w.formId && forms.value[w.formId] !== undefined) {
    currentTab.value = 'Forms';
    const source = idmapping.value.find((x) => x.id === w.formId)?.source;
    collapsedPaths.value.delete(`file:${source || '__base__'}`);
    selectForm(w.formId);
  } else if (w.tab) {
    currentTab.value = w.tab;
  } else {
    return;
  }
  showWarnings.value = false;
}

// the base schema pins one category : `categories` must CONTAIN exactly
// {name: Default, icon: bars}. Renaming it, restyling it, giving it children or
// dropping it makes every save fail on a raw schema error, so catch it here (the
// Edit categories modal protects that row, the raw yaml editor cannot).
function hasDefaultCategory(cats) {
  return (
    Array.isArray(cats) &&
    cats.some((c) => c && c.name === 'Default' && c.icon === 'bars' && Object.keys(c).length === 2)
  );
}

const warnings = computed(() => {
  var warnings = [];
  var names = idmapping.value.map((x) => x.name);
  var dups = names.filter((item, index) => names.indexOf(item) !== index);
  var empties = idmapping.value.filter((item, _index) => !item.name);
  // a parse failure is carried by `issue` now, not by a replaced source : the form
  // keeps the file it belongs to so the tree does not move it while you type
  var parsing = idmapping.value.filter((item) => item.issue);
  var badsource = idmapping.value.filter(
    (item) => item.source && !(item.source.endsWith('.yaml') || item.source.endsWith('.yml')),
  );
  warnings = warnings.concat(
    dups.map((x) =>
      // a duplicate is by definition several forms : point at the first one
      // carrying the name, the other is one click away in the same file
      formWarning(
        warning(t('designer.warnFormDuplicate', { name: escHtml(x) }), t('designer.warnUniqueFormName')),
        formIdByName(x),
      ),
    ),
  );
  warnings = warnings.concat(
    empties.map((x) => formWarning(warning(t('designer.warnEmptyFormName'), t('designer.warnUniqueFormName')), x.id)),
  );
  warnings = warnings.concat(
    parsing.map((x) =>
      formWarning(warning(t('designer.warnBadFormYaml', { name: escHtml(x.name) }), escHtml(x.issue)), x.id),
    ),
  );
  warnings = warnings.concat(
    badsource.map((x) =>
      formWarning(
        warning(
          t('designer.warnBadSource', { name: escHtml(x.name) }),
          t('designer.warnBadSourceHint'),
          t('designer.warnBadSourceKeep'),
        ),
        x.id,
      ),
    ),
  );
  if (!categoriesObj.value) {
    warnings.push(
      tabWarning(warning(t('designer.warnBadCategories'), t('designer.warnBadCategoriesHint')), 'Categories'),
    );
  } else if (!hasDefaultCategory(categoriesObj.value)) {
    warnings.push(
      tabWarning(warning(t('designer.warnNoDefaultCategory'), t('designer.warnNoDefaultCategoryHint')), 'Categories'),
    );
  }
  if (!rolesObj.value) {
    // the roles are edited in Settings > Roles : no section here to send the warning to
    warnings.push(tabWarning(warning(t('designer.warnBadRoles'), t('designer.warnBadRolesHint')), null));
  }
  if (!constantsObj.value) {
    warnings.push(tabWarning(warning(t('designer.warnBadConstants'), t('designer.warnBadConstantsHint')), 'Constants'));
  }
  // check field dups
  (formsObj.value || []).forEach((item) => {
    var fields = [];
    if (item.fields) {
      item.fields.forEach((item2) => {
        fields.push(item2.name);
      });
      var dups = Helpers.findDuplicates(fields);
      dups.forEach((item2, _i) => {
        warnings.push(
          formWarning(
            warning(
              t('designer.warnFieldDuplicate', { field: escHtml(item2), form: escHtml(item.name) }),
              t('designer.warnUniqueFieldName'),
            ),
            formIdByName(item.name),
          ),
        );
      });
    }
  });
  return warnings;
});

// methods

async function loadForms() {
  loadFailed.value = false;
  try {
    const formConfig = await Form.loadAll();
    forms.value = {};
    formMeta.value = {};
    // Drag order belongs to the document that was on screen, and form ids are POSITIONAL
    // (form_0, form_1, ...) so they are reused by the next load. Keeping the map across a
    // reload therefore applied one document's ordering to a different one - silently
    // rearranging forms the user never touched, including after a discard.
    formOrderMap.value = {};
    categories.value = YAML.stringify(formConfig.categories);
    roles.value = YAML.stringify(formConfig.roles);
    if (formConfig.constants) {
      constants.value = YAML.stringify(formConfig.constants);
    }
    formConfig.forms.forEach((f, i) => {
      const id = `form_${i}`;
      // readOnly : a subform a form of the user's uses, none of their roles in its own (the role
      // option designAllForms off) - shown, not saved (the server refuses it)
      formMeta.value[id] = { source: f.source, repository: f.repository, readOnly: !!f.readOnly };
      delete f.source;
      delete f.repository;
      delete f.readOnly;
      forms.value[id] = YAML.stringify(f);
    });
    selectDefaultForm();
    for (const source of files.value) {
      collapsedPaths.value.add(`file:${source || '__base__'}`);
    }
    const sel = idmapping.value.find((x) => x.id === currentForm.value);
    if (sel) {
      collapsedPaths.value.delete(`file:${sel.source || '__base__'}`);
    }
    loaded.value = true;
    // the freshly loaded content is the clean baseline (only on success, so a
    // failed/partial load doesn't mark a blank designer as "clean" and saveable)
    setDirtyBaseline();
  } catch (err) {
    // a (re)load failed after the content was cleared : don't leave a blank
    // editor paired with a stale baseline (that reads as dirty and would let a
    // save overwrite the repo with empty content). Drop back to the not-loaded
    // state with no baseline, so the editor is hidden and Save stays disabled.
    loaded.value = false;
    dirtyBaseline.value = null;
    loadFailed.value = true;
    toast.error(Helpers.parseAxiosResponseError(err, t('designer.loadFailed')));
  }
}

// the user turning the designer off : their lock going free is no lock left behind to take back
const releasing = ref(false);

async function loadLock() {
  try {
    const before = lock.value;
    lock.value = await Lock.get();
    // ours a moment ago, free now : it was left behind (the computer asleep past
    // LOCK_STALE_SECONDS, server/src/models/lock.model.js) and nobody took it - taken back, so
    // the edits open here go on ; somebody else's by now shows who
    //
    // Unless an admin released it (the server says so, and by whom) : taking it back then
    // undid their release within seconds. Say so instead, and leave it free.
    if (before?.match && lock.value?.free && lock.value?.released) {
      toast.warning(t('designer.lockReleasedBy', { name: lock.value.released.by || '?' }));
    } else if (before?.match && lock.value?.free && !releasing.value) {
      try {
        await Lock.set();
        lock.value = await Lock.get();
      } catch {
        // taken meanwhile : the next read shows who
      }
    }
    lockError.value = '';
    // the header's Designer link shows the lock too : keep it in step with this poll
    store.designerLock = lock.value;
  } catch (err) {
    if (err?.response?.status === 403 && err?.response?.data?.error) {
      lockError.value = err.response.data.error;
    } else {
      toast.error(err.message);
    }
  } finally {
    lockRead.value = true;
  }
}

async function loadBackups() {
  try {
    backups.value = await Backup.load();
  } catch (err) {
    toast.error(err.message);
  }
}

function selectDefaultForm() {
  currentForm.value = idmapping.value[0]?.id || null;
  // the form the address names (/designer/forms/<form>)
  const slug = addressOf(route.params).form;
  // its exact name first, then the first of that slug, then its 7.2 address (a bookmark)
  const f = slug ? findBySlug(slug, idmapping.value) : null;
  if (f) {
    currentForm.value = f.id;
  }
}

function isCurrentTab(name) {
  return currentTab.value == name;
}

function selectTab(name) {
  if (projectFiles.value?.dirty && name !== currentTab.value) {
    projectFiles.value.leave(() => selectTab(name));
    return;
  }
  currentTab.value = name;
}

// the page title : the open view's name and icon once the designer is started (the lock ours) ;
// before that, or while somebody else holds it, the designer alone, as the header names it (the section, so the title is not Designer ›
// Designer)
const pageTitle = computed(() => {
  if (!lock.value?.match) return { title: t('nav.designer'), icon: 'pen-to-square' };
  const tab = tabs.find((x) => x.name === currentTab.value);
  return tab ? { title: tab.label(), icon: tab.icon } : { title: t('nav.designer'), icon: 'pen-to-square' };
});

// once it runs, the title names everything its address does, each step a link : the view, the
// form in the forms view, the editor - Designer › Forms › Approval demo › Preview (the section
// first, AppSettings)
const titleCrumbs = computed(() => {
  if (!lock.value?.match) return [];
  const tab = tabs.find((x) => x.name === currentTab.value);
  if (!tab) return [];
  const formName = currentTab.value === 'Forms' ? currentFormName.value : '';
  const steps = [{ title: tab.label(), icon: tab.icon, to: designerPath(tab.name) }];
  if (formName) steps.push({ title: formName, icon: 'file-lines', to: designerPath(tab.name, formName) });
  const editor = {
    yaml: ['YAML', 'code'],
    visual: [t('designer.visual'), 'table-list'],
    preview: [t('designer.preview'), 'eye'],
  };
  const [label, icon] = editor[editorView.value] || editor.yaml;
  steps.push({ title: label, icon, to: designerPath(tab.name, formName, editorView.value) });
  return steps;
});

// the line under the title describes the open view once the designer is started, and
// what the designer is for until then
const tabDescription = computed(() => {
  if (!lock.value?.match) return t('designer.offDescription');
  return tabs.find((tab) => tab.name === currentTab.value)?.description() || '';
});

// the left menu : one entry per view ; until the designer is started (locked) the entries
// are shown greyed out, so it is clear what the designer holds but nothing can be opened
const sidebarSections = computed(() => {
  // started : the lock is ours ; free or somebody else's, the sections are greyed out
  const started = !!lock.value?.match;
  return [
    {
      title: '',
      items: sortedTabs.value.map((tab) => ({
        title: tab.label(),
        icon: tab.icon,
        active: started && isCurrentTab(tab.name),
        disabled: !started,
        action: () => selectTab(tab.name),
      })),
    },
  ];
});

function isCurrentForm(id) {
  return currentForm.value == id;
}

function selectForm(id) {
  // select the form by id
  currentForm.value = id;
  // get the name and update the route
  if (currentFormName.value) {
    // its address, the rest of it kept
    const query = { ...route.query };
    const path = designerPath('Forms', currentFormName.value, editorView.value);
    // the form is chosen already : the route watcher must not choose another of the same slug
    markDesignerAddress(path);
    router
      .push({ path, query })
      .then(clearFailedDesignerAddress)
      .catch(() => (designerAddress = null));
  }
}

// once the designer runs and its forms are read : first the editor its address names, then the
// address follows the open view, form and editor - in that order, or the address would be
// rewritten to the YAML before its own editor was shown
const addressApplied = ref(false);
watch([loaded, () => !!lock.value && !lock.value.free], ([isLoaded, started]) => {
  if (!isLoaded || !started) {
    addressApplied.value = false;
    return;
  }
  if (addressApplied.value) return;
  applyEditor(addressOf(route.params).editor);
  addressApplied.value = true;
});
watch([currentTab, currentFormName, editorView, addressApplied], ([tab, formName, editor, applied]) => {
  if (!applied) return;
  const path = designerPath(tab, formName, editor);
  if (route.path !== path) {
    // the address follows the designer here : the route watcher must not switch forms for it
    markDesignerAddress(path);
    router
      .replace({ path, query: route.query })
      .then(clearFailedDesignerAddress)
      .catch(() => (designerAddress = null));
  }
});
// ─── read-only subforms ─────────────────────────────────────────────────────────
// a subform a form of the user's uses, none of their roles in its own (the role option
// designAllForms off) : shown, never deleted nor moved - the server keeps it as stored, so the
// designer would say saved while it is back on the next load
const readOnlyForm = (id) => !!formMeta.value[id]?.readOnly;
// a file holding one : not renamed, moved nor deleted (its read-only subform would stay behind)
const fileHoldsReadOnly = (source) =>
  Object.keys(forms.value).some((id) => formMeta.value[id]?.source === source && readOnlyForm(id));
// a folder holding such a file : not deleted
const folderHoldsReadOnly = (folder) =>
  files.value.some((s) => s && s.startsWith(folder + '/') && fileHoldsReadOnly(s));

/**
 * Refuses a change to a read-only subform (or a file or folder holding one), said in a toast.
 *
 * Args:
 *   held (boolean): whether the target is or holds a read-only subform.
 *
 * Returns:
 *   boolean: true when it is refused.
 */
function refusedReadOnly(held) {
  if (held) toast.warning(t('designer.subformReadOnly'));
  return held;
}

function deleteForm(id) {
  if (refusedReadOnly(readOnlyForm(id))) return;
  selectForm(id);
  action.value = 'delete';
}

const collapsedPaths = ref(new Set());
// the forms explorer's search (its magnifying glass) : the forms and files whose name has it
const treeSearch = ref(false);
const treeFilter = ref('');
const treeSearchInput = ref(null);

// the search box is only in the dom once treeSearch is on : focus it after vue
// has rendered it, otherwise the toggle just shows an input nobody can type in
// without clicking it first
function toggleTreeSearch() {
  treeSearch.value = !treeSearch.value;
  if (!treeSearch.value) {
    treeFilter.value = '';
    return;
  }
  nextTick(() => treeSearchInput.value?.focus());
}
// its X (and Escape) : emptied, the box kept open and focused
function clearTreeSearch() {
  treeFilter.value = '';
  treeSearchInput.value?.focus();
}

// the search on the title line, as every page's : it searches the YAML open (a form's, a file's,
// the categories' or the constants'), usable on the YAML tab once the designer is mine ; another
// section or tab starts with it empty
const editorSearch = ref('');
watch(currentTab, () => (editorSearch.value = ''));
watch(editorView, (view) => {
  if (view !== 'yaml') editorSearch.value = '';
});
// the search in the editor open (a form's YAML, a file's) : every match highlighted, the first one
// from the cursor selected and scrolled to the middle ; again when another form or file opens
// (once read)
let markTimer = null;
function markSearch() {
  const editor = activeEditor.value;
  if (!editor?.session || projectFiles.value?.busy) return;
  const q = editorSearch.value.trim();
  const re = q.length >= 2 ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  editor.session.highlight(re);
  editor.renderer.updateBackMarkers();
  if (!re) return;
  editor.find(q, { caseSensitive: false, wrap: true, skipCurrent: false });
  // the match in the editor's middle, not on its last line
  editor.renderer.scrollCursorIntoView(null, 0.5);
  // the lines from their start while the match fits the width : no sideways scroll that cuts the
  // beginning of every line for a match near the right edge
  const end = editor.getSelectionRange().end;
  const right = editor.renderer.$cursorLayer.getPixelPosition(end, false).left;
  if (right + editor.renderer.characterWidth * 2 < editor.renderer.$size.scrollerWidth) {
    editor.renderer.scrollToX(0);
  }
}
watch(
  [
    editorSearch,
    activeEditor,
    currentForm,
    editorView,
    () => projectFiles.value?.selected,
    () => projectFiles.value?.busy,
  ],
  () => {
    clearTimeout(markTimer);
    markTimer = setTimeout(markSearch, 300);
  },
);
onBeforeUnmount(() => clearTimeout(markTimer));
// the designer turned off (its trees gone, the searches disabled) : the searches emptied with them
watch(
  () => !!lock.value?.match,
  (ours) => {
    if (!ours) {
      treeFilter.value = '';
      editorSearch.value = '';
    }
  },
);

function toggleCollapse(key) {
  if (collapsedPaths.value.has(key)) {
    collapsedPaths.value.delete(key);
  } else {
    collapsedPaths.value.add(key);
  }
}

function isCollapsed(key) {
  return collapsedPaths.value.has(key);
}

// every collapsible row of the tree : the files (a file holds its forms) and the
// folders. Derived from the sources/folders themselves, so a key of a file that
// is gone never keeps the toggle in the wrong state.
const allTreeKeys = computed(() => {
  const keys = files.value.map((s) => `file:${s || '__base__'}`);
  for (const f of folders.value) keys.push(`folder:${f}`);
  return keys;
});
const allTreeCollapsed = computed(
  () => allTreeKeys.value.length > 0 && allTreeKeys.value.every((k) => collapsedPaths.value.has(k)),
);

function toggleCollapseAll() {
  if (allTreeCollapsed.value) {
    collapsedPaths.value.clear();
  } else {
    for (const key of allTreeKeys.value) collapsedPaths.value.add(key);
  }
}

const dragFormId = ref(null);
const formOrderMap = ref({});
const dropTargetId = ref(null);

function onDragStart(id, event) {
  // a read-only subform stays in its file
  if (readOnlyForm(id)) {
    event.preventDefault();
    return;
  }
  dragFormId.value = id;
  event.dataTransfer.effectAllowed = 'move';
}

function onDropOnFile(targetSource, event) {
  event.preventDefault();
  const id = dragFormId.value;
  if (!id || !forms.value[id]) return;
  if (formMeta.value[id]?.source === targetSource) return;
  if (!formMeta.value[id]) formMeta.value[id] = {};
  formMeta.value[id].source = targetSource;
  dragFormId.value = null;
  dropTargetId.value = null;
}

function onDropOnForm(targetId, event) {
  event.preventDefault();
  event.stopPropagation();
  const dragId = dragFormId.value;
  dropTargetId.value = null;
  if (!dragId || dragId === targetId) {
    dragFormId.value = null;
    return;
  }
  const dragMap = idmapping.value.find((x) => x.id === dragId);
  const targetMap = idmapping.value.find((x) => x.id === targetId);
  if (!dragMap || !targetMap) {
    dragFormId.value = null;
    return;
  }
  if (dragMap.source !== targetMap.source) {
    if (!formMeta.value[dragId]) formMeta.value[dragId] = {};
    formMeta.value[dragId].source = targetMap.source;
    dragFormId.value = null;
    return;
  }
  const key = dragMap.source ?? '__base__';
  let order = formOrderMap.value[key];
  if (!order) {
    order = formnames(dragMap.source).map((f) => f.id);
  } else {
    order = [...order];
  }
  const fromIdx = order.indexOf(dragId);
  if (fromIdx >= 0) order.splice(fromIdx, 1);
  const insertIdx = order.indexOf(targetId);
  order.splice(insertIdx >= 0 ? insertIdx : order.length, 0, dragId);
  formOrderMap.value = { ...formOrderMap.value, [key]: order };
  dragFormId.value = null;
}

function onFormDragOver(targetId, event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  dropTargetId.value = targetId;
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

const ctxMenu = ref({ show: false, x: 0, y: 0, target: null });
const showRenameModal = ref(false);
const renameValue = ref('');
const renameSource = ref(null);
const showMoveModal = ref(false);
const moveFormId = ref(null);
const moveTarget = ref('');

function openContextMenu(event, target) {
  event.preventDefault();
  ctxMenu.value = { show: true, x: event.clientX, y: event.clientY, target };
}

function closeContextMenu() {
  ctxMenu.value = { ...ctxMenu.value, show: false };
}

function ctxRenameFile() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  // the base file is not a file on disk (see confirmDeleteFile) : renaming it
  // would move every base form into a named file, which is not a rename
  if (!source || refusedReadOnly(fileHoldsReadOnly(source))) return;
  renameSource.value = source;
  renameValue.value = source;
  showRenameModal.value = true;
}

// Move a file's manual drag ordering with the file.
//
// formOrderMap is keyed by the file source, and nothing re-keyed it when a file was
// renamed or moved to a folder - every form's source was rewritten while the map kept
// the old key. explicitOrder(newName) was then null, so the tree snapped straight back
// to alphabetical and the save order silently fell back to document order: a manual
// ordering was lost with no message, and the stale entry stayed in the map for ever.
function moveFormOrder(oldSource, newSource) {
  const from = oldSource ?? '__base__';
  const to = newSource ?? '__base__';
  if (from === to) return;
  const order = formOrderMap.value[from];
  const next = { ...formOrderMap.value };
  delete next[from];
  if (order) next[to] = order;
  formOrderMap.value = next;
}

function doRenameFile() {
  const newName = (renameValue.value || '').trim();
  // the base file has no filename to rename (see ctxRenameFile)
  if (!renameSource.value || !newName || newName === renameSource.value) {
    showRenameModal.value = false;
    return;
  }
  if (!/^[A-Za-z0-9_./-]+\.(yaml|yml)$/.test(newName)) {
    toast.error(t('designer.newFileInvalid'));
    return;
  }
  moveFormOrder(renameSource.value, newName);
  for (const id of Object.keys(forms.value)) {
    if (formMeta.value[id]?.source === renameSource.value) {
      formMeta.value[id].source = newName;
    }
  }
  showRenameModal.value = false;
}

// A form name must be unique across the whole config (the designer warns
// otherwise), so a copy gets the first free '<name> (copy)' / '(copy N)'.
// `taken` carries the names handed out earlier in the same operation : a file
// copy renames several forms before any of them exists.
function uniqueFormName(baseName, taken = []) {
  let name = `${baseName} (copy)`;
  let counter = 2;
  while (idmapping.value.some((x) => x.name === name) || taken.includes(name)) {
    name = `${baseName} (copy ${counter++})`;
  }
  return name;
}

// The filename of a copy. Parentheses and spaces are not allowed in a forms
// filename (addFile pins the shape), hence '-copy' rather than ' (copy)'.
function uniqueFileName(source) {
  const dot = source.lastIndexOf('.');
  const base = dot > 0 ? source.slice(0, dot) : source;
  const ext = dot > 0 ? source.slice(dot) : '.yaml';
  let name = `${base}-copy${ext}`;
  let counter = 2;
  while (files.value.includes(name)) name = `${base}-copy-${counter++}${ext}`;
  return name;
}

// the next free internal id ; the ids are only a handle on the buffer, the file
// a form belongs to lives in formMeta
function nextFormId() {
  let idx = Object.keys(forms.value).length;
  while (forms.value[`form_${idx}`]) idx++;
  return `form_${idx}`;
}

function ctxDuplicateForm() {
  const srcId = ctxMenu.value.target.id;
  closeContextMenu();
  if (!forms.value[srcId]) return;
  try {
    const parsed = YAML.parse(forms.value[srcId]);
    parsed.name = uniqueFormName(parsed.name || 'Form');
    const newId = nextFormId();
    formMeta.value[newId] = { ...formMeta.value[srcId] };
    forms.value[newId] = YAML.stringify(parsed);
    currentForm.value = newId;
  } catch (err) {
    toast.error(t('designer.badYamlDuplicate'));
  }
}

// Duplicate a whole file : a copy of every form it holds, under a free filename
// and with free form names. Written through the document api, so the comments of
// the originals travel along (unlike the form-level duplicate, which predates
// those helpers and round-trips through parse/stringify).
function ctxDuplicateFile() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  if (busyOrTemplated.value) {
    toast.warning(t('designer.readOnly'));
    return;
  }
  // the base file is not a file on disk (see confirmDeleteFile) : there is
  // nothing to copy it to
  if (!source) return;
  const formIds = Object.keys(forms.value).filter((id) => formMeta.value[id]?.source === source);
  if (formIds.length === 0) return;
  const newSource = uniqueFileName(source);
  const taken = [];
  let failed = 0;
  let firstId = null;
  for (const srcId of formIds) {
    const doc = parseDocOrNull(forms.value[srcId]);
    if (!doc || !YAML.isMap(doc.contents)) {
      failed++;
      continue;
    }
    const baseName = doc.get('name');
    const copyName = uniqueFormName(typeof baseName === 'string' && baseName ? baseName : 'Form', taken);
    taken.push(copyName);
    doc.set('name', copyName);
    const newId = nextFormId();
    formMeta.value[newId] = { source: newSource };
    forms.value[newId] = doc.toString();
    if (!firstId) firstId = newId;
  }
  if (firstId) {
    collapsedPaths.value.delete(`file:${newSource}`);
    selectForm(firstId);
  }
  if (failed > 0) toast.warning(t('designer.badYamlDuplicate'));
  if (firstId) toast.success(t('designer.fileDuplicated', { file: newSource }));
}

function ctxMoveToFile() {
  if (refusedReadOnly(readOnlyForm(ctxMenu.value.target.id))) {
    closeContextMenu();
    return;
  }
  moveFormId.value = ctxMenu.value.target.id;
  const currentSource = idmapping.value.find((x) => x.id === moveFormId.value)?.source;
  moveTarget.value = files.value.find((f) => f !== currentSource) || '';
  closeContextMenu();
  showMoveModal.value = true;
}

function ctxAddFormToFile() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  addForm(source);
}

function ctxDownloadFile() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  const formIds = Object.keys(forms.value).filter((id) => formMeta.value[id]?.source === source);
  const content = formIds.map((id) => forms.value[id]).join('\n---\n');
  if (!content) return;
  const blob = new Blob([content], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = source || 'forms.yaml';
  a.click();
  URL.revokeObjectURL(url);
}

const fileToDelete = ref(null);

function confirmDeleteFile(source) {
  // the base file is not a file on disk (the forms without a `source` live in
  // the main config) : there is nothing to delete, so don't open a modal whose
  // Delete button would do nothing
  if (!source || refusedReadOnly(fileHoldsReadOnly(source))) return;
  fileToDelete.value = source;
  action.value = 'deleteFile';
}

function doDeleteFile() {
  const source = fileToDelete.value;
  // never leave the modal open on a Delete that can't do anything
  if (!source) {
    action.value = null;
    return;
  }
  const formIds = Object.keys(forms.value).filter((id) => formMeta.value[id]?.source === source);
  if (formIds.length) {
    formIds.forEach((id) => {
      delete forms.value[id];
      delete formMeta.value[id];
    });
    selectDefaultForm();
  }
  fileToDelete.value = null;
  action.value = null;
}

function ctxDeleteFile() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  confirmDeleteFile(source);
}

const showMoveFileModal = ref(false);
const moveFileSource = ref(null);
const moveFileTarget = ref('');

const moveFileFolderOptions = computed(() => {
  if (!moveFileSource.value) return [];
  const currentFolder = moveFileSource.value.includes('/')
    ? moveFileSource.value.substring(0, moveFileSource.value.lastIndexOf('/'))
    : '';
  const opts = [{ value: '', label: '/ (root)' }];
  for (const f of folders.value) {
    if (f !== currentFolder) opts.push({ value: f, label: f });
  }
  return opts;
});

function ctxMoveFileToFolder() {
  const source = ctxMenu.value.target.source;
  closeContextMenu();
  // the base file has no file to move (see confirmDeleteFile)
  if (!source || refusedReadOnly(fileHoldsReadOnly(source))) return;
  moveFileSource.value = source;
  const currentFolder = source.includes('/') ? source.substring(0, source.lastIndexOf('/')) : '';
  moveFileTarget.value = folders.value.find((f) => f !== currentFolder) || '';
  showMoveFileModal.value = true;
}

function doMoveFileToFolder() {
  const source = moveFileSource.value;
  if (source == null) return;
  const fileName = source.includes('/') ? source.substring(source.lastIndexOf('/') + 1) : source;
  const newSource = moveFileTarget.value ? `${moveFileTarget.value}/${fileName}` : fileName;
  if (newSource === source) {
    showMoveFileModal.value = false;
    return;
  }
  moveFormOrder(source, newSource);
  for (const id of Object.keys(forms.value)) {
    if (formMeta.value[id]?.source === source) {
      formMeta.value[id].source = newSource;
    }
  }
  showMoveFileModal.value = false;
  moveFileSource.value = null;
}

function openNewFileInFolder(folder) {
  newFileName.value = folder + '/';
  showNewFile.value = true;
}

function confirmDeleteFolder(folder) {
  const sources = files.value.filter((s) => s && s.startsWith(folder + '/'));
  if (!sources.length || refusedReadOnly(folderHoldsReadOnly(folder))) return;
  fileToDelete.value = folder;
  action.value = 'deleteFolder';
}

function doDeleteFolder() {
  const folder = fileToDelete.value;
  if (!folder) return;
  const sources = files.value.filter((s) => s && s.startsWith(folder + '/'));
  for (const source of sources) {
    const formIds = Object.keys(forms.value).filter((id) => formMeta.value[id]?.source === source);
    formIds.forEach((id) => {
      delete forms.value[id];
      delete formMeta.value[id];
    });
  }
  selectDefaultForm();
  fileToDelete.value = null;
  action.value = null;
}

function ctxAddFileToFolder() {
  const folder = ctxMenu.value.target.path;
  closeContextMenu();
  openNewFileInFolder(folder);
}

function ctxDeleteFolder() {
  const folder = ctxMenu.value.target.path;
  closeContextMenu();
  confirmDeleteFolder(folder);
}

function ctxDeleteFormFromMenu() {
  const id = ctxMenu.value.target.id;
  closeContextMenu();
  deleteForm(id);
}

function doMoveToFile() {
  showMoveModal.value = false;
  if (!moveFormId.value || !forms.value[moveFormId.value]) return;
  if (!formMeta.value[moveFormId.value]) formMeta.value[moveFormId.value] = {};
  if (moveTarget.value) formMeta.value[moveFormId.value].source = moveTarget.value;
  else delete formMeta.value[moveFormId.value].source;
}

const moveFileOptions = computed(() => {
  if (!moveFormId.value) return [];
  const currentSource = idmapping.value.find((x) => x.id === moveFormId.value)?.source;
  return files.value.filter((f) => f !== currentSource).map((f) => ({ value: f, label: f || t('designer.baseFile') }));
});

function addForm(file) {
  // add a new form to the forms list
  // check if the form "New Form" already exists

  if (idmapping.value.find((x) => x.name == 'New Form')) {
    toast.error(t('designer.newFormExists'));
    return false;
  }

  let idx = Object.keys(forms.value).length;
  while (forms.value[`form_${idx}`]) idx++;
  const id = `form_${idx}`;
  formMeta.value[id] = { source: file };
  forms.value[id] = YAML.stringify({ ...formTemplate });
  currentForm.value = id;
  collapsedPaths.value.delete(`file:${file || '__base__'}`);
  return true;
}

function doDeleteForm() {
  // delete the form by id from forms list. Keyed on the id, not on the name : a
  // form whose yaml doesn't parse has no name of its own (currentFormName falls
  // back to the internal id) and deleting it is exactly what is wanted then.
  if (currentForm.value) {
    delete forms.value[currentForm.value];
    delete formMeta.value[currentForm.value];
    // select default form
    selectDefaultForm();
  }
  action.value = null;
}

function restore() {
  // start from no selection : a leftover pick from a previous open points at a
  // backup that a restore since then may have replaced
  backupToRestore.value = null;
  action.value = 'restore';
}

// Key-sorted JSON, so two documents can be compared for STRUCTURE regardless of the
// order their keys happen to be written in.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value ?? null);
}

/**
 * Build the config document the save posts, KEEPING the comments the user typed.
 *
 * This used to be YAML.stringify() over the parsed objects, so every comment, blank line
 * and anchor in the editor was dropped by every save - including comments that were in
 * the file before the designer ever opened it. The visual editors (categories, roles,
 * constants) go out of their way to preserve them through the document API; the
 * designer's own save silently threw them away.
 *
 * The yaml library keeps comments on the nodes it parses, and a node can be re-hosted in
 * another document, so each section and each form is parsed as a DOCUMENT and its
 * contents node is placed into the outer one. `source` and `repository` are injected the
 * same way (doc.set on the parsed node), because the server routes each form to its file
 * by those and the editor buffers do not carry them.
 *
 * The result is then re-parsed and compared, key-sorted, against the object assembly this
 * replaced. Any difference at all - an unparsable buffer, an anchor that does not survive
 * re-hosting, anything unforeseen - falls back to that assembly. Losing comments is a
 * papercut; writing a structurally different config would be data loss, so the fallback
 * is what makes this safe to do at all.
 */
function assembleFormsPlain() {
  return YAML.stringify({
    categories: categoriesObj.value,
    roles: rolesObj.value,
    constants: constantsObj.value,
    forms: formsObj.value,
  });
}

function assembleForms() {
  const plain = assembleFormsPlain();
  try {
    const sources = [];
    for (const m of idmapping.value) if (!sources.includes(m.source)) sources.push(m.source);
    const orderedIds = sources.flatMap((s) => formIdsForSave(s));
    for (const id of Object.keys(forms.value)) if (!orderedIds.includes(id)) orderedIds.push(id);

    const out = new YAML.Document({});
    const section = (raw, fallback) => {
      const doc = YAML.parseDocument(raw ?? '');
      if (doc.errors.length || doc.contents == null) return out.createNode(fallback);
      return doc.contents;
    };
    out.set('categories', section(categories.value, categoriesObj.value));
    out.set('roles', section(roles.value, rolesObj.value));
    out.set('constants', section(constants.value, constantsObj.value));

    const seq = out.createNode([]);
    for (const id of orderedIds) {
      const doc = YAML.parseDocument(forms.value[id] ?? '');
      if (doc.errors.length || doc.contents == null) return plain; // an unparsable form: use the safe path
      const meta = formMeta.value[id];
      if (meta?.source) doc.set('source', meta.source);
      if (meta?.repository) doc.set('repository', meta.repository);
      seq.items.push(doc.contents);
    }
    out.set('forms', seq);

    const text = out.toString();
    // structural equality or nothing
    if (canonicalJson(YAML.parse(text)) !== canonicalJson(YAML.parse(plain))) return plain;
    return text;
  } catch {
    return plain;
  }
}

function resetAction() {
  action.value = null;
  nextAction.value = false; // clear any pending callback so a later flow can't fire a stale one
}

// somebody took or released the lock (here, in another tab, on another node) : shown at once
useLiveEvent('designer', () => {
  if (!busy.value) loadLock();
});

/**
 * Releases somebody else's lock, as an admin, once confirmed : for a lock its holder cannot
 * release any more (gone, or away) ; their unsaved changes are lost.
 */
function forceRelease() {
  action.value = 'forceRelease';
  nextAction.value = async (proceed) => {
    resetAction();
    if (!proceed) return;
    try {
      await Lock.forceRelease();
    } catch (err) {
      toast.error(err.message);
    }
    await loadLock();
  };
}

async function setLock(proceed = true) {
  if (!proceed) {
    resetAction();
    return;
  }
  try {
    loaded.value = false;
    lockLoading.value = true;
    await Lock.set(true);
    await loadLock();
    await loadForms();
    await loadBackups();
  } catch (err) {
    toast.error(err.message);
    // Read who holds it now rather than clearing it : `lock = undefined` left the YAML
    // editors (readonly only for a templated config) editable with no lock at all, and the
    // next save answered 423. The real lock read back shows "locked by" and keeps every
    // editor read-only.
    await loadLock();
    // `loaded` is only ever set back to true inside loadForms(), which is never reached
    // when Lock.set throws - and the panel renders a spinner while `lock && !lock.free &&
    // !loaded`. So losing a race for the lock (someone else took it between the 5s poll
    // and the click, answered 423) left an endless spinner that only a page reload
    // cleared. Restore it here: the buffers are still in memory and must stay reachable.
    loaded.value = true;
  } finally {
    lockLoading.value = false;
  }
}

async function restoreBackup() {
  // the button is disabled without a selection ; keep the guard anyway, there is
  // nothing to restore from and dereferencing it throws
  if (!backupToRestore.value?.file) {
    toast.warning(t('designer.selectBackupFirst'));
    return;
  }
  // Confirm first when there are unsaved edits, exactly as pullAndReload does.
  //
  // loadAll() replaces every buffer, so restoring a backup threw away whatever was in the
  // editor with no prompt at all - while the sibling operation that does the same thing
  // from a repository goes through withReloadConfirm. (withReloadConfirm is a function
  // declaration, so calling it from above its definition is fine.)
  withReloadConfirm(async () => {
    try {
      await Backup.restore(backupToRestore.value.file, backupBeforeRestore.value);
      toast.success(t('designer.backupRestored'));
      await loadAll();
      action.value = null;
    } catch (err) {
      toast.error(err.message);
    }
  });
}

/**
 * The lock switch is STATE driven, not DOM driven.
 *
 * It is bound with :checked (one way) and a @change handler, so the browser flips the box
 * itself and Vue only re-renders if `lock.match` actually changes. Cancel the unsaved
 * changes confirmation, or let the request fail, and the box stayed flipped while the lock
 * was untouched - the designer then read "Locked by me" with no lock, and the next save
 * answered 423 for no visible reason.
 *
 * Putting the DOM back immediately makes the real lock state the only thing that can move
 * the switch: the reload inside setLock/deleteLock re-renders it once the answer is known.
 */
function onLockToggle(event) {
  const held = !!lock.value?.match;
  if (event?.target) event.target.checked = held;
  if (held) releaseLock();
  else setLock();
}

async function releaseLock() {
  try {
    // if dirty, we need to ask for confirmation, it means you are releasing the designer with unsaved changes
    if (isDirty.value) {
      action.value = 'dirty';
      nextAction.value = async (proceed) => {
        resetAction();
        await deleteLock(proceed);
      };
      return;
    }
    // if not dirty, just release the lock
    await deleteLock();
  } catch (err) {
    toast.error(err.message);
    // the lock as it really is now, not a cleared one (see setLock)
    await loadLock();
  }
}

async function deleteLock(proceed = true) {
  if (!proceed) {
    resetAction();
    return;
  }
  try {
    // release the lock and reload the data ; released on purpose : never taken back (loadLock)
    loaded.value = false;
    releasing.value = true;
    await Lock.release();
    lock.value = { free: true };
    await loadAll();
  } catch (err) {
    toast.error(err.message);
    // the lock as it really is now, not a cleared one (see setLock)
    await loadLock();
    // same as setLock : a failed release must not leave the editor behind a spinner with
    // the in-memory buffers unreachable
    loaded.value = true;
  } finally {
    releasing.value = false;
  }
}

// forms repositories (issue #414) : the forms live in git, the designer
// saves into the working trees and 'Push to repo' commits & pushes them
const formsRepos = ref([]);
const configRepo = ref(''); // the repository that holds config.yaml
const stagedForms = ref(false); // new forms saved but not yet pushed to a repo
const configInDatabase = ref(false); // true when forms_yaml is stored in and served from the database

const isConfigTab = computed(() => ['Categories', 'Constants'].includes(currentTab.value));
// whether an editor is currently mounted and targeting real content : config
// tabs always mount one once loaded ; the Forms tab only when a form is
// selected. Gates the editor toolbar actions (undo/cut/format/diff/...), which
// would otherwise act on a stale, hidden editor instance (activeEditor is set
// by the last @init and survives unmounts).
const editorTarget = computed(() => {
  if (!loaded.value) return false;
  if (isConfigTab.value) return true;
  return currentTab.value === 'Forms' && !!currentForm.value && forms.value[currentForm.value] !== undefined;
});
// repo mode with the base config in the database : a restore only affects the
// config (categories/roles/constants), the forms stay in git
const repoConfigMode = computed(() => configInDatabase.value && formsRepos.value.length > 0);
// the restore action is available whenever there is something to snapshot :
// local mode (no repos) or the base config lives in the database
const canRestore = computed(() => formsRepos.value.length === 0 || configInDatabase.value);
const syncing = ref(false);
const loadingRepos = ref(false);
const showPushModal = ref(false);
const pushRepo = ref(''); // "" means all repositories
const showLoadModal = ref(false);
const loadRepo = ref('');

// unpushed work : a repository with uncommitted/unpushed changes, or new forms
// still staged. Drives the "you have unpushed changes" indicator on Save (repository).
const hasUnpushed = computed(() => stagedForms.value || formsRepos.value.some((r) => r.dirty));
// a save is in flight : a second Save (a double click, Ctrl+S held) used to post the same
// buffers again while the first request was still out - two backups, and on a repository two
// commits racing each other
const saving = ref(false);
// a push, load or save is in flight : gate other actions that would race it
const busy = computed(() => syncing.value || loadingRepos.value || saving.value);
// gate for everything that WRITES : the same in-flight guard, plus the ytt
// template case where the designer only holds an expansion of the real config
// the categories, the constants and the forms are changed only with the role option allowFormDesign
const canDesignForms = computed(() => store.profile?.options?.allowFormDesign !== false);
const busyOrTemplated = computed(() => busy.value || configTemplated.value || !canDesignForms.value);
// the form shown is a subform the user only uses (designAllForms off) : read only
const formReadOnly = computed(() => !!formMeta.value[currentForm.value]?.readOnly);

async function loadFormsRepos() {
  try {
    const result = await axios.get(`/api/v2/forms-repos`);
    formsRepos.value = result.data?.repositories || [];
    configRepo.value = result.data?.configRepo || '';
    stagedForms.value = !!result.data?.staged;
  } catch (err) {
    // a transient failure must not wipe the repo list (it would hide the push
    // button and the unpushed indicator for work that is still unpushed)
  }
}

async function loadConfigMode() {
  try {
    const result = await axios.get('/api/v2/config/mode');
    configInDatabase.value = !!result.data?.configInDatabase;
  } catch (err) {
    // non-critical; default to false
  }
}

// Is the STORED config a ytt template ? It cannot be answered from the designer
// buffers : those come from Form.load, which runs the config through ytt when
// USE_YTT is on, so what the designer holds is the EXPANSION and the directives
// are already gone. Even with ytt off the directives are yaml comments, which
// the parse+stringify roundtrip of loadForms drops just the same. Only the raw
// text still has them, and /api/v2/settings/config is the one endpoint that
// returns it (the database copy or the file on disk, un-expanded). A hit puts
// the designer in read-only : a save would write the expansion over the
// template and destroy it, exactly what the settings pages refuse to do.
async function loadConfigTemplated() {
  try {
    // /config/templated, not /settings/config : the settings endpoint needs settings
    // access, so a designer without it got a 403 here, the catch answered "not
    // templated", and their next save wrote the ytt EXPANSION over the template and
    // destroyed it. This one is designer-accessible and returns only the boolean.
    const result = await axios.get('/api/v2/config/templated');
    configTemplated.value = !!result.data?.templated;
    if (configTemplated.value) toast.warning(t('settings.settingsPage.configTemplated'));
  } catch (err) {
    // fail CLOSED. Unanswered means unknown, and the cost of guessing wrong is an
    // unrecoverable overwrite of a templated config ; read-only is recoverable by a
    // reload. The designer without settings rights is no longer the reason we get here.
    configTemplated.value = true;
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// the default push target : the config-origin repository (config.yaml lives
// there), falling back to the first forms repository
function defaultRepo() {
  return configRepo.value || formsRepos.value[0]?.name || '';
}

// re-read the forms from disk (working trees + staging) into the designer,
// discarding any in-memory edits
async function reloadFromDisk() {
  forms.value = {};
  categories.value = '';
  roles.value = '';
  constants.value = '';
  currentForm.value = null;
  await loadForms(); // sets a fresh baseline => isDirty false
}

// reload helper that warns when there are unsaved edits (they would be lost)
function withReloadConfirm(run) {
  if (isDirty.value) {
    action.value = 'confirmReload';
    nextAction.value = async (proceed) => {
      resetAction();
      if (proceed) await run();
    };
  } else {
    run();
  }
}

// the load dropdown options : one entry per forms repository
const loadRepoOptions = computed(() => formsRepos.value.map((r) => ({ value: r.name, label: r.name })));

// Load (repository) : with several repos open a chooser (pick one, or load
// from all) ; with a single repo pull it directly
function loadRepository() {
  if (formsRepos.value.length > 1) {
    // default to the config-origin repo, consistent with Save (repository)
    loadRepo.value = defaultRepo();
    showLoadModal.value = true;
  } else {
    pullAndReload();
  }
}

// pull the given forms repository (or all when name is omitted) from its
// remote, then reload the designer
function pullAndReload(name) {
  showLoadModal.value = false;
  withReloadConfirm(async () => {
    loadingRepos.value = true;
    try {
      const url = name ? `/api/v2/forms-repos/pull/${encodeURIComponent(name)}` : `/api/v2/forms-repos/pull`;
      const result = await axios.post(url, {});
      stagedForms.value = false;
      await reloadFromDisk();
      toast.success(t('designer.loadDone'));
      // a repository whose changes are not pushed yet is not pulled (a single pull is refused
      // with the server's reason, in the catch below) : say which ones Pull all skipped
      const skipped = skippedPulls(result?.data);
      if (skipped.length) toast.warning(t('settings.repositories.pullAllSkipped', { names: skipped.join(', ') }));
    } catch (err) {
      const error = err.response?.data?.error || err.message;
      const details = err.response?.data?.details;
      toast.error(details ? `${error}: ${details}` : error);
    } finally {
      loadingRepos.value = false;
      await loadFormsRepos(); // refresh the unpushed indicator
      await loadLock(); // the lock poll was suppressed while busy : re-verify now
    }
  });
}

// the dropdown options : one entry per forms repository
const pushRepoOptions = computed(() => formsRepos.value.map((r) => ({ value: r.name, label: r.name })));

function pushToRepo() {
  if (isDirty.value) {
    toast.warning(t('designer.syncSaveFirst'));
    return;
  }
  if (formsRepos.value.length > 1) {
    // several forms repositories : choose one (default to the config-origin repo)
    pushRepo.value = defaultRepo();
    showPushModal.value = true;
  } else {
    syncRepos();
  }
}

async function syncRepos(name) {
  showPushModal.value = false;
  syncing.value = true;
  try {
    const url = name ? `/api/v2/forms-repos/sync/${encodeURIComponent(name)}` : `/api/v2/forms-repos/sync`;
    await axios.post(url, {});
    toast.success(t('designer.syncDone'));
  } catch (err) {
    const error = err.response?.data?.error || err.message;
    const details = err.response?.data?.details;
    toast.error(details ? `${error}: ${details}` : error);
  } finally {
    syncing.value = false;
    await loadFormsRepos(); // refresh the unpushed indicator
    await loadLock(); // the lock poll was suppressed while busy : re-verify now
  }
}

// create a new forms file : a file only exists through a form pointing at it,
// so this adds a new form with the given filename as its source. In repository
// mode the new file is staged and assigned to a repository later, on push.
const showNewFile = ref(false);
const newFileName = ref('');

function openNewFile() {
  newFileName.value = '';
  showNewFile.value = true;
}

function openNewFolder() {
  newFileName.value = 'new-folder/forms.yaml';
  showNewFile.value = true;
}

function addFile() {
  const name = (newFileName.value || '').trim();
  if (!/^[A-Za-z0-9._/-]+\.(yaml|yml)$/.test(name)) {
    toast.error(t('designer.newFileInvalid'));
    return;
  }
  if (files.value.includes(name)) {
    toast.error(t('designer.newFileExists'));
    return;
  }
  if (!addForm(name)) return; // addForm refused (eg "New Form" already exists)
  if (name.includes('/')) {
    const parts = name.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i];
      collapsedPaths.value.delete(`folder:${path}`);
    }
  }
  showNewFile.value = false;
  newFileName.value = '';
}

async function validateForms() {
  try {
    const formConfig = assembleForms();
    await Form.validate(formConfig);
    toast.success(t('designer.formsValid'));
  } catch (err) {
    toast.error(err.message);
  }
}

async function saveForms(close = false) {
  if (busy.value) return; // a push/load/save is in flight : ignore (e.g. Ctrl+S)
  // the forms without allowFormDesign : read, not saved (Ctrl+S included ; the server refuses too)
  if (!canDesignForms.value) {
    if (close) resetAction();
    return;
  }
  // the buffers are the ytt EXPANSION of the stored template : saving them would
  // replace the template with its output (see loadConfigTemplated)
  if (configTemplated.value) {
    toast.warning(t('settings.settingsPage.configTemplated'));
    if (close) resetAction();
    return;
  }
  if (!lock.value?.match) {
    toast.error(t('designer.readOnly'));
    // close the dirty modal like the two sibling early-returns do : without this its
    // "Save and close" button was dead - a toast appeared and the modal just sat there,
    // which is what you get when someone force-unlocks while you are editing
    if (close) resetAction();
    return;
  }
  // if there are warnings, show them and do not save
  if (warnings.value.length > 0) {
    showWarnings.value = true;
    toast.warning(t('designer.fixWarnings'));
    // 'Save and close' cannot go through : close the dirty modal instead of
    // leaving it stranded behind the warnings panel with a callback that can
    // never fire. The user stays in the designer, with the warnings in view.
    if (close) resetAction();
    return;
  }
  if (!isDirty.value) {
    toast.info(t('designer.noChanges'));
    return;
  }
  saving.value = true;
  try {
    // the roles are Settings' (Settings > Roles) : the ones stored now go back as they are, so
    // a role changed there while the designer was open is never written over with the copy it
    // read at its start
    roles.value = YAML.stringify((await Form.loadAll()).roles);
    const formConfig = assembleForms();
    // Capture the baseline BEFORE awaiting, from the same buffers that were just
    // assembled into formConfig. It used to be taken after the save resolved, reading the
    // LIVE refs - so anything typed while the request was in flight (a repo-backed save
    // commits and pushes, easily over a second, and nothing makes the editor read-only)
    // became the clean baseline. isDirty went false, Save greyed out, the unsaved marker
    // cleared and the navigation guard stopped warning, for an edit that was never sent.
    const baseline = captureBaseline();

    // save the forms with axios async
    await Form.save(formConfig);

    applyBaseline(baseline); // the content that was actually POSTED is the new baseline
    toast.success(t('designer.formsSaved'));
    // the save took a server-side snapshot (Form.save backs up whenever there is
    // something to snapshot, the same condition canRestore describes) : refresh
    // the list, otherwise the backup you most want to undo to is missing from
    // Restore until the page is reloaded
    if (canRestore.value) await loadBackups();
    if (formsRepos.value.length > 0) await loadFormsRepos(); // saved to a working tree => now unpushed
    // the save is done : what "Save and close" goes on to (a reload, a release) must not find
    // the designer still busy with it
    saving.value = false;
    if (close && typeof nextAction.value === 'function') {
      const cb = nextAction.value;
      nextAction.value = false;
      try {
        cb(true);
      } catch (err) {
        toast.error(err.message);
      }
    }
  } catch (err) {
    toast.error(err.message);
  } finally {
    saving.value = false;
  }
}

/** The order the user dragged a file's forms into, or null when they never did. */
function explicitOrder(file) {
  return formOrderMap.value[file ?? '__base__'] || null;
}

function byExplicitOrder(order) {
  return (a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  };
}

/**
 * The order a file's forms are WRITTEN in.
 *
 * This used to be formnames(), the DISPLAY order, whose fallback is alphabetical - so
 * opening the designer and saving without touching anything rewrote every forms file
 * with its forms alphabetised. On a repository-backed config that is a whole-file diff
 * on every save, burying the real change and churning git history.
 *
 * Document order is idmapping's own order : forms.value is keyed form_0, form_1, ... in
 * the order the loader returned them. Only an explicit drag overrides it.
 */
function formIdsForSave(file) {
  const items = idmapping.value.filter((x) => x.source === file);
  const order = explicitOrder(file);
  if (!order) return items.map((x) => x.id);
  return [...items].sort(byExplicitOrder(order)).map((x) => x.id);
}

function formnames(file) {
  // copy before sorting : the array from filter() is fresh, but returning a sorted copy
  // keeps this safe if that ever changes
  const items = [...idmapping.value.filter((x) => x.source === file)];
  const order = explicitOrder(file);
  if (order) {
    return items.sort(byExplicitOrder(order));
  }
  return items.sort((a, b) => ((a.name || '').toLowerCase() > (b.name || '').toLowerCase() && 1) || -1);
}

async function loadAll() {
  await loadLock();
  await loadForms();
  await loadBackups();
}

// Unsaved work : the designer keeps everything in memory until Save, so leaving
// the page throws it away. Two guards, because they cover different exits.
// 1. reload / tab close / external link : only the browser's own prompt can stop
//    that, and it needs preventDefault (returnValue for the older engines).
function onBeforeUnload(e) {
  if (!isDirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}
// 2. in-app navigation (navbar, sidebar, browser back) : reuse the dirty modal,
//    so the user gets the same Save-and-close / Close-without-saving choice as
//    when releasing the lock. The navigation is replayed once confirmed.
const leaveConfirmed = ref(false);
const pendingRoute = ref(null);

// ─── the toolbar ──────────────────────────────────────────────────────────────
// What the section shown offers : the actions of config/designerActions.js (their icons, titles
// and order are its, the same in every section), each with what it does and when it is off.
const toolbarActions = computed(() => {
  const yaml = editorView.value === 'yaml';
  const visual = editorView.value === 'visual';
  // the text editor's own : undo, redo, cut, copy, paste, format, find, compare
  const textActions = (off, diffOff) => [
    { key: 'undo', run: editorUndo, disabled: off, show: yaml },
    { key: 'redo', run: editorRedo, disabled: off, show: yaml },
    { key: 'cut', run: editorCut, disabled: off, show: yaml },
    { key: 'copy', run: editorCopy, disabled: off, show: yaml },
    { key: 'paste', run: editorPaste, disabled: off, show: yaml },
    { key: 'format', run: editorFormat, disabled: off, show: yaml },
    { key: 'find', run: editorFind, disabled: off, show: yaml },
    { key: 'diff', run: editorDiff, disabled: diffOff },
  ];

  // the playbooks, the vars files, the inventories : the file open
  if (FILE_SECTIONS[currentTab.value]) {
    const f = projectFiles.value;
    if (!f) return [];
    const none = f.busy || !f.selected;
    const inventories = currentTab.value === 'Inventories';
    const workflows = currentTab.value === 'Workflows';
    // a kind of file without its role option (allowPlaybookDesign, ...) : read, not changed
    const readOnly = !canDesignFiles(FILE_SECTIONS[currentTab.value]);
    return [
      // a new file, the same button first on every section's bar : in the inventories a new
      // inventory (a repository), in the workflows a new workflow (a file, an empty workflow in it)
      {
        key: 'newFile',
        run: () => f.newFile(),
        disabled: f.busy || readOnly || (inventories && !canCreateInventories.value),
        title: inventories ? t('designer.files.newInventory') : workflows ? t('designer.files.newWorkflow') : undefined,
      },
      {
        key: 'save',
        run: () => f.save(),
        disabled: !f.dirty || f.busy || readOnly,
        title: f.repository ? t('designer.saveLocal') : undefined,
      },
      {
        key: 'push',
        run: () => f.push(),
        show: !!f.repository,
        disabled: f.dirty || f.busy || !f.unpushed || readOnly,
        color: f.unpushed && !f.dirty ? 'orange' : undefined,
      },
      ...textActions(none, none || !f.dirty),
      {
        key: 'addVar',
        run: () => f.addVar(),
        show: visual && f.canAddVar,
        disabled: f.busy || !(lock.value && lock.value.match),
      },
      { key: 'reload', run: () => f.reload(), disabled: f.busy },
      { key: 'download', run: downloadYaml, disabled: none },
      { key: 'revert', run: () => f.revert(), disabled: !f.dirty || f.busy },
    ];
  }

  // the categories, the constants and the forms : the configuration
  const tab = currentTab.value;
  const forms = tab === 'Forms';
  const noForm = busyOrTemplated.value || !currentForm.value;
  const formOnly = noForm || currentFormIsSubform.value;
  const formWords = (key) => (currentFormIsSubform.value ? t('designer.notForSubforms') : t(key));
  const repos = formsRepos.value.length > 0;
  return [
    { key: 'newFile', run: openNewFile, show: forms, disabled: busyOrTemplated.value },
    { key: 'import', run: openImport, show: forms, disabled: busyOrTemplated.value },
    {
      key: 'loadRepository',
      run: loadRepository,
      show: repos,
      disabled: busy.value || !canDesignForms.value,
      title: loadingRepos.value ? t('designer.loading') : undefined,
    },
    { key: 'validate', run: validateForms, disabled: busy.value },
    {
      key: 'save',
      run: saveForms,
      disabled: !isValid.value || !isDirty.value || busyOrTemplated.value,
      title: repos ? t('designer.saveLocal') : undefined,
    },
    {
      key: 'push',
      run: pushToRepo,
      show: repos,
      disabled: isDirty.value || busyOrTemplated.value || !hasUnpushed.value,
      color: !isDirty.value && !busyOrTemplated.value && hasUnpushed.value ? 'orange' : undefined,
      title: syncing.value ? t('designer.syncing') : undefined,
    },
    { key: 'restore', run: restore, show: canRestore.value, disabled: busyOrTemplated.value },
    ...textActions(busy.value || !editorTarget.value, busy.value || !isDirty.value || !editorTarget.value),
    // the visual tab : a row added to its outline (a category, a constant, a field)
    {
      key: 'add',
      run: () => visualEditor.value?.add(),
      show: visual,
      disabled: busyOrTemplated.value || !!visualEditor.value?.locked,
      title:
        tab === 'Categories' ? t('designer.addCategory') : forms ? t('designer.addField') : t('designer.addConstant'),
    },
    // the YAML tab : a category or a constant added, or all of them edited, in a dialog
    {
      key: 'add',
      run: tab === 'Categories' ? openAddCategory : openAddConstant,
      show: yaml && (tab === 'Categories' || tab === 'Constants'),
      disabled: busyOrTemplated.value || !(tab === 'Categories' ? canAddCategories.value : canAddConstants.value),
      title: tab === 'Categories' ? t('designer.addCategory') : t('designer.addConstant'),
    },
    {
      key: 'edit',
      run: tab === 'Categories' ? openEditCategories : openEditConstants,
      show: yaml && (tab === 'Categories' || tab === 'Constants'),
      disabled:
        busyOrTemplated.value || !(tab === 'Categories' ? hasEditableCategories.value : hasEditableConstants.value),
      title: tab === 'Categories' ? t('designer.editCategories') : t('designer.editConstants'),
    },
    // a form's own
    { key: 'formSettings', run: () => showView('visual'), show: forms, disabled: noForm },
    { key: 'icon', run: openIconPicker, show: forms, disabled: formOnly, title: formWords('designer.chooseIcon') },
    {
      key: 'tileColor',
      run: openTilePicker,
      show: forms,
      disabled: formOnly,
      title: formWords('designer.chooseBackground'),
    },
    { key: 'image', run: openImagePicker, show: forms, disabled: formOnly, title: formWords('designer.chooseImage') },
    {
      key: 'categories',
      run: openCatPicker,
      show: forms,
      disabled: formOnly,
      title: formWords('designer.assignCategories'),
    },
    { key: 'roles', run: openRolePicker, show: forms, disabled: formOnly, title: formWords('designer.assignRoles') },
    { key: 'insertConstant', run: openInsertConstant, show: forms, disabled: busy.value || !editorTarget.value },
    { key: 'fieldProperties', run: () => showView('visual'), show: forms, disabled: noForm },
    { key: 'download', run: downloadYaml, disabled: busy.value || !editorTarget.value },
    { key: 'revert', run: editorRevert, disabled: busy.value || !isDirty.value || !editorTarget.value },
  ];
});

onBeforeRouteLeave((to) => {
  if (!isDirty.value || leaveConfirmed.value) return true;
  pendingRoute.value = to.fullPath;
  action.value = 'dirty';
  nextAction.value = async (proceed) => {
    resetAction();
    if (!proceed) return;
    // skip this guard on the replay, otherwise it would ask again forever
    leaveConfirmed.value = true;
    router.push(pendingRoute.value);
  };
  return false;
});

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
  await loadAll();
  await Promise.all([loadFormsRepos(), loadConfigMode(), loadConfigTemplated()]);
  // The awaits above mean onBeforeUnmount can already have run - leaving the designer
  // before those requests finish is easy, and the route guard allows it because
  // dirtyBaseline is still null. It cleared a lockInterval that did not exist yet, and
  // then this line installed one on a destroyed component: it polled every 5s for the
  // rest of the SPA session, accumulated one per visit, popped its error toasts on
  // unrelated pages, and pinned the component and its buffers in memory.
  if (unmounted.value) return;
  // the lock's changes come live (useLiveEvent below) ; this read is the holder's heartbeat :
  // the server keeps a lock seen at least every LOCK_STALE_SECONDS (5 min), and a browser
  // tab in the background still runs it once a minute
  lockInterval.value = setInterval(async () => {
    // skip the poll while a push/load is in flight : a lock refresh that races
    // a sync can pull the rug out from under the in-flight operation
    if (busy.value) return;
    await loadLock();
  }, 30000);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  unmounted.value = true;
  if (lockInterval.value) clearInterval(lockInterval.value);
  themeObserver.disconnect();
});
</script>
<template>
  <AppNav />
  <div class="af-fill-page designer-page">
    <main class="d-flex flex-nowrap af-settings-layout af-with-sidebar">
      <!-- the designer's views (categories, roles, constants, forms) : a left menu like
           the settings pages, listed once the designer is started -->
      <BsSidebar :sections="sidebarSections" storageKey="af_designer_sidebar_collapsed" />
      <!-- Modal - delete verify -->
      <BsModal v-if="action == 'delete'" size="md" @close="resetAction()" icon="trash">
        <template #title> {{ t('designer.deleteForm') }} {{ currentFormName }} </template>
        <template #default>
          <p class="mb-0 fs-6 user-select-none">
            {{ t('designer.deleteConfirm') }} <strong>{{ currentFormName }}</strong
            >?
          </p>
        </template>
        <template #footer>
          <BsButton icon="trash" @click="doDeleteForm()">{{ t('common.delete') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - delete file verify -->
      <BsModal
        v-if="action == 'deleteFile'"
        size="md"
        @close="
          resetAction();
          fileToDelete = null;
        "
        icon="trash"
      >
        <template #title> {{ t('designer.deleteFile') }} </template>
        <template #default>
          <p class="mb-0 fs-6 user-select-none">
            {{ t('designer.deleteFileConfirm') }} <strong>{{ fileToDelete }}</strong
            >?
          </p>
        </template>
        <template #footer>
          <BsButton icon="trash" @click="doDeleteFile()">{{ t('common.delete') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - delete folder verify -->
      <BsModal
        v-if="action == 'deleteFolder'"
        size="md"
        @close="
          resetAction();
          fileToDelete = null;
        "
        icon="trash"
      >
        <template #title> {{ t('designer.deleteFolder') }} </template>
        <template #default>
          <p class="mb-0 fs-6 user-select-none">
            {{ t('designer.deleteFolderConfirm') }} <strong>{{ fileToDelete }}</strong
            >?
          </p>
        </template>
        <template #footer>
          <BsButton icon="trash" @click="doDeleteFolder()">{{ t('common.delete') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - new file -->
      <BsModal v-if="showNewFile" size="md" @close="showNewFile = false" icon="file-circle-plus">
        <template #title> {{ t('designer.newFileTitle') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            v-model="newFileName"
            :label="t('designer.newFileLabel')"
            placeholder="my-forms.yaml"
            icon="file"
            :help="t('designer.newFileHelp')"
            @keyup_enter="addFile()"
          />
        </template>
        <template #footer>
          <BsButton icon="plus" @click="addFile()">{{ t('common.create') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - import a yaml file -->
      <BsModal v-if="showImportModal" @close="showImportModal = false" size="lg" icon="file-import">
        <template #title> {{ t('designer.importTitle') }} </template>
        <template #default>
          <p class="text-muted small mb-3">{{ t('designer.importHelp') }}</p>
          <BsInput
            :isFloating="false"
            type="select"
            icon="file"
            v-model="importTarget"
            :values="importFileOptions"
            name="importTarget"
            :label="t('designer.targetFile')"
            class="mb-3"
          />
          <div class="d-flex flex-column gap-2">
            <div v-for="(entry, i) in importCandidates" :key="'imp-' + i" class="form-check">
              <input class="form-check-input" type="checkbox" v-model="entry.include" :id="'imp-chk-' + i" />
              <label class="form-check-label d-flex align-items-center gap-2" :for="'imp-chk-' + i" role="button">
                <span>{{ entry.finalName }}</span>
                <!-- a name that is taken is imported under a new one, the form
                     that holds it is never touched -->
                <span v-if="entry.finalName !== entry.name" class="badge bg-warning-subtle text-warning-emphasis">{{
                  t('designer.importRenamedBadge', { name: entry.name })
                }}</span>
              </label>
            </div>
          </div>
          <p v-if="importSkipped > 0" class="text-muted small mt-3 mb-0">
            {{ t('designer.importSkipped', importSkipped) }}
          </p>
        </template>
        <template #footer>
          <BsButton icon="file-import" @click="doImport()">{{ t('designer.import') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - choose repository to push -->
      <BsModal v-if="showPushModal" @close="showPushModal = false" icon="code-branch">
        <template #title> {{ t('designer.pushChooseTitle') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            type="select"
            icon="code-branch"
            v-model="pushRepo"
            :values="pushRepoOptions"
            name="pushRepo"
            :label="t('designer.pushRepoLabel')"
          />
        </template>
        <template #footer>
          <!-- symmetric with the load modal : syncRepos() without a name pushes
               every repository in one call -->
          <BsButton icon="code-branch" @click="syncRepos(pushRepo)">{{ t('designer.commitSync') }}</BsButton>
          <BsButton icon="code-branch" @click="syncRepos()">{{ t('designer.pushAll') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - choose repository to load -->
      <BsModal v-if="showLoadModal" @close="showLoadModal = false" icon="cloud-arrow-down">
        <template #title> {{ t('designer.loadChooseTitle') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            type="select"
            icon="code-branch"
            v-model="loadRepo"
            :values="loadRepoOptions"
            name="loadRepo"
            :label="t('designer.pushRepoLabel')"
          />
        </template>
        <template #footer>
          <BsButton icon="cloud-arrow-down" @click="pullAndReload(loadRepo)">{{ t('designer.loadFromRepo') }}</BsButton>
          <BsButton icon="cloud-arrow-down" @click="pullAndReload()">{{ t('designer.loadAll') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - an admin releases somebody else's lock -->
      <BsModal v-if="action == 'forceRelease'" size="md" @close="resetAction()" icon="unlock" :footerClose="false">
        <template #title>{{ t('designer.releaseTitle') }}</template>
        <template #default>
          <p class="mb-0 fs-6">
            {{ t('designer.releaseAdminOnly') }}<br /><br />
            {{ t('designer.releaseConfirm', { user: lock?.lock?.username }) }}<br /><br />
            {{ t('designer.releaseLoss', { user: lock?.lock?.username }) }}
          </p>
        </template>
        <template #footer>
          <BsButton icon="check" colorClass="danger" @click="nextAction(true)">{{ t('common.yes') }}</BsButton>
          <BsButton icon="times" @click="resetAction()">{{ t('common.no') }}</BsButton>
        </template>
      </BsModal>

      <!-- modal - dirty -->
      <BsModal
        v-if="action == 'dirty'"
        size="md"
        dialogClass="af-unsaved-dialog"
        @close="resetAction()"
        icon="triangle-exclamation"
        iconClass="text-warning"
      >
        <template #title> {{ t('designer.unsavedChanges') }} </template>
        <template #default>
          <p class="mb-0 fs-6 user-select-none">
            {{ t('designer.unsavedConfirm') }}<br />{{ t('designer.unsavedNote') }}
          </p>
        </template>
        <template #footer>
          <!-- 'proceed' means "go ahead and discard" for both flows this modal
               serves : release the lock and reload, or leave the page. Passing
               false here made the button a no-op that only closed the dialog,
               which since the route guard exists means unsaved changes trapped
               you on the page - the modal's own @close is the cancel path. -->
          <BsButton icon="times" @click="nextAction(true)">{{ t('designer.closeWithoutSaving') }}</BsButton>
          <BsButton icon="save" @click="saveForms(true)">{{ t('designer.saveAndClose') }}</BsButton>
        </template>
      </BsModal>

      <!-- modal - confirm reload (discards unsaved changes) -->
      <BsModal v-if="action == 'confirmReload'" size="md" @close="nextAction(false)" icon="download">
        <template #title> {{ t('designer.reloadTitle') }} </template>
        <template #default>
          <p class="mb-0 fs-6 user-select-none">{{ t('designer.reloadConfirm') }}</p>
        </template>
        <template #footer>
          <BsButton icon="times" @click="nextAction(false)">{{ t('common.cancel') }}</BsButton>
          <BsButton icon="download" @click="nextAction(true)">{{ t('designer.reloadDiscard') }}</BsButton>
        </template>
      </BsModal>

      <BsModal v-if="action == 'restore'" @close="resetAction()" icon="undo">
        <template #title> {{ t('designer.restoreBackup') }} </template>
        <template #default>
          <div v-if="repoConfigMode" class="text-muted mb-2">{{ t('designer.restoreConfigOnly') }}</div>
          <div v-if="backups.length === 0" class="text-muted">{{ t('designer.noBackups') }}</div>
          <template v-else>
            <BsInput
              type="select_advanced"
              v-model="backupToRestore"
              :values="backups"
              :required="true"
              name="backup"
              :label="t('designer.backup')"
              :sticky="true"
              :hasError="!backupToRestore"
            />
            <BsInput type="checkbox" v-model="backupBeforeRestore" :label="t('designer.backupBeforeRestore')" />
          </template>
        </template>
        <template #footer>
          <!-- nothing picked : restoring would dereference a null backup.
               No resetAction() after it : restoreBackup closes this modal itself once the
               restore is done, and with unsaved edits it swaps it for the reload confirm -
               which a trailing resetAction() cleared again at once, so Restore did nothing. -->
          <BsButton icon="undo" :disabled="!backupToRestore" @click="restoreBackup()">{{
            t('designer.restore')
          }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - rename file -->
      <BsModal v-if="showRenameModal" @close="showRenameModal = false" icon="pen">
        <template #title> {{ t('designer.renameFile') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            v-model="renameValue"
            :label="t('designer.newFileLabel')"
            icon="file"
            @keyup_enter="doRenameFile()"
          />
        </template>
        <template #footer>
          <BsButton icon="check" @click="doRenameFile()">{{ t('designer.rename') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - move form to file -->
      <BsModal v-if="showMoveModal" @close="showMoveModal = false" icon="arrow-right-arrow-left">
        <template #title> {{ t('designer.moveToFile') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            type="select"
            icon="file"
            v-model="moveTarget"
            :values="moveFileOptions"
            :label="t('designer.targetFile')"
          />
        </template>
        <template #footer>
          <BsButton icon="check" @click="doMoveToFile()">{{ t('designer.move') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - move file to folder -->
      <BsModal v-if="showMoveFileModal" @close="showMoveFileModal = false" icon="folder-open">
        <template #title> {{ t('designer.moveFileToFolder') }} </template>
        <template #default>
          <p class="fs-6 user-select-none mb-3">{{ moveFileSource }}</p>
          <BsInput
            :isFloating="false"
            type="select"
            icon="folder"
            v-model="moveFileTarget"
            :values="moveFileFolderOptions"
            :label="t('designer.targetFolder')"
          />
        </template>
        <template #footer>
          <BsButton icon="check" @click="doMoveFileToFolder()">{{ t('designer.move') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - diff -->
      <BsModal v-if="showDiffModal" @close="showDiffModal = false" icon="code-compare">
        <template #title> {{ t('designer.diff') }} </template>
        <template #default>
          <div class="diff-view">
            <div v-for="(line, i) in diffLines" :key="'diff-' + i" class="diff-line" :class="'diff-' + line.type">
              <span class="diff-marker">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }}</span>
              <span>{{ line.text }}</span>
            </div>
            <div v-if="diffLines.length === 0" class="text-muted p-3">{{ t('designer.noChanges') }}</div>
          </div>
        </template>
      </BsModal>

      <!-- Modal - icon picker -->
      <BsModal v-if="showIconPicker" @close="showIconPicker = false" icon="icons">
        <template #title> {{ t('designer.chooseIcon') }} </template>
        <template #default>
          <!-- Preview -->
          <div class="icon-section-header mb-2">
            <span class="fw-semibold">{{ t('designer.preview') }}</span>
          </div>
          <div
            class="d-flex align-items-center justify-content-center py-3 mb-3 rounded"
            style="background: var(--bs-tertiary-bg)"
          >
            <FaIcon
              v-if="iconForm.icon"
              :icon="iconForm.icon"
              :size="iconForm.iconSize || '3x'"
              :color="iconForm.iconColor || undefined"
              :overlayIcon="iconForm.overlayIcon || undefined"
              :overlayIconColor="iconForm.overlayIconColor"
              :overlayIconCircle="iconForm.overlayIconCircle"
              :overlayIconText="iconForm.overlayIconText || undefined"
              :overlayIconTextPosition="iconForm.overlayIconTextPosition"
              :overlayIconTextColor="iconForm.overlayIconTextColor"
            />
            <span v-else class="text-muted">{{ t('designer.noIconSelected') }}</span>
          </div>

          <!-- Icons section -->
          <div class="icon-section-header mb-2" role="button" @click="iconSections.icons = !iconSections.icons">
            <FaIcon :icon="iconSections.icons ? 'chevron-down' : 'chevron-right'" class="me-2 tree-chevron" size="xs" />
            <span class="fw-semibold">{{ t('designer.chooseIcon') }}</span>
          </div>
          <div v-if="iconSections.icons" class="mb-2">
            <BsInput
              :isFloating="false"
              v-model="iconSearch"
              :label="t('designer.searchIcons')"
              icon="magnifying-glass"
              :placeholder="t('common.searchPlaceholder')"
            />
            <div class="icon-grid mt-2">
              <div
                v-for="ic in filteredIcons"
                :key="'icon-' + ic"
                class="icon-cell"
                :class="{ 'icon-selected': iconForm.icon === ic }"
                role="button"
                :title="ic"
                @click="pickIcon(ic)"
              >
                <FaIcon :icon="ic" size="xl" />
                <small class="icon-label">{{ ic }}</small>
              </div>
            </div>
            <div v-if="filteredIcons.length === 0" class="text-muted text-center py-3">
              {{ t('designer.noIconsFound') }}
            </div>
          </div>

          <!-- Color & Size section -->
          <div class="icon-section-header mb-2" role="button" @click="iconSections.style = !iconSections.style">
            <FaIcon :icon="iconSections.style ? 'chevron-down' : 'chevron-right'" class="me-2 tree-chevron" size="xs" />
            <span class="fw-semibold">{{ t('designer.colorAndSize') }}</span>
          </div>
          <div v-if="iconSections.style" class="mb-2">
            <div class="row g-2">
              <div class="col-6">
                <BsInput
                  :isFloating="false"
                  type="select"
                  v-model="iconForm.iconColor"
                  :values="iconColorOptions"
                  :label="t('designer.iconColor')"
                  icon="droplet"
                />
              </div>
              <div class="col-6">
                <BsInput
                  :isFloating="false"
                  type="select"
                  v-model="iconForm.iconSize"
                  :values="iconSizeOptions"
                  :label="t('designer.iconSize')"
                  icon="up-right-and-down-left-from-center"
                />
              </div>
            </div>
          </div>

          <!-- Overlay section -->
          <div class="icon-section-header mb-2" role="button" @click="iconSections.overlay = !iconSections.overlay">
            <FaIcon
              :icon="iconSections.overlay ? 'chevron-down' : 'chevron-right'"
              class="me-2 tree-chevron"
              size="xs"
            />
            <span class="fw-semibold">{{ t('designer.overlaySettings') }}</span>
          </div>
          <div v-if="iconSections.overlay" class="mb-2">
            <div class="row g-2">
              <div class="col-6">
                <BsInput
                  :isFloating="false"
                  v-model="iconForm.overlayIcon"
                  :label="t('designer.overlayIcon')"
                  icon="layer-group"
                  :placeholder="t('designer.overlayIconPlaceholder')"
                />
              </div>
              <div class="col-6">
                <BsInput
                  :isFloating="false"
                  type="select"
                  v-model="iconForm.overlayIconColor"
                  :values="iconColorOptions.filter((o) => o.value)"
                  :label="t('designer.overlayColor')"
                  icon="droplet"
                />
              </div>
            </div>
            <div class="py-1 mb-2">
              <BsInput
                :isFloating="false"
                :isInline="true"
                type="checkbox"
                v-model="iconForm.overlayIconCircle"
                :isSwitch="true"
                :label="t('designer.overlayCircle')"
              />
            </div>
            <div class="row g-2">
              <div class="col-4">
                <BsInput
                  :isFloating="false"
                  v-model="iconForm.overlayIconText"
                  :label="t('designer.overlayText')"
                  icon="font"
                  :placeholder="t('designer.overlayTextPlaceholder')"
                />
              </div>
              <div class="col-4">
                <BsInput
                  :isFloating="false"
                  type="select"
                  v-model="iconForm.overlayIconTextPosition"
                  :values="overlayPositionOptions"
                  :label="t('designer.overlayPosition')"
                  icon="arrows-up-down-left-right"
                />
              </div>
              <div class="col-4">
                <BsInput
                  :isFloating="false"
                  type="select"
                  v-model="iconForm.overlayIconTextColor"
                  :values="iconColorOptions.filter((o) => o.value)"
                  :label="t('designer.overlayTextColor')"
                  icon="droplet"
                />
              </div>
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyIconForm()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - add category -->
      <BsModal v-if="showAddCategory" @close="showAddCategory = false" icon="folder-tree">
        <template #title> {{ t('designer.addCategory') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            v-model="newCatName"
            :label="t('designer.categoryName')"
            icon="tag"
            :placeholder="t('designer.categoryNamePlaceholder')"
            class="mb-3"
          />
          <BsInput
            v-if="parentCatOptions.length > 1"
            :isFloating="false"
            type="select"
            icon="folder-tree"
            v-model="newCatParent"
            :values="parentCatOptions"
            valueKey="value"
            labelKey="label"
            :label="t('designer.parentCategory')"
            class="mb-3"
          />
          <div class="fw-semibold mb-2">{{ t('designer.chooseIcon') }}</div>
          <div class="d-flex align-items-center gap-2 mb-3 p-2 rounded" style="background: var(--bs-tertiary-bg)">
            <FaIcon :icon="newCatIcon" size="2x" />
            <span class="text-muted">{{ newCatIcon }}</span>
          </div>
          <BsInput
            :isFloating="false"
            v-model="catIconSearch"
            :label="t('designer.searchIcons')"
            icon="magnifying-glass"
            :placeholder="t('common.searchPlaceholder')"
            class="mb-2"
          />
          <div class="icon-grid">
            <div
              v-for="ic in filteredCatIcons"
              :key="'caticon-' + ic"
              class="icon-cell"
              :class="{ 'icon-selected': newCatIcon === ic }"
              role="button"
              :title="ic"
              @click="newCatIcon = ic"
            >
              <FaIcon :icon="ic" size="xl" />
              <small class="icon-label">{{ ic }}</small>
            </div>
          </div>
          <div v-if="filteredCatIcons.length === 0" class="text-muted text-center py-3">
            {{ t('designer.noIconsFound') }}
          </div>
        </template>
        <template #footer>
          <BsButton icon="plus" @click="doAddCategory()">{{ t('designer.addCategory') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - edit categories -->
      <BsModal v-if="showEditCategories" @close="showEditCategories = false" icon="folder-tree">
        <template #title> {{ t('designer.editCategories') }} </template>
        <template #default>
          <div v-if="editCats.length === 0" class="text-muted text-center py-3">{{ t('designer.noCategories') }}</div>
          <!-- a form references a category by its PATH, so a move or a rename leaves
               those forms pointing at something that is no longer there -->
          <div v-if="editCatMovedPaths.length > 0" class="alert alert-warning py-2" role="alert">
            {{ t('settings.settingsPage.categoryPathsChanged', { paths: editCatMovedPaths.join(', ') }) }}
          </div>
          <div
            v-for="(row, idx) in flatEditCats"
            :key="'editcat-' + idx"
            class="d-flex align-items-end gap-2 mb-2"
            :style="{ paddingLeft: row.depth * 1 + 'rem' }"
          >
            <FaIcon
              v-if="row.depth > 0"
              icon="level-up-alt"
              class="text-muted fa-rotate-90 flex-shrink-0"
              style="font-size: 0.75rem; margin-bottom: 0.75rem"
            />
            <div class="flex-shrink-0">
              <label v-if="idx === 0" class="form-label fw-bold">{{ t('designer.categoryIcon') }}</label>
              <div class="d-flex align-items-center gap-3">
                <span
                  :role="isDefaultEditCat(row.cat, row.depth) ? undefined : 'button'"
                  class="d-flex align-items-center justify-content-center rounded flex-shrink-0"
                  :class="{ 'border border-primary': editCatIconIdx === idx }"
                  style="width: 2.5rem; height: calc(2.25rem + 2px); background: var(--bs-tertiary-bg)"
                  :title="t('designer.chooseIcon')"
                  @click="editCatPickIcon(idx)"
                >
                  <FaIcon :icon="row.cat.icon" size="lg" />
                </span>
                <select
                  class="form-select"
                  style="width: 12rem"
                  v-model="row.cat.icon"
                  :disabled="isDefaultEditCat(row.cat, row.depth)"
                >
                  <option v-for="ic in availableIcons" :key="'selicon-' + idx + '-' + ic" :value="ic">{{ ic }}</option>
                </select>
              </div>
            </div>
            <div class="flex-grow-1">
              <label v-if="idx === 0" class="form-label fw-bold">{{ t('designer.categoryName') }}</label>
              <input
                type="text"
                class="form-control"
                v-model="row.cat.name"
                :disabled="isDefaultEditCat(row.cat, row.depth)"
              />
            </div>
            <!-- the schema pins the Default category : no rename, no restyle, no
                 delete and no subcategories (same rule as the settings page) -->
            <template v-if="!isDefaultEditCat(row.cat, row.depth)">
              <!-- reorganize : indent makes the row above the parent, outdent lifts it
                   back out. Greyed instead of hidden so the row does not reshuffle. -->
              <span
                :role="canMoveUp(editCats, row.cat) ? 'button' : undefined"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border"
                :class="canMoveUp(editCats, row.cat) ? 'border-secondary' : 'border-secondary-subtle opacity-50'"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="canMoveUp(editCats, row.cat) && editCatMove(moveCategoryUp, row.cat)"
                :title="t('designer.moveUp')"
              >
                <font-awesome-icon icon="chevron-up" style="color: var(--bs-secondary)" />
              </span>
              <span
                :role="canMoveDown(editCats, row.cat) ? 'button' : undefined"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border"
                :class="canMoveDown(editCats, row.cat) ? 'border-secondary' : 'border-secondary-subtle opacity-50'"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="canMoveDown(editCats, row.cat) && editCatMove(moveCategoryDown, row.cat)"
                :title="t('designer.moveDown')"
              >
                <font-awesome-icon icon="chevron-down" style="color: var(--bs-secondary)" />
              </span>
              <span
                :role="canIndent(editCats, row.cat) ? 'button' : undefined"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border"
                :class="canIndent(editCats, row.cat) ? 'border-secondary' : 'border-secondary-subtle opacity-50'"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="canIndent(editCats, row.cat) && editCatMove(indentCategory, row.cat)"
                :title="t('settings.settingsPage.indentCategory')"
              >
                <font-awesome-icon icon="indent" style="color: var(--bs-secondary)" />
              </span>
              <span
                :role="canOutdent(editCats, row.cat) ? 'button' : undefined"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border"
                :class="canOutdent(editCats, row.cat) ? 'border-secondary' : 'border-secondary-subtle opacity-50'"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="canOutdent(editCats, row.cat) && editCatMove(outdentCategory, row.cat)"
                :title="t('settings.settingsPage.outdentCategory')"
              >
                <font-awesome-icon icon="outdent" style="color: var(--bs-secondary)" />
              </span>
              <span
                role="button"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border border-secondary"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="editCatAddSub(row.cat)"
                :title="t('designer.addSubcategory')"
              >
                <font-awesome-icon icon="plus" style="color: var(--bs-secondary)" />
              </span>
              <span
                role="button"
                class="d-flex align-items-center justify-content-center flex-shrink-0 rounded border border-danger"
                style="width: 2.5rem; height: calc(2.25rem + 2px)"
                @click="editCatRemove(row.cat)"
                :title="t('common.delete')"
              >
                <font-awesome-icon icon="trash" style="color: var(--bs-danger)" />
              </span>
            </template>
            <span
              v-else
              class="badge bg-secondary-subtle text-muted d-flex align-items-center flex-shrink-0"
              style="height: calc(2.25rem + 2px)"
              >{{ t('settings.settingsPage.requiredItem') }}</span
            >
          </div>
          <div v-if="editCatIconIdx !== null" class="mt-2 p-3 rounded" style="background: var(--bs-tertiary-bg)">
            <div class="fw-semibold mb-2">
              {{ t('designer.chooseIcon') }}: {{ flatEditCats[editCatIconIdx]?.cat?.name || '' }}
            </div>
            <BsInput
              :isFloating="false"
              v-model="editCatIconSearch"
              :label="t('designer.searchIcons')"
              icon="magnifying-glass"
              :placeholder="t('common.searchPlaceholder')"
              class="mb-2"
            />
            <div class="icon-grid">
              <div
                v-for="ic in filteredEditCatIcons"
                :key="'ecicon-' + ic"
                class="icon-cell"
                :class="{ 'icon-selected': flatEditCats[editCatIconIdx]?.cat?.icon === ic }"
                role="button"
                :title="ic"
                @click="editCatSelectIcon(editCatIconIdx, ic)"
              >
                <FaIcon :icon="ic" size="xl" />
                <small class="icon-label">{{ ic }}</small>
              </div>
            </div>
            <div v-if="filteredEditCatIcons.length === 0" class="text-muted text-center py-3">
              {{ t('designer.noIconsFound') }}
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyEditCategories()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - add constant -->
      <BsModal v-if="showAddConstant" @close="showAddConstant = false" icon="sliders">
        <template #title> {{ t('designer.addConstant') }} </template>
        <template #default>
          <div class="mb-3">
            <label class="form-label fw-bold">{{ t('designer.parentConstant') }}</label>
            <select class="form-select" v-model="newConstParent" :disabled="!hasAnyConstants">
              <option value="">{{ t('designer.topLevel') }}</option>
              <option v-for="(p, idx) in addConstParents" :key="'constparent-' + idx" :value="String(idx)">
                {{ p.label }}
              </option>
            </select>
          </div>
          <BsInput
            :isFloating="false"
            v-model="newConstKey"
            :label="t('settings.settingsPage.key')"
            icon="tag"
            placeholder="CONSTANT_NAME"
            class="mb-3"
          />
          <BsInput
            :isFloating="false"
            type="textarea"
            :rows="3"
            v-model="newConstValue"
            :label="t('settings.settingsPage.value')"
            icon="pen"
            :placeholder="t('settings.settingsPage.constantValuePlaceholder')"
          />
        </template>
        <template #footer>
          <BsButton icon="plus" @click="doAddConstant()">{{ t('designer.addConstant') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - edit constants -->
      <BsModal v-if="showEditConstants" @close="showEditConstants = false" icon="sliders">
        <template #title> {{ t('designer.editConstants') }} </template>
        <template #default>
          <div v-if="editConsts.length === 0" class="text-muted text-center py-3">
            {{ t('settings.settingsPage.noConstants') }}
          </div>
          <div
            v-for="(entry, idx) in flatEditConsts"
            :key="'editconst-' + entry.row._uid"
            class="d-flex align-items-end gap-2 mb-2"
            :style="{ paddingLeft: entry.depth * 1 + 'rem' }"
          >
            <FaIcon
              v-if="entry.depth > 0"
              icon="level-up-alt"
              class="text-muted fa-rotate-90 flex-shrink-0"
              style="font-size: 0.75rem; margin-bottom: 0.75rem"
            />
            <div class="flex-shrink-0" style="width: 14rem">
              <label v-if="idx === 0 || flatEditConsts[idx - 1].depth !== entry.depth" class="form-label fw-bold">{{
                t('settings.settingsPage.key')
              }}</label>
              <input type="text" class="form-control" v-model="entry.row.key" />
            </div>
            <div class="flex-grow-1">
              <template v-if="entry.row.children && entry.row.children.length > 0">
                <label v-if="idx === 0 || flatEditConsts[idx - 1].depth !== entry.depth" class="form-label fw-bold">{{
                  t('settings.settingsPage.value')
                }}</label>
                <div class="form-control bg-body-tertiary text-muted fst-italic" style="cursor: default">
                  {{ t('settings.settingsPage.subkeyCount', entry.row.children.length) }}
                </div>
              </template>
              <template v-else>
                <label v-if="idx === 0 || flatEditConsts[idx - 1].depth !== entry.depth" class="form-label fw-bold">{{
                  t('settings.settingsPage.value')
                }}</label>
                <textarea
                  class="form-control"
                  :rows="constantValueRows(entry.row.value)"
                  v-model="entry.row.value"
                  :placeholder="t('settings.settingsPage.constantValuePlaceholder')"
                ></textarea>
              </template>
            </div>
            <div class="d-flex gap-2 flex-shrink-0" style="margin-bottom: 1px">
              <span
                role="button"
                class="d-flex align-items-center justify-content-center rounded border border-secondary"
                style="width: 2.25rem; height: calc(2.25rem + 2px)"
                @click="editConstAddSub(entry.row)"
                :title="t('settings.settingsPage.addSubkey')"
              >
                <font-awesome-icon icon="plus" style="color: var(--bs-secondary)" />
              </span>
              <span
                role="button"
                class="d-flex align-items-center justify-content-center rounded border border-danger"
                style="width: 2.25rem; height: calc(2.25rem + 2px)"
                @click="editConstRemove(entry.row)"
                :title="t('common.delete')"
              >
                <font-awesome-icon icon="trash" style="color: var(--bs-danger)" />
              </span>
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyEditConstants()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - tile background picker -->
      <BsModal v-if="showTilePicker" @close="showTilePicker = false" icon="image">
        <template #title> {{ t('designer.chooseBackground') }} </template>
        <template #default>
          <div class="tile-grid">
            <div
              v-for="opt in tileOptions"
              :key="'tile-' + opt.value"
              class="tile-cell"
              :class="{ 'tile-selected': selectedTile === opt.value }"
              role="button"
              :title="opt.value"
              @click="selectedTile = opt.value"
            >
              <div class="tile-swatch" :style="{ backgroundColor: opt.color }"></div>
              <small class="tile-label">{{ opt.label }}</small>
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyTile()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - image picker -->
      <BsModal v-if="showImagePicker" @close="showImagePicker = false" icon="image">
        <template #title> {{ t('designer.chooseImage') }} </template>
        <template #default>
          <BsInput
            :isFloating="false"
            v-model="imageUrl"
            :label="t('designer.imageUrl')"
            icon="link"
            placeholder="https://... or data:image/..."
          />
          <div
            v-if="imageUrl"
            class="d-flex justify-content-center mt-3 p-3 rounded"
            style="background: var(--bs-tertiary-bg)"
          >
            <img :src="imageUrl" style="max-width: 100%; max-height: 200px; object-fit: contain" />
          </div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyImage()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - form settings -->

      <!-- Modal - categories picker -->
      <BsModal v-if="showCatPicker" @close="showCatPicker = false" size="lg" icon="folder-tree">
        <template #title> {{ t('designer.assignCategories') }} </template>
        <template #default>
          <div v-if="flatCategoriesForPicker && flatCategoriesForPicker.length" class="d-flex flex-column gap-2">
            <!-- the indent has to ADD to Bootstrap's own `.form-check` padding-left
                 (1.5em) : that padding is what holds the checkbox, which is floated
                 with `margin-left: -1.5em`. Setting padding-left to the bare indent
                 overrode it, so a depth-0 row got 0 padding and its checkbox hung
                 outside the modal's left edge. -->
            <div
              v-for="row in flatCategoriesForPicker"
              :key="'cat-' + row.path"
              class="form-check"
              role="button"
              @click="toggleCat(row.path)"
              :style="{ paddingLeft: `calc(1.5em + ${row.depth * 1.25}rem)` }"
            >
              <input
                class="form-check-input"
                type="checkbox"
                :checked="selectedCats.includes(row.path)"
                @click.stop="toggleCat(row.path)"
              />
              <label class="form-check-label d-flex align-items-center gap-2" role="button">
                <FaIcon :icon="row.icon || 'folder'" />
                <span>{{ row.name }}</span>
              </label>
            </div>
          </div>
          <div v-else class="text-muted">{{ t('designer.noCategories') }}</div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyCats()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - insert a constant reference into the form -->
      <BsModal v-if="showInsertConstant" @close="showInsertConstant = false" size="lg" icon="sliders">
        <template #title> {{ t('designer.insertConstant') }} </template>
        <template #default>
          <p class="text-muted small mb-3">{{ t('designer.insertConstantHelp') }}</p>
          <div v-if="insertableConstants.length" class="list-group">
            <button
              v-for="c in insertableConstants"
              :key="'ins-' + c.path"
              type="button"
              class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3"
              @click="insertConstant(c.path)"
            >
              <code class="text-nowrap">$({{ c.path }})</code>
              <span class="text-muted small text-truncate">{{ c.value }}</span>
            </button>
          </div>
          <div v-else class="text-muted">{{ t('designer.noConstants') }}</div>
        </template>
        <template #footer>
          <BsButton icon="plus" @click="newConstantFromInsert()">{{ t('designer.addConstant') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - roles picker -->
      <BsModal v-if="showRolePicker" @close="showRolePicker = false" size="lg" icon="user-shield">
        <template #title> {{ t('designer.assignRoles') }} </template>
        <template #default>
          <div v-if="rolesObj && rolesObj.length" class="d-flex flex-column gap-2">
            <div
              v-for="role in rolesObj"
              :key="'role-' + role.name"
              class="form-check"
              role="button"
              @click="toggleRole(role.name)"
            >
              <input
                class="form-check-input"
                type="checkbox"
                :checked="selectedRoles.includes(role.name)"
                @click.stop="toggleRole(role.name)"
              />
              <label class="form-check-label" role="button">{{ role.name }}</label>
            </div>
          </div>
          <div v-else class="text-muted">{{ t('designer.noRoles') }}</div>
        </template>
        <template #footer>
          <BsButton icon="check" @click="applyRoles()">{{ t('common.apply') }}</BsButton>
        </template>
      </BsModal>

      <!-- Modal - field properties editor -->

      <!-- Context menu -->
      <Teleport to="body">
        <div
          v-if="ctxMenu.show"
          class="ctx-menu"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click="closeContextMenu()"
        >
          <template v-if="ctxMenu.target?.type === 'file'">
            <div class="ctx-item" @click="ctxAddFormToFile()">
              <FaIcon icon="plus" class="me-2" size="sm" />{{ t('designer.addForm') }}
            </div>
            <hr class="ctx-divider" />
            <div
              class="ctx-item"
              :class="{ 'ctx-item-disabled': !ctxMenu.target?.source || fileHoldsReadOnly(ctxMenu.target?.source) }"
              @click="ctxRenameFile()"
            >
              <FaIcon icon="pen" class="me-2" size="sm" />{{ t('designer.renameFile') }}
            </div>
            <!-- the base file is not a file on disk : it can't be duplicated -->
            <div class="ctx-item" :class="{ 'ctx-item-disabled': !ctxMenu.target?.source }" @click="ctxDuplicateFile()">
              <FaIcon icon="copy" class="me-2" size="sm" />{{ t('designer.duplicateFile') }}
            </div>
            <div class="ctx-item" @click="ctxDownloadFile()">
              <FaIcon icon="download" class="me-2" size="sm" />{{ t('designer.downloadFile') }}
            </div>
            <!-- the base file is not a file on disk : it can't be moved or deleted -->
            <div
              class="ctx-item"
              :class="{
                'ctx-item-disabled':
                  folders.length === 0 || !ctxMenu.target?.source || fileHoldsReadOnly(ctxMenu.target?.source),
              }"
              @click="ctxMoveFileToFolder()"
            >
              <FaIcon icon="arrow-right" class="me-2" size="sm" />{{ t('designer.moveFileToFolder') }}
            </div>
            <hr class="ctx-divider" />
            <div
              class="ctx-item ctx-item-danger"
              :class="{ 'ctx-item-disabled': !ctxMenu.target?.source || fileHoldsReadOnly(ctxMenu.target?.source) }"
              @click="ctxDeleteFile()"
            >
              <FaIcon icon="trash" class="me-2" size="sm" />{{ t('designer.deleteFile') }}
            </div>
          </template>
          <template v-if="ctxMenu.target?.type === 'folder'">
            <div class="ctx-item" @click="ctxAddFileToFolder()">
              <FaIcon icon="plus" class="me-2" size="sm" />{{ t('designer.newFile') }}
            </div>
            <hr class="ctx-divider" />
            <div
              class="ctx-item ctx-item-danger"
              :class="{ 'ctx-item-disabled': folderHoldsReadOnly(ctxMenu.target?.path) }"
              @click="ctxDeleteFolder()"
            >
              <FaIcon icon="trash" class="me-2" size="sm" />{{ t('designer.deleteFolder') }}
            </div>
          </template>
          <template v-if="ctxMenu.target?.type === 'form'">
            <div class="ctx-item" @click="ctxDuplicateForm()">
              <FaIcon icon="copy" class="me-2" size="sm" />{{ t('designer.duplicateForm') }}
            </div>
            <div
              class="ctx-item"
              :class="{ 'ctx-item-disabled': readOnlyForm(ctxMenu.target?.id) }"
              @click="ctxMoveToFile()"
            >
              <FaIcon icon="arrow-right" class="me-2" size="sm" />{{ t('designer.moveToFile') }}
            </div>
            <hr class="ctx-divider" />
            <div
              class="ctx-item ctx-item-danger"
              :class="{ 'ctx-item-disabled': readOnlyForm(ctxMenu.target?.id) }"
              @click="ctxDeleteFormFromMenu()"
            >
              <FaIcon icon="trash" class="me-2" size="sm" />{{ t('designer.deleteForm') }}
            </div>
          </template>
        </div>
        <div
          v-if="ctxMenu.show"
          class="ctx-backdrop"
          @click="closeContextMenu()"
          @contextmenu.prevent="closeContextMenu()"
        ></div>
      </Teleport>

      <BsOffCanvas
        v-if="showWarnings"
        :show="true"
        icon="triangle-exclamation"
        :title="t('designer.warnings')"
        @close="showWarnings = false"
      >
        <template #default>
          <!-- a warning takes you to what it is about : the form it names, or
               the config tab that holds the section -->
          <p
            v-for="(w, i) in warnings"
            :key="'warning' + i"
            class="mb-3 warning-entry"
            role="button"
            :title="t('designer.warnGoTo')"
            v-html="w.html"
            @click="goToWarning(w)"
          ></p>
        </template>
      </BsOffCanvas>
      <!-- titled after the open view, like the jobs and profile pages ; until the designer is
           started (nothing can be opened yet) after the lock it needs -->
      <AppSettings
        v-if="authenticated"
        :title="pageTitle.title"
        :crumbs="titleCrumbs"
        :description="tabDescription"
        :icon="pageTitle.icon"
      >
        <!-- the item's views, on top of its card, once the designer runs : its YAML ; the categories
             and constants as tables (Visual) ; a form's preview -->
        <template v-if="lock && lock.match && loaded" #tabs>
          <ul class="nav nav-tabs mb-0 designer-tabs">
            <li class="nav-item">
              <a class="nav-link" :class="{ active: editorView === 'yaml' }" href="#" @click.prevent="showView('yaml')">
                <FaIcon icon="code" class="me-1" />
                YAML
              </a>
            </li>
            <!-- the categories, the constants and a form as outlines, on the same YAML -->
            <li v-if="hasVisual(currentTab) && (currentTab != 'Forms' || currentForm)" class="nav-item">
              <a
                class="nav-link"
                :class="{ active: editorView === 'visual' }"
                href="#"
                @click.prevent="showView('visual')"
              >
                <FaIcon icon="table-list" class="me-1" />
                {{ t('designer.visual') }}
              </a>
            </li>
            <!-- a form's preview : the form rendered from its YAML as it is now ; the categories' :
                 the Forms page's menu, from them ; a workflow drawn, an inventory's tree, the
                 schedules' next runs (still to build) -->
            <li v-if="hasPreview(currentTab) && (currentTab != 'Forms' || currentForm)" class="nav-item">
              <a
                class="nav-link"
                :class="{ active: editorView === 'preview' }"
                href="#"
                @click.prevent="showView('preview')"
              >
                <FaIcon icon="eye" class="me-1" />
                {{ t('designer.preview') }}
              </a>
            </li>
          </ul>
        </template>
        <template #feedback>
          <Transition appear>
            <div v-if="warnings.length > 0" class="ms-2">
              <button @click="showWarnings = !showWarnings" class="btn btn-warning me-3">
                <span class="me-2">
                  <font-awesome-icon icon="exclamation-triangle" />
                </span>
                <span class="mr-1"
                  >{{ showWarnings ? t('designer.hideWarnings') : t('designer.hasWarnings') }}
                  {{ t('designer.warnings') }}
                </span>
              </button>
            </div>
          </Transition>
        </template>
        <!-- the search of the section's tree at the left, the designer's on/off switch at the right -->
        <template #headerActions>
          <!-- always in its place ; usable on the YAML tab once the designer is mine (locked by me) :
               it marks what it finds in the YAML open. Disabled while the designer is off or someone
               else's, and on the Visual and Preview tabs -->
          <BsSearch v-model="editorSearch" :disabled="!lock?.match || editorView !== 'yaml'" />
          <template v-if="lock">
            <popper v-if="lock.lock && !lock.match">
              <!-- someone else's : the switch on and disabled, the lock is theirs until they
                   turn the designer off -->
              <div class="form-check form-switch d-inline-flex align-items-center ms-3 mb-0 designer-switch-other">
                <input class="form-check-input" type="checkbox" :checked="true" disabled />
                <label class="form-check-label" style="margin-left: 0.75rem">
                  <font-awesome-icon icon="lock" size="sm" class="me-1" />{{
                    t('designer.lockedByUser', { user: lock.lock.username })
                  }}
                </label>
              </div>
              <template #content>
                {{ t('designer.user') }}: {{ lock.lock.username }}<br />
                {{ t('designer.type') }}: {{ lock.lock.type }}<br />
                {{ t('designer.created') }}: {{ lockAge }}
              </template>
            </popper>
            <!-- an admin releases somebody else's lock (one its holder cannot release any more) -->
            <BsButton
              v-if="lock.lock && !lock.match && store.isAdmin"
              icon="unlock"
              cssClass="designer-release"
              colorClass="danger"
              @click="forceRelease()"
              >{{ t('designer.release') }}</BsButton
            >
            <div v-else class="form-check form-switch d-inline-flex align-items-center ms-3 mb-0">
              <input
                class="form-check-input"
                type="checkbox"
                :checked="lock.match"
                @change="onLockToggle"
                role="button"
              />
              <label
                class="form-check-label"
                :class="lock.match ? 'text-success' : ''"
                style="margin-left: 0.75rem"
                role="button"
                @click="onLockToggle"
              >
                <font-awesome-icon :icon="lock.match ? 'lock' : 'unlock'" size="sm" class="me-1" />{{
                  lock.match ? t('designer.lockedByMe') : t('designer.startDesigner')
                }}
              </label>
            </div>
          </template>
        </template>
        <template #default>
          <!-- loading (the lock not read yet, or being taken) : the editor's lines as grey placeholders,
               filling the card (which fills the page) -->
          <AppSkeleton v-if="lockLoading || !lockRead" shape="editor" :count="40" />
          <!-- someone else holds the lock : nothing shown, only who, as when the designer is off -->
          <div
            v-else-if="lock && lock.lock && !lock.match"
            class="d-flex flex-column align-items-center justify-content-center py-5 text-muted"
          >
            <FaIcon icon="lock" style="font-size: 2.5rem; opacity: 0.3" class="mb-3" />
            <p class="mb-3 fw-semibold" style="font-size: 1.2rem">
              {{ t('designer.inUseBy', { user: lock.lock.username }) }}
            </p>
            <p class="fs-6 mb-0">{{ t('designer.inUseByHint', { user: lock.lock.username }) }}</p>
          </div>
          <!-- the configuration could not be read : said, with a Retry, rather than placeholders
               that never fill -->
          <div
            v-else-if="lock && !lock.free && !loaded && loadFailed"
            class="d-flex flex-column align-items-center justify-content-center py-5 text-muted"
          >
            <FaIcon icon="triangle-exclamation" style="font-size: 2.5rem; opacity: 0.3" class="mb-3" />
            <p class="mb-3 fw-semibold" style="font-size: 1.2rem">{{ t('designer.loadFailed') }}</p>
            <p class="fs-6 mb-3">{{ t('designer.loadFailedHint') }}</p>
            <BsButton icon="rotate-right" @click="loadForms()">{{ t('designer.retry') }}</BsButton>
          </div>
          <AppSkeleton v-else-if="lock && !lock.free && !loaded" shape="editor" :count="40" />
          <div
            v-else-if="lock && lock.free"
            class="d-flex flex-column align-items-center justify-content-center py-5 text-muted"
          >
            <FaIcon icon="unlock" style="font-size: 2.5rem; opacity: 0.3" class="mb-3" />
            <p class="mb-3 fw-semibold" style="font-size: 1.2rem">{{ t('designer.notLocked') }}</p>
            <p class="fs-6 mb-0">{{ t('designer.notLockedHint') }}</p>
          </div>
          <div v-else>
            <!-- the file picker of the import : hidden, openImport() clicks it -->
            <input ref="importInput" type="file" accept=".yaml,.yml,text/yaml" class="d-none" @change="onImportFile" />
            <!-- Every gap in the card matches its side padding : the card's 1px border plus
                 the body's 16px = 17px from the card edge. Above the buttons that is all there
                 is (no padding here) ; below them this 9px is followed by the 8px bottom
                 margin of the empty <label> BsInput always renders, 17px again ; and under
                 the editor the wrapper's margin is removed (see the global style block), so
                 the editor ends 17px above the card's bottom edge as well. -->
            <!-- a preview has no toolbar : the row then takes no room (unless a notice shows), and the
                 preview starts where the toolbar does -->
            <div
              class="d-flex align-items-center flex-wrap gap-2"
              :style="{
                paddingTop: 0,
                paddingBottom:
                  editorView === 'preview' && !lockError && !configTemplated && !(lock && !lock.match && !lock.free)
                    ? 0
                    : '9px',
              }"
            >
              <small
                v-if="lockError !== ''"
                class="d-inline-flex px-2 py-1 fw-semibold text-warning-emphasis bg-warning-subtle border border-warning-subtle rounded-2"
                >{{ lockError }}</small
              >
              <!-- the stored config is a ytt template : what the designer holds
                     is its expansion, so nothing here may be written back -->
              <small
                v-if="configTemplated"
                class="d-inline-flex px-2 py-1 fw-semibold text-warning-emphasis bg-warning-subtle border border-warning-subtle rounded-2"
                >{{ t('settings.settingsPage.configTemplated') }}</small
              >
              <template v-if="lock && lock.match && editorView !== 'preview'">
                <!-- the section's actions : their icons, titles and order from config/designerActions.js,
                     the same in every section (toolbarActions says which and what they do) -->
                <AppDesignerToolbar :actions="toolbarActions" />
              </template>
            </div>
            <div
              class="designer-layout"
              :class="{ 'designer-layout-preview': editorView === 'preview' }"
              :style="currentTab == 'Forms' ? { gridTemplateColumns: explorerColumns(treeWidthPct) } : undefined"
            >
              <div class="designer-editor">
                <!-- Preview : the Forms page's menu, from the categories as they are now -->
                <div v-if="loaded && currentTab == 'Categories' && editorView === 'preview'" class="designer-preview">
                  <div class="designer-preview-bar">
                    <span class="text-body-secondary small">
                      <FaIcon icon="circle-info" class="me-1" />{{ t('designer.menuPreviewHint') }}
                    </span>
                  </div>
                  <div class="designer-menu-preview">
                    <AppFormsMenu
                      :formConfig="menuPreview"
                      :currentCategory="previewCategory"
                      preview
                      @select="(path) => (previewCategory = path)"
                    />
                  </div>
                </div>
                <!-- Visual : the categories as a table, on the same YAML (saved with Save) -->
                <div
                  v-else-if="loaded && currentTab == 'Categories' && editorView === 'visual'"
                  class="designer-visual"
                >
                  <AppCategoriesEditor
                    ref="visualEditor"
                    v-model="categories"
                    :readOnly="!(lock && lock.match) || configTemplated || !canDesignForms"
                  />
                </div>
                <div v-else-if="loaded && currentTab == 'Categories'">
                  <BsInput
                    type="editor"
                    :readonly="!lock?.match || configTemplated || !canDesignForms"
                    :isFloating="false"
                    v-model="categories"
                    @save="saveForms()"
                    @init="onEditorInit"
                    lang="yaml"
                    :theme="editorTheme"
                    :liveSync="true"
                    :style="editorStyle('100%')"
                  />
                </div>
                <!-- a section still to build : its Visual tab empty, its YAML an empty text area, nothing
                     saved -->
                <!-- the playbooks and the vars files : one explorer and the file open for the YAML and the
                     Visual tab alike (switching keeps the file and its changes) -->
                <div v-if="loaded && FILE_SECTIONS[currentTab]" class="designer-files">
                  <AppProjectFiles
                    ref="projectFiles"
                    :kind="FILE_SECTIONS[currentTab]"
                    :forms="formsForPreview"
                    :view="editorView"
                    :readOnly="!(lock && lock.match) || !canDesignFiles(FILE_SECTIONS[currentTab])"
                    :theme="editorTheme"
                    :editorStyle="editorStyle('100%')"
                    @init="onEditorInit"
                    @reveal="showView('yaml')"
                    :canCreateInventories="canCreateInventories"
                    @newInventory="newInventory"
                  />
                  <!-- a new inventory : the repositories' New dialog, used for inventories (only for a user
                       who may create a repository) -->
                  <AppAdminMulti
                    v-if="currentTab === 'Inventories' && canCreateInventories"
                    ref="inventoryRepoDialog"
                    :apiVersion="2"
                    :settings="inventoryRepoSettings"
                    dialogOnly
                    canCreateChoices
                    @created="onInventoryRepoCreated"
                  />
                </div>
                <!-- a section's preview, still to build -->
                <div
                  v-else-if="loaded && draftSections.includes(currentTab) && editorView === 'preview'"
                  class="designer-visual d-flex flex-column"
                >
                  <AppDesignerEmpty :icon="'eye'" :title="t('designer.noFiles')" :text="t('designer.sectionToBuild')" />
                </div>
                <div
                  v-else-if="loaded && draftSections.includes(currentTab) && editorView === 'visual'"
                  class="designer-visual d-flex flex-column"
                >
                  <AppDesignerEmpty
                    :icon="tabs.find((x) => x.name === currentTab)?.icon"
                    :title="t('designer.noFiles')"
                    :text="t('designer.sectionToBuild')"
                  />
                </div>
                <!-- a section still to build : nothing to edit yet, nothing typed to lose -->
                <div
                  v-else-if="loaded && draftSections.includes(currentTab)"
                  class="designer-visual d-flex flex-column"
                >
                  <AppDesignerEmpty
                    :icon="tabs.find((x) => x.name === currentTab)?.icon"
                    :title="t('designer.noFiles')"
                    :text="t('designer.sectionToBuild')"
                  />
                </div>
                <!-- Preview : each constant, its reference ($(NAME)) and the forms using it -->
                <div v-if="loaded && currentTab == 'Constants' && editorView === 'preview'" class="designer-visual">
                  <AppValuesPreview :text="constants" mode="constants" :forms="formsForPreview" />
                </div>
                <!-- Visual : the constants as a table, on the same YAML (saved with Save) -->
                <div v-else-if="loaded && currentTab == 'Constants' && editorView === 'visual'" class="designer-visual">
                  <AppConstantsEditor
                    ref="visualEditor"
                    v-model="constants"
                    :readOnly="!(lock && lock.match) || configTemplated || !canDesignForms"
                  />
                </div>
                <div v-else-if="loaded && currentTab == 'Constants'">
                  <BsInput
                    type="editor"
                    :readonly="!lock?.match || configTemplated || !canDesignForms"
                    :isFloating="false"
                    v-model="constants"
                    @save="saveForms()"
                    @init="onEditorInit"
                    lang="yaml"
                    :theme="editorTheme"
                    :liveSync="true"
                    :style="editorStyle('100%')"
                  />
                </div>
                <div v-if="currentTab == 'Forms'">
                  <template v-if="loaded">
                    <!-- nothing selected (or the selection was just deleted) : the
                       pane would be blank, so say what to do with it -->
                    <div
                      v-if="!editorTarget"
                      class="d-flex flex-column align-items-center justify-content-center py-5 text-muted"
                    >
                      <FaIcon icon="pen-to-square" style="font-size: 2.5rem; opacity: 0.3" class="mb-3" />
                      <p class="mb-3 fw-semibold" style="font-size: 1.2rem">{{ t('designer.noFormSelected') }}</p>
                      <p class="fs-6 mb-0">{{ t('designer.noFormSelectedHint') }}</p>
                    </div>
                    <!-- ONE editor, keyed by the form it edits. This used to be rendered
                       inside v-for="f in files", and `files` is derived from the PARSED
                       yaml : the moment a keystroke left the document invalid the form's
                       source flipped to "Parsing issues", the enclosing v-for key changed
                       with it, and vue tore the editor down and mounted a new one - so
                       typing an incomplete line (which every line is, halfway through
                       typing it) threw away the ace instance along with the cursor and the
                       focus. Keying on currentForm keeps the editor alive while the yaml
                       is broken, and still gives each form its own instance - and its own
                       undo stack - when you switch forms. -->
                    <!-- the Preview tab : the form page in a frame, its own menu and header left out
                         (embed) ; refreshed with the YAML as it is now, or opened in a new window -->
                    <div v-if="editorTarget && editorView === 'preview'" class="designer-preview">
                      <div class="designer-preview-bar">
                        <span class="text-body-secondary small">
                          <FaIcon icon="circle-info" class="me-1" />{{ t('designer.previewHint') }}
                        </span>
                        <span class="d-flex gap-1">
                          <BsButton
                            icon="rotate-right"
                            :isIconButton="true"
                            :title="t('designer.previewRefresh')"
                            @click="refreshPreview"
                          />
                          <BsButton
                            icon="arrow-up-right-from-square"
                            :isIconButton="true"
                            :title="t('designer.previewForm')"
                            @click="previewForm"
                          />
                        </span>
                      </div>
                      <iframe
                        v-if="previewUrl"
                        :key="previewKey"
                        :src="previewUrl"
                        class="designer-preview-frame"
                        :title="t('designer.preview')"
                      ></iframe>
                    </div>
                    <!-- the Visual tab : what the form is, and its fields as an outline, on the same
                         YAML (saved with Save) -->
                    <div v-else-if="editorTarget && editorView === 'visual'" class="designer-visual">
                      <!-- a subform the user only uses : read only, said as on the YAML tab -->
                      <div v-if="formReadOnly" class="alert alert-secondary py-2 mb-2">
                        <FaIcon icon="lock" class="me-2" />{{ t('designer.subformReadOnly') }}
                      </div>
                      <AppFormVisualEditor
                        :key="'formvisual-' + currentForm"
                        ref="visualEditor"
                        v-model="forms[currentForm]"
                        :readOnly="!(lock && lock.match) || configTemplated || !canDesignForms || formReadOnly"
                        :categoryOptions="visualCategoryOptions"
                        :roleOptions="visualRoleOptions"
                        :otherForms="visualOtherForms"
                      />
                    </div>
                    <div v-else-if="editorTarget" :key="'formeditor-' + currentForm">
                      <!-- a subform the user only uses : read only, said -->
                      <div v-if="formReadOnly" class="alert alert-secondary py-2 mb-2">
                        <FaIcon icon="lock" class="me-2" />{{ t('designer.subformReadOnly') }}
                      </div>
                      <BsInput
                        type="editor"
                        :readonly="!lock?.match || configTemplated || !canDesignForms || formReadOnly"
                        :isFloating="false"
                        v-model="forms[currentForm]"
                        @save="saveForms()"
                        @init="onEditorInit"
                        lang="yaml"
                        :theme="editorTheme"
                        :liveSync="true"
                        :style="editorStyle('100%')"
                      />
                    </div>
                  </template>
                </div>
              </div>
              <div
                v-if="currentTab == 'Forms'"
                class="designer-resize"
                @mousedown="!explorerFolded && startResize($event)"
              ></div>
              <!-- folded away : only its < remains, to bring it back -->
              <div v-if="currentTab == 'Forms' && explorerFolded" class="designer-explorer-folded">
                <span
                  role="button"
                  class="tree-add-btn"
                  :title="t('designer.files.showExplorer')"
                  @click="explorerFolded = false"
                  ><FaIcon icon="chevron-left"
                /></span>
              </div>
              <AppExplorerColumn v-else-if="currentTab == 'Forms'" class="designer-tree">
                <div class="file-tree-panel">
                  <div class="file-tree-header d-flex justify-content-between align-items-center">
                    <!-- its heading on one line, cut with an ellipsis when narrow (as the file sections') -->
                    <span class="d-flex align-items-center min-w-0"
                      ><span
                        role="button"
                        class="tree-add-btn me-2"
                        :title="t('designer.files.hideExplorer')"
                        @click="explorerFolded = true"
                        ><FaIcon icon="chevron-right" /></span
                      ><span class="text-truncate">{{ t('designer.fileExplorer') }}</span></span
                    >
                    <span class="d-flex gap-2">
                      <span
                        role="button"
                        class="tree-add-btn"
                        @click="toggleCollapseAll()"
                        :title="allTreeCollapsed ? t('designer.expandAll') : t('designer.collapseAll')"
                        ><FaIcon :icon="allTreeCollapsed ? 'angles-down' : 'angles-up'"
                      /></span>
                      <span role="button" class="tree-add-btn" @click="toggleTreeSearch()" :title="t('designer.search')"
                        ><FaIcon icon="magnifying-glass"
                      /></span>
                      <span role="button" class="tree-add-btn" @click="openNewFolder()" :title="t('designer.newFolder')"
                        ><FaIcon icon="folder"
                      /></span>
                      <span role="button" class="tree-add-btn" @click="openNewFile()" :title="t('designer.newFile')"
                        ><FaIcon icon="file"
                      /></span>
                    </span>
                  </div>
                  <div v-if="treeSearch" class="tree-search-bar">
                    <div class="tree-search-box">
                      <input
                        type="text"
                        class="form-control form-control-sm"
                        v-model="treeFilter"
                        :placeholder="t('designer.search') + '...'"
                        ref="treeSearchInput"
                        @keydown.esc="clearTreeSearch()"
                      />
                      <button
                        v-if="treeFilter"
                        type="button"
                        class="tree-search-clear"
                        :title="t('common.clear')"
                        :aria-label="t('common.clear')"
                        @click="clearTreeSearch()"
                      >
                        <FaIcon icon="xmark" />
                      </button>
                    </div>
                  </div>
                  <div class="file-tree-content">
                    <template v-for="(item, idx) in fileTreeFlat" :key="'tree-' + idx">
                      <div
                        v-if="item.type === 'folder'"
                        class="d-flex justify-content-between align-items-center py-1 tree-node"
                        role="button"
                        :style="{ paddingLeft: item.depth * 1.25 + 'rem' }"
                        @click="toggleCollapse(item.key)"
                        @contextmenu="openContextMenu($event, { type: 'folder', name: item.name, path: item.path })"
                      >
                        <span class="d-flex align-items-center min-w-0">
                          <FaIcon
                            :icon="isCollapsed(item.key) ? 'chevron-right' : 'chevron-down'"
                            class="me-1 flex-shrink-0 tree-chevron"
                            size="xs"
                          />
                          <FaIcon
                            :icon="isCollapsed(item.key) ? 'folder' : 'folder-open'"
                            class="tree-folder-icon me-2 flex-shrink-0"
                          />
                          <span class="text-truncate" :title="item.name">{{ item.name }}</span>
                        </span>
                        <span class="d-flex gap-2 flex-shrink-0 ms-2">
                          <span
                            role="button"
                            class="tree-add-btn"
                            @click.stop="openNewFileInFolder(item.path)"
                            :title="t('designer.newFile')"
                            ><FaIcon icon="file"
                          /></span>
                          <span
                            role="button"
                            class="tree-del-btn"
                            @click.stop="confirmDeleteFolder(item.path)"
                            :title="t('designer.deleteFolder')"
                            ><FaIcon icon="times"
                          /></span>
                        </span>
                      </div>
                      <template v-else>
                        <div
                          class="d-flex justify-content-between align-items-center py-1 tree-node"
                          :class="{ 'tree-drop-target': dragFormId && dragFormId !== null }"
                          :style="{ paddingLeft: item.depth * 1.25 + 'rem' }"
                          @click="toggleCollapse(item.key)"
                          @contextmenu="openContextMenu($event, { type: 'file', source: item.source, name: item.name })"
                          @dragover="onDragOver"
                          @drop="onDropOnFile(item.source, $event)"
                          role="button"
                        >
                          <span class="d-flex align-items-center min-w-0">
                            <FaIcon
                              :icon="isCollapsed(item.key) ? 'chevron-right' : 'chevron-down'"
                              class="me-1 flex-shrink-0 tree-chevron"
                              size="xs"
                            />
                            <FaIcon icon="file-code" class="text-secondary me-2 flex-shrink-0" />
                            <span class="fw-semibold text-truncate" :title="item.name || t('designer.baseFile')">{{
                              item.name || t('designer.baseFile')
                            }}</span>
                          </span>
                          <span class="d-flex gap-2 flex-shrink-0 ms-2">
                            <span
                              role="button"
                              class="tree-add-btn"
                              @click.stop="addForm(item.source)"
                              :title="t('designer.addForm')"
                            >
                              <FaIcon icon="plus" />
                            </span>
                            <!-- no delete for the base file : it is not a file on disk -->
                            <span
                              v-if="item.source"
                              role="button"
                              class="tree-del-btn"
                              @click.stop="confirmDeleteFile(item.source)"
                              :title="t('designer.deleteFile')"
                            >
                              <FaIcon icon="times" />
                            </span>
                          </span>
                        </div>
                        <template v-if="!isCollapsed(item.key) || treeFilter">
                          <div
                            v-for="n in formnames(item.source).filter(
                              (f) => !treeFilter || (f.name || '').toLowerCase().includes(treeFilter.toLowerCase()),
                            )"
                            :key="n.id"
                            class="d-flex justify-content-between align-items-center py-1 tree-node tree-form"
                            :class="{
                              'tree-active': isCurrentForm(n.id),
                              'tree-dirty': isFormDirty(n.id),
                              'tree-drop-above': dropTargetId === n.id && dragFormId,
                            }"
                            :style="{ paddingLeft: (item.depth + 1) * 1.25 + 'rem' }"
                            role="button"
                            :draggable="!readOnlyForm(n.id)"
                            @click="selectForm(n.id)"
                            @contextmenu="openContextMenu($event, { type: 'form', id: n.id, name: n.name })"
                            @dragstart="onDragStart(n.id, $event)"
                            @dragend="
                              dragFormId = null;
                              dropTargetId = null;
                            "
                            @dragover="onFormDragOver(n.id, $event)"
                            @drop="onDropOnForm(n.id, $event)"
                            @dragleave="dropTargetId === n.id && (dropTargetId = null)"
                          >
                            <span class="d-flex align-items-center min-w-0">
                              <FaIcon v-if="n.icon" :icon="n.icon" class="me-2 flex-shrink-0" />
                              <span class="text-truncate" :title="n.name">{{ n.name }}</span>
                            </span>
                            <span
                              v-if="!readOnlyForm(n.id)"
                              role="button"
                              class="tree-del-btn flex-shrink-0 ms-2"
                              @click.stop="deleteForm(n.id)"
                            >
                              <FaIcon icon="times" />
                            </span>
                          </div>
                        </template>
                      </template>
                    </template>
                  </div>
                </div>
              </AppExplorerColumn>
            </div>
          </div>
        </template>
      </AppSettings>
      <!-- the user being checked : the title and placeholders where the designer comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
<style lang="scss" scoped>
.designer-layout {
  display: grid;
  /* the explorer's width when it opens : EXPLORER_WIDTH.start (config/fileExplorer.js), set
     inline as soon as the forms show it */
  grid-template-columns: 1fr 1rem 30%;
  align-items: start;
}
.designer-layout:not(:has(.designer-tree)) {
  grid-template-columns: 1fr;
}
.designer-editor {
  min-width: 0;
}
/* someone else holds the lock : the switch on and disabled (Bootstrap's faded blue), its label
   (the lock, who holds it) in the normal text colour, as Start designer - Bootstrap fades a
   disabled switch's label too */
/* the admin's Release stands a little apart from whose lock it is : more than the title
   controls' gap, which otherwise zeroes a control's margin (bootstrap-override.scss) */
.af-title-controls > .designer-release {
  /* with the 8px gap, 14px from the lock's label */
  margin-left: 6px !important;
}
.designer-switch-other .form-check-input:disabled ~ .form-check-label {
  opacity: 1;
  cursor: default;
}
.designer-resize {
  cursor: col-resize;
  align-self: stretch;
  // matches the editor column's own top offset, which is the 0.5rem bottom margin
  // of the empty <label> BsInput renders above the ace box - so the handle, the
  // tree and the editor all start on the same line
  margin-top: 0.5rem;
  position: relative;
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    top: 0;
    bottom: 0;
    width: 2px;
    border-radius: 1px;
    background: transparent;
    transition: background 0.15s;
  }
  &:hover::after {
    background: var(--bs-border-color);
  }
}
.designer-explorer-folded {
  margin-top: 0.5rem;
  display: flex;
  justify-content: center;
}
.designer-tree {
  // its height is the editor's column (AppExplorerColumn) : the panel scrolls its file list,
  // not itself, the header with its buttons (and the search bar) staying in place
  // see .designer-resize : aligns the panel's top edge with the ace box
  margin-top: 0.5rem;
  // its bottom edge already lines up : the editor's wrapper has no bottom margin here (see
  // the global style block), so the grid row ends where the ace box ends
}
@media (max-width: 991.98px) {
  .designer-layout {
    grid-template-columns: 1fr !important;
  }
  .designer-resize,
  .designer-tree {
    display: none;
  }
}
.file-tree-panel {
  background: var(--bs-tertiary-bg);
  border: 1px solid rgba(var(--bs-emphasis-color-rgb), 0.25);
  border-radius: 0.375rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100%;
}
.file-tree-header,
.tree-search-bar {
  flex-shrink: 0;
}
.file-tree-header {
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--bs-secondary-color);
  // 0.5rem on the right, the file list's own padding, so these buttons line up with the
  // buttons of the rows below
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  background: var(--bs-card-bg, var(--bs-body-bg));
  border-bottom: 1px solid rgba(var(--bs-emphasis-color-rgb), 0.25);
}
.tree-search-bar {
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid rgba(var(--bs-emphasis-color-rgb), 0.25);
}
/* the X inside the box, at its right, while something is typed : it empties it (as the page
   filters' X, BsSearch.vue) */
.tree-search-box {
  position: relative;
}
.tree-search-box .form-control {
  padding-right: 1.75rem;
}
.tree-search-clear {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  border: 0;
  background: transparent;
  color: var(--bs-secondary-color);
  padding: 0 0.5rem;
}
.tree-search-clear:hover {
  color: var(--bs-body-color);
}
.file-tree-content {
  padding: 0.25rem 0.5rem;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.tree-add-btn,
.tree-del-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  font-size: 0.9rem;
  border-radius: 0.25rem;
  flex-shrink: 0;
}
.tree-add-btn {
  color: var(--bs-secondary-color);
  border: 1px solid var(--bs-secondary-color);
  &:hover {
    background: var(--bs-secondary-color);
    color: #fff;
  }
}
.tree-del-btn {
  color: var(--bs-danger);
  border: 1px solid var(--bs-danger);
  &:hover {
    background: var(--bs-danger);
    color: #fff;
  }
}
.tree-node {
  border-radius: 0.25rem;
  // no space on the right : the row's buttons sit on its right edge, so the highlight of
  // the selected row ends on the edge of its buttons (the header's buttons line up with them)
  min-width: 0;
}
.tree-drop-above {
  border-top: 2px solid var(--bs-primary);
}
// a file row is a valid drop target while a form is being dragged
.tree-drop-target {
  outline: 1px dashed var(--bs-primary);
  outline-offset: -1px;
}
.tree-node:hover {
  background-color: var(--bs-tertiary-bg);
}
.tree-form:hover {
  background-color: rgba(var(--bs-primary-rgb), 0.3);
}
.tree-active {
  background-color: var(--bs-primary-bg-subtle);
  font-weight: 600;
}
.tree-active:hover {
  background-color: rgba(var(--bs-primary-rgb), 0.35);
}
/* on the selected row the delete button gets a light red fill (the ✕ stays red, white on
   light red would be unreadable), so the row's action stands out from the blue ; hover
   still turns it solid red with a white ✕ */
.tree-active .tree-del-btn:not(:hover) {
  background-color: var(--bs-danger-bg-subtle);
}
.tree-dirty > span > span.text-truncate {
  color: var(--bs-primary);
  font-style: italic;
}
.tree-chevron {
  width: 0.75rem;
  color: var(--bs-secondary-color);
}
// a folder is folder yellow in every theme : it used text-warning, which the themes tone
// down for warning text (nearly black on the light theme, nearly white on the dark one)
.tree-folder-icon {
  color: #f0b429;
}
.diff-view {
  max-height: 60vh;
  overflow: auto;
  font-family: monospace;
  font-size: 0.85rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.375rem;
}
.diff-line {
  white-space: pre;
  padding: 0 0.5rem;
  line-height: 1.5;
}
.diff-marker {
  display: inline-block;
  width: 1rem;
  user-select: none;
  color: var(--bs-secondary-color);
}
.diff-added {
  background-color: rgba(40, 167, 69, 0.15);
}
.diff-added .diff-marker {
  color: var(--bs-success);
}
.diff-removed {
  background-color: rgba(220, 53, 69, 0.15);
}
.diff-removed .diff-marker {
  color: var(--bs-danger);
}
.icon-section-header {
  display: flex;
  align-items: center;
  padding: 0.5rem 0;
  margin-bottom: 0.25rem;
  user-select: none;
}
.icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
  gap: 0.25rem;
}
.icon-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  padding: 0.85rem 0.25rem 0.5rem;
  border-radius: 0.375rem;
  border: 2px solid transparent;
  cursor: pointer;
}
.icon-cell:hover {
  background-color: var(--bs-tertiary-bg);
}
.icon-selected {
  border-color: var(--bs-primary);
  background-color: var(--bs-primary-bg-subtle);
}
.icon-label {
  font-size: 0.85rem;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  color: var(--bs-secondary-color);
}
.tile-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.5rem;
}
.tile-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem;
  border-radius: 0.375rem;
  border: 2px solid transparent;
  cursor: pointer;
}
.tile-cell:hover {
  border-color: var(--bs-border-color);
}
.tile-selected {
  border-color: var(--bs-primary);
}
.tile-swatch {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 0.375rem;
  border: 1px solid var(--bs-border-color);
}
.tile-label {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
}
.v-enter-from {
  opacity: 0;
  translate: -100px 0;
}

.v-enter-to {
  opacity: 1;
  translate: 0 0;
}

.v-leave-from {
  opacity: 1;
  translate: 0 0;
}

.v-leave-to {
  opacity: 0;
  translate: 100px 0;
}

// a flex item defaults to min-width:auto, which keeps it from shrinking below
// its content : without this the text-truncate inside never gets to ellipsis and
// a long form/file name overflows the tree column (bootstrap has no such utility)
.min-w-0 {
  min-width: 0;
}
.field-editor-table {
  table-layout: fixed;
}
.field-grip {
  cursor: grab;
}
.field-drag-over td {
  border-top: 2px solid var(--bs-primary);
}
.field-values-panel {
  background: var(--bs-tertiary-bg);
  border: 1px solid var(--bs-border-color);
}
.warning-entry {
  border-radius: 0.25rem;
  padding: 0.25rem 0.5rem;
  margin-left: -0.5rem;
}
.warning-entry:hover {
  background-color: var(--bs-tertiary-bg);
}
</style>
<style>
/* The editors fill whatever height the viewport leaves over instead of a
   hard-coded 75vh, so they end at the card and the card ends just short of the
   bottom of the screen. `af-fill-page` (bootstrap-override.scss) already turns
   the chain from this page's wrapper down to the AppSettings card body into a
   flex column; these rules continue it through the designer's own wrappers and
   into BsInput/AceEditor, which is why they live in the global block - a scoped
   rule cannot reach another component's DOM.
   The `:has(.ace_editor)` selector is what keeps it robust: it matches exactly
   the wrappers that lead to the visible editor, so the empty divs the Forms
   v-for renders for every non-selected form claim no space (giving all of them
   flex-grow would split the height between them). */
/* af-fill-page sizes the card body but leaves it a block container (on /logs it
   is just the scroll pane), so its child would not stretch - make it a column
   here, otherwise every flex rule below it is ignored and the editor collapses
   back to its content height. */
.designer-page > main > .section > .container-fluid > .card > .card-body,
.designer-page > main > .section > .container-fluid > .card > .card-body > div,
.designer-page .designer-editor,
.designer-page .designer-editor div:has(.ace_editor),
.designer-page .designer-editor div:has(.designer-preview),
.designer-page .designer-editor div:has(.designer-visual) {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
/* the grid is a flex item here, and its columns must be full height (default
   `align-items: start` would collapse them back to content height) */
.designer-page .designer-layout {
  flex: 1 1 auto;
  min-height: 0;
  align-items: stretch;
}
/* the playbooks and the vars files : their editor and explorer side by side (AppProjectFiles),
   a grid the rule above would make a column ; its editor's column still fills the height */
/* a file section takes the editor's whole height, so its empty message stands in the card's middle */
.designer-page .designer-editor .designer-files {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.designer-page .designer-editor .designer-files > .af-files {
  display: grid;
}
/* the editor's BsInput wrapper keeps no bottom margin : the card body's own padding is
   the gap under the editor, the same as the card's side padding */
.designer-page .card-body .mb-3:has(.ace_editor) {
  margin-bottom: 0 !important;
}
/* breathing room between the bottom of the card and the bottom of the screen ;
   flexbox subtracts item margins before handing out the free space, so the card
   shrinks by this much rather than overflowing */
.designer-page > main > .section > .container-fluid > .card {
  margin-bottom: 1rem;
}
.ctx-menu {
  position: fixed;
  z-index: 1060;
  min-width: 10rem;
  background: var(--bs-body-bg);
  border: 1px solid var(--bs-border-color);
  border-radius: 0.375rem;
  box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.15);
  padding: 0.25rem 0;
}
.ctx-item {
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  white-space: nowrap;
}
.ctx-item:hover {
  background-color: var(--bs-tertiary-bg);
}
.ctx-item-disabled {
  opacity: 0.4;
  cursor: default;
  pointer-events: none;
}
.ctx-divider {
  margin: 0.25rem 0;
  border-color: var(--bs-secondary-color);
  opacity: 0.5;
}
.ctx-item-danger {
  color: var(--bs-danger);
}
.ctx-item-danger:hover {
  background-color: var(--bs-danger-bg-subtle);
}
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1059;
}
/* the designer toolbar only : keep the pointer events so a disabled button still
   shows its title (why it is disabled). Never widen this beyond .designer-toolbar,
   bootstrap relies on pointer-events:none as the activation guard of .btn.disabled */
.designer-toolbar > .btn:disabled,
.designer-toolbar > .btn.disabled {
  pointer-events: auto;
  cursor: not-allowed;
}

/* a preview : no toolbar over it, so no room for one - the preview and the file explorer
   beside it start where the toolbar does */
.designer-layout-preview .designer-preview,
.designer-layout-preview .designer-tree {
  margin-top: 0;
}
/* the card's tabs : their height, whatever the card under them holds - the page is a column
   that fills the window, and a tall preview squeezed them */
.designer-tabs {
  flex-shrink: 0;
}
/* the visual editors (categories, constants, a form) : as far down as the YAML editor, and
   scrolling inside themselves as it does - the file explorer beside them stays where it is */
.designer-visual {
  margin-top: 0.5rem;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* room for a field's focus ring, which a scrolling pane would cut at its edges ; pulled back
     by as much, so the fields stay where they were */
  padding: 0.25rem 0.5rem 0.25rem 0.25rem;
  margin-left: -0.25rem;
}
/* a form's preview : a bar (what it is, refresh, a new window) over the form page in a frame,
   the editor's height ; as far down as the editor and the file explorer beside it */
.designer-preview {
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  /* the card's height, as the YAML editor (the full-height rules above), never less than a
     usable height on a short window */
  flex: 1 1 auto;
  min-height: 20rem;
  border: 1px solid var(--af-field-border);
  border-radius: 0.375rem;
  overflow: hidden;
}
.designer-preview-bar {
  /* one height for every preview's bar : a form's, with its buttons (38px and the padding),
     and the categories', with its text alone */
  min-height: calc(2.375rem + 0.75rem + 1px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem 0.375rem 0.75rem;
  border-bottom: 1px solid var(--af-field-border);
  background: var(--bs-tertiary-bg);
}
.designer-menu-preview {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--bs-body-bg);
}
.designer-preview-frame {
  flex: 1 1 auto;
  width: 100%;
  border: 0;
  background: var(--bs-body-bg);
}
</style>
<route lang="yaml">
meta:
  layout: standard
</route>
