<script setup>
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import BaseUrl from '@/lib/BaseUrl';
import { useEnvVars } from '@/composables/useEnvVars';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useSeedManaged } from '@/composables/useSeedManaged';

/******************************************************************/
/*                                                                */
/*  Settings > Connections > MCP : the MCP server for AI agents   */
/*  (its switch and its two options, environment variables that   */
/*  apply without a restart), and how a client connects to it.    */
/*  An MCP repository keeps the switches in its mcp.yaml ; the    */
/*  config seed's mcp section holds them per variable (read only) */
/*                                                                */
/******************************************************************/

const { t } = useI18n();

// INIT

const authenticated = ref(false);
// the page's values read once : until then its fields as grey placeholders
const loaded = ref(false);

// the tab shown, kept in the address : a link can open the client configuration directly
const { activeTab, tabLink } = useRouteTab('general', (key) => ['general', 'client-configuration'].includes(key));
const pageTabs = computed(() => [
  { key: 'general', label: t('settings.settingsPage.mcpTabGeneral'), icon: 'sliders' },
  { key: 'client-configuration', label: t('settings.settingsPage.mcpClientConfig'), icon: 'plug' },
]);
// the title names the tab : MCP › Clients, each step a link (the page to its plain address)
const titleCrumbs = computed(() => {
  const tab = pageTabs.value.find((x) => x.key === activeTab.value);
  if (!tab) return [];
  return [
    { title: t('sidebar.mcp'), icon: 'robot', to: tabLink('general') },
    { title: tab.label, icon: tab.icon, to: tabLink(tab.key) },
  ];
});

// the variables of the page : the switch first, then what it decides while on
const { envItems, envEdits, envDirty, envRestartPending, loadEnvironmentVariables, saveEnvironmentVariables } =
  useEnvVars(['ENABLE_MCP', 'MCP_READ_ONLY', 'MCP_CHAT_FORMS_ONLY']);

// the switches the config seed's mcp section manages : read only here (the server refuses them)
const { seeded, loadSeedManaged } = useSeedManaged();

// the MCP server switched on, as the page shows it (before Save too) : its options follow
const mcpOn = computed(() => String(envEdits.value.ENABLE_MCP ?? '0') === '1');

// ─── search ──────────────────────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows both tabs at once, as Settings > General's :
// the switches that match (label, name, help), the client configuration when it matches (the
// endpoint, a client's name), each under its tab's name, the tabs set aside meanwhile.
const { search, searching, matches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => pageTabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => (key === 'general' ? shownEnvItems.value.length : clientsMatch.value),
});
const envMatch = (e) => matches(e.short, e.name, e.hint, e.description);
const shownEnvItems = computed(() => envItems.value.filter(envMatch));
const clientsMatch = computed(() =>
  matches(
    t('settings.settingsPage.mcpEndpoint'),
    t('settings.settingsPage.mcpConnectHelp'),
    t('settings.settingsPage.mcpClientConfig'),
    t('settings.settingsPage.mcpTokenHint'),
    ...mcpClients.value.map((c) => c.label),
  ),
);

// how an MCP client connects : the endpoint under the public root url (Settings > Mail &
// URL), or this page's own address when none is set
const publicUrl = ref('');
const mcpEndpoint = computed(() => {
  const root = (publicUrl.value || window.location.origin + BaseUrl).replace(/\/+$/, '');
  return root + '/api/v2/mcp';
});

