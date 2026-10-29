<script setup>
/******************************************************************/
/*                                                                */
/*  The designer's Playbooks, Vars files and Inventories          */
/*  sections : the files of their folder (or of their             */
/*  repositories) in an explorer on                               */
/*  the right, the file chosen in the editor. Its actions sit in  */
/*  the designer's toolbar (exposed) : save, push, new file,      */
/*  reload, revert ; a file is deleted from its row.              */
/*                                                                */
/*  @props:                                                       */
/*      kind: String - 'playbooks', 'vars' or 'inventories'       */
/*         (/api/v2/files/...) ; the inventories one folder each  */
/*         (inventory.yaml, group_vars/, host_vars/)              */
/*      readOnly: Boolean - the designer lock is not ours, or a   */
/*         playbook without the role's allowPlaybookDesign        */
/*      canCreateInventories: Boolean - a new inventory (a new    */
/*         repository) may be made : off without the              */
/*         connections settings                                   */
/*      theme: String - the editor's theme                        */
/*      editorStyle: String|Object - the editor's size            */
/*      view: String - 'yaml' (the text) or 'visual' (a           */
/*         vars file's variables, an inventory's groups and       */
/*         hosts)                                                 */
/*                                                                */
/*  @emit:                                                        */
/*      init: the editor, for the toolbar's undo, find ...        */
/*      reveal: the Visual tab asks for the YAML (on a line)      */
/*                                                                */
/******************************************************************/
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers';
import { varsKind } from '@/config/varsFile';
import { workflowSkeleton } from '@/config/workflowFile';
import {
  EXPLORER_WIDTH,
  explorerWidthAfterDrag,
  explorerFolded,
  explorerColumns,
  firstExplorerFile,
} from '@/config/fileExplorer';
import { inventoryOf, inventoryFileRole } from '@/config/inventoryTree';

const { t } = useI18n();
const router = useRouter();
const emit = defineEmits(['init', 'reveal', 'newInventory']);
const props = defineProps({
  kind: { type: String, required: true },
  // the tab shown : 'yaml' (the text) or 'visual' (a vars file's variables)
  view: { type: String, default: 'yaml' },
  readOnly: { type: Boolean, default: false },
  // a new inventory is a new repository : off for a user without the connections settings
  canCreateInventories: { type: Boolean, default: true },
  theme: { type: String, default: null },
  editorStyle: { type: [String, Object], default: 'width: 100%;height: 75vh;font-size:1rem' },
  // the designer's forms ({ name, text }) : a vars file's Preview says which load it
  forms: { type: Array, default: () => [] },
});

// ─── state ────────────────────────────────────────────────────────────────────
const api = computed(() => `/api/v2/files/${props.kind}`);
const listing = ref({ repository: null, exists: true, truncated: false, dirty: false, files: [] });
const extraFolders = ref([]); // folders made here, still without a file
const selected = ref('');
const content = ref('');
const loadedContent = ref('');
const loading = ref(false);
const working = ref(false);
const dirty = computed(() => !!selected.value && content.value !== loadedContent.value);
const busy = computed(() => loading.value || working.value);
// listed at least once : until then, an empty listing only means not loaded yet
const listed = ref(false);
// a section with nothing in it shows no explorer (its New file is in the toolbar)
const sectionEmpty = computed(() => listed.value && !listing.value.files.length && !extraFolders.value.length);

// the dialogs : a new file, a new folder, a delete, leaving a file with changes
// { kind: 'file' | 'folder', path } ; an inventory's : { kind: 'inventory', name, repo }, or
// { kind: 'group_vars' | 'host_vars', inventory, name }
const creating = ref(null);
const deleting = ref('');
const leavingFor = ref(null); // the file to open once the changes are dropped
const leavingTo = ref(null); // what to do once the changes are dropped : go to a page, a section

// ─── the explorer ─────────────────────────────────────────────────────────────
const collapsed = ref(new Set());
// the explorer's search (its magnifying glass) : the files whose name or path has it
const filter = ref('');
const searching = ref(false);

/**
 * The explorer's rows : the folders and files, a folder before its content, each with its
 * depth. A filter shows the files whose path has it, with their folders, all open.
 */
