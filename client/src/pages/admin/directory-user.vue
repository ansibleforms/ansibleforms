<script setup>
/******************************************************************/
/*                                                                */
/*  An LDAP or SSO user's page (/settings/users/<source>/<name>), */
/*  opened from the users list : what was recorded at its last    */
/*  sign-in (models/directoryUser.model.js on the server), read   */
/*  only - its directory owns who it is and its groups - in tabs, */
/*  the tab kept in the address ; a row of a tab opens its item : */
/*  Details - username, source, name, email, first seen, last     */
/*            sign-in                                             */
/*  Groups - the groups it had at its last sign-in                */
/*  Roles - the roles it has, and how                             */
/*  Forms, Jobs, Stored jobs, Schedules, Activity - as a local    */
/*          user's (composables/useUserLinks.js)                  */
/*  Its Sign-in switch in Details, saved with Save (off :         */
/*  blocked, asked first) ; End sessions, Forget and Save top     */
/*  right ; the search on the title line narrows every tab at     */
/*  once (API tokens aside : its table keeps its own search).     */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, watch, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { deleteRecords } from '@/lib/bulkDelete';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { formPath } from '@/lib/formsPath';
import { sourceLabel } from '@/config/settings';
import { setSignInBlocked } from '@/lib/signIn';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRoleAssignments } from '@/composables/useRoleAssignments';
import { useRoleMembership } from '@/composables/useRoleMembership';
import { useFormLinks } from '@/composables/useFormLinks';
import { useUserLinks } from '@/composables/useUserLinks';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { repositorySourceFields } from '@/lib/repositoryUsage';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);
// how many API tokens it has : the count of its tab, read at once (its table reads them only when
// its tab is open, and says the count again after a revoke)
const tokenCount = ref(null);

// ─── the user ─────────────────────────────────────────────────────────────────
const source = computed(() => String(route.params.type || ''));
const username = computed(() => String(route.params.name || ''));
const user = ref(null); // its record : { username, description, email, groups, seen, blocked, ... }
const sourceName = computed(() => sourceLabel(t, source.value));
// the address of the api for this user
const apiPath = computed(
  () => `/api/v2/directory/users/${encodeURIComponent(source.value)}/${encodeURIComponent(username.value)}`,
);

// its Sign-in switch as edited : saved with Save, as every record page's switches
const signIn = ref(true);
const dirty = computed(() => !!user.value && signIn.value === !!user.value.blocked);
// leaving with it turned and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Loads the user's record ; none when it was neither seen nor named by a role.
 */
async function load() {
  try {
    const res = await axios.get(apiPath.value);
    user.value = res.data.records ? res.data.records[0] : res.data;
  } catch {
    user.value = null;
  }
  signIn.value = !user.value?.blocked;
  loaded.value = true;
}

// its groups at its last sign-in, written source/name : the name alone, each opening its page
const userGroups = computed(() =>
  (user.value?.groups || []).map((g) => {
    const name = String(g).slice(String(g).indexOf('/') + 1);
    return { id: g, name };
  }),
);

// ─── Roles, Forms ─────────────────────────────────────────────────────────────
// the roles it has, by the login's rule on the groups of its last sign-in ; a row opens the role
const { loadRoles, rolesOfUser } = useRoleAssignments();

// ─── Add role / Remove from role ──────────────────────────────────────────────
// Add role names it in a role of the forms config ; the roles ticked are taken out of those
// named in by its own name (not those through a group, nor default : everyone's) ; both saved at once, as the roles' pages save
const { roleNames, readOnly: rolesReadOnly, addTo, removeFrom } = useRoleMembership();
const addingRole = ref(false);
// the roles it can be added to : those it is not named in yet
const roleChoices = computed(() => {
  const named = new Set(userRoles.value.filter((r) => r.direct).map((r) => r.name));
  return roleNames.value.filter((n) => !named.has(n));
});
/**
 * Names it in the role picked, then reads the roles again.
 *
 * Args:
 *   roleName (string): the role.
 */
