<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Appearance > Links : the links of the header, in   */
/*  tabs (the tab kept in the address) :                          */
/*    Built-in : the Designer's, shown or not (SHOW_DESIGNER, an  */
/*      environment variable applied without a restart).          */
/*      Switched off, the designer is gone for everyone : its     */
/*      link, its page, its api.                                  */
/*    Custom : the instance's own links (a wiki, a runbook, a     */
/*      support portal) - a label, an address, an icon, a new tab */
/*      or not. An outline, as the designer's categories : → puts */
/*      a link inside the header link above it (then a menu in    */
/*      the header, one level), ← takes it back out, ↑ ↓ move it  */
/*      (a menu with what is inside it). Kept in the settings     */
/*      row ; the server keeps only http(s) sites and pages of    */
/*      the app.                                                  */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import State from '@/lib/State';
import { isIconName, LINK_ICONS } from '@/lib/iconName';
import { useEnvVars } from '@/composables/useEnvVars';
import { useSettingsRow } from '@/composables/useSettingsRow';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useSeedManaged } from '@/composables/useSeedManaged';
import BsSwitch from '@/components/BsSwitch.vue';

const { t } = useI18n();
const authenticated = ref(false);
// the page's values read once : until then its fields as grey placeholders
const loaded = ref(false);

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'builtin', label: t('settings.interface.tabBuiltin'), icon: 'cube' },
  { key: 'custom', label: t('settings.interface.tabCustom'), icon: 'pen-to-square' },
]);
const { activeTab, tabLink } = useRouteTab('builtin', (key) => tabs.value.some((x) => x.key === key));
// the title names the tab : Links › Custom, each step a link
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  const base = [{ title: t('sidebar.links'), icon: 'link', to: tabLink('builtin') }];
  return tab ? [...base, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : base;
});

// as many as the header has room for, as the server keeps them (models/settings.model.js)
const MAX_LINKS = 5;
const MAX_INSIDE = 10;
// the title's popover : what the page is for, and on Custom how a link is written
const description = computed(() =>
  activeTab.value === 'custom'
    ? `${t('settings.interface.linksDescription')} ${t('settings.interface.linksHelp', { max: MAX_LINKS })}`
    : t('settings.interface.linksDescription'),
);

// ─── Built-in : the Designer's link, an environment variable ─────────────────
const { envItems, envEdits, envDirty, envRestartPending, loadEnvironmentVariables, saveEnvironmentVariables } =
  useEnvVars(['SHOW_DESIGNER']);
// said as the header shows it : the designer's link, there or not
const builtin = computed(() =>
  envItems.value.map((e) => ({
    ...e,
    short: t('settings.interface.designer'),
    hint: t('settings.interface.designerHelp'),
  })),
);

// ─── search ──────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows both tabs at once, as Settings > General's :
// the Designer's switch when it matches (its name, its help), the own links whose label or
// address match (and a link holding one that does, so a link inside keeps its place), each
// under its tab's name, the tabs set aside meanwhile.
const { search, searching, matches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => (key === 'builtin' ? shownBuiltin.value.length : own.value.header_links.some(linkShown)),
});
const shownBuiltin = computed(() => builtin.value.filter((e) => matches(e.short, e.name, e.hint)));
/**
 * Whether an own link shows while searching : its label or its address matches, or one of the
 * links inside it does.
 *
 * Args:
 *   l (object): the link.
 *
 * Returns:
 *   boolean: true when it shows (always when nothing is searched).
 */
function linkShown(l) {
  if (matches(l.label, l.url)) return true;
  return !l.parent && own.value.header_links.some((c) => c.parent === l.id && matches(c.label, c.url));
}

// ─── Custom : the instance's own links, in the settings row ──────────────────

/**
 * The own links of a settings row, as the page edits them.
 *
 * Args:
 *   row (object): the settings row.
 *
 * Returns:
 *   object: { header_links : [{ id, label, url, icon, newTab, parent }] }.
 */