const rows = computed(() => {
  const root = { folders: new Map(), files: [] };
  const folderAt = (parts) => {
    let node = root;
    for (const p of parts) {
      if (!node.folders.has(p)) node.folders.set(p, { folders: new Map(), files: [] });
      node = node.folders.get(p);
    }
    return node;
  };
  const needle = filter.value.trim().toLowerCase();
  for (const f of listing.value.files) {
    if (needle && !f.path.toLowerCase().includes(needle)) continue;
    const parts = f.path.split('/');
    folderAt(parts.slice(0, -1)).files.push({ name: parts.at(-1), path: f.path });
  }
  if (!needle) for (const d of extraFolders.value) folderAt(d.split('/'));
  const out = [];
  const walk = (node, prefix, depth) => {
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ type: 'folder', name, path, depth });
      if (needle || !collapsed.value.has(path)) walk(node.folders.get(name), path, depth + 1);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ type: 'file', name: f.name, path: f.path, depth });
    }
  };
  walk(root, '', 0);
  return out;
});
const allFolders = computed(() => rows.value.filter((r) => r.type === 'folder').map((r) => r.path));
const allCollapsed = computed(
  () => allFolders.value.length > 0 && allFolders.value.every((p) => collapsed.value.has(p)),
);

function toggleFolder(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}
function toggleAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(allFolders.value);
}

/** The editor's language for a file : YAML for .yml / .yaml, plain text otherwise. */
const lang = computed(() => (/\.ya?ml$/i.test(selected.value) ? 'yaml' : 'text'));

// ─── the Visual tab ───────────────────────────────────────────────────────────
// what the file open is : variables the Visual tab shows, or not
const fileKind = computed(() => (props.view === 'visual' && lang.value === 'yaml' ? varsKind(content.value) : null));

// ─── the inventories ──────────────────────────────────────────────────────────
// one folder per inventory at the top (production/inventory.yaml, group_vars/, host_vars/) : a
// folder of the local inventories folder, or a repository that is an inventory
const isInventories = computed(() => props.kind === 'inventories');
// the workflows : a file is job templates and workflows (the AWX export syntax), drawn as a graph
const isWorkflows = computed(() => props.kind === 'workflows');
const inventoryDepth = computed(() => 0);
// the inventories that are repositories : their folder shows git's mark
const repositoryInventories = computed(() => (listing.value.repositories || []).map((r) => r.name));
// what the file open is in its inventory : the inventory, a group's or a host's vars, other
const fileRole = computed(() => (isInventories.value ? inventoryFileRole(selected.value) : null));
// the inventory file open : edited in the Visual tab, drawn as a tree in the Preview
const isInventoryFile = computed(() => fileRole.value?.role === 'inventory');
const inventory = computed(() =>
  props.view === 'preview' && isInventoryFile.value ? inventoryOf(content.value) : null,
);
// the groups and hosts of the inventory open that have a vars file
const varsFilesOf = (role) =>
  listing.value.files
    .map((f) => inventoryFileRole(f.path))
    .filter((r) => r.role === role && r.inventory === fileRole.value?.inventory)
    .map((r) => r.name);
const groupVars = computed(() => (inventory.value ? varsFilesOf('group_vars') : []));
const hostVars = computed(() => (inventory.value ? varsFilesOf('host_vars') : []));
/** Opens a group's or a host's vars file of the inventory open. */
function openVars({ role, name }) {
  const base = `${fileRole.value.inventory}/${role}/${name}`;
  const file = listing.value.files.find((f) => f.path === `${base}.yaml` || f.path === `${base}.yml`);
  if (file) open(file.path);
}
// a new inventory : its file and the variables of all its hosts
const INVENTORY_SKELETON = 'all:\n  hosts: {}\n  children: {}\n';
// a key's name opens the YAML on its line : the designer shows the YAML tab, whose new
// editor goes to the line once it is there (onEditorInit)
const pendingLine = ref(null);
function reveal(line) {
  pendingLine.value = line || null;
  emit('reveal');
}
function onEditorInit(editor) {
  emit('init', editor);
  const line = pendingLine.value;
  pendingLine.value = null;
  if (!line) return;
  setTimeout(() => {
    editor.gotoLine(line, 0, false);
    editor.scrollToLine(line - 1, true, false, () => {});
    editor.focus();
  }, 50);
}
const varsEditor = ref(null);

// ─── load ─────────────────────────────────────────────────────────────────────
/**
 * Loads the list of files ; the file open stays open while it is still there.
 */
