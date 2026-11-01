<script setup>
/******************************************************************/
/*                                                                */
/*  A credential's page (/settings/credentials/<id>), opened from    */
/*  the credentials' list : the steps of its dialog as tabs, the  */
/*  tab kept in the url -                                         */
/*    Details     its name and description                        */
/*    Type        what it is for (SSH, Git, LDAP, SSO ...)        */
/*    Login       where it connects (SSH, a database : the host   */
/*                and port, a database's type and name), its user */
/*                and password (a CyberArk's AppID, client        */
/*                certificate and key ; an Entra ID one's tenant) */
/*                ; the password masked : left empty kept, typed  */
/*                replaced                                        */
/*    Store       where the user and password are kept : the app's*/
/*                database, or a secret store (not a CyberArk's)  */
/*  Test connection (a database), Delete and Save top right. A    */
/*  credential of the config seed is read only.                   */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import TokenStorage from '@/lib/TokenStorage';
import Helpers from '@/lib/Helpers';
import { useAppStore } from '@/stores/app';
import {
  CREDENTIAL_TYPES,
  SERVER_CREDENTIAL_TYPES,
  TOKEN_CREDENTIAL_TYPES,
  CREDENTIAL_SERVER_EXAMPLE,
  credentialLabels,
} from '@/config/settings';
import { formRows, fitsPattern } from '@/lib/formUseRows';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';
import { ssoCallbackUrl, SSO_EXAMPLE_BASE } from '@/lib/ssoCallback';
import { useRecordSearch } from '@/composables/useRecordSearch';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the credential ───────────────────────────────────────────────────────────
const credentialId = computed(() => String(route.params.id || ''));
const credential = ref(null); // as saved
const edit = ref(null); // as edited
const secretStores = ref([]); // the stores a credential can read from
// what this page edits : the password has its own dialog ; a CyberArk's client key is typed
// on the Login tab, left empty to keep the stored one
const EDITED = [
  'name',
  'description',
  'credential_type',
  'user',
  'client_cert',
  'client_key',
  'tenant_id',
  'issuer',
  'redirect_uri',
  'secret_source',
  'secret_store',
  'secret_ref',
  'host',
  'port',
  'secure',
  'url',
  'ignore_certs',
  'ca_bundle',
  'db_type',
  'db_name',
];
const DB_TYPES = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'mssql', label: 'MSSQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'mongodb', label: 'MongoDB' },
];

/**
 * The fields of a credential as this page edits them : its type (from is_database for an old
 * one), where its secret is kept, the client key always empty (the stored one is never sent).
 *
 * Args:
 *   record (object): the credential.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  return {
    name: record.name ?? '',
    description: record.description ?? '',
    credential_type: CREDENTIAL_TYPES.includes(record.credential_type)
      ? record.credential_type
      : record.is_database
        ? 'database'
        : 'userpass',
    user: record.user ?? '',
    client_cert: record.client_cert ?? '',
    client_key: '',
    tenant_id: record.tenant_id ?? '',
    issuer: record.issuer ?? '',
    redirect_uri: record.redirect_uri ?? '',
    secret_source: record.secret_store ? 'store' : 'local',
    secret_store: record.secret_store ?? '',
    secret_ref: record.secret_ref ?? '',
    host: record.host ?? '',
    port: record.port ?? '',
    secure: !!record.secure,
    url: record.url ?? '',
    ignore_certs: !!record.ignore_certs,
    ca_bundle: record.ca_bundle ?? '',
    db_type: record.db_type || 'mysql',
    db_name: record.db_name ?? '',
  };
}

const managed = computed(() => !!credential.value?.managed);
// A credential a runner, a connection or a sign-in takes its address and secret from is an
// admin's to change, as the runner itself is (runner.vue) : the server refuses the others
// (controllers/v2/credential.controller.js assertMayChange). The kinds that carry the address
// of the one server they log in to, the sign-in kinds, and any credential a runner names.
const ADMIN_ONLY_TYPES = [
  'rte',
  'awx',
  'aap',
  'ascender',
  'semaphore',
  'rundeck',
  'jenkins',
  'vault',
  'cyberark',
  'oidc',
  'entraid',
  'ldap',
];
const appStore = useAppStore();
const adminOnly = computed(() => {
  if (appStore.isAdmin || !credential.value) return false;
  if (ADMIN_ONLY_TYPES.includes(credential.value.credential_type)) return true;
  // a runner naming it, as its Used by tab lists (load)
  return users.value.some((u) => u.kind === 'runner' && u.credential === credential.value.name);
});
// read only : one of the config seed, or one only an admin changes
const readOnly = computed(() => managed.value || adminOnly.value);
// which secret it reads from a secret store (its store and its reference) : only an admin chooses
// or changes it, on any credential (the server refuses the others) ; a connections user may still
// turn a credential back to keeping its own password, which drops the reference
const secretRefLocked = computed(() => !appStore.isAdmin);
// the From a secret store choice, for who may not choose one : open only while it already reads one
const storeSourceLocked = computed(() => secretRefLocked.value && !credential.value?.secret_store);
const type = computed(() => edit.value?.credential_type);
const isCyberark = computed(() => type.value === 'cyberark');
const isDatabase = computed(() => type.value === 'database');
// a secret store's login never comes from a secret store (it would read a store to find it)
const noStore = computed(() => ['cyberark', 'vault'].includes(type.value));
// read from a secret store : the user and password typed here are not kept
const fromStore = computed(() => !noStore.value && edit.value?.secret_source === 'store');
// a Vault, an RTE, a Semaphore and a Rundeck log in with a token only : no user
const hasUser = computed(() => !TOKEN_CREDENTIAL_TYPES.includes(type.value));
// the types in the order of their names, in the language shown, as the dialog's
const sortedTypes = computed(() =>
  [...CREDENTIAL_TYPES].sort((a, b) =>
    t(`settings.credentials.type_${a}`).localeCompare(t(`settings.credentials.type_${b}`)),
  ),
);
// what its fields are called for its type
const labels = computed(() => credentialLabels(t, type.value));
const dirty = computed(
  () =>
    !!credential.value &&
    (EDITED.some((k) => String(edit.value[k] ?? '') !== String(editable(credential.value)[k] ?? '')) ||
      !!newPassword.value),
);
// leaving with the credential changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Loads the credential and the secret stores it can read from.
 */