async function addRole(roleName) {
  if (await addTo(roleName, 'users', source.value, username.value)) {
    addingRole.value = false;
    await loadRoles();
  }
}
/**
 * Takes it out of the roles ticked that name it, then reads the roles again.
 *
 * Args:
 *   rows (object[]): the rows ticked.
 */
async function removeRoles(rows) {
  const names = rows.filter((r) => r.direct).map((r) => r.name);
  if (names.length && (await removeFrom(names, 'users', source.value, username.value))) await loadRoles();
}
const userRoles = computed(() =>
  user.value
    ? rolesOfUser(
        user.value.username,
        userGroups.value.map((g) => g.name),
        source.value,
      )
    : [],
);
/**
 * How a role is the user's, in words : directly, through which groups, or everyone's.
 *
 * Args:
 *   r (object): a row of userRoles.
 *
 * Returns:
 *   string: the Given by cell.
 */
function givenBy(r) {
  if (r.everyone) return t('settings.common.roleEveryone');
  const parts = [];
  if (r.direct) parts.push(t('settings.common.roleDirectly'));
  if (r.groups.length) parts.push(t('settings.common.roleThroughGroups', { groups: r.groups.join(', ') }));
  return parts.join(' · ');
}
const roleColumns = computed(() => [
  { key: 'name', label: t('settings.common.role') },
  { key: 'given', label: t('settings.common.roleGivenBy'), value: givenBy },
  { key: 'description', label: t('settings.fields.description') },
]);
// the forms its roles open (the admin role, every form) ; a row opens the form
const { loadForms, formsOfRoles } = useFormLinks();
const userForms = computed(() => formsOfRoles(userRoles.value.map((r) => r.name)));
const formColumns = computed(() => [
  { key: 'name', label: t('settings.fields.form') },
  { key: 'through', label: t('settings.linked.throughRoles'), value: (f) => f.through.join(', ') },
  { key: 'description', label: t('settings.fields.description') },
]);
const groupColumns = computed(() => [{ key: 'name', label: t('settings.fields.name') }]);

// what it launched, keeps and did, as a local user's page shows it
const who = computed(() => (user.value ? { type: source.value, username: user.value.username } : null));
const {
  jobs,
  storedJobs,
  schedules,
  activity,
  loadUserLinks,
  jobColumns,
  stepsOf,
  storedJobColumns,
  scheduleColumns,
  activityColumns,
} = useUserLinks(who);

// ─── tabs ─────────────────────────────────────────────────────────────────────
// Details first, then the others by their name, as a local user's page
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  ...otherTabs.value.slice().sort((a, b) => a.label.localeCompare(b.label)),
]);
const otherTabs = computed(() => [
  { key: 'groups', label: t('settings.settingsPage.groups'), icon: 'users', count: userGroups.value.length },
  { key: 'roles', label: t('settings.settingsPage.roles'), icon: 'user-shield', count: userRoles.value.length },
  { key: 'forms', label: t('settings.linked.forms'), icon: 'rectangle-list', count: userForms.value.length },
  { key: 'jobs', label: t('settings.linked.jobs'), icon: 'history', count: jobs.value.length },
  {
    key: 'stored-jobs',
    label: t('settings.storedJobs.labelPlural'),
    icon: 'floppy-disk',
    count: storedJobs.value.length,
  },
  { key: 'schedules', label: t('settings.schedules.labelPlural'), icon: 'clock', count: schedules.value.length },
  { key: 'activity', label: t('settings.linked.activity'), icon: 'clipboard-list', count: activity.value.length },
  // its api tokens, each to revoke (#1068)
  { key: 'tokens', label: t('apiTokens.tab'), icon: 'code', count: tokenCount.value },
]);
// the API tokens table's controls on the title line, its pager under the card
const toolsId = `af-tools-${useId()}`;
const pagerId = `af-pager-${useId()}`;
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Users › <name>, each step a link, and the open tab last
const pagePath = computed(
  () => `/settings/users/${encodeURIComponent(source.value)}/${encodeURIComponent(username.value)}`,
);
const crumbs = computed(() => {
  const base = [
    { title: t('settings.users.labelPlural'), icon: 'user', to: '/settings/users' },
    { title: user.value?.username || username.value, icon: 'user', to: pagePath.value },
  ];
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...base, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : base;
});