async function loadList() {
  loading.value = true;
  try {
    const result = await axios.get(api.value);
    listing.value = result.data;
    listed.value = true;
    const paths = new Set(result.data.files.map((f) => f.path));
    extraFolders.value = extraFolders.value.filter((d) => ![...paths].some((p) => p.startsWith(`${d}/`)));
    if (selected.value && !paths.has(selected.value)) {
      selected.value = '';
      content.value = loadedContent.value = '';
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to list the files'));
  } finally {
    loading.value = false;
  }
}

/**
 * Opens a file in the editor ; the changes of the one open are dropped (asked first).
 *
 * Args:
 *   path (string): the file's path.
 *   force (boolean): drop the changes without asking.
 */
async function open(path, force = false) {
  if (path === selected.value) return;
  if (dirty.value && !force) {
    leavingFor.value = path;
    return;
  }
  leavingFor.value = null;
  loading.value = true;
  try {
    const result = await axios.get(`${api.value}/file`, { params: { path } });
    selected.value = result.data.path;
    content.value = loadedContent.value = result.data.content;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to open the file'));
  } finally {
    loading.value = false;
  }
}

/** Loads the list and the file open again ; its changes are dropped. */
async function reload() {
  const path = selected.value;
  selected.value = '';
  content.value = loadedContent.value = '';
  await loadList();
  if (path && listing.value.files.some((f) => f.path === path)) await open(path, true);
}

/** Drops the changes of the file open : the file as saved. */
function revert() {
  content.value = loadedContent.value;
}

// ─── write ────────────────────────────────────────────────────────────────────
/** Saves the file open. */
async function save() {
  if (!dirty.value || props.readOnly) return;
  working.value = true;
  try {
    const res = await axios.put(`${api.value}/file`, { path: selected.value, content: content.value });
    // a workflow named as one in another file : said now, not when a form fails to start it
    const shared = res.data?.sharedNames || [];
    if (shared.length) toast.warning(t('designer.files.sharedWorkflowNames', { names: shared.join(', ') }));
    loadedContent.value = content.value;
    toast.success(t('designer.files.saved', { path: selected.value }));
    await loadList();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to save the file'));
  } finally {
    working.value = false;
  }
}

/** Commits and pushes the repository the files are in. */
async function push() {
  if (!listing.value.repository || props.readOnly) return;
  if (dirty.value) {
    toast.warning(t('designer.syncSaveFirst'));
    return;
  }
  working.value = true;
  try {
    await axios.post(`${api.value}/push`);
    toast.success(t('designer.files.pushed', { repository: listing.value.repository }));
    await loadList();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to push'));
  } finally {
    working.value = false;
  }
}

/**
 * Opens the dialog of a new file or folder, in a folder.
 *
 * Args:
 *   kind (string): 'file' or 'folder'.
 *   folder (string): the folder it goes in ('' for the top).
 */
function startCreate(kind, folder = '') {
  if (props.readOnly) return;
  if (kind === 'inventory') {
    // a new repository : not for a user who may not create one
    if (!props.canCreateInventories) return;
    // a new inventory is a new repository : the designer opens the repositories' New dialog,
    // used for inventories (newInventory), then seeds it (seedInventory)
    emit('newInventory');
  } else if (kind === 'group_vars' || kind === 'host_vars') {
    creating.value = { kind, name: '', inventory: folder };
  } else {
    creating.value = { kind, path: folder ? `${folder}/` : '' };
  }
}
// what the dialog asks : a path, or a name (a group's, a host's)
const asksName = computed(() => ['group_vars', 'host_vars'].includes(creating.value?.kind));
const createValue = computed(() => String((asksName.value ? creating.value?.name : creating.value?.path) || '').trim());
const CREATE_LOOK = {
  // a new playbook or vars file : its file name as the placeholder
  file: { icon: 'file', title: 'designer.newFile', help: 'designer.files.pathHelp', placeholder: 'file.yaml' },
  folder: { icon: 'folder', title: 'designer.newFolder', help: 'designer.files.folderHelp' },
  group_vars: { icon: 'layer-group', title: 'designer.files.newGroupVars', help: 'designer.files.groupVarsHelp' },
  host_vars: { icon: 'server', title: 'designer.files.newHostVars', help: 'designer.files.hostVarsHelp' },
  // a new workflow : a new file, an empty workflow named after it (createFile)
  workflow: {
    icon: 'diagram-project',
    title: 'designer.files.newWorkflow',
    help: 'designer.files.workflowPathHelp',
    placeholder: 'workflow.yaml',
  },
};
const createLook = computed(() => CREATE_LOOK[creating.value?.kind] || CREATE_LOOK.file);

/**
 * A new inventory's repository, once cloned : its inventory.yaml and group_vars/all.yaml when it
 * has none yet, then opened - ready to save and push.
 *
 * Args:
 *   name (string): the repository (the inventory's name).
 */
async function seedInventory(name) {
  await loadList();
  const has = (p) => listing.value.files.some((f) => f.path === p);
  try {
    if (!has(`${name}/inventory.yaml`)) await postFile(`${name}/inventory.yaml`, INVENTORY_SKELETON);
    if (!has(`${name}/group_vars/all.yaml`)) await postFile(`${name}/group_vars/all.yaml`, '---\n');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to start the inventory'));
  }
  await loadList();
  await open(`${name}/inventory.yaml`, true);
}

/** Posts a new file (its folders made by the server) ; its path as the server stored it. */
async function postFile(path, content) {
  return (await axios.post(`${api.value}/file`, { path, content })).data.path;
}

/** Creates the file (empty, or '---' for YAML) and opens it, or keeps the new folder. */
async function create() {
  const c = creating.value;
  if (asksName.value) {
    const name = createValue.value;
    if (!name) return;
    working.value = true;
    try {
      // web or web.yaml : web.yaml, never web.yaml.yaml
      const file = /\.ya?ml$/i.test(name) ? name : `${name}.yaml`;
      const opened = await postFile(`${c.inventory}/${c.kind}/${file}`, '---\n');
      creating.value = null;
      await loadList();
      await open(opened, true);
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, 'Failed to create'));
    } finally {
      working.value = false;
    }
    return;
  }
  const path = (c.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!path) return;
  if (c.kind === 'folder') {
    extraFolders.value = [...new Set([...extraFolders.value, path])];
    creating.value = null;
    return;
  }
  working.value = true;
  try {
    // a new workflow file starts as one workflow (named after the file), to add nodes to
    const yaml = /\.ya?ml$/i.test(path);
    const content =
      yaml && isWorkflows.value
        ? workflowSkeleton(
            path
              .split('/')
              .pop()
              .replace(/\.ya?ml$/i, ''),
          )
        : yaml
          ? '---\n'
          : '';
    const result = await axios.post(`${api.value}/file`, { path, content });
    creating.value = null;
    await loadList();
    await open(result.data.path, true);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to create the file'));
  } finally {
    working.value = false;
  }
}

