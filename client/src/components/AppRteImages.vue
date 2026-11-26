<script setup>
/******************************************************************/
/*                                                                */
/*  The Designer's RTE images (server lib/rteImages.js) : the     */
/*  definitions of the repositories used for them, each an entry  */
/*  of a runner_rte: list. An explorer of them on the right, the  */
/*  one open on the left : Visual (its fields), YAML (its entry)  */
/*  and Preview (the Dockerfile a builder is handed, and its      */
/*  files). Save writes it to its file, Push commits and pushes,  */
/*  Build hands it to a builder (a job : its log on the job page).*/
/*  Its toolbar actions are read by the Designer (actions).       */
/*                                                                */
/*  Props                                                         */
/*    view          'visual', 'yaml' or 'preview'                 */
/*    readOnly      nothing can be changed (no lock, or no role   */
/*                  option)                                       */
/*    canBuild      the user may build (allowRteBuild)            */
/*    theme         the editors' theme                            */
/*    editorStyle   the editors' size                             */
/*                                                                */
/******************************************************************/
import 'ace-builds/src-noconflict/mode-dockerfile';
import 'ace-builds/src-noconflict/mode-ini';
import 'ace-builds/src-noconflict/mode-text';
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import YAML from 'yaml';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import { askConfirm } from '@/lib/confirmPrompt';
import { useLiveEvent } from '@/composables/useLiveEvent';
import { DESIGNER_ACTIONS } from '@/config/designerActions';
import { applyRteInsert } from '@/lib/rteImageEdit';
import { useAppStore } from '@/stores/app';
import {
  EXPLORER_WIDTH,
  explorerWidthAfterDrag,
  explorerFolded,
  explorerColumns,
  openFirstExplorerItem,
} from '@/config/fileExplorer';

const props = defineProps({
  view: { type: String, default: 'visual' },
  readOnly: { type: Boolean, default: false },
  canBuild: { type: Boolean, default: false },
  theme: { type: String, default: 'chrome' },
  editorStyle: { type: [String, Object], default: '' },
});
const { t } = useI18n();
const router = useRouter();
const store = useAppStore();
const api = '/api/v2/rte-images';

// the versions an image is made of, as the server knows them (lib/rteDockerfile.js versionsOf) :
// the architectures an image is built for : both (one multi-architecture image), or one
const ARCH_CHOICES = ['all', 'amd64', 'arm64'];
// the pythons rte-base may get, the one rte-core brings, and the ansible-core releases with the
// pythons each runs on
const versions = ref({ os: '', pythons: [], defaultPython: '3.15', ansibleCore: {} });

// ===========================================================================
// STATE
// ===========================================================================

const images = ref([]);
const repositories = ref([]);
const registries = ref([]);
const signingKeys = ref([]);
const builders = ref([]);
// the builds (jobs of type build), newest first : the images last built for an older release
const builds = ref([]);
const busy = ref(false);
// the image open : its name as saved (null for a new one), what it was and what it is now
const selected = ref(null);
const isNew = ref(false);
const original = ref('');
const draft = ref(null);
// a new image's repository, when there are several
const newRepository = ref('');
// its entry as YAML (the YAML tab), and why it does not read when it does not
const yamlText = ref('');
const yamlError = ref('');
// what it builds (the Preview tab)
const preview = ref(null);
const previewError = ref('');
// commits not pushed yet (a save since the last push)
const unpushed = ref(false);

/**
 * An error's message as the API said it.
 *
 * Args:
 *   e (Error): the error.
 *
 * Returns:
 *   string: its message.
 */
const why = (e) => e?.response?.data?.message || e?.response?.data?.error || e?.message || String(e);

/**
 * An image's tag : its registry's, a tag beside the registry (as before) read as it ; app when none.
 *
 * Args:
 *   image (object): the definition.
 *
 * Returns:
 *   string: app (the app's release) or its own tag.
 */
const tagOf = (image) => String(image?.registry?.tag || image?.tag || 'app');

/**
 * An image as its fields are edited : every list there, the texts of the lists as lines.
 *
 * Args:
 *   image (object): the definition.
 *
 * Returns:
 *   object: the draft.
 */
function draftOf(image) {
  return {
    name: image.name || '',
    description: image.description || '',
    // what it is built for : both architectures when none is given
    arch: image.arch || 'all',
    // none given : the default one
    python: String(image.python || versions.value.defaultPython),
    ansible_core: image.ansible_core || '',
    collections: (image.ansible_collections || []).map((c) =>
      typeof c === 'string' ? { name: c, version: '' } : { name: c.name, version: c.version || '' },
    ),
    python_packages: (image.python_packages || []).join('\n'),
    os_packages: (image.os_packages || []).join('\n'),
    // the registry : its name (a registry credential's) and the image's path in it (a credential and
    // a repository of before read as them)
    registry_credential: image.registry?.credential || image.registry?.name || '',
    registry_path: image.registry?.path || image.registry?.repository || '',
    // the registry's tag (a tag beside the registry, as before, read as it) : app, or its own
    tag_mode: tagOf(image) === 'app' ? 'app' : 'fixed',
    tag: tagOf(image) === 'app' ? '' : tagOf(image),
    sbom: image.sbom !== false,
    // signed with the credential named (a key: or name: of before read as it)
    sign: !!(image.sign?.credential || image.sign?.key || image.sign?.name),
    sign_credential: image.sign?.credential || image.sign?.key || image.sign?.name || '',
  };
}

/**
 * A draft as the definition the server saves : empty fields left out.
 *
 * Args:
 *   d (object): the draft.
 *
 * Returns:
 *   object: the definition.
 */
function imageOf(d) {
  const image = { name: d.name.trim() };
  if (d.description.trim()) image.description = d.description.trim();
  image.arch = d.arch || 'all';
  image.python = d.python;
  if (d.ansible_core.trim()) image.ansible_core = d.ansible_core.trim();
  const collections = d.collections
    .filter((c) => c.name.trim())
    .map((c) => (c.version.trim() ? { name: c.name.trim(), version: c.version.trim() } : { name: c.name.trim() }));
  if (collections.length) image.ansible_collections = collections;
  const packages = d.python_packages
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (packages.length) image.python_packages = packages;
  const os = d.os_packages
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (os.length) image.os_packages = os;
  // the registry : its credential first, the image's path in it, then its tag
  image.registry = {};
  if (d.registry_credential) image.registry.credential = d.registry_credential;
  if (d.registry_path.trim()) image.registry.path = d.registry_path.trim();
  image.registry.tag = d.tag_mode === 'app' ? 'app' : d.tag.trim() || 'app';
  image.sbom = !!d.sbom;
  if (d.sign && d.sign_credential) image.sign = { credential: d.sign_credential };
  return image;
}