// ─── Details ──────────────────────────────────────────────────────────────────
// what was recorded, as read-only fields : a date in the user's zone, an en dash for none
const when = (v) => (v ? Helpers.formatServerDate(v) : '–');
const details = computed(() =>
  user.value
    ? [
        { key: 'username', icon: 'user', label: t('settings.fields.username'), value: user.value.username },
        {
          key: 'signInSource',
          icon: 'right-to-bracket',
          label: t('settings.directory.source'),
          value: sourceName.value,
        },
        {
          key: 'name',
          icon: 'id-card',
          label: t('settings.directory.displayName'),
          value: user.value.display_name || '–',
        },
        // what an admin or its repository entry says it is : only when one says it
        ...(user.value.note
          ? [
              {
                key: 'description',
                icon: 'info-circle',
                label: t('settings.fields.description'),
                value: user.value.note,
              },
            ]
          : []),
        { key: 'email', icon: 'envelope', label: t('settings.fields.email'), value: user.value.email || '–' },
        {
          key: 'first',
          icon: 'calendar',
          label: t('settings.directory.firstSeen'),
          value: when(user.value.first_seen),
        },
        {
          key: 'last',
          icon: 'clock',
          label: t('settings.directory.lastLogin'),
          value: user.value.seen ? when(user.value.last_login) : t('settings.directory.neverSignedIn'),
        },
      ]
    : [],
);

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the facts of Details whose label or value has it (the Sign-in switch by its label or help), the
// rows of the other tabs with it in one of their cells (AppLinkedTable's search), each under its
// tab's name, the tabs set aside meanwhile. API tokens too : its tokens are read once when a
// search starts (tokenRows), its table given the word.
const { search, searching, matches, matchingKeys, shownTabs, tabShown, searchHead, tableMatches } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => tabMatches.value[key],
});
const shownFields = computed(() =>
  matchingKeys([
    ...repositorySourceFields(t, user.value || {}),
    ...details.value.map((d) => [d.key, d.label, d.value]),
    [
      'signIn',
      t('settings.directory.allowSignIn'),
      user.value?.blocked
        ? t('settings.directory.blockedNote')
        : t('settings.directory.signInHelp', { source: sourceName.value }),
    ],
  ]),
);
const fieldShown = (key) => shownFields.value.includes(key);
// the API tokens, for the search only : the tab's own table reads them when it shows, and while a
// word is searched the page must know whether one has it before showing the tab ; read once,
// when a search starts
const tokenRows = ref(null);
watch(searching, async (on) => {
  if (!on || tokenRows.value !== null) return;
  try {
    tokenRows.value = (await axios.get(`${apiPath.value}/tokens`)).data?.records || [];
  } catch {
    tokenRows.value = [];
  }
});
// each tab's match : Details by its facts, the others by their table's rows
const tabMatches = computed(() => ({
  details: shownFields.value.length > 0,
  groups: tableMatches(userGroups.value, groupColumns.value),
  roles: tableMatches(userRoles.value, roleColumns.value),
  forms: tableMatches(userForms.value, formColumns.value),
  jobs: tableMatches(jobs.value, jobColumns.value),
  'stored-jobs': tableMatches(storedJobs.value, storedJobColumns.value),
  schedules: tableMatches(schedules.value, scheduleColumns.value),
  activity: tableMatches(activity.value, activityColumns.value),
  tokens: (tokenRows.value || []).some((r) => matches(...Object.values(r || {}))),
}));

// ─── actions ──────────────────────────────────────────────────────────────────
// Save blocking asks first (its sessions end at once) ; Forget asks first ; Save allowing and End
// sessions do not
const confirming = ref(null); // 'block' or 'forget' while its dialog is open

/**
 * Calls the api, then reloads the record ; a refusal is said in a toast.
 *
 * Args:
 *   method (string): post or delete.
 *   path (string): after the user's api address ('' for the user itself).
 *   body (object): the request's body.
 *   done (string): what the toast says once done.
 *
 * Returns:
 *   Promise<boolean>: whether it was done.
 */