async function load() {
  const auth = TokenStorage.getAuthentication();
  try {
    const res = await axios.get(`/api/v2/credential/${encodeURIComponent(credentialId.value)}`, auth);
    const record = res.data.records ? res.data.records[0] : res.data;
    credential.value = record?.id ? record : null;
    edit.value = credential.value ? editable(record) : null;
  } catch {
    credential.value = null;
  }
  const [stores, mails, repos, directories, providers, chat, runners, databases, forms, workflows] = await Promise.all([
    axios.get('/api/v2/secretstore/', auth).catch(() => null),
    axios.get('/api/v2/notificationchannel/', auth).catch(() => null),
    axios.get('/api/v2/repository/', auth).catch(() => null),
    axios.get('/api/v2/ldapdirectory/', auth).catch(() => null),
    axios.get('/api/v2/oauth2/', auth).catch(() => null),
    axios.get('/api/v2/chatsettings/', auth).catch(() => null),
    axios.get('/api/v2/runner/', auth).catch(() => null),
    axios.get('/api/v2/database/', auth).catch(() => null),
    axios.get('/api/v2/config/formscredentials', auth).catch(() => null),
    axios.get('/api/v2/config/workflowscredentials', auth).catch(() => null),
  ]);
  secretStores.value = [{ name: '' }, ...(stores?.data?.records || []).map((s) => ({ name: s.name }))];
  // what names a credential : a secret store (its token or login), a notification channel (a
  // mail server's smtp login, a bot's or a webhook's token), a repository (its git login), an LDAP
  // directory (its bind account), an SSO provider (its client), a runner (its token or login), a
  // database of Connections > Databases (its connection), the chat assistant (its key), a form (in
  // its yaml) and a workflow of the designer (its nodes) : one row per credential a form or a
  // workflow names, where it names it ; the Used by tab keeps those naming this one
  users.value = [
    ...(stores?.data?.records || []).map((r) => ({ ...r, kind: 'secretStore', to: `/settings/secret-stores/${r.id}` })),
    ...(mails?.data?.records || []).map((r) => ({
      ...r,
      kind: 'notificationChannel',
      to: `/settings/notifications/${r.id}`,
    })),
    ...(repos?.data?.records || []).map((r) => ({ ...r, kind: 'repository', to: `/settings/repositories/${r.id}` })),
    ...(directories?.data?.records || []).map((r) => ({ ...r, kind: 'ldapDirectory', to: `/settings/ldap/${r.id}` })),
    ...(providers?.data?.records || []).map((r) => ({ ...r, kind: 'ssoProvider', to: `/settings/sso/${r.id}` })),
    ...(runners?.data?.records || []).map((r) => ({ ...r, kind: 'runner', to: `/settings/runners/${r.id}` })),
    ...(databases?.data?.records || []).map((r) => ({ ...r, kind: 'database', to: `/settings/databases/${r.id}` })),
    ...(chat?.data?.credential
      ? [{ name: t('sidebar.chat'), credential: chat.data.credential, kind: 'chat', to: '/settings/chat' }]
      : []),
    ...formRows(forms?.data?.records || []),
    ...formRows(workflows?.data?.records || [], 'workflow'),
  ];
  dynamicForms.value = (forms?.data?.records || []).filter((f) => f.dynamic?.length);
  loaded.value = true;
}

/**
 * Saves fields of the credential.
 *
 * Args:
 *   data (object): the fields.
 *
 * Returns:
 *   Promise<boolean>: whether they were saved.
 */