/** Deletes the file asked about, and closes it when it was open. */
async function remove() {
  const path = deleting.value;
  working.value = true;
  try {
    await axios.delete(`${api.value}/file`, { params: { path } });
    deleting.value = '';
    if (selected.value === path) {
      selected.value = '';
      content.value = loadedContent.value = '';
    }
    toast.success(t('designer.files.deleted', { path }));
    await loadList();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to delete the file'));
  } finally {
    working.value = false;
  }
}

// ─── the explorer's width (as the forms') ─────────────────────────────────────
const treeWidthPct = ref(EXPLORER_WIDTH.start);
function startResize(e) {
  e.preventDefault();
  const layout = e.target.closest('.af-files');
  const startX = e.clientX;
  const width = layout.getBoundingClientRect().width;
  const startPct = treeWidthPct.value;
  const onMove = (ev) => {
    treeWidthPct.value = explorerWidthAfterDrag(startPct, ev.clientX - startX, width);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// the explorer's search box : shown by its magnifying glass and focused once in the dom, emptied
// when hidden
const searchInput = ref(null);
async function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) filter.value = '';
  else {
    await nextTick();
    searchInput.value?.focus();
  }
}
// its X (and Escape) : emptied, the box kept open and focused
function clearSearch() {
  filter.value = '';
  searchInput.value?.focus();
}

// ─── leaving with changes ─────────────────────────────────────────────────────
// another page, or another section or tab of the designer : asked first, as another file is.
// The designer asks before it switches (leave, exposed) ; an address asks through the router.
/**
 * Runs a step that closes the file open : at once without changes, after the question with.
 *
 * Args:
 *   go (function): the step (switch the section, the tab, go to a page).
 *
 * Returns:
 *   boolean: true when it ran at once.
 */