function linksOf(row) {
  let list;
  try {
    list = JSON.parse(row?.header_links || '[]');
  } catch {
    list = [];
  }
  return {
    header_links: (Array.isArray(list) ? list : []).map((l) => ({
      label: l.label || '',
      url: l.url || '',
      icon: l.icon || 'link',
      newTab: !!l.newTab,
      id: l.id || newId(),
      // the link it is inside ; none : in the header itself
      parent: l.parent || '',
    })),
  };
}
// sent as the server keeps it : in the header itself is no parent
const {
  edit: own,
  dirty: ownDirty,
  load: loadOwn,
  save: saveOwn,
} = useSettingsRow(linksOf, (fields) => ({
  header_links: fields.header_links.map((l) => ({ ...l, parent: l.parent || null })),
}));

/**
 * A new link's id : what a link inside it names.
 *
 * Returns:
 *   string: 8 letters and digits.
 */
function newId() {
  // from the browser's cryptographic generator : saved in the links file, so unique, never guessed
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/**
 * Whether links sit inside a link : it is a menu in the header, so it stays there.
 *
 * Args:
 *   link (object): the link.
 *
 * Returns:
 *   boolean: true when it holds others.
 */
function holdsLinks(link) {
  return own.value.header_links.some((l) => l.parent === link.id);
}

/**
 * Whether an address may be a header link : an http or https site, or a page of the app (one
 * leading slash, not two ; no backslash or space). The server checks it again.
 *
 * Args:
 *   url (string): the address.
 *
 * Returns:
 *   boolean: true when it may.
 */
function isLinkUrl(url) {
  const u = String(url || '').trim();
  if (!u || u.length > 500 || /[\s\\]/.test(u)) return false;
  if (/^\/(?!\/)/.test(u)) return true;
  try {
    const parsed = new URL(u);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

// a link that would not be kept : no label, or an address the header may not open
// a link that would not be kept : no label, or an address the header may not open (a menu may
// have none : its links open something)
const invalid = computed(() =>
  own.value.header_links.map((l) => ({
    label: !l.label.trim(),
    url: holdsLinks(l) && !l.parent ? !!l.url.trim() && !isLinkUrl(l.url) : !isLinkUrl(l.url),
  })),
);
// more in the header itself, or inside one, than the header has room for
const tooMany = computed(() => {
  const tops = own.value.header_links.filter((l) => !l.parent);
  return (
    tops.length > MAX_LINKS ||
    tops.some((top) => own.value.header_links.filter((l) => l.parent === top.id).length > MAX_INSIDE)
  );
});
const anyInvalid = computed(() => tooMany.value || invalid.value.some((x) => x.label || x.url));

/**
 * Adds an empty link at the end.
 */
function addLink() {
  own.value.header_links.push({ id: newId(), label: '', url: 'https://', icon: 'link', newTab: true, parent: '' });
}

// ─── the outline : a menu's links follow it ─────────────────────────────────
// The list keeps a menu's links right after it (the server sends them so) : what a link is
// inside is where it sits.

/**
 * The rows a link moves with : itself, and the links inside it.
 *
 * Args:
 *   index (number): the link.
 *
 * Returns:
 *   number: how many rows, from index.
 */
function blockSize(index) {
  const list = own.value.header_links;
  const id = list[index].id;
  let end = index + 1;
  while (end < list.length && list[end].parent === id) end++;
  return end - index;
}

/**
 * Whether a link may move one place up or down : a link in the header past the next one (and
 * its links) ; a link inside one within its menu only.
 *
 * Args:
 *   index (number): the link.
 *   step (number): -1 up, 1 down.
 *
 * Returns:
 *   boolean: true when it may.
 */
function canMove(index, step) {
  const list = own.value.header_links;
  const link = list[index];
  if (link.parent) {
    const next = list[index + step];
    return !!next && next.parent === link.parent;
  }
  if (step < 0) return index > 0;
  return index + blockSize(index) < list.length;
}

/**
 * Moves a link one place up or down : the header shows them in this order. A link in the header
 * moves with the links inside it, past the whole of the next one ; a link inside one, within
 * its menu.
 *
 * Args:
 *   index (number): the link.
 *   step (number): -1 up, 1 down.
 */
function moveLink(index, step) {
  if (!canMove(index, step)) return;
  const list = own.value.header_links;
  if (list[index].parent) {
    const to = index + step;
    [list[index], list[to]] = [list[to], list[index]];
    return;
  }
  const block = list.splice(index, blockSize(index));
  if (step < 0) {
    // before the link in the header above (its own first row)
    let to = index - 1;
    while (to > 0 && list[to].parent) to--;
    list.splice(to, 0, ...block);
  } else {
    // after the next link in the header and the links inside it
    const after = index + blockSize(index);
    list.splice(after, 0, ...block);
  }
}

/**
 * Whether → may put a link inside the header link above it : a link in the header, not the
 * first, that holds no links itself (one level).
 *
 * Args:
 *   index (number): the link.
 *
 * Returns:
 *   boolean: true when it may.
 */
function canIndent(index) {
  const link = own.value.header_links[index];
  return index > 0 && !link.parent && !holdsLinks(link);
}

/**
 * Puts a link inside the header link above it : the last of that link's menu.
 *
 * Args:
 *   index (number): the link.
 */
function indentLink(index) {
  if (!canIndent(index)) return;
  const list = own.value.header_links;
  let top = index - 1;
  while (top > 0 && list[top].parent) top--;
  list[index].parent = list[top].id;
}

/**
 * Takes a link out of its menu, to the header : right after that menu, so the links below it
 * stay inside.
 *
 * Args:
 *   index (number): the link.
 */
function outdentLink(index) {
  const list = own.value.header_links;
  const link = list[index];
  if (!link.parent) return;
  const parent = link.parent;
  let end = index + 1;
  while (end < list.length && list[end].parent === parent) end++;
  const [moved] = list.splice(index, 1);
  moved.parent = '';
  list.splice(end - 1, 0, moved);
}

/**
 * Removes a link.
 *
 * Args:
 *   index (number): the link.
 */
function removeLink(index) {
  const [gone] = own.value.header_links.splice(index, 1);
  // the links that were inside it go to the header itself
  for (const l of own.value.header_links) if (l.parent === gone.id) l.parent = '';
}

// ─── saving ───────────────────────────────────────────────────────────────────
const dirty = computed(() => envDirty.value || ownDirty.value);
useUnsavedGuard(dirty, () => save());

/**
 * Saves what changed : the switches, then the own links ; the header follows at once.
 */
async function save() {
  if (anyInvalid.value) return;
  if (envDirty.value) await saveEnvironmentVariables();
  if (ownDirty.value) await saveOwn(t('settings.common.nameUpdated', { name: t('sidebar.links') }));
  await Promise.all([State.loadAppConfig(), State.loadHeaderLinks()]);
}

// the fields the config seed manages : read only here
const { seeded, loadSeedManaged } = useSeedManaged();

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (authenticated.value) await Promise.all([loadEnvironmentVariables(), loadOwn(), loadSeedManaged()]);
  loaded.value = true;
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="link"
      :title="t('sidebar.links')"
      :crumbs="crumbs"
      :description="description"
    >
      <!-- narrows both tabs at once ; the search box of the other pages -->
      <template #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="!searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in tabs" :key="tab.key" class="nav-item">
            <a
              class="nav-link"
              :class="{ active: activeTab === tab.key }"
              href="#"
              @click.prevent="activeTab = tab.key"
            >
              <FaIcon :icon="tab.icon" class="me-1" />
              {{ tab.label }}
            </a>
          </li>
        </ul>
      </template>
      <template #actions>
        <BsButton
          v-if="activeTab === 'custom' && !searching"
          icon="plus"
          :disabled="seeded('header_links') || own.header_links.length >= MAX_LINKS * (1 + MAX_INSIDE)"
          @click="addLink()"
          >{{ t('settings.interface.addLink') }}</BsButton
        >
        <BsButton icon="save" :disabled="!dirty || anyInvalid" @click="save()">{{
          t('settings.common.save')
        }}</BsButton>
      </template>
      <template #default>
        <!-- the first load : the fields as grey placeholders, in their place -->
        <AppSkeleton v-if="!loaded" shape="form" :count="4" />
        <template v-else>
          <!-- kept under links: in a repository's file : which one, and the file -->
          <AppRepositorySource v-show="!searching" type="links" />
          <AppSeedNotice v-if="seeded('header_links', 'show_designer')" />
          <div v-if="envRestartPending.length" class="alert alert-warning py-2">
            <FaIcon icon="triangle-exclamation" class="me-2" />
            {{ t('settings.settingsPage.envRestartPending', { names: envRestartPending.join(', ') }) }}
          </div>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
          <!-- Built-in : the Designer's link -->
          <div v-show="tabShown('builtin')">
            <h6
              v-if="searching && searchHead('builtin')"
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('builtin').first }"
            >
              <FaIcon :icon="searchHead('builtin').tab.icon" class="me-1" />{{ searchHead('builtin').tab.label }}
            </h6>
            <fieldset :disabled="seeded('show_designer')">
              <AppEnvField v-for="e in shownBuiltin" :key="e.name" v-model="envEdits[e.name]" :e="e" :asSwitch="true" />
            </fieldset>
          </div>
          <!-- Custom : the instance's own links, in the header's order -->
          <fieldset v-show="tabShown('custom')" :disabled="seeded('header_links')">
            <template v-if="searching && searchHead('custom')">
              <hr v-if="!searchHead('custom').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('custom').first }"
              >
                <FaIcon :icon="searchHead('custom').tab.icon" class="me-1" />{{ searchHead('custom').tab.label }}
              </h6>
            </template>
            <div v-if="!own.header_links.length && !searching" class="empty-state">
              <FaIcon icon="link" class="empty-state-icon" />
              <span>{{ t('settings.interface.noLinks') }}</span>
            </div>
            <div v-if="tooMany" class="alert alert-warning py-2">
              <FaIcon icon="triangle-exclamation" class="me-2" />
              {{ t('settings.interface.linksTooMany', { max: MAX_LINKS, inside: MAX_INSIDE }) }}
            </div>
            <div v-if="own.header_links.length" class="af-links">
              <div class="af-links-row af-links-head">
                <span>{{ t('settings.interface.linkIcon') }}</span>
                <span>{{ t('settings.interface.linkLabel') }}</span>
                <span>{{ t('settings.interface.linkUrl') }}</span>
                <span class="text-center">{{ t('settings.interface.linkNewTab') }}</span>
                <span></span>
              </div>
              <div
                v-for="(l, i) in own.header_links"
                v-show="!searching || linkShown(l)"
                :key="l.id"
                class="af-links-row"
                :class="{ 'af-link-nested': l.parent }"
              >
                <!-- every field as the settings pages' (BsInput) : the grey box with its icon, then the
                     field. The icon : picked from a few that suit a link, shown in its grey box (as a
                     category's icon in the designer) -->
                <!-- a link inside another : indented, with the designer categories' nested icon -->
                <div class="d-flex align-items-center" :style="{ paddingLeft: l.parent ? '1.5rem' : 0 }">
                  <FaIcon
                    v-if="l.parent"
                    icon="level-up-alt"
                    class="text-muted me-2 fa-rotate-90"
                    style="font-size: 0.75rem"
                  />
                  <div class="input-group flex-grow-1">
                    <span class="input-group-text"
                      ><FaIcon :fixedwidth="true" :icon="isIconName(l.icon) ? l.icon : 'link'"
                    /></span>
                    <select v-model="l.icon" class="form-select" :aria-label="t('settings.interface.linkIcon')">
                      <!-- an icon not in the list (saved through the api) : offered, so it stays visible -->
                      <option v-if="l.icon && !LINK_ICONS.includes(l.icon)" :value="l.icon">{{ l.icon }}</option>
                      <option v-for="name in LINK_ICONS" :key="name" :value="name">{{ name }}</option>
                    </select>
                  </div>
                </div>
                <div class="input-group">
                  <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
                  <input
                    v-model="l.label"
                    class="form-control"
                    :class="{ 'is-invalid': invalid[i]?.label }"
                    maxlength="30"
                    :aria-label="t('settings.interface.linkLabel')"
                  />
                </div>
                <div class="input-group">
                  <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="globe" /></span>
                  <input
                    v-model.trim="l.url"
                    class="form-control"
                    :class="{ 'is-invalid': invalid[i]?.url }"
                    :placeholder="holdsLinks(l) ? t('settings.interface.linkUrlOptional') : ''"
                    :aria-label="t('settings.interface.linkUrl')"
                    spellcheck="false"
                  />
                </div>
                <BsSwitch
                  v-model="l.newTab"
                  :aria-label="t('settings.interface.linkNewTab')"
                  class="d-flex justify-content-center mb-0"
                />
                <div class="d-flex gap-2 justify-content-end">
                  <!-- the moves : one group of outlined buttons, as tall as the fields ; blue as the page's
                       buttons when they may be pressed, grey when not -->
                  <div class="btn-group" role="group" :aria-label="t('settings.interface.linkMoves')">
                    <!-- ← out of its menu, → inside the header link above -->
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="!l.parent ? 'btn-outline-secondary' : 'btn-outline-primary'"
                      :disabled="!l.parent"
                      :title="t('settings.interface.linkOutdent')"
                      @click="outdentLink(i)"
                    >
                      <FaIcon icon="arrow-left" />
                    </button>
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="!canIndent(i) ? 'btn-outline-secondary' : 'btn-outline-primary'"
                      :disabled="!canIndent(i)"
                      :title="
                        holdsLinks(l) ? t('settings.interface.linkHoldsLinks') : t('settings.interface.linkIndent')
                      "
                      @click="indentLink(i)"
                    >
                      <FaIcon icon="arrow-right" />
                    </button>
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="!canMove(i, -1) ? 'btn-outline-secondary' : 'btn-outline-primary'"
                      :disabled="!canMove(i, -1)"
                      :title="t('settings.interface.linkUp')"
                      @click="moveLink(i, -1)"
                    >
                      <FaIcon icon="arrow-up" />
                    </button>
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="!canMove(i, 1) ? 'btn-outline-secondary' : 'btn-outline-primary'"
                      :disabled="!canMove(i, 1)"
                      :title="t('settings.interface.linkDown')"
                      @click="moveLink(i, 1)"
                    >
                      <FaIcon icon="arrow-down" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="btn btn-outline-danger af-row-btn"
                    :title="t('common.delete')"
                    @click="removeLink(i)"
                  >
                    <FaIcon icon="trash" />
                  </button>
                </div>
              </div>
            </div>
          </fieldset>
        </template>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the card ends at its own padding : no margin of the last field under it */
:deep(.card-body > .mb-3:last-child),
:deep(.card-body > :last-child > .mb-3:last-child) {
  margin-bottom: 0 !important;
}
/* the own links : one row each, the same columns for the header line ; a card narrower than
   them scrolls sideways rather than squeezing the fields */
.af-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
  /* a little room under the last row, as under the Environment page's preview */
  padding-bottom: 0.5rem;
}
.af-links-row {
  display: grid;
  /* the last : as wide as its buttons (four 2.5rem moves, the 0.5rem gap, delete), no wider */
  grid-template-columns: 14.5rem 12rem minmax(14rem, 1fr) 5rem 13rem;
  gap: 0.75rem;
  align-items: center;
  min-width: 58rem;
}
/* the column names : as a field's label on the settings pages (form-label fw-bold) */
.af-links-head {
  font-weight: 700;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