// the configuration of each client, in its own file and format, the endpoint filled in : a
// tab each (their documentation : Claude Code .mcp.json, Cursor mcp.json, VS Code
// .vscode/mcp.json with a prompted token, Codex config.toml with the token from the environment)
const json = (o) => JSON.stringify(o, null, 2);
const mcpClients = computed(() => {
  const url = mcpEndpoint.value;
  const bearer = 'Bearer <your-token>';
  return [
    {
      key: 'claude',
      label: 'Claude Code',
      file: '.mcp.json',
      text: json({ mcpServers: { ansibleforms: { type: 'http', url, headers: { Authorization: bearer } } } }),
      // the same, as a command (the note above it introduces it)
      extra: `claude mcp add --transport http ansibleforms ${url} --header "Authorization: ${bearer}"`,
    },
    {
      key: 'cursor',
      label: 'Cursor',
      file: '~/.cursor/mcp.json',
      text: json({ mcpServers: { ansibleforms: { url, headers: { Authorization: bearer } } } }),
    },
    {
      key: 'vscode',
      label: 'VS Code',
      file: '.vscode/mcp.json',
      text: json({
        inputs: [{ type: 'promptString', id: 'ansibleforms-token', description: 'AnsibleForms token', password: true }],
        servers: {
          ansibleforms: { type: 'http', url, headers: { Authorization: 'Bearer ${input:ansibleforms-token}' } },
        },
      }),
      note: t('settings.settingsPage.mcpNoteVscode'),
    },
    {
      key: 'codex',
      label: 'Codex',
      file: '~/.codex/config.toml',
      text: `[mcp_servers.ansibleforms]\nurl = "${url}"\nbearer_token_env_var = "ANSIBLEFORMS_TOKEN"`,
      note: t('settings.settingsPage.mcpNoteCodex'),
    },
  ];
});
const mcpClient = ref('claude');
const mcpCurrent = computed(() => mcpClients.value.find((c) => c.key === mcpClient.value) || mcpClients.value[0]);

// METHODS