async function act(method, path, body, done) {
  try {
    await axios[method](apiPath.value + path, body);
    toast.success(done);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

/**
 * Saves the Sign-in switch (POST <user>/block) : turned on, allows the user ; turned off, asks
 * first (its sessions end), then blocks it.
 *
 * Args:
 *   confirmed (boolean): true once the block was confirmed in its dialog.
 *
 * Returns:
 *   Promise<boolean>: whether it was saved (false while the dialog asks).
 */
async function save(confirmed = false) {
  if (!dirty.value) return true;
  const blocked = !signIn.value;
  // step 1 : blocking asks first
  if (blocked && !confirmed) {
    confirming.value = 'block';
    return false;
  }
  confirming.value = null;
  // step 2 : saved, then read again
  const name = user.value.username;
  const done = blocked ? t('settings.directory.nowBlocked', { name }) : t('settings.directory.nowAllowed', { name });
  try {
    await setSignInBlocked({ source: source.value, username: user.value.username }, blocked);
    toast.success(done);
    await load();
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

/**
 * Ends the user's sessions : it signs in again.
 */
async function endSessions() {
  await act('post', '/end-sessions', {}, t('settings.directory.sessionsEnded', { name: user.value.username }));
}

/**
 * Forgets the user's record, then goes back to the list.
 */
async function forget() {
  confirming.value = null;
  if (await act('delete', '', undefined, t('settings.directory.forgotten', { name: user.value.username }))) {
    router.push('/settings/users');
  }
}

// how many API tokens it has (loadTokenCount)
/**
 * Reads how many API tokens the user has ; unknown on an error (no count shown).
 */
async function loadTokenCount() {
  const res = await axios.get(`${apiPath.value}/tokens`).catch(() => null);
  tokenCount.value = res ? (res.data?.records || []).length : null;
}

/**
 * Deletes the rows ticked in its Jobs, Stored jobs or Schedules table, after asking, then reads
 * them again.
 *
 * Args:
 *   rows (object[]): the rows ticked.
 *   api (string): their api : job, stored-jobs or schedule.
 */
async function deleteTicked(rows, api) {
  if (
    await deleteRecords(
      t,
      rows.map((r) => `/api/v2/${api}/${r.id}`),
    )
  )
    await loadUserLinks();
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadRoles(), loadForms()]);
  await loadUserLinks();
  loadTokenCount();
});
</script>
<template>
  <AppAddRoleDialog v-if="addingRole" :choices="roleChoices" @save="addRole" @close="addingRole = false" />
  <AppBlockSignInDialog
    v-if="confirming === 'block'"
    :name="user?.username || username"
    @confirm="save(true)"
    @close="confirming = null"
  />
  <BsModal v-if="confirming === 'forget'" size="md" @close="confirming = null" icon="eraser">
    <template #title> {{ t('settings.directory.forget') }} {{ user?.username }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">{{ t('settings.directory.forgetConfirm', { name: user?.username }) }}</p>
    </template>
    <template #footer>
      <BsButton icon="eraser" @click="forget()">{{ t('settings.directory.forget') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="user"
      :title="user?.username || username"
      :crumbs="crumbs"
      :description="t('settings.users.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="user" #headerActions>
        <BsSearch v-model="search" />
        <!-- the API tokens table's search, Select all, columns and export, on the title line (the
             other tabs' tables put theirs there themselves, AppLinkedTable) -->
        <div v-if="tabShown('tokens')" :id="toolsId" class="af-title-flow"></div>
      </template>
      <template v-if="user && !searching" #tabs>
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
              <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
            </a>
          </li>
        </ul>
      </template>
      <!-- the record loading : its tabs as grey placeholders -->
      <template v-else-if="!loaded && !searching" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loaded && !user" class="empty-state">
          <FaIcon icon="user" class="empty-state-icon" />
          <span>{{ t('settings.directory.notFound', { name: username, source: sourceName }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !user" shape="form" :count="3" />
        <!-- the tab open, or while searching each tab with a match under its name -->
        <template v-for="tab in user ? shownTabs : []" :key="tab.key">
          <template v-if="searching && searchHead(tab.key)">
            <hr v-if="!searchHead(tab.key).first" class="mt-4 mb-0 af-search-line" />
            <h6
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead(tab.key).first }"
            >
              <FaIcon :icon="searchHead(tab.key).tab.icon" class="me-1" />{{ searchHead(tab.key).tab.label }}
            </h6>
          </template>
          <!-- Details : what was recorded at its last sign-in, read only ; its note set aside while
               searching -->
          <div v-if="tab.key === 'details'" class="af-user-details">
            <template v-if="!searching">
              <div v-if="!user.seen" class="alert alert-secondary py-2">
                <!-- never signed in : declared by its repository entry, else named by a role -->
                <FaIcon icon="circle-info" class="me-2" />{{
                  t(user.repository ? 'settings.directory.repoNeverNote' : 'settings.directory.neverNote')
                }}
              </div>
              <div v-else class="alert alert-secondary py-2">
                <FaIcon icon="circle-info" class="me-2" />{{
                  t('settings.directory.readOnlyNote', { source: sourceName })
                }}
              </div>
            </template>
            <!-- where it comes from : the users repository's entry ; nothing for one it does not hold -->
            <AppRepositorySource v-show="fieldShown('source')" :record="user" />
            <BsInput
              v-for="d in details"
              v-show="fieldShown(d.key)"
              :key="d.key"
              class="af-user-field"
              :modelValue="d.value"
              :icon="d.icon"
              :isFloating="false"
              :disabled="true"
              :label="d.label"
            />
            <!-- Sign-in : allowed, or blocked by an admin ; saved with Save, as a runner's Default -->
            <div v-show="fieldShown('signIn')" class="mb-0">
              <label class="form-label fw-bold d-block" for="af-sign-in">{{
                t('settings.directory.allowSignIn')
              }}</label>
              <div class="form-check form-switch mb-0">
                <input id="af-sign-in" class="form-check-input" type="checkbox" role="switch" v-model="signIn" />
              </div>
              <!-- On, then Off on its own line -->
              <div class="form-text af-help-lines">
                {{
                  !signIn
                    ? t('settings.directory.blockedNote')
                    : t('settings.directory.signInHelp', { source: sourceName })
                }}
              </div>
            </div>
          </div>
          <!-- Groups : those of its last sign-in ; a row opens the group -->
          <AppLinkedTable
            v-else-if="tab.key === 'groups'"
            :search="search"
            :exportName="`${username}-groups`"
            :columns="groupColumns"
            :rows="userGroups"
            :to="(g) => `/settings/groups/${encodeURIComponent(source)}/${encodeURIComponent(g.name)}`"
            :empty="t('settings.directory.noGroupSeen')"
          />
          <!-- Roles : the roles it has, and how (default always) ; a row opens the role -->
          <AppLinkedTable
            v-else-if="tab.key === 'roles'"
            :search="search"
            selectable
            :rowActions="[
              {
                title: t('settings.settingsPage.removeFromRole'),
                icon: 'trash',
                danger: true,
                enabledWhen: (r) => !!r.direct,
                run: (r) => removeRoles([r]),
              },
            ]"
            :exportName="`${username}-roles`"
            :columns="roleColumns"
            :rows="userRoles"
            rowKey="name"
            :to="(r) => `/settings/roles/${encodeURIComponent(r.name)}`"
            :empty="t('settings.users.noRole')"
          >
            <!-- the roles ticked that name it : taken out of them -->
            <template #bulk-actions="{ selected, count }">
              <BsButton
                v-if="count"
                icon="trash"
                :disabled="rolesReadOnly || !selected.some((r) => r.direct)"
                @click="removeRoles(selected)"
                >{{ t('settings.settingsPage.removeFromRole') }} ({{ count }})</BsButton
              >
            </template>
          </AppLinkedTable>
          <AppLinkedTable
            v-else-if="tab.key === 'forms'"
            :search="search"
            :exportName="`${username}-forms`"
            :columns="formColumns"
            :rows="userForms"
            rowKey="name"
            :to="(f) => formPath(f.name)"
            :empty="t('settings.linked.noFormUser')"
          />
          <AppLinkedTable
            v-else-if="tab.key === 'jobs'"
            :search="search"
            selectable
            :rowActions="[
              { title: t('common.delete'), icon: 'trash', danger: true, run: (r) => deleteTicked([r], 'job') },
            ]"
            :exportName="`${username}-jobs`"
            :columns="jobColumns"
            :children="stepsOf"
            childrenBefore="form"
            :rows="jobs"
            :to="(j) => `/jobs/${j.id}`"
            :empty="t('settings.linked.noJob')"
          >
            <template #cell-status="{ row }"><AppStatusPill :status="row.status" /></template>
            <template #bulk-actions="{ selected, count }">
              <BsButton v-if="count" icon="trash" @click="deleteTicked(selected, 'job')"
                >{{ t('common.delete') }} ({{ count }})</BsButton
              >
            </template>
          </AppLinkedTable>
          <AppLinkedTable
            v-else-if="tab.key === 'stored-jobs'"
            :search="search"
            selectable
            :rowActions="[
              { title: t('common.delete'), icon: 'trash', danger: true, run: (r) => deleteTicked([r], 'stored-jobs') },
            ]"
            :exportName="`${username}-stored-jobs`"
            :columns="storedJobColumns"
            :rows="storedJobs"
            :to="(j) => `/jobs/stored/${j.id}`"
            :empty="t('settings.users.noStoredJob')"
          >
            <template #bulk-actions="{ selected, count }">
              <BsButton v-if="count" icon="trash" @click="deleteTicked(selected, 'stored-jobs')"
                >{{ t('common.delete') }} ({{ count }})</BsButton
              >
            </template>
          </AppLinkedTable>
          <AppLinkedTable
            v-else-if="tab.key === 'schedules'"
            :search="search"
            selectable
            :rowActions="[
              { title: t('common.delete'), icon: 'trash', danger: true, run: (r) => deleteTicked([r], 'schedule') },
            ]"
            :exportName="`${username}-schedules`"
            :columns="scheduleColumns"
            :rows="schedules"
            :to="(s) => `/jobs/scheduled/${s.id}`"
            :empty="t('settings.users.noSchedule')"
          >
            <template #bulk-actions="{ selected, count }">
              <BsButton v-if="count" icon="trash" @click="deleteTicked(selected, 'schedule')"
                >{{ t('common.delete') }} ({{ count }})</BsButton
              >
            </template>
          </AppLinkedTable>
          <AppLinkedTable
            v-else-if="tab.key === 'activity'"
            :search="search"
            :exportName="`${username}-activity`"
            :columns="activityColumns"
            :rows="activity"
            :empty="t('settings.linked.noActivity')"
          />
          <!-- API tokens : its own table, given the page's search -->
          <AppApiTokens
            v-else-if="tab.key === 'tokens'"
            :search="search"
            @count="(n) => (tokenCount = n)"
            :url="`${apiPath}/tokens`"
            :toolbarTo="'#' + toolsId"
            :pagerTo="'#' + pagerId"
          />
        </template>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <!-- its pager, under the card -->
      <template #footer>
        <div :id="pagerId"></div>
      </template>
      <template v-if="user" #actions>
        <BsButton v-if="activeTab === 'roles'" icon="plus" :disabled="rolesReadOnly" @click="addingRole = true">{{
          t('settings.settingsPage.addRole')
        }}</BsButton>
        <BsButton icon="right-from-bracket" :disabled="!user.seen" @click="endSessions()">{{
          t('settings.directory.endSessions')
        }}</BsButton>
        <!-- a blocked user is kept : forgetting it would let it in ; one never seen has nothing -->
        <BsButton icon="eraser" :disabled="user.blocked || !user.seen" @click="confirming = 'forget'">{{
          t('settings.directory.forget')
        }}</BsButton>
        <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="[130, 100, 80]" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a local user's */
.af-user-field :deep(.input-group) {
  max-width: 40rem;
}
.af-user-details {
  padding-bottom: 0.5rem;
}
/* the count of a tab : small and grey, as the menus' badges */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
/* a help of several lines (Allow sign-in's On, then Off) : its line breaks kept */
.af-help-lines {
  white-space: pre-line;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