const current = computed(() => (draft.value ? imageOf(draft.value) : null));

// ─── the base and its python, and ansible-core : two dropdowns that only offer what runs together ───

/**
 * The release of an ansible-core version (2.22.1 : 2.22).
 *
 * Args:
 *   version (string): the version or the release.
 *
 * Returns:
 *   string: the release ; '' for none.
 */
const releaseOf = (version) => String(version || '').match(/^(\d+\.\d+)/)?.[1] || '';

/**
 * Whether an ansible-core runs on a python : a release the table does not know (a newer one)
 * is let through, as the server does.
 *
 * Args:
 *   version (string): the ansible-core version or release ('' : rte-core's own).
 *   python (string): the python.
 *
 * Returns:
 *   boolean: true when they run together.
 */
function fits(version, python) {
  const pythons = versions.value.ansibleCore[releaseOf(version)];
  return !version || !pythons || pythons.includes(python);
}

// the python the image runs on now
const draftPython = computed(() => draft.value?.python || versions.value.defaultPython);

// the Python dropdown : every python ; it leads, ansible-core follows (baseChoice)
const baseChoices = computed(() => versions.value.pythons.map((p) => ({ value: p, label: `Python ${p}` })));

// the ansible-core dropdown : the releases that run on the python, newest first ; an exact version
// from the file kept as a choice of its own when it runs on it
const coreChoices = computed(() => {
  const releases = Object.keys(versions.value.ansibleCore).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  const choices = [];
  const own = draft.value?.ansible_core;
  if (own && !releases.includes(own) && fits(own, draftPython.value))
    choices.push({ value: own, label: `ansible-core ${own}` });
  for (const r of releases) if (fits(r, draftPython.value)) choices.push({ value: r, label: `ansible-core ${r}` });
  return choices;
});

// the ansible-core dropdown's choice : the release (or version) the image installs
const coreChoice = computed({
  get: () => draft.value?.ansible_core || '',
  set: (v) => (draft.value.ansible_core = v),
});

/**
 * The newest ansible-core release that runs on a python.
 *
 * Args:
 *   python (string): the python.
 *
 * Returns:
 *   string: the release ; '' when none does.
 */
function newestFor(python) {
  return (
    Object.keys(versions.value.ansibleCore)
      .filter((r) => versions.value.ansibleCore[r].includes(python))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || ''
  );
}

// the Python dropdown's choice ; a python its ansible-core does not run on takes the newest
// release that does
const baseChoice = computed({
  get: () => draftPython.value,
  set: (python) => {
    draft.value.python = python;
    if (!draft.value.ansible_core || !fits(draft.value.ansible_core, python))
      draft.value.ansible_core = newestFor(python);
  },
});
// the python and the OS packages : both as tall as the longer list, never taller (one line when empty)
const packageRows = computed(() =>
  Math.max(1, ...['python_packages', 'os_packages'].map((k) => String(draft.value?.[k] || '').split('\n').length)),
);
const dirty = computed(() => !!draft.value && JSON.stringify(current.value) !== original.value);
// the images built for the app's release (tag app) whose last good build was for another one
const stale = computed(() =>
  images.value
    .filter((i) => !i.error && tagOf(i.image) === 'app')
    .filter((i) => {
      const last = builds.value.find((b) => b.image === i.name && b.status === 'success');
      return last && last.appVersion && last.appVersion !== store.version;
    })
    .map((i) => i.name),
);

/**
 * Builds again the images of an older release, one after the other.
 */
async function rebuildStale() {
  busy.value = true;
  try {
    for (const name of stale.value) await axios.post(`${api}/${encodeURIComponent(name)}/build`);
    toast.success(t('designer.rte.rebuildStarted', { count: stale.value.length }, stale.value.length));
    await load();
  } catch (e) {
    toast.error(why(e));
  } finally {
    busy.value = false;
  }
}

const onlineBuilders = computed(() => builders.value.filter((b) => b.online).length);
// the images by repository, as the explorer shows them
// ─── the explorer (as the other sections' file explorers, AppProjectFiles) ───
// no repository used for RTE images : no explorer at all
const sectionEmpty = computed(() => !repositories.value.length);
// the folders folded, and the search
const collapsed = ref(new Set());
const searching = ref(false);
const filter = ref('');
const searchInput = ref(null);
// the explorer's rows, as the forms explorer's : the folders of the images' files, each file - the
// image itself when it holds one (a folder of the image's name, its rte.yaml in it), else its
// images under it -, each level its folders first then its files, by name ; the search keeps
// the images it finds, with their file and folders. No folder for the repository, as the forms
// explorer shows none either. Folders and files fold (collapsed : a folder by its path, a file by
// 'file:' and its path).
const rows = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const root = { folders: new Map(), files: new Map() };
  for (const img of byRepository.value.flatMap((g) => g.list)) {
    if (f && !img.name.toLowerCase().includes(f)) continue;
    const parts = String(img.file || '').split('/');
    const fileName = parts.pop();
    let node = root;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { path, folders: new Map(), files: new Map() });
      node = node.folders.get(part);
    }
    if (!node.files.has(fileName)) node.files.set(fileName, { path: img.file, images: [] });
    node.files.get(fileName).images.push(img);
  }
  const out = [];
  const walk = (node, depth) => {
    for (const [name, sub] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ type: 'folder', path: sub.path, name, depth });
      if (!collapsed.value.has(sub.path) || f) walk(sub, depth + 1);
    }
    for (const [name, file] of [...node.files].sort((a, b) => a[0].localeCompare(b[0]))) {
      // a file of one image (each new image's rte.yaml, in its folder) : the file is the image
      if (file.images.length === 1) {
        const img = file.images[0];
        out.push({ type: 'image', path: `${img.repository}/${img.name}`, name: img.name, label: name, depth, img });
        continue;
      }
      const key = `file:${file.path}`;
      out.push({ type: 'file', path: key, name, depth, title: file.path });
      if (collapsed.value.has(key) && !f) continue;
      for (const img of [...file.images].sort((a, b) => a.name.localeCompare(b.name)))
        out.push({
          type: 'image',
          path: `${img.repository}/${img.name}`,
          name: img.name,
          label: img.name,
          depth: depth + 1,
          img,
        });
    }
  };
  walk(root, 0);
  return out;
});
// the folders and the files, for Collapse all
const folders = computed(() => rows.value.filter((r) => r.type !== 'image').map((r) => r.path));
const allCollapsed = computed(() => folders.value.length > 0 && folders.value.every((p) => collapsed.value.has(p)));
/**
 * Folds or unfolds a folder.
 *
 * Args:
 *   path (string): the folder.
 */