/**
 * Copies a text to the clipboard.
 *
 * Args:
 *   text (string): the endpoint or the client configuration.
 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t('settings.settingsPage.mcpCopied'));
  } catch {
    // no clipboard access (plain http) : the text stays selectable
  }
}

// HOOKS

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([loadEnvironmentVariables(), loadSeedManaged()]);
  try {
    publicUrl.value = (await axios.get('/api/v2/settings/')).data?.url || '';
  } catch {
    // no public url : the page's own address stands in
  }
  loaded.value = true;
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="robot"
      :title="t('sidebar.mcp')"
      :crumbs="titleCrumbs"
      :description="t('settings.settingsPage.mcpDescription')"
    >
      <!-- narrows both tabs at once ; the search box of the other pages -->
      <template #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="!searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in pageTabs" :key="tab.key" class="nav-item">
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
      <!-- Save : the switches of the General tab only (shown while a search shows them) -->
      <template v-if="tabShown('general')" #actions>
        <BsButton icon="save" :disabled="!envDirty" @click="saveEnvironmentVariables()">{{
          t('settings.common.save')
        }}</BsButton>
      </template>
      <template #default>
        <!-- the first load : the fields as grey placeholders, in their place -->
        <AppSkeleton v-if="!loaded" shape="form" :count="4" />
        <template v-else>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
          <!-- GENERAL : the switch, and the options waiting for it while the server is off -->
          <div v-show="tabShown('general')">
            <h6
              v-if="searching && searchHead('general')"
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('general').first }"
            >
              <FaIcon :icon="searchHead('general').tab.icon" class="me-1" />{{ searchHead('general').tab.label }}
            </h6>
            <!-- the MCP repository keeping the switches, and the ones the config seed manages -->
            <AppRepositorySource v-show="!searching" type="mcp" />
            <AppSeedNotice v-if="seeded(...shownEnvItems.map((e) => e.name))" />
            <div v-if="envRestartPending.length" class="alert alert-warning py-2">
              <FaIcon icon="triangle-exclamation" class="me-2" />
              {{ t('settings.settingsPage.envRestartPending', { names: envRestartPending.join(', ') }) }}
            </div>
            <template v-for="(e, i) in shownEnvItems" :key="e.name">
              <div v-if="i > 0" class="mt-4"></div>
              <AppEnvField
                v-model="envEdits[e.name]"
                :e="e"
                :asSwitch="true"
                :disabled="seeded(e.name) || (e.name !== 'ENABLE_MCP' && !mcpOn)"
              />
            </template>
          </div>

          <!-- CLIENT CONFIGURATION : the endpoint, and each client's configuration -->
          <div v-show="tabShown('client-configuration')">
            <template v-if="searching && searchHead('client-configuration')">
              <hr v-if="!searchHead('client-configuration').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('client-configuration').first }"
              >
                <FaIcon :icon="searchHead('client-configuration').tab.icon" class="me-1" />{{
                  searchHead('client-configuration').tab.label
                }}
              </h6>
            </template>
            <!-- as wide as the endpoint and the configuration under it -->
            <div v-if="!mcpOn" class="alert alert-warning py-2 af-mcp-config">
              <FaIcon icon="triangle-exclamation" class="me-2" />{{ t('settings.settingsPage.mcpOffNote') }}
            </div>
            <label class="form-label fw-bold">{{ t('settings.settingsPage.mcpEndpoint') }}</label>
            <div class="input-group af-mcp-endpoint">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="link" /></span>
              <input class="form-control font-monospace" readonly :value="mcpEndpoint" />
              <BsButton icon="copy" @click="copy(mcpEndpoint)">{{ t('profilePage.token.copy') }}</BsButton>
            </div>
            <div class="form-text mb-4">{{ t('settings.settingsPage.mcpConnectHelp') }}</div>
            <label class="form-label fw-bold">{{ t('settings.settingsPage.mcpClientConfig') }}</label>
            <!-- a tab per client : its file, its format -->
            <ul class="nav nav-tabs af-mcp-tabs af-mcp-config mb-0">
              <li v-for="c in mcpClients" :key="c.key" class="nav-item">
                <a
                  class="nav-link"
                  :class="{ active: mcpClient === c.key }"
                  href="#"
                  @click.prevent="mcpClient = c.key"
                  >{{ c.label }}</a
                >
              </li>
            </ul>
            <div class="position-relative af-mcp-config">
              <pre class="form-control font-monospace mb-0">{{ mcpCurrent.text }}</pre>
              <BsButton icon="copy" cssClass="position-absolute top-0 end-0 m-2" @click="copy(mcpCurrent.text)">{{
                t('profilePage.token.copy')
              }}</BsButton>
            </div>
            <div class="form-text">
              {{ t('settings.settingsPage.mcpConfigFile') }} <code>{{ mcpCurrent.file }}</code>
              <template v-if="mcpCurrent.note"> {{ mcpCurrent.note }}</template>
            </div>
            <!-- the command alternative : a field as the endpoint's, the Copy button beside it -->
            <template v-if="mcpCurrent.extra">
              <div class="form-text mt-2">{{ t('settings.settingsPage.mcpNoteClaude') }}</div>
              <div class="input-group af-mcp-endpoint mt-1">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="terminal" /></span>
                <input class="form-control font-monospace" readonly :value="mcpCurrent.extra" />
                <BsButton icon="copy" @click="copy(mcpCurrent.extra)">{{ t('profilePage.token.copy') }}</BsButton>
              </div>
            </template>
            <div class="form-text mt-3">
              {{ t('settings.settingsPage.mcpTokenHint') }}
              <router-link to="/profile/token">{{ t('settings.settingsPage.mcpCreateToken') }}</router-link>
            </div>
          </div>
        </template>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the endpoint and the configuration as wide as the wide fields (a path, a command) */
.af-mcp-endpoint,
.af-mcp-config {
  max-width: 40rem;
}
.af-mcp-config pre {
  background-color: var(--bs-tertiary-bg);
  white-space: pre;
  overflow-x: auto;
}
/* the tabs sit on the snippet : its top corners square, as a tabbed card's */
.af-mcp-tabs + .af-mcp-config pre {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  border-top: 0;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