function leave(go) {
  if (!dirty.value) {
    go();
    return true;
  }
  leavingTo.value = go;
  return false;
}
function guard(to, from) {
  if (!dirty.value) return true;
  // the YAML, Visual and Preview tabs of a section show the same file : only their address changes
  // (/designer/inventories/yaml, /visual), so no question, and the tab never moves without it
  const section = (r) => r.path.split('/')[2];
  if (section(to) === section(from) && to.path.startsWith('/designer/')) return true;
  leavingTo.value = () => router.push(to.fullPath);
  return false;
}
onBeforeRouteUpdate(guard);
onBeforeRouteLeave(guard);
function onBeforeUnload(e) {
  if (dirty.value) e.preventDefault();
}
window.addEventListener('beforeunload', onBeforeUnload);
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

/** Saves the changes, then goes where the dialog was opened for ; a failed save stays. */
async function saveAndGo() {
  await save();
  if (dirty.value) return;
  if (leavingFor.value) return open(leavingFor.value, true);
  const go = leavingTo.value;
  leavingTo.value = null;
  go();
}

/** Drops the changes and goes where the dialog was opened for : a file, or a page. */
function discardAndGo() {
  if (leavingFor.value) return open(leavingFor.value, true);
  const go = leavingTo.value;
  leavingTo.value = null;
  content.value = loadedContent.value;
  go();
}

/**
 * Loads the files and opens the first the explorer lists (for the inventories, the first
 * inventory's inventory.yaml) : the section opens on a file rather than on nothing.
 */
async function loadAndOpen() {
  await loadList();
  if (selected.value) return;
  const first = firstExplorerFile(
    listing.value.files.map((f) => f.path),
    isInventories.value ? (p) => inventoryFileRole(p).role === 'inventory' : undefined,
  );
  if (first) await open(first, true);
}