function toggleFolder(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}
/** Folds every folder, or unfolds them all when they are all folded. */
function toggleAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(folders.value);
}
/** Shows or hides the search box (hidden : the search emptied). */
function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) filter.value = '';
  else setTimeout(() => searchInput.value?.focus(), 0);
}
const clearSearch = () => (filter.value = '');
// the explorer's width, dragged by the line between it and the editor
const treeWidthPct = ref(EXPLORER_WIDTH.start);
/**
 * Drags the line between the editor and the explorer.
 *
 * Args:
 *   e (MouseEvent): the press on the line.
 */
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

const byRepository = computed(() => {
  const groups = new Map();
  for (const img of images.value) groups.set(img.repository, [...(groups.get(img.repository) || []), img]);
  // the repositories by name, each one's images by name : the order firstExplorerFile reads
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repository, list]) => ({ repository, list: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
});

// ===========================================================================
// LOADING
// ===========================================================================

/** Reads the images, the repositories, the credentials and the builders. */
async function load() {
  busy.value = true;
  try {
    const [list, repos, creds, bld] = await Promise.all([
      axios.get(api),
      axios.get(`${api}/repositories`),
      axios.get('/api/v2/credential').catch(() => ({ data: { records: [] } })),
      axios.get(`${api}/builders`).catch(() => ({ data: { records: [] } })),
    ]);
    versions.value = (await axios.get(`${api}/versions`)).data;
    builds.value = (await axios.get(`${api}/builds`).catch(() => ({ data: { records: [] } }))).data.records || [];
    images.value = list.data.records || [];
    repositories.value = repos.data.records || [];
    const all = creds.data.records || creds.data || [];
    registries.value = all.filter((c) => c.credential_type === 'registry').map((c) => c.name);
    signingKeys.value = all.filter((c) => c.credential_type === 'signing_key').map((c) => c.name);
    builders.value = bld.data.records || [];
    if (!newRepository.value) newRepository.value = repositories.value[0] || '';
  } catch (e) {
    toast.error(t('designer.rte.loadFailed', { error: why(e) }));
  } finally {
    busy.value = false;
  }
}

// the one open waits for a build : saved, and changed since its last good build (the server says,
// lib/rteImages.js needsBuild)
const needsBuildNow = computed(
  () =>
    !!selected.value &&
    !isNew.value &&
    !dirty.value &&
    !!images.value.find((i) => i.name === selected.value)?.needsBuild,
);

// a build that ends changes what needs one : the list and the builds read again, once the job
// events of a build calm down (its output sends one per line)
let buildsTimer = null;
useLiveEvent('jobs', () => {
  clearTimeout(buildsTimer);
  buildsTimer = setTimeout(async () => {
    const [list, bld] = await Promise.all([
      axios.get(api).catch(() => null),
      axios.get(`${api}/builds`).catch(() => null),
    ]);
    if (list) images.value = list.data.records || [];
    if (bld) builds.value = bld.data.records || [];
  }, 3000);
});
onBeforeUnmount(() => clearTimeout(buildsTimer));

/**
 * Opens an image (asks first when the one open has changes).
 *
 * Args:
 *   name (string): its name.
 */
async function open(name) {
  if (
    dirty.value &&
    !(await askConfirm(t('designer.rte.discard'), { title: t('designer.rte.unsaved'), icon: 'triangle-exclamation' }))
  )
    return;
  const found = images.value.find((i) => i.name === name);
  if (!found) return;
  selected.value = name;
  isNew.value = false;
  draft.value = draftOf(found.image || {});
  original.value = JSON.stringify(imageOf(draft.value));
}

/** A new image : its fields empty, the default python and its newest ansible-core, built for the app's release. */
/** Starts a new image : its fields empty, its file rte.yaml of a folder of its name once saved. */
async function newImage() {
  if (
    dirty.value &&
    !(await askConfirm(t('designer.rte.discard'), { title: t('designer.rte.unsaved'), icon: 'triangle-exclamation' }))
  )
    return;
  if (!repositories.value.length) {
    toast.error(t('designer.rte.noRepository'));
    return;
  }
  // its name first, in a dialog : the name is its folder's (<name>/rte.yaml)
  newName.value = '';
  if (!repositories.value.includes(newRepository.value)) newRepository.value = repositories.value[0] || '';
  asking.value = true;
}

// ─── the New dialog : its name, and its repository when there are several ───
const asking = ref(false);
const newName = ref('');
// a name as the server takes it (lib/rteImages.js NAME), and one no runtime environment has
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const newNameError = computed(() => {
  const name = newName.value.trim();
  if (!name) return '';
  if (!NAME.test(name)) return t('designer.rte.nameInvalid');
  if (images.value.some((i) => i.name === name)) return t('designer.rte.nameTaken', { name });
  return '';
});

/** Create : the new runtime environment opened with its name, to fill in and save. */
function createImage() {
  const name = newName.value.trim();
  if (!name || newNameError.value) return;
  asking.value = false;
  selected.value = null;
  isNew.value = true;
  draft.value = draftOf({ name });
  draft.value.ansible_core = newestFor(draft.value.python);
  original.value = '';
}

// ===========================================================================
// THE YAML AND THE PREVIEW
// ===========================================================================