async function update(data) {
  try {
    await axios.put(`/api/v2/credential/${encodeURIComponent(credentialId.value)}`, data);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── Used by ──────────────────────────────────────────────────────────────────
// the secret stores, notification channels, repositories, LDAP directories, SSO providers,
// runners, the chat assistant, the forms and the designer's workflows that name the credential (a
// channel as its login or its token) ; a row opens it
const users = ref([]);
// the forms that build a credential's name when they run ($(field) in it) : they may use this one
// when its name fits their pattern
const dynamicForms = ref([]);

const usedBy = computed(() =>
  credential.value ? users.value.filter((u) => [u.credential, u.token_credential].includes(credential.value.name)) : [],
);
const usedByColumns = computed(() => [
  { key: 'name', label: t('settings.fields.name') },
  { key: 'type', label: t('settings.linked.type'), value: (u) => t(`settings.linked.${u.kind}`) },
  { key: 'description', label: t('settings.fields.description') },
  // where a form names it ; the other records name it in their own credential field
  { key: 'how', label: t('settings.linked.usesItAs'), value: (u) => u.how || '' },
]);
// the forms that may use it : their credential's name, built when they run, fits this one's
const dynamicNote = computed(() => {
  const name = credential.value?.name;
  if (!name) return '';
  const forms = dynamicForms.value
    .map((f) => ({ name: f.name, places: (f.dynamic || []).filter((d) => fitsPattern(d.pattern, name)) }))
    .filter((f) => f.places.length)
    .map((f) => `${f.name} (${f.places.map((d) => `${d.where}: ${d.pattern}`).join(', ')})`);
  return forms.length ? t('settings.linked.dynamicForms', { forms: forms.join('; ') }) : '';
});

// ─── tabs ─────────────────────────────────────────────────────────────────────
// the dialog's steps : Store not for a CyberArk's ; then what uses it. Where an SSH or a database
// credential connects is in its Login tab, with its user and password
const tabs = computed(() =>
  [
    { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
    { key: 'type', label: t('settings.credentials.stepType'), icon: 'shapes' },
    { key: 'login', label: t('settings.credentials.stepLogin'), icon: 'user' },
    !noStore.value && { key: 'store', label: t('settings.credentials.stepStore'), icon: 'vault' },
    { key: 'used-by', label: t('settings.linked.usedBy'), icon: 'link', count: usedBy.value.length },
  ].filter(Boolean),
);
const { activeTab, tabLink } = useRouteTab('details', (key) =>
  ['details', 'type', 'login', 'store', 'connection', 'used-by'].includes(key),
);
// a tab the type does not have (Store of a CyberArk credential) : its first ; the Connection tab of
// before (a link kept) is the Login tab now
const shownTab = computed(() => {
  const key = activeTab.value === 'connection' ? 'login' : activeTab.value;
  return tabs.value.some((x) => x.key === key) ? key : 'details';
});
// an SSH, a database or an smtp credential connects somewhere : its host and port in its Login
// tab (an smtp one's the mail server, and its TLS)
// an ldap one's its directory's servers (in failover order), TLS and certificates
const hasConnection = computed(() => ['ssh', 'database', 'smtp', 'ldap'].includes(type.value));
const isSmtp = computed(() => type.value === 'smtp');
const isLdap = computed(() => type.value === 'ldap');
/**
 * TLS turned on or off : an ldap one's standard port follows it (389 plain, 636 with TLS), as the
 * directory's page did.
 */
function onTlsSwitch() {
  if (!isLdap.value) return;
  const port = Number(edit.value.port);
  if (!edit.value.port || port === 389 || port === 636) edit.value.port = edit.value.secure ? 636 : 389;
}
// an api, userpass or cyberark one : the one server it logs in to (a Vault, a CyberArk, a runner),
// optional, and its TLS once it has one
const hasServer = computed(() => SERVER_CREDENTIAL_TYPES.includes(type.value));
const serverTls = computed(() => hasServer.value && !!String(edit.value?.url || '').trim());
// an ldap one's servers' certificates : checked against these unless told not to
const ldapCerts = computed(() => isLdap.value && edit.value?.secure && !edit.value?.ignore_certs);
// an Entra ID or Open ID one : the app registration of an SSO provider, its redirect URL too
const isSso = computed(() => ['entraid', 'oidc'].includes(type.value));
// the redirect URL it gets when left empty : the app's address (Settings > URL) and the callback
const appUrl = ref('');
const defaultRedirect = computed(
  () => ssoCallbackUrl(type.value, appUrl.value) || ssoCallbackUrl(type.value, SSO_EXAMPLE_BASE),
);

// the title : Credentials › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('sidebar.credentials'), icon: 'lock', to: '/settings/credentials' },
  {
    title: credential.value?.name || (loaded.value ? credentialId.value : null),
    icon: 'lock',
    to: `/settings/credentials/${credentialId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === shownTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the fields of every tab, as the dialog saves them : read from a secret store, no user
 * and password are kept ; kept in the app's database, no secret store.
 */
async function save() {
  const e = edit.value;
  if (!e.name.trim() || !e.description.trim()) {
    toast.warning(t('settings.credentials.fieldsRequired'));
    return;
  }
  const data = {
    name: e.name.trim(),
    description: e.description.trim(),
    credential_type: e.credential_type,
    host: hasConnection.value ? e.host.trim() : '',
    port: hasConnection.value && String(e.port ?? '').trim() !== '' ? e.port : null,
    // an api, userpass or cyberark one's server
    url: hasServer.value ? e.url.trim() : '',
    // an ldap one's, or a server's : certificates not checked, the CA bundle (an ldap one's client
    // certificate below)
    ignore_certs: (isLdap.value || serverTls.value) && e.ignore_certs ? 1 : 0,
    ca_bundle: isLdap.value || (serverTls.value && !e.ignore_certs) ? e.ca_bundle : '',
    // an smtp or an ldap one's TLS
    secure: ['smtp', 'ldap'].includes(e.credential_type) && e.secure ? 1 : 0,
    db_type: isDatabase.value ? e.db_type : '',
    db_name: isDatabase.value ? e.db_name.trim() : '',
  };
  if (fromStore.value) {
    Object.assign(data, { secret_store: e.secret_store, secret_ref: e.secret_ref.trim() });
  } else {
    Object.assign(data, { secret_store: '', secret_ref: '', user: hasUser.value ? e.user.trim() : '' });
    // an Entra ID one's tenant
    data.tenant_id = e.credential_type === 'entraid' ? e.tenant_id.trim() : '';
    // an Open ID one's issuer
    data.issuer = e.credential_type === 'oidc' ? e.issuer.trim() : '';
    // an Entra ID or Open ID one's redirect URL : empty, the app's address and the callback path
    data.redirect_uri = isSso.value ? e.redirect_uri.trim() : '';
    // its new password, typed in its Login tab
    if (newPassword.value && !isCyberark.value) data.password = newPassword.value;
  }
  // an ldap one's client certificate, checked by its servers
  if (isLdap.value) data.client_cert = e.client_cert;
  if (isCyberark.value) {
    data.client_cert = e.client_cert;
    // left empty, the stored key stays
    if (e.client_key.trim()) data.client_key = e.client_key;
  }
  if (await update(data)) {
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    newPassword.value = '';
    await load();
  }
}

// Test connection : a database credential, one at a time
const testing = ref(false);

/**
 * Logs in to the database with the credential, and says how it went.
 */
async function testConnection() {
  testing.value = true;
  try {
    const result = await axios.get(`/api/v2/credential/testdb/${encodeURIComponent(credentialId.value)}`);
    toast.success(result.data.message);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('admin.connectionFailed')));
  } finally {
    testing.value = false;
  }
}

// its password, typed in its Login tab ; empty, the stored one is kept
const newPassword = ref('');
// the user and the password as its type names them : an LDAP one's bind DN and password, an SSO
// one's (Entra ID, Open ID) client id and secret, a CyberArk one's AppID
const userLabel = computed(() => labels.value.user || t('settings.fields.user'));
const passwordLabel = computed(() => labels.value.password || t('settings.fields.password'));

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields of Details, Type, Login and Store whose label or help has it (a type or a store
// option by its name and grey words), what uses it with it in one of its cells (AppLinkedTable's
// search), each under its tab's name, the tabs set aside meanwhile.
const { search, searching, matchingKeys, tableMatches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => shownTab.value,
  tabMatch: (key) => (key === 'used-by' ? usedByMatch.value : fieldsMatch(key)),
});
// each tab's fields : [key, label, help], only those its type shows (as the template's v-if)
const tabFields = computed(() => {
  const e = edit.value || {};
  const conn = hasConnection.value;
  const typed = !fromStore.value;
  return {
    details: [
      ['name', t('settings.fields.name')],
      ['description', t('settings.fields.description')],
    ],
    type: sortedTypes.value.map((kind) => [
      `type-${kind}`,
      t(`settings.credentials.type_${kind}`),
      t(`settings.credentials.type_${kind}Hint`),
    ]),
    login: [
      conn && isDatabase.value && ['db_type', t('settings.credentials.databaseType')],
      conn && isLdap.value && ['servers', t('settings.ldap.servers'), t('settings.ldap.serversHelp')],
      conn &&
        !isLdap.value && [
          'host',
          isSmtp.value ? t('settings.mail.mailServer') : t('settings.fields.host'),
          isSmtp.value ? t('settings.mail.mailServerHelp') : '',
        ],
      conn && [
        'port',
        isSmtp.value ? t('settings.mail.mailPort') : t('settings.fields.port'),
        isSmtp.value ? t('settings.mail.mailPortHelp') : '',
      ],
      conn &&
        (isSmtp.value || isLdap.value) && [
          'tls',
          isLdap.value ? t('settings.ldap.enableTls') : t('settings.mail.useTls'),
          isLdap.value ? t('settings.ldap.enableTlsDesc') : t('settings.mail.useTlsHelp'),
        ],
      conn &&
        isLdap.value &&
        e.secure && ['ldap_ignore_certs', t('settings.ldap.ignoreCerts'), t('settings.ldap.ignoreCertsDesc')],
      conn && ldapCerts.value && ['ldap_client_cert', t('settings.fields.certificate')],
      conn && ldapCerts.value && ['ldap_ca_bundle', t('settings.fields.caBundle')],
      conn && isDatabase.value && ['db_name', t('settings.credentials.database')],
      hasServer.value && ['url', t('settings.credentials.server'), labels.value.serverHelp],
      serverTls.value && ['skip_verify', t('settings.runners.skipVerify')],
      serverTls.value &&
        !e.ignore_certs && ['ca_bundle', t('settings.fields.caBundle'), t('settings.secretStores.caBundleHelp')],
      !typed && ['from_store', t('settings.credentials.loginFromStore')],
      typed && e.credential_type === 'entraid' && ['tenant_id', t('settings.oauth2.tenantId')],
      typed && e.credential_type === 'oidc' && ['issuer', t('settings.oauth2.issuer')],
      typed && hasUser.value && ['user', userLabel.value, isCyberark.value ? t('settings.secretStores.appIdHelp') : ''],
      typed &&
        isCyberark.value && [
          'client_cert',
          t('settings.secretStores.clientCert'),
          t('settings.secretStores.clientCertHelp'),
        ],
      typed &&
        isCyberark.value && [
          'client_key',
          t('settings.secretStores.clientKey'),
          t('settings.credentials.clientKeyKeep'),
        ],
      typed &&
        !isCyberark.value && [
          'password',
          passwordLabel.value,
          labels.value.passwordHelp
            ? `${labels.value.passwordHelp} ${t('settings.common.passwordKeep')}`
            : t('settings.common.passwordKeep'),
        ],
      typed && isSso.value && ['redirect_uri', t('settings.oauth2.redirectUrl'), t('settings.oauth2.redirectHelp')],
    ].filter(Boolean),
    store: [
      ['source-local', t('settings.credentials.secretLocal'), t('settings.credentials.secretLocalHint')],
      ['source-store', t('settings.credentials.secretFromStore'), t('settings.credentials.secretFromStoreHint')],
      fromStore.value && [
        'secret_store',
        t('settings.credentials.secretStore'),
        t('settings.credentials.secretStoreHelp'),
      ],
      fromStore.value && ['secret_ref', t('settings.credentials.secretRef'), t('settings.credentials.secretRefHelp')],
    ].filter(Boolean),
  };
});
// the fields shown : those of a tab shown whose label or help has the text
const shownFields = computed(() => matchingKeys(Object.values(tabFields.value).flat()));
const fieldShown = (key) => shownFields.value.includes(key);
// a tab of fields with one of them shown
const fieldsMatch = (key) => (tabFields.value[key] || []).some(([k]) => fieldShown(k));
// a row of Used by with the text in one of the cells its table shows (lib/recordSearch.js)
const usedByMatch = computed(() => tableMatches(usedBy.value, usedByColumns.value));

// Delete asks first
const confirmDelete = ref(false);

/**
 * Deletes the credential, then goes back to the credentials.
 */
async function deleteCredential() {
  confirmDelete.value = false;
  try {
    const name = credential.value?.name;
    await axios.delete(`/api/v2/credential/${encodeURIComponent(credentialId.value)}`);
    credential.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/credentials');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
  // the app's address : an SSO credential's redirect URL when left empty
  axios
    .get('/api/v2/settings')
    .then((res) => (appUrl.value = res.data?.url || ''))
    .catch(() => {});
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ credential?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ credential?.name }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteCredential()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="lock"
      :title="credential?.name || credentialId"
      :crumbs="crumbs"
      :description="t('settings.credentials.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="credential" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="credential && !searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in tabs" :key="tab.key" class="nav-item">
            <a class="nav-link" :class="{ active: shownTab === tab.key }" href="#" @click.prevent="activeTab = tab.key">
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
        <div v-if="loaded && !credential" class="empty-state">
          <FaIcon icon="lock" class="empty-state-icon" />
          <span>{{ t('settings.credentials.notFound', { id: credentialId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !credential" shape="form" :count="3" />
        <div
          v-if="credential && edit && ['details', 'type', 'login', 'store'].some(tabShown)"
          class="af-credential-tab"
        >
          <!-- a credential of the config seed : read only here -->
          <div v-if="managed" class="alert alert-secondary py-2">
            <FaIcon icon="lock" class="me-2" />{{ t('settings.common.seedManagedNotice') }}
          </div>
          <!-- one only an admin changes : read only for the others -->
          <div v-else-if="adminOnly" class="alert alert-secondary py-2">
            <FaIcon icon="lock" class="me-2" />{{ t('settings.credentials.adminOnlyNotice') }}
          </div>
          <fieldset :disabled="readOnly">
            <!-- Details : what it is called -->
            <template v-if="tabShown('details')">
              <template v-if="searching && searchHead('details')">
                <hr v-if="!searchHead('details').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('details').first }"
                >
                  <FaIcon :icon="searchHead('details').tab.icon" class="me-1" />{{ searchHead('details').tab.label }}
                </h6>
              </template>
              <BsInput
                class="af-credential-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="lock"
                :isFloating="false"
                :required="true"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-credential-field"
                v-model="edit.description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :required="true"
                :label="t('settings.fields.description')"
              />
            </template>
            <!-- Type : what it is for, each its label and a few grey words ; set when it was made (what
                 uses it expects it) -->
            <template v-if="tabShown('type')">
              <template v-if="searching && searchHead('type')">
                <hr v-if="!searchHead('type').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('type').first }"
                >
                  <FaIcon :icon="searchHead('type').tab.icon" class="me-1" />{{ searchHead('type').tab.label }}
                </h6>
              </template>
              <AppTypeOptions
                :options="
                  sortedTypes.map((kind) => ({
                    value: kind,
                    label: t(`settings.credentials.type_${kind}`),
                    hint: t(`settings.credentials.type_${kind}Hint`),
                  }))
                "
                :selected="edit.credential_type"
                name="credential-type"
                :shown="(kind) => fieldShown(`type-${kind}`)"
              />
            </template>
            <!-- Login : its user (read from a store : nothing here) ; a CyberArk's AppID,
               client certificate and key -->
            <template v-if="tabShown('login')">
              <template v-if="searching && searchHead('login')">
                <hr v-if="!searchHead('login').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('login').first }"
                >
                  <FaIcon :icon="searchHead('login').tab.icon" class="me-1" />{{ searchHead('login').tab.label }}
                </h6>
              </template>
              <!-- where it connects (SSH, a database, a mail server) : a database's type, the host
                   and port, a database's name, a mail server's TLS ; then the user and password -->
              <template v-if="hasConnection">
                <BsInput
                  v-if="isDatabase"
                  class="af-credential-field"
                  v-model="edit.db_type"
                  v-show="fieldShown('db_type')"
                  type="select"
                  icon="database"
                  :isFloating="false"
                  :values="DB_TYPES"
                  valueKey="value"
                  labelKey="label"
                  :required="true"
                  :label="t('settings.credentials.databaseType')"
                />
                <!-- an ldap one's servers : one per input, tried in order (Add server) -->
                <BsInputList
                  v-if="isLdap"
                  class="af-credential-field"
                  v-model="edit.host"
                  v-show="fieldShown('servers')"
                  icon="server"
                  placeholder="dc1.corp.example"
                  :required="true"
                  :addLabel="t('settings.ldap.addServer')"
                  :help="t('settings.ldap.serversHelp')"
                  :label="t('settings.ldap.servers')"
                />
                <BsInput
                  v-else
                  class="af-credential-field"
                  v-model="edit.host"
                  v-show="fieldShown('host')"
                  icon="server"
                  :placeholder="isSmtp ? 'smtp.example.com' : ''"
                  :isFloating="false"
                  :required="isSmtp"
                  :help="isSmtp ? t('settings.mail.mailServerHelp') : ''"
                  :label="isSmtp ? t('settings.mail.mailServer') : t('settings.fields.host')"
                />
                <BsInput
                  class="af-credential-field"
                  v-model="edit.port"
                  v-show="fieldShown('port')"
                  type="number"
                  icon="arrows-alt-v"
                  :isFloating="false"
                  :help="isSmtp ? t('settings.mail.mailPortHelp') : ''"
                  :label="isSmtp ? t('settings.mail.mailPort') : t('settings.fields.port')"
                />
                <!-- an smtp or an ldap one : TLS -->
                <div v-if="isSmtp || isLdap" v-show="fieldShown('tls')" class="form-check form-switch mb-3">
                  <input
                    id="af-credential-tls"
                    v-model="edit.secure"
                    class="form-check-input"
                    type="checkbox"
                    role="switch"
                    @change="onTlsSwitch"
                  />
                  <label class="form-check-label" for="af-credential-tls">{{
                    isLdap ? t('settings.ldap.enableTls') : t('settings.mail.useTls')
                  }}</label>
                  <div class="form-text mt-1">
                    {{ isLdap ? t('settings.ldap.enableTlsDesc') : t('settings.mail.useTlsHelp') }}
                  </div>
                </div>
                <!-- an ldap one with TLS : whether its servers' certificates are checked, and against
                     which -->
                <template v-if="isLdap && edit.secure">
                  <div v-show="fieldShown('ldap_ignore_certs')" class="form-check form-switch mb-3">
                    <input
                      id="af-credential-ignore-certs"
                      v-model="edit.ignore_certs"
                      class="form-check-input"
                      type="checkbox"
                      role="switch"
                    />
                    <label class="form-check-label" for="af-credential-ignore-certs">{{
                      t('settings.ldap.ignoreCerts')
                    }}</label>
                    <div class="form-text mt-1">{{ t('settings.ldap.ignoreCertsDesc') }}</div>
                  </div>
                  <template v-if="ldapCerts">
                    <BsInput
                      class="af-credential-field"
                      v-model="edit.client_cert"
                      v-show="fieldShown('ldap_client_cert')"
                      type="textarea"
                      icon="certificate"
                      placeholder="-----BEGIN CERTIFICATE-----"
                      :isFloating="false"
                      :label="t('settings.fields.certificate')"
                    />
                    <BsInput
                      class="af-credential-field"
                      v-model="edit.ca_bundle"
                      v-show="fieldShown('ldap_ca_bundle')"
                      type="textarea"
                      icon="certificate"
                      placeholder="-----BEGIN CERTIFICATE-----"
                      :isFloating="false"
                      :label="t('settings.fields.caBundle')"
                    />
                  </template>
                </template>
                <BsInput
                  v-if="isDatabase"
                  class="af-credential-field"
                  v-model="edit.db_name"
                  v-show="fieldShown('db_name')"
                  icon="database"
                  :isFloating="false"
                  :label="t('settings.credentials.database')"
                />
              </template>
              <!-- a secret store's or a runner's : the one server it logs in to, and how its
                   certificate is checked -->
              <template v-if="hasServer">
                <BsInput
                  class="af-credential-field"
                  v-model="edit.url"
                  v-show="fieldShown('url')"
                  icon="globe"
                  :placeholder="CREDENTIAL_SERVER_EXAMPLE[type]"
                  :isFloating="false"
                  :required="true"
                  :help="labels.serverHelp"
                  :label="t('settings.credentials.server')"
                />
                <template v-if="serverTls">
                  <div v-show="fieldShown('skip_verify')" class="form-check form-switch mb-3">
                    <input
                      id="af-credential-skip-verify"
                      v-model="edit.ignore_certs"
                      class="form-check-input"
                      type="checkbox"
                      role="switch"
                    />
                    <label class="form-check-label" for="af-credential-skip-verify">{{
                      t('settings.runners.skipVerify')
                    }}</label>
                  </div>
                  <BsInput
                    v-if="!edit.ignore_certs"
                    class="af-credential-field"
                    v-model="edit.ca_bundle"
                    v-show="fieldShown('ca_bundle')"
                    type="textarea"
                    icon="certificate"
                    placeholder="-----BEGIN CERTIFICATE-----"
                    :isFloating="false"
                    :help="t('settings.secretStores.caBundleHelp')"
                    :label="t('settings.fields.caBundle')"
                  />
                </template>
              </template>
              <p v-if="fromStore" v-show="fieldShown('from_store')" class="form-text mb-0">
                {{ t('settings.credentials.loginFromStore') }}
              </p>
              <template v-else>
                <!-- an Entra ID one's tenant : the tenant id the app is in, first as in
                     the Entra admin center (tenant, client id, secret) -->
                <BsInput
                  v-if="edit.credential_type === 'entraid'"
                  class="af-credential-field"
                  v-model="edit.tenant_id"
                  v-show="fieldShown('tenant_id')"
                  icon="building"
                  :isFloating="false"
                  :required="true"
                  :label="t('settings.oauth2.tenantId')"
                />
                <!-- an Open ID one's issuer : the provider's address, first as the tenant -->
                <BsInput
                  v-if="edit.credential_type === 'oidc'"
                  class="af-credential-field"
                  v-model="edit.issuer"
                  v-show="fieldShown('issuer')"
                  icon="globe"
                  placeholder="https://id.example.com/realms/main"
                  :isFloating="false"
                  :required="true"
                  :label="t('settings.oauth2.issuer')"
                />
                <BsInput
                  v-if="hasUser"
                  class="af-credential-field"
                  v-model="edit.user"
                  v-show="fieldShown('user')"
                  icon="user"
                  :isFloating="false"
                  :help="isCyberark ? t('settings.secretStores.appIdHelp') : ''"
                  :label="userLabel"
                />
                <template v-if="isCyberark">
                  <BsInput
                    class="af-credential-field"
                    v-model="edit.client_cert"
                    v-show="fieldShown('client_cert')"
                    type="textarea"
                    icon="certificate"
                    placeholder="-----BEGIN CERTIFICATE-----"
                    :isFloating="false"
                    :help="t('settings.secretStores.clientCertHelp')"
                    :label="t('settings.secretStores.clientCert')"
                  />
                  <BsInput
                    class="af-credential-field"
                    v-model="edit.client_key"
                    v-show="fieldShown('client_key')"
                    type="textarea"
                    icon="key"
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    :isFloating="false"
                    :help="t('settings.credentials.clientKeyKeep')"
                    :label="t('settings.secretStores.clientKey')"
                  />
                </template>
                <!-- its password, masked : left empty, the stored one is kept ; typed, replaced -->
                <BsInput
                  v-else
                  class="af-credential-field"
                  v-model="newPassword"
                  v-show="fieldShown('password')"
                  type="password"
                  icon="lock"
                  placeholder="**********"
                  :isFloating="false"
                  :disabled="readOnly"
                  :help="
                    labels.passwordHelp
                      ? `${labels.passwordHelp} ${t('settings.common.passwordKeep')}`
                      : t('settings.common.passwordKeep')
                  "
                  :label="passwordLabel"
                />
                <!-- an Entra ID or Open ID one's redirect URL, as registered with its client -->
                <BsInput
                  v-if="isSso"
                  class="af-credential-field"
                  v-model="edit.redirect_uri"
                  v-show="fieldShown('redirect_uri')"
                  icon="link"
                  :placeholder="defaultRedirect"
                  :isFloating="false"
                  :help="t('settings.oauth2.redirectHelp')"
                  :label="t('settings.oauth2.redirectUrl')"
                />
              </template>
            </template>
            <!-- Store : the app's database, or a secret store and the place in it -->
            <template v-if="tabShown('store')">
              <template v-if="searching && searchHead('store')">
                <hr v-if="!searchHead('store').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('store').first }"
                >
                  <FaIcon :icon="searchHead('store').tab.icon" class="me-1" />{{ searchHead('store').tab.label }}
                </h6>
              </template>
              <div
                v-for="opt in [
                  {
                    value: 'local',
                    label: t('settings.credentials.secretLocal'),
                    hint: t('settings.credentials.secretLocalHint'),
                  },
                  {
                    value: 'store',
                    label: t('settings.credentials.secretFromStore'),
                    hint: t('settings.credentials.secretFromStoreHint'),
                  },
                ]"
                v-show="fieldShown(`source-${opt.value}`)"
                :key="opt.value"
                class="form-check af-short-check"
              >
                <input
                  :id="'af-source-' + opt.value"
                  v-model="edit.secret_source"
                  class="form-check-input"
                  type="radio"
                  name="af-credential-source"
                  :value="opt.value"
                  :disabled="opt.value === 'store' && storeSourceLocked"
                />
                <label class="form-check-label" :for="'af-source-' + opt.value">
                  <span class="af-short-label">{{ opt.label }}</span>
                  <span class="text-body-secondary small">{{ opt.hint }}</span>
                </label>
              </div>
              <template v-if="fromStore">
                <BsInput
                  class="af-credential-field mt-3"
                  v-model="edit.secret_store"
                  v-show="fieldShown('secret_store')"
                  type="select"
                  icon="vault"
                  :disabled="secretRefLocked"
                  :isFloating="false"
                  :values="secretStores"
                  valueKey="name"
                  labelKey="name"
                  :help="t('settings.credentials.secretStoreHelp')"
                  :label="t('settings.credentials.secretStore')"
                />
                <BsInput
                  class="af-credential-field"
                  v-model="edit.secret_ref"
                  v-show="fieldShown('secret_ref')"
                  icon="shield-alt"
                  :readonly="secretRefLocked"
                  :placeholder="t('settings.credentials.secretRefPlaceholder')"
                  :isFloating="false"
                  :help="t('settings.credentials.secretRefHelp')"
                  :label="t('settings.credentials.secretRef')"
                />
              </template>
            </template>
          </fieldset>
        </div>
        <!-- Used by : what names the credential ; a row opens it. Under it, the forms that build a
             credential's name when they run and may use this one -->
        <div v-if="credential && tabShown('used-by')">
          <template v-if="searching && searchHead('used-by')">
            <hr v-if="!searchHead('used-by').first" class="mt-4 mb-0 af-search-line" />
            <h6
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('used-by').first }"
            >
              <FaIcon :icon="searchHead('used-by').tab.icon" class="me-1" />{{ searchHead('used-by').tab.label }}
            </h6>
          </template>
          <AppLinkedTable
            :search="search"
            :exportName="`${credential.name}-used-by`"
            :columns="usedByColumns"
            :rows="usedBy"
            rowKey="to"
            :to="(u) => u.to"
            :empty="t('settings.linked.noUse')"
          />
          <p v-if="dynamicNote" class="form-text mt-3 mb-0">{{ dynamicNote }}</p>
        </div>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <template v-if="credential" #actions>
        <BsButton
          v-if="credential.is_database"
          icon="plug"
          cssClass="text-nowrap"
          :disabled="testing"
          @click="testConnection()"
          >{{ t('settings.common.testConnection') }}</BsButton
        >
        <template v-if="!readOnly">
          <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
          <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
        </template>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('credentials', credentialId)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the count of a tab : small and grey, as the menus' badges */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
/* the wide fields' width of the settings pages, as a runner's and a secret store's */
.af-credential-field :deep(.input-group) {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-credential-tab {
  padding-bottom: 0.5rem;
}
/* the fields sit in a fieldset (read only for the config seed's credentials) : the card cannot
   reach its last field's margin to zero it, so it is zeroed here */
.af-credential-tab fieldset > :last-child,
.af-credential-tab fieldset > :last-child :deep(.mb-3:last-child) {
  margin-bottom: 0 !important;
}
/* the radio buttons : their labels one width, so the grey hints line up, as in the dialog */
.af-short-check {
  margin-bottom: 0.6rem;
}
.af-short-label {
  display: inline-block;
  min-width: 12rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