watch(
  () => props.kind,
  () => {
    selected.value = '';
    content.value = loadedContent.value = '';
    extraFolders.value = [];
    loadAndOpen();
  },
);
onMounted(loadAndOpen);
defineExpose({
  save,
  push,
  reload,
  revert,
  newFile: () => startCreate(isInventories.value ? 'inventory' : isWorkflows.value ? 'workflow' : 'file'),
  seedInventory,
  // the file open's text, as the toolbar's format, compare and download need it
  getText: () => content.value,
  setText: (text) => {
    content.value = text;
  },
  savedText: () => loadedContent.value,
  isYaml: computed(() => lang.value === 'yaml'),
  // the Visual tab of a vars file : a new key at its top
  addVar: () => varsEditor.value?.add(),
  canAddVar: computed(() => !!varsEditor.value),
  leave,
  dirty,
  busy,
  selected,
  repository: computed(() => listing.value.repository),
  unpushed: computed(() => listing.value.dirty),
});
</script>
<template>
  <div class="af-files" :style="{ gridTemplateColumns: sectionEmpty ? '1fr' : explorerColumns(treeWidthPct) }">
    <div class="af-files-editor">
      <AppDesignerEmpty
        v-if="!selected"
        :icon="kind === 'playbooks' ? 'file-code' : 'file-lines'"
        :title="sectionEmpty ? t('designer.noFiles') : t('designer.files.noneOpen')"
        :text="
          listing.exists
            ? listing.files.length
              ? t('designer.files.pickOne')
              : isInventories
                ? t('designer.files.noInventories')
                : t('designer.files.noFiles')
            : t('designer.files.noFolder')
        "
      />
      <!-- the Preview tab of a playbook : its outline, read only -->
      <div v-else-if="view === 'preview' && kind === 'playbooks'" class="af-files-visual">
        <AppPlaybookOutline :modelValue="content" @reveal="reveal" />
      </div>
      <!-- the Preview tab of an inventory : its groups and hosts as a tree ; a vars file's (an
           inventory's, or one of Vars files) : its variables, as a playbook reads them -->
      <div v-else-if="view === 'preview' && (isInventories || kind === 'vars')" class="af-files-visual">
        <div v-if="lang !== 'yaml'" class="empty-state">
          <FaIcon icon="file-lines" class="empty-state-icon" />
          <span>{{ t('designer.files.visualNotYaml') }}</span>
        </div>
        <AppInventoryTree
          v-else-if="inventory && inventory.kind !== 'invalid'"
          :inventory="inventory"
          :groupVars="groupVars"
          :hostVars="hostVars"
          :fileName="selected.split('/').pop()"
          @reveal="reveal"
          @open="openVars"
        />
        <div v-else-if="inventory" class="alert alert-warning d-flex align-items-center gap-2">
          <FaIcon icon="triangle-exclamation" />
          <span class="flex-grow-1">{{ t('designer.files.visualInvalid', { error: inventory.error }) }}</span>
          <BsButton icon="code" @click="reveal(inventory.line)">{{ t('designer.files.showInYaml') }}</BsButton>
        </div>
        <AppValuesPreview v-else :text="content" mode="vars" :file="selected" :forms="forms" @reveal="reveal" />
      </div>
      <!-- the Preview tab of a workflow file : a dry run of its workflows -->
      <AppWorkflowEditor v-else-if="view === 'preview' && isWorkflows" :modelValue="content" readOnly preview />
      <!-- the Visual tab : a vars file as its variables -->
      <div v-else-if="view === 'visual'" class="af-files-visual">
        <div v-if="lang !== 'yaml'" class="empty-state">
          <FaIcon icon="file-lines" class="empty-state-icon" />
          <span>{{ t('designer.files.visualNotYaml') }}</span>
        </div>
        <!-- a playbook : its plays and tasks, field by field -->
        <AppPlaybookEditor v-else-if="kind === 'playbooks'" v-model="content" :readOnly="readOnly" @reveal="reveal" />
        <!-- a workflow file : its workflows as graphs, its job templates -->
        <AppWorkflowEditor v-else-if="isWorkflows" v-model="content" :readOnly="readOnly" @reveal="reveal" />
        <!-- an inventory : its groups and hosts, edited -->
        <AppInventoryEditor v-else-if="isInventoryFile" v-model="content" :readOnly="readOnly" @reveal="reveal" />
        <div v-else-if="fileKind.kind === 'invalid'" class="alert alert-warning d-flex align-items-center gap-2">
          <FaIcon icon="triangle-exclamation" />
          <span class="flex-grow-1">{{ t('designer.files.visualInvalid', { error: fileKind.error }) }}</span>
          <BsButton icon="code" @click="reveal(fileKind.line)">{{ t('designer.files.showInYaml') }}</BsButton>
        </div>
        <AppVarsEditor
          v-else-if="fileKind.kind === 'vars' || fileKind.kind === 'empty'"
          ref="varsEditor"
          v-model="content"
          :readOnly="readOnly"
          @reveal="reveal"
        />
        <div v-else class="empty-state">
          <FaIcon icon="file-code" class="empty-state-icon" />
          <span>{{ t('designer.files.visualOther') }}</span>
        </div>
      </div>
      <BsInput
        v-else
        :key="selected"
        type="editor"
        :isFloating="false"
        v-model="content"
        :readonly="readOnly"
        :lang="lang"
        :theme="theme"
        :liveSync="true"
        :style="editorStyle"
        @save="save()"
        @init="onEditorInit"
      />
    </div>
    <!-- nothing in the section : no explorer at all -->
    <div v-if="!sectionEmpty" class="af-files-resize" @mousedown="!explorerFolded && startResize($event)"></div>
    <!-- folded away : only its < remains, to bring it back -->
    <div v-if="!sectionEmpty && explorerFolded" class="af-explorer-folded">
      <span role="button" class="tree-add-btn" :title="t('designer.files.showExplorer')" @click="explorerFolded = false"
        ><FaIcon icon="chevron-left"
      /></span>
    </div>
    <AppExplorerColumn v-else-if="!sectionEmpty" class="af-files-tree">
      <div class="file-tree-panel">
        <div class="file-tree-header d-flex justify-content-between align-items-center">
          <span class="d-flex align-items-center min-w-0" :title="listing.repository || ''">
            <!-- > folds it away -->
            <span
              role="button"
              class="tree-add-btn me-2"
              :title="t('designer.files.hideExplorer')"
              @click="explorerFolded = true"
              ><FaIcon icon="chevron-right"
            /></span>
            <span class="text-truncate">{{
              (!isInventories && listing.repository) || t('designer.fileExplorer')
            }}</span>
          </span>
          <span class="d-flex gap-2">
            <span
              role="button"
              class="tree-add-btn"
              @click="toggleAll()"
              :title="allCollapsed ? t('designer.expandAll') : t('designer.collapseAll')"
              ><FaIcon :icon="allCollapsed ? 'angles-down' : 'angles-up'"
            /></span>
            <span role="button" class="tree-add-btn" @click="toggleSearch()" :title="t('designer.search')"
              ><FaIcon icon="magnifying-glass"
            /></span>
            <template v-if="!readOnly && isInventories && canCreateInventories">
              <span
                role="button"
                class="tree-add-btn"
                @click="startCreate('inventory')"
                :title="t('designer.files.newInventory')"
                ><FaIcon icon="sitemap"
              /></span>
            </template>
            <!-- the inventories hold no loose folder nor file, with or without a new inventory -->
            <template v-else-if="!readOnly && !isInventories">
              <span role="button" class="tree-add-btn" @click="startCreate('folder')" :title="t('designer.newFolder')"
                ><FaIcon icon="folder"
              /></span>
              <span role="button" class="tree-add-btn" @click="startCreate('file')" :title="t('designer.newFile')"
                ><FaIcon icon="file"
              /></span>
            </template>
          </span>
        </div>
        <div v-if="searching" class="tree-search-bar">
          <div class="tree-search-box">
            <input
              ref="searchInput"
              v-model="filter"
              type="text"
              class="form-control form-control-sm"
              :placeholder="t('designer.search') + '...'"
              @keydown.esc="clearSearch()"
            />
            <button
              v-if="filter"
              type="button"
              class="tree-search-clear"
              :title="t('common.clear')"
              :aria-label="t('common.clear')"
              @click="clearSearch()"
            >
              <FaIcon icon="xmark" />
            </button>
          </div>
        </div>
        <div class="file-tree-content">
          <div v-if="listing.truncated" class="small text-warning-emphasis py-1">
            {{ t('designer.files.truncated') }}
          </div>
          <template v-for="item in rows" :key="item.type + item.path">
            <div
              v-if="item.type === 'folder'"
              class="d-flex justify-content-between align-items-center py-1 tree-node"
              role="button"
              :style="{ paddingLeft: item.depth * 1.25 + 'rem' }"
              @click="toggleFolder(item.path)"
            >
              <span class="d-flex align-items-center min-w-0">
                <FaIcon
                  :icon="collapsed.has(item.path) && !filter ? 'chevron-right' : 'chevron-down'"
                  class="me-1 flex-shrink-0 tree-chevron"
                  size="xs"
                />
                <!-- an inventory that is a repository : the Inventories section's mark (its tooltip
                     says it is a repository) -->
                <FaIcon
                  v-if="isInventories && item.depth === 0 && repositoryInventories.includes(item.name)"
                  icon="sitemap"
                  class="text-secondary me-2 flex-shrink-0"
                  :title="t('designer.files.inventoryRepository')"
                />
                <FaIcon
                  v-else
                  :icon="collapsed.has(item.path) && !filter ? 'folder' : 'folder-open'"
                  class="tree-folder-icon me-2 flex-shrink-0"
                />
                <span class="text-truncate" :title="item.name">{{ item.name }}</span>
              </span>
              <!-- an inventory's folder : its group vars and its host vars ; any other : a new file -->
              <span
                v-if="!readOnly && isInventories && item.depth === inventoryDepth"
                class="d-flex gap-2 flex-shrink-0 ms-2"
              >
                <span
                  role="button"
                  class="tree-add-btn"
                  @click.stop="startCreate('group_vars', item.path)"
                  :title="t('designer.files.newGroupVars')"
                  ><FaIcon icon="layer-group"
                /></span>
                <span
                  role="button"
                  class="tree-add-btn"
                  @click.stop="startCreate('host_vars', item.path)"
                  :title="t('designer.files.newHostVars')"
                  ><FaIcon icon="server"
                /></span>
              </span>
              <span v-else-if="!readOnly" class="d-flex gap-2 flex-shrink-0 ms-2">
                <span
                  role="button"
                  class="tree-add-btn"
                  @click.stop="startCreate('file', item.path)"
                  :title="t('designer.newFile')"
                  ><FaIcon icon="file"
                /></span>
              </span>
            </div>
            <div
              v-else
              class="d-flex justify-content-between align-items-center py-1 tree-node tree-file"
              :class="{ 'tree-active': item.path === selected, 'tree-dirty': item.path === selected && dirty }"
              role="button"
              :style="{ paddingLeft: item.depth * 1.25 + 1 + 'rem' }"
              @click="open(item.path)"
            >
              <span class="d-flex align-items-center min-w-0">
                <FaIcon
                  :icon="/\.ya?ml$/i.test(item.name) ? 'file-code' : 'file-lines'"
                  class="text-secondary me-2 flex-shrink-0"
                />
                <span class="text-truncate" :title="item.path">{{ item.name }}</span>
              </span>
              <span v-if="!readOnly" class="d-flex gap-2 flex-shrink-0 ms-2">
                <span
                  role="button"
                  class="tree-del-btn"
                  @click.stop="deleting = item.path"
                  :title="t('designer.deleteFile')"
                  ><FaIcon icon="times"
                /></span>
              </span>
            </div>
          </template>
        </div>
      </div>
    </AppExplorerColumn>

    <!-- a new file or folder : its path in the section's folder -->
    <BsModal v-if="creating" size="md" :icon="createLook.icon" @close="creating = null">
      <template #title>{{ t(createLook.title) }}</template>
      <template #default>
        <!-- the label above a field of the usual height, as the designer's other dialogs -->
        <BsInput
          v-if="asksName"
          :isFloating="false"
          v-model="creating.name"
          :label="t('designer.newFileLabel')"
          placeholder="file.yaml"
          :icon="createLook.icon"
          :help="t(createLook.help, { inventory: creating.inventory })"
          @keyup_enter="create()"
        />
        <BsInput
          v-else
          :isFloating="false"
          v-model="creating.path"
          :label="t('designer.files.path')"
          :placeholder="createLook.placeholder || ''"
          :icon="createLook.icon"
          :help="t(createLook.help)"
          @keyup_enter="create()"
        />
      </template>
      <template #footer>
        <BsButton :icon="createLook.icon" :disabled="!createValue || working" @click="create()">{{
          t('designer.files.create')
        }}</BsButton>
      </template>
    </BsModal>
    <!-- a delete, asked first -->
    <BsModal v-if="deleting" size="md" icon="trash" @close="deleting = ''">
      <template #title>{{ t('designer.deleteFile') }}</template>
      <template #default>
        <p class="mb-0 fs-6">
          {{ t('designer.files.deleteConfirm') }} <strong>{{ deleting }}</strong
          >?
        </p>
      </template>
      <template #footer>
        <BsButton icon="trash" :disabled="working" @click="remove()">{{ t('common.delete') }}</BsButton>
      </template>
    </BsModal>
    <!-- another file, section or page chosen while this file has changes -->
    <BsModal
      v-if="leavingFor || leavingTo"
      size="md"
      icon="triangle-exclamation"
      @close="leavingFor = leavingTo = null"
    >
      <template #title>{{ t('designer.unsavedChanges') }}</template>
      <template #default>
        <p class="mb-0 fs-6">{{ t('designer.files.leaveConfirm', { path: selected }) }}</p>
      </template>
      <template #footer>
        <!-- the likely answer first : keep the changes -->
        <BsButton v-if="!readOnly" icon="save" colorClass="primary" :disabled="working" @click="saveAndGo()">{{
          t('designer.saveAndClose')
        }}</BsButton>
        <BsButton icon="xmark" :disabled="working" @click="discardAndGo()">{{ t('designer.files.discard') }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>
<style lang="scss" scoped>
/* the editor and, on its right, the explorer : as the forms' (designer.vue) */
.af-files {
  display: grid;
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
  /* one row, as tall as the card leaves : the Visual tab scrolls inside it, never the card */
  grid-template-rows: minmax(0, 1fr);
}
.af-files-editor {
  min-width: 0;
  /* a column, so the empty message can fill it and sit in its middle */
  display: flex;
  flex-direction: column;
}
/* the Visual tab : the height the card leaves (whatever the banners above take), scrolling inside
   itself ; room for a field's focus ring */
.af-files-visual {
  margin-top: 0.5rem;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.25rem 0.5rem 0.25rem 0.25rem;
  margin-left: -0.25rem;
}
.af-files-resize {
  cursor: col-resize;
  align-self: stretch;
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
.af-explorer-folded {
  margin-top: 0.5rem;
  display: flex;
  justify-content: center;
}
/* its height is the editor's column (AppExplorerColumn), never more : a long list scrolls inside */
.af-files-tree {
  margin-top: 0.5rem;
}
@media (max-width: 991.98px) {
  .af-files {
    grid-template-columns: 1fr !important;
  }
  .af-files-resize {
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
.min-w-0 {
  min-width: 0;
}
.tree-node {
  border-radius: 0.25rem;
  min-width: 0;
  min-height: 2.5rem;
}
.tree-node:hover {
  background-color: var(--bs-tertiary-bg);
}
.tree-file:hover {
  background-color: rgba(var(--bs-primary-rgb), 0.3);
}
.tree-active {
  background-color: var(--bs-primary-bg-subtle);
  font-weight: 600;
}
.tree-active:hover {
  background-color: rgba(var(--bs-primary-rgb), 0.35);
}
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
.tree-folder-icon {
  color: #f0b429;
}
</style>