// the YAML tab shows the entry as the fields make it ; typed in, it sets the fields when it reads
watch(
  () => [props.view, current.value],
  () => {
    if (props.view !== 'yaml' && current.value) {
      yamlText.value = YAML.stringify(current.value);
      yamlError.value = '';
    }
  },
  { immediate: true, deep: true },
);
watch(
  () => props.view,
  (v) => {
    if (v === 'yaml' && current.value) yamlText.value = YAML.stringify(current.value);
    if (v === 'preview') refreshPreview();
  },
);
// another image opened (or a new one) : its YAML and its Dockerfile, whatever tab shows - the YAML
// tab open when the section opens on its first image showed nothing until the tabs were switched
watch(
  () => [selected.value, isNew.value],
  () => {
    if (!current.value) return;
    yamlText.value = YAML.stringify(current.value);
    yamlError.value = '';
    if (props.view === 'preview') refreshPreview();
  },
);
watch(yamlText, (text) => {
  if (props.view !== 'yaml' || !draft.value) return;
  try {
    const parsed = YAML.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('designer.rte.yamlMap'));
    draft.value = draftOf(parsed);
    yamlError.value = '';
  } catch (e) {
    yamlError.value = e.message;
  }
});

/** The Files tab's files : the Dockerfile first, then the files it copies, by name. */
const previewFiles = computed(() =>
  preview.value ? { Dockerfile: preview.value.dockerfile, ...(preview.value.files || {}) } : {},
);

// the files folded by their name (all open at first)
const foldedFiles = ref(new Set());

/**
 * Folds or unfolds a file of the Files tab.
 *
 * Args:
 *   name (string): the file's name.
 */
function toggleFile(name) {
  const next = new Set(foldedFiles.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  foldedFiles.value = next;
}

/**
 * The editor language a file is coloured in, by its name.
 *
 * Args:
 *   name (string): the file's name.
 *
 * Returns:
 *   string: an ace mode (dockerfile, ini, yaml or text).
 */
const langOf = (name) =>
  name === 'Dockerfile' ? 'dockerfile' : /\.(cfg|ini)$/.test(name) ? 'ini' : /\.ya?ml$/.test(name) ? 'yaml' : 'text';

/**
 * Makes a file's editor as tall as its text : it never scrolls up and down inside.
 *
 * Args:
 *   editor (object): the ace editor, once made.
 */
function fitContent(editor) {
  editor.setOptions({ minLines: 1, maxLines: Infinity, highlightActiveLine: false });
}

/** What the definition builds now : its Dockerfile and its files, or why it does not build. */
async function refreshPreview() {
  if (!current.value) return;
  try {
    const res = await axios.post(`${api}/preview`, { image: current.value });
    preview.value = res.data;
    previewError.value = '';
  } catch (e) {
    preview.value = null;
    previewError.value = why(e);
  }
}

// ===========================================================================
// THE ACTIONS
// ===========================================================================

/** Saves the image to its file (a new one to rte.yaml of its repository). */
async function save() {
  if (!dirty.value || busy.value) return;
  busy.value = true;
  try {
    const res = isNew.value
      ? await axios.post(api, {
          image: current.value,
          repository: newRepository.value,
        })
      : await axios.put(`${api}/${encodeURIComponent(selected.value)}`, { image: current.value });
    toast.success(t('designer.rte.saved', { name: res.data.name, file: `${res.data.repository}/${res.data.file}` }));
    unpushed.value = true;
    await load();
    selected.value = res.data.name;
    isNew.value = false;
    original.value = JSON.stringify(current.value);
  } catch (e) {
    toast.error(why(e));
  } finally {
    busy.value = false;
  }
}

/**
 * Removes an image from its file, once asked : the one open, or the one the explorer's X is on.
 *
 * Args:
 *   name (string): the image (the one open when not given).
 */
async function remove(name = selected.value) {
  if (!name || busy.value) return;
  if (!(await askConfirm(t('designer.rte.removeAsk', { name }), { title: t('designer.rte.remove'), icon: 'trash' })))
    return;
  busy.value = true;
  try {
    await axios.delete(`${api}/${encodeURIComponent(name)}`);
    toast.success(t('designer.rte.removed', { name }));
    unpushed.value = true;
    if (name === selected.value) {
      selected.value = null;
      draft.value = null;
      original.value = '';
    }
    await load();
  } catch (e) {
    toast.error(why(e));
  } finally {
    busy.value = false;
  }
}

/** Commits and pushes the images' repositories. */
async function push() {
  busy.value = true;
  try {
    const res = await axios.post(`${api}/push`);
    toast.success(t('designer.rte.pushed', { repository: res.data.repository }));
    unpushed.value = false;
  } catch (e) {
    toast.error(why(e));
  } finally {
    busy.value = false;
  }
}

/** Builds the image on a builder : the build's job opens on the Jobs page. */
async function build() {
  if (!selected.value || dirty.value || busy.value) return;
  busy.value = true;
  try {
    const res = await axios.post(`${api}/${encodeURIComponent(selected.value)}/build`);
    toast.success(t('designer.rte.buildStarted', { ref: res.data.ref, builder: res.data.builder }));
    router.push({ path: '/jobs', query: { id: res.data.jobId } });
  } catch (e) {
    toast.error(why(e));
  } finally {
    busy.value = false;
  }
}

/** The image as it was saved. */
function revert() {
  if (isNew.value) {
    draft.value = null;
    isNew.value = false;
    return;
  }
  const found = images.value.find((i) => i.name === selected.value);
  if (found) draft.value = draftOf(found.image || {});
}

/**
 * Asks before leaving an image with changes.
 *
 * Args:
 *   go (function): what to do once agreed.
 */
async function leave(go) {
  if (
    !dirty.value ||
    (await askConfirm(t('designer.rte.discard'), { title: t('designer.rte.unsaved'), icon: 'triangle-exclamation' }))
  )
    go();
}

// the toolbar's actions (config/designerActions.js), as the Designer shows them
const actions = computed(() => [
  { key: 'newFile', run: newImage, disabled: busy.value || props.readOnly, title: t('designer.rte.new') },
  { key: 'save', run: save, disabled: !dirty.value || busy.value || props.readOnly || !!yamlError.value },
  {
    key: 'push',
    run: push,
    disabled: dirty.value || busy.value || props.readOnly || !unpushed.value,
    color: unpushed.value && !dirty.value ? 'orange' : undefined,
  },
  {
    key: 'build',
    run: build,
    disabled: !selected.value || dirty.value || busy.value || !props.canBuild || !onlineBuilders.value,
    title: !onlineBuilders.value ? t('designer.rte.noBuilder') : undefined,
    // orange while its definition changed since its last good build (or it never built), as Save
    // and Push while something waits for them
    color: needsBuildNow.value ? 'orange' : undefined,
  },
  // the YAML tab : a part of the image set or added in a dialog, its text written again
  ...[
    'rteArch',
    'rtePython',
    'rteCore',
    'rteCollection',
    'rtePythonPackages',
    'rteOsPackages',
    'rteRegistry',
    'rteSigning',
  ].map((key) => ({
    key,
    run: () => openInsert(key),
    show: props.view === 'yaml',
    disabled: !draft.value || busy.value || props.readOnly,
  })),
  { key: 'reload', run: load, disabled: busy.value },
  { key: 'revert', run: revert, disabled: !dirty.value || busy.value },
]);

// ===========================================================================
// THE YAML TAB'S DIALOGS : A PART OF THE IMAGE SET OR ADDED, AS A FORM'S ICON OR ROLES
// ===========================================================================

// the dialog open (its action's key), and what it holds
const insert = ref(null);
const ins = ref({});

/**
 * Opens a YAML tab dialog, its fields as the image has them ; refused while the YAML does not read.
 *
 * Args:
 *   key (string): the action (rteArch, rtePython, rteCore, rteCollection, rtePythonPackages, rteOsPackages,
 *     rteRegistry, rteSigning).
 */
function openInsert(key) {
  if (yamlError.value) {
    toast.warning(t('designer.rte.fixYamlFirst', { error: yamlError.value }));
    return;
  }
  const d = draft.value;
  ins.value = {
    arch: d.arch,
    python: d.python,
    core: d.ansible_core || newestFor(d.python),
    name: '',
    version: '',
    packages: '',
    path: d.registry_path,
    credential: d.registry_credential,
    signing: d.sign_credential,
  };
  insert.value = key;
}

// the ansible-core releases that run on the dialog's python (the Python dialog keeps ansible-core
// when it runs on it, else takes the newest that does)
const insertCores = computed(() =>
  Object.keys(versions.value.ansibleCore)
    .filter((r) => fits(r, draftPython.value))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
);

/** Applies the dialog to the image (lib/rteImageEdit.js), and writes its YAML again. */
function applyInsert() {
  const why = applyRteInsert(draft.value, insert.value, ins.value, { fits, newestFor });
  if (why) {
    toast.warning(t(`designer.rte.${why}`));
    return;
  }
  yamlText.value = YAML.stringify(current.value);
  yamlError.value = '';
  insert.value = null;
}

const addCollection = () => draft.value.collections.push({ name: '', version: '' });
const removeCollection = (i) => draft.value.collections.splice(i, 1);

/**
 * Loads the images and opens the first the explorer lists, as every Designer section opens on
 * its first item (config/fileExplorer.js openFirstExplorerItem).
 */
async function loadAndOpen() {
  await load();
  await openFirstExplorerItem({
    isOpen: () => !!draft.value,
    paths: images.value.map((i) => `${i.repository}/${i.name}`),
    open: (path) => open(path.slice(path.indexOf('/') + 1)),
  });
}

onMounted(loadAndOpen);
defineExpose({ actions, dirty, leave, load });
</script>

<template>
  <!-- the images built for an older release of the app : rebuilt from here -->
  <div v-if="stale.length" class="alert alert-warning d-flex align-items-center gap-2">
    <FaIcon icon="triangle-exclamation" />
    <span class="flex-grow-1">{{
      t('designer.rte.staleImages', { count: stale.length, version: store.version }, stale.length)
    }}</span>
    <BsButton icon="hammer" :disabled="busy || !canBuild || !onlineBuilders" @click="rebuildStale">{{
      t('designer.rte.rebuildAll')
    }}</BsButton>
  </div>
  <!-- the editor and, on its right, the explorer, as the other sections' (AppProjectFiles) -->
  <div class="af-files" :style="{ gridTemplateColumns: sectionEmpty ? '1fr' : explorerColumns(treeWidthPct) }">
    <div class="af-files-editor">
      <AppDesignerEmpty
        v-if="!draft"
        icon="cubes"
        :title="images.length ? t('designer.rte.noneOpen') : t('designer.noFiles')"
        :text="
          repositories.length
            ? images.length
              ? t('designer.rte.pickOne')
              : t('designer.rte.noImages')
            : t('designer.rte.noRepository')
        "
      />
      <!-- Files : the Dockerfile a builder is handed and the files it copies -->
      <div v-else-if="view === 'preview'" class="af-rte-preview af-files-visual">
        <div v-if="previewError" class="alert alert-warning">{{ previewError }}</div>
        <template v-else-if="preview">
          <!-- each file coloured as its language, read-only and as tall as its text, the Dockerfile
               first ; its name folds it -->
          <div v-for="(text, name) in previewFiles" :key="name" class="af-rte-file-block">
            <button
              type="button"
              class="btn btn-link p-0 text-reset text-decoration-none fw-semibold text-start mb-1 af-rte-file-name"
              :aria-expanded="!foldedFiles.has(name)"
              @click="toggleFile(name)"
            >
              <FaIcon :icon="foldedFiles.has(name) ? 'caret-right' : 'caret-down'" fixedwidth class="me-1" />{{ name }}
            </button>
            <AceEditor
              v-if="!foldedFiles.has(name)"
              :modelValue="text"
              :lang="langOf(name)"
              readonly
              class="af-rte-file"
              style="width: 100%; font-size: 1rem"
              @init="fitContent"
            />
          </div>
        </template>
      </div>
      <!-- YAML : the entry, as the file holds it -->
      <div v-else-if="view === 'yaml'">
        <div v-if="yamlError" class="alert alert-warning py-2 mb-2">{{ yamlError }}</div>
        <BsInput
          type="editor"
          :isFloating="false"
          v-model="yamlText"
          :readonly="readOnly"
          lang="yaml"
          :theme="theme"
          :liveSync="true"
          :style="editorStyle"
        />
      </div>
      <!-- Visual : its fields -->
      <form v-else class="af-rte-form af-files-visual" @submit.prevent="save">
        <fieldset :disabled="readOnly">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-name">{{ t('designer.rte.name') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
                <input id="rte-name" v-model="draft.name" class="form-control" placeholder="rte-vmware" />
              </div>
              <div class="form-text">{{ t('designer.rte.nameHelp') }}</div>
            </div>
            <div class="col-12">
              <label class="form-label fw-bold" for="rte-desc">{{ t('designer.rte.description') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="info-circle" /></span>
                <input id="rte-desc" v-model="draft.description" class="form-control" />
              </div>
            </div>
            <!-- what it is built on : its python, then ansible-core (the operating system is always
                 rte-base's, so it is not asked) -->
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-base">Python</label>
              <!-- the python, which the image gets from scratch on rte-base (uv) -->
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="fab,python" /></span>
                <select id="rte-base" v-model="baseChoice" class="form-select">
                  <option v-for="c in baseChoices" :key="c.value" :value="c.value">
                    {{ c.label }}
                  </option>
                </select>
              </div>
              <div class="form-text">{{ t('designer.rte.pythonHelp') }}</div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-core">ansible-core</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="microchip" /></span>
                <select id="rte-core" v-model="coreChoice" class="form-select">
                  <option v-for="c in coreChoices" :key="c.value" :value="c.value">
                    {{ c.label }}
                  </option>
                </select>
              </div>
              <div class="form-text">
                {{ t('designer.rte.coreHelp', { python: draftPython }) }}
              </div>
            </div>
            <!-- its python and OS packages, the same height side by side -->
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-pip">{{ t('designer.rte.pythonPackages') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="cubes" /></span>
                <textarea
                  id="rte-pip"
                  v-model="draft.python_packages"
                  class="form-control font-monospace"
                  :rows="packageRows"
                  placeholder="pyvmomi==8.0.3.0.1"
                ></textarea>
              </div>
              <div class="form-text">{{ t('designer.rte.pythonPackagesHelp') }}</div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-os">{{ t('designer.rte.osPackages') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="boxes-stacked" /></span>
                <textarea
                  id="rte-os"
                  v-model="draft.os_packages"
                  class="form-control font-monospace"
                  :rows="packageRows"
                  placeholder="sshpass"
                ></textarea>
              </div>
              <div class="form-text">{{ t('designer.rte.osPackagesHelp') }}</div>
            </div>
            <!-- what it is built for : one architecture, or one image for both (a line of its own, the
                 packages filling the one before) -->
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-arch">{{ t('designer.rte.arch') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="server" /></span>
                <select id="rte-arch" v-model="draft.arch" class="form-select">
                  <option v-for="a in ARCH_CHOICES" :key="a" :value="a">{{ t(`designer.rte.arch_${a}`) }}</option>
                </select>
              </div>
              <div class="form-text">{{ t('designer.rte.archHelp') }}</div>
            </div>
            <!-- its collections -->
            <div class="col-12">
              <label class="form-label fw-bold d-block">{{ t('designer.rte.collections') }}</label>
              <!-- none yet : said, the button under it as every add button -->
              <div v-if="!draft.collections.length" class="text-body-secondary fst-italic mb-2">
                {{ t('designer.rte.noCollections') }}
              </div>
              <div v-for="(c, i) in draft.collections" :key="i" class="d-flex gap-2 mb-2">
                <div class="input-group">
                  <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="box-open" /></span>
                  <input v-model="c.name" class="form-control" placeholder="community.vmware" />
                </div>
                <div class="input-group af-rte-version">
                  <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="tag" /></span>
                  <input
                    v-model="c.version"
                    class="form-control af-rte-version"
                    :placeholder="t('designer.rte.latestVersion')"
                  />
                </div>
                <BsButton icon="trash" :title="t('designer.rte.removeCollection')" @click="removeCollection(i)" />
              </div>
              <BsButton icon="plus" @click="addCollection">{{ t('designer.rte.addCollection') }}</BsButton>
              <div class="form-text">{{ t('designer.rte.collectionsHelp') }}</div>
            </div>
            <!-- where it is pushed -->
            <!-- the registry it is pushed to, then the image's path in it -->
            <div class="col-md-6">
              <label class="form-label fw-bold" for="rte-reg">{{ t('designer.rte.registry') }}</label>
              <AppCredentialSelect
                id="rte-reg"
                v-model="draft.registry_credential"
                :options="registries"
                type="registry"
                :emptyText="t('designer.rte.noRegistries')"
                icon="warehouse"
                :newLabel="t('designer.rte.newRegistry')"
                :disabled="readOnly"
                @created="load"
              />
            </div>
            <!-- its path : only in a registry, so only once one is chosen -->
            <div v-if="draft.registry_credential" class="col-md-6">
              <label class="form-label fw-bold" for="rte-path">{{ t('designer.rte.registryPath') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="route" /></span>
                <input
                  id="rte-path"
                  v-model="draft.registry_path"
                  class="form-control"
                  :placeholder="'af/' + (draft.name || 'rte-vmware')"
                />
              </div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('designer.rte.tag') }}</label>
              <div class="form-check">
                <input id="rte-tag-app" v-model="draft.tag_mode" class="form-check-input" type="radio" value="app" />
                <label class="form-check-label" for="rte-tag-app"
                  >{{ t('designer.rte.tagApp') }}
                  <span class="text-body-secondary small">{{ t('designer.rte.tagAppHint') }}</span></label
                >
              </div>
              <div class="form-check d-flex align-items-center gap-2">
                <input
                  id="rte-tag-fixed"
                  v-model="draft.tag_mode"
                  class="form-check-input"
                  type="radio"
                  value="fixed"
                />
                <label class="form-check-label" for="rte-tag-fixed">{{ t('designer.rte.tagFixed') }}</label>
                <input
                  v-if="draft.tag_mode === 'fixed'"
                  v-model="draft.tag"
                  class="form-control form-control-sm af-rte-version"
                  placeholder="stable"
                />
              </div>
            </div>
            <div class="col-md-6">
              <!-- what the build adds : its SBOM, its signature -->
              <div class="form-label fw-bold">{{ t('designer.rte.options') }}</div>
              <div class="form-check">
                <input id="rte-sbom" v-model="draft.sbom" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="rte-sbom"
                  >SBOM <span class="text-body-secondary small">{{ t('designer.rte.sbomHint') }}</span></label
                >
              </div>
              <div class="form-check">
                <input id="rte-sign" v-model="draft.sign" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="rte-sign"
                  >{{ t('designer.rte.sign') }}
                  <span class="text-body-secondary small">{{ t('designer.rte.signHint') }}</span></label
                >
              </div>
              <template v-if="draft.sign">
                <AppCredentialSelect
                  class="mt-2"
                  v-model="draft.sign_credential"
                  :options="signingKeys"
                  type="signing_key"
                  icon="signature"
                  :newLabel="t('designer.rte.newSigningKey')"
                  :noneLabel="t('designer.rte.none')"
                  :disabled="readOnly"
                  @created="load"
                />
              </template>
            </div>
          </div>
        </fieldset>
      </form>
    </div>
    <!-- the line between the editor and the explorer : dragged, it sets the explorer's width -->
    <div v-if="!sectionEmpty" class="af-files-resize" @mousedown="!explorerFolded && startResize($event)"></div>
    <!-- folded away : only its < remains, to bring it back -->
    <div v-if="!sectionEmpty && explorerFolded" class="af-explorer-folded">
      <span role="button" class="tree-add-btn" :title="t('designer.files.showExplorer')" @click="explorerFolded = false"
        ><FaIcon icon="chevron-left"
      /></span>
    </div>
    <!-- the images, in the folders of their files -->
    <AppExplorerColumn v-else-if="!sectionEmpty" class="af-files-tree">
      <div class="file-tree-panel">
        <div class="file-tree-header d-flex justify-content-between align-items-center">
          <span class="d-flex align-items-center min-w-0">
            <span
              role="button"
              class="tree-add-btn me-2"
              :title="t('designer.files.hideExplorer')"
              @click="explorerFolded = true"
              ><FaIcon icon="chevron-right"
            /></span>
            <span class="text-truncate">{{ t('designer.fileExplorer') }}</span>
          </span>
          <span class="d-flex gap-2">
            <span
              v-if="folders.length"
              role="button"
              class="tree-add-btn"
              @click="toggleAll()"
              :title="allCollapsed ? t('designer.expandAll') : t('designer.collapseAll')"
              ><FaIcon :icon="allCollapsed ? 'angles-down' : 'angles-up'"
            /></span>
            <span role="button" class="tree-add-btn" @click="toggleSearch()" :title="t('designer.search')"
              ><FaIcon icon="magnifying-glass"
            /></span>
            <span v-if="!readOnly" role="button" class="tree-add-btn" @click="newImage()" :title="t('designer.rte.new')"
              ><FaIcon icon="cube"
            /></span>
          </span>
        </div>
        <div v-if="searching" class="tree-search-bar">
          <div class="tree-search-box">
            <input
              ref="searchInput"
              v-model="filter"
              type="text"
              class="form-control form-control-sm"
              :placeholder="t('common.search')"
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
          <template v-for="item in rows" :key="item.type + item.path">
            <!-- a folder -->
            <div
              v-if="item.type === 'folder'"
              class="d-flex justify-content-between align-items-center py-1 tree-node"
              role="button"
              :style="{ paddingLeft: item.depth * 1.25 + 0.25 + 'rem' }"
              @click="toggleFolder(item.path)"
            >
              <span class="d-flex align-items-center min-w-0">
                <FaIcon
                  :icon="collapsed.has(item.path) && !filter ? 'chevron-right' : 'chevron-down'"
                  class="me-1 flex-shrink-0 tree-chevron"
                  size="xs"
                />
                <FaIcon
                  :icon="collapsed.has(item.path) && !filter ? 'folder' : 'folder-open'"
                  class="tree-folder-icon me-2 flex-shrink-0"
                />
                <span class="text-truncate" :title="item.path">{{ item.name }}</span>
              </span>
            </div>
            <!-- a file : its images under it -->
            <div
              v-else-if="item.type === 'file'"
              class="d-flex justify-content-between align-items-center py-1 tree-node"
              role="button"
              :style="{ paddingLeft: item.depth * 1.25 + 0.25 + 'rem' }"
              @click="toggleFolder(item.path)"
            >
              <span class="d-flex align-items-center min-w-0">
                <FaIcon
                  :icon="collapsed.has(item.path) && !filter ? 'chevron-right' : 'chevron-down'"
                  class="me-1 flex-shrink-0 tree-chevron"
                  size="xs"
                />
                <FaIcon icon="file-code" class="text-secondary me-2 flex-shrink-0" />
                <span class="fw-semibold text-truncate" :title="item.title">{{ item.name }}</span>
              </span>
            </div>
            <!-- an image : its file in the tooltip, or why it is not valid -->
            <div
              v-else
              class="d-flex justify-content-between align-items-center py-1 tree-node tree-file"
              :class="{
                'tree-active': item.name === selected && !isNew,
                'tree-dirty': item.name === selected && dirty,
              }"
              role="button"
              :style="{ paddingLeft: item.depth * 1.25 + 1 + 'rem' }"
              @click="open(item.name)"
            >
              <span class="d-flex align-items-center min-w-0">
                <!-- the file it is (its rte.yaml), or one image among others of its file -->
                <FaIcon
                  :icon="item.img.error ? 'triangle-exclamation' : item.label !== item.name ? 'file-code' : 'cube'"
                  :class="item.img.error ? 'text-warning' : 'text-secondary'"
                  class="me-2 flex-shrink-0"
                />
                <span class="text-truncate" :title="item.img.error || item.img.file">{{ item.label }}</span>
              </span>
              <span v-if="!readOnly" class="d-flex gap-2 flex-shrink-0 ms-2">
                <span
                  role="button"
                  class="tree-del-btn"
                  @click.stop="remove(item.name)"
                  :title="t('designer.rte.remove')"
                  ><FaIcon icon="times"
                /></span>
              </span>
            </div>
          </template>
          <div v-if="!rows.length" class="small text-body-secondary py-2">
            {{ filter ? t('common.noFilterMatch') : t('designer.rte.noImages') }}
          </div>
        </div>
      </div>
    </AppExplorerColumn>
    <!-- New : its name first (its folder's), and its repository when there are several -->
    <BsModal v-if="asking" size="md" icon="plus" @close="asking = false">
      <template #title>{{ t('designer.rte.new') }}</template>
      <template #default>
        <label class="form-label fw-bold" for="rte-new-name">{{ t('designer.rte.name') }}</label>
        <div class="input-group">
          <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
          <input
            id="rte-new-name"
            v-model="newName"
            class="form-control"
            :class="{ 'is-invalid': newNameError }"
            placeholder="rte-vmware"
            autofocus
            @keydown.enter.prevent="createImage()"
          />
        </div>
        <div v-if="newNameError" class="invalid-feedback d-block">{{ newNameError }}</div>
        <div v-else class="form-text">{{ t('designer.rte.nameHelp') }}</div>
        <template v-if="repositories.length > 1">
          <label class="form-label fw-bold mt-3" for="rte-new-repo">{{ t('designer.rte.repository') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="code-branch" /></span>
            <select id="rte-new-repo" v-model="newRepository" class="form-select">
              <option v-for="r in repositories" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>
        </template>
      </template>
      <template #footer>
        <BsButton icon="check" :disabled="!newName.trim() || !!newNameError" @click="createImage()">{{
          t('common.create')
        }}</BsButton>
      </template>
    </BsModal>
    <!-- the YAML tab's dialogs : a part of the image set or added -->
    <BsModal v-if="insert" size="md" :icon="DESIGNER_ACTIONS[insert].icon" @close="insert = null">
      <template #title>{{ t(DESIGNER_ACTIONS[insert].title) }}</template>
      <template #default>
        <template v-if="insert === 'rteArch'">
          <label class="form-label fw-bold" for="ins-arch">{{ t('designer.rte.arch') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="server" /></span>
            <select id="ins-arch" v-model="ins.arch" class="form-select">
              <option v-for="a in ARCH_CHOICES" :key="a" :value="a">{{ t(`designer.rte.arch_${a}`) }}</option>
            </select>
          </div>
          <div class="form-text">{{ t('designer.rte.archHelp') }}</div>
        </template>
        <template v-else-if="insert === 'rtePython'">
          <label class="form-label fw-bold" for="ins-python">Python</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="fab,python" /></span>
            <select id="ins-python" v-model="ins.python" class="form-select">
              <option v-for="c in baseChoices" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </div>
          <div class="form-text">{{ t('designer.rte.pythonHelp') }}</div>
        </template>
        <template v-else-if="insert === 'rteCore'">
          <label class="form-label fw-bold" for="ins-core">ansible-core</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="microchip" /></span>
            <select id="ins-core" v-model="ins.core" class="form-select">
              <option v-for="r in insertCores" :key="r" :value="r">ansible-core {{ r }}</option>
            </select>
          </div>
          <div class="form-text">{{ t('designer.rte.coreHelp', { python: draftPython }) }}</div>
        </template>
        <template v-else-if="insert === 'rteCollection'">
          <label class="form-label fw-bold" for="ins-col">{{ t('designer.rte.collections') }}</label>
          <div class="d-flex gap-2">
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="box-open" /></span>
              <input id="ins-col" v-model="ins.name" class="form-control" placeholder="community.vmware" />
            </div>
            <div class="input-group af-rte-version">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="tag" /></span>
              <input
                v-model="ins.version"
                class="form-control af-rte-version"
                :placeholder="t('designer.rte.latestVersion')"
              />
            </div>
          </div>
        </template>
        <template v-else-if="insert === 'rtePythonPackages' || insert === 'rteOsPackages'">
          <label class="form-label fw-bold" for="ins-pkg">{{
            t(insert === 'rtePythonPackages' ? 'designer.rte.pythonPackages' : 'designer.rte.osPackages')
          }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="cubes" /></span>
            <textarea
              id="ins-pkg"
              v-model="ins.packages"
              class="form-control font-monospace"
              rows="4"
              :placeholder="insert === 'rtePythonPackages' ? 'pyvmomi==8.0.3.0.1' : 'sshpass'"
            ></textarea>
          </div>
          <div class="form-text">
            {{ t(insert === 'rtePythonPackages' ? 'designer.rte.pythonPackagesHelp' : 'designer.rte.osPackagesHelp') }}
          </div>
        </template>
        <!-- the registry : its name (the credential that holds its address and login), then the
             image's path in it -->
        <template v-else-if="insert === 'rteRegistry'">
          <label class="form-label fw-bold" for="ins-reg">{{ t('designer.rte.registry') }}</label>
          <AppCredentialSelect
            id="ins-reg"
            v-model="ins.credential"
            class="mb-3"
            :options="registries"
            type="registry"
            :emptyText="t('designer.rte.noRegistries')"
            icon="warehouse"
            :newLabel="t('designer.rte.newRegistry')"
            @created="load"
          />
          <!-- its path : only in a registry, so only once one is chosen -->
          <template v-if="ins.credential">
            <label class="form-label fw-bold" for="ins-path">{{ t('designer.rte.registryPath') }}</label>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="route" /></span>
              <input
                id="ins-path"
                v-model="ins.path"
                class="form-control"
                :placeholder="'af/' + (draft.name || 'rte-vmware')"
              />
            </div>
          </template>
        </template>
        <template v-else-if="insert === 'rteSigning'">
          <label class="form-label fw-bold" for="ins-sign">{{ t('designer.rte.sign') }}</label>
          <AppCredentialSelect
            id="ins-sign"
            v-model="ins.signing"
            :options="signingKeys"
            type="signing_key"
            icon="signature"
            :newLabel="t('designer.rte.newSigningKey')"
            :noneLabel="t('designer.rte.none')"
            @created="load"
          />
          <div class="form-text">{{ t('designer.rte.signingHelp') }}</div>
        </template>
      </template>
      <template #footer>
        <BsButton icon="check" @click="applyInsert()">{{ t('common.apply') }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>

<style lang="scss" scoped>
/* the editor and, on its right, the explorer : as the other sections' (AppProjectFiles) */
.af-files {
  display: grid;
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
}
.af-files-editor {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* the Visual and Dockerfile tabs : the height the card leaves, scrolling inside ; room for a
   field's focus ring */
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
/* a collection's version, a fixed tag : a short field beside another */
.af-rte-version {
  max-width: 10rem;
}
/* the Files tab : its first file's name right at the top, as the YAML tab's editor */
.af-rte-preview {
  margin-top: 0;
  padding-top: 0;
}
/* the Dockerfile and the files it copies : each as tall as its text, one under the other. The
   designer makes every block holding an editor a flex item that fills the page (designer.vue,
   div:has(.ace_editor)), which would squeeze them into the card's height : not these. */
.af-rte-file-block {
  display: block !important;
  flex: none !important;
  margin-bottom: 1rem !important;
}
.af-rte-file-block > div {
  display: block !important;
  flex: none !important;
}
</style>
