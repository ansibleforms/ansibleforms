// Shared role helpers used by the settings roles page (via useFormsConfig) and
// the designer's role add/edit modals. Keep these pure so both can import the
// same lists/logic instead of duplicating them.

export const authProviders = ['local', 'ldap', 'azuread', 'oidc'];

// the Microsoft Entra ID provider : kept as azuread, the type its sign-in stores, and written
// entraid/<name> in a role since 7.3 ; an azuread/<name> of before is the same member
const ENTRA_TYPE = 'azuread';
const ENTRA_PREFIX = 'entraid';

/**
 * The prefix a provider is written with in a role, as the editors show it.
 *
 * Args:
 *   provider (string): the provider : local, ldap, azuread, oidc.
 *
 * Returns:
 *   string: its prefix, entraid for Microsoft Entra ID.
 */
export function providerPrefix(provider) {
  return provider === ENTRA_TYPE ? ENTRA_PREFIX : provider;
}

// the role options in their groups, in the order they show : the role's page and its New role
// dialog (AppRoleEditor) and the profile's Permissions view, each group under its title
export const roleOptionGroups = [
  {
    name: 'settings',
    title: 'nav.settings',
    keys: [
      'showSettings',
      'showAppearanceSettings',
      'showConnectionsSettings',
      'showLogs',
      'showAuditLog',
      'allowBackupOps',
    ],
  },
  {
    name: 'designer',
    title: 'nav.designer',
    keys: [
      'showDesigner',
      'allowFormDesign',
      'designAllForms',
      'allowPlaybookDesign',
      'designAllPlaybooks',
      'allowWorkflowDesign',
      'designAllWorkflows',
      'allowInventoryDesign',
      'allowVarsFileDesign',
    ],
  },
  {
    name: 'jobs',
    title: 'profilePage.groupJobs',
    keys: [
      'showJobs',
      'showAllJobLogs',
      'manageAllJobs',
      'showExtravars',
      'showDebugButtons',
      'showArtifacts',
      'allowVerboseMode',
      'allowJobRelaunch',
      'allowJobDeletion',
      'allowScheduledJobs',
      'allowPlannedJobs',
      'allowStoredJobs',
      'allowStoredJobsShare',
      'allowStoredJobsViewAll',
    ],
  },
  {
    name: 'access',
    title: 'profilePage.groupAccess',
    keys: ['allowLogin', 'allowChat', 'allowMcp', 'allowFileUploads', 'allowApiTokens', 'extendedTokenExpiration'],
  },
];

/**
 * What a role option gives, in words : its description (profilePage.optionDescription.<key>), the
 * same on the role's page (the (i) beside each toggle) and on the profile's Permissions view.
 *
 * Args:
 *   t (Function): vue-i18n's translate function.
 *   te (Function): vue-i18n's "has this key" function.
 *   key (string): the option.
 *
 * Returns:
 *   string: the description ; '' for an option without one (a hand-written key).
 */
export function roleOptionDescription(t, te, key) {
  const path = `profilePage.optionDescription.${key}`;
  return te(path) ? t(path) : '';
}

// the options another one already gives : with it on, they are on whatever the role says (the
// server's guards accept either), so the role editor shows them on and greyed out
export const roleOptionIncludedIn = {
  showAppearanceSettings: 'showSettings',
  showConnectionsSettings: 'showSettings',
  showAuditLog: 'showSettings',
  // acting on every user's jobs means seeing them (job.model.js seesAllJobs)
  showAllJobLogs: 'manageAllJobs',
};

// the options that only matter with another one on : without it, the role editor shows them off
// and greyed out (their own value kept), as the role gets them
export const roleOptionNeeds = {
  allowFormDesign: 'showDesigner',
  designAllForms: 'showDesigner',
  designAllPlaybooks: 'showDesigner',
  designAllWorkflows: 'showDesigner',
  allowPlaybookDesign: 'showDesigner',
  allowWorkflowDesign: 'showDesigner',
  allowInventoryDesign: 'showDesigner',
  allowVarsFileDesign: 'showDesigner',
  // extended tokens add Never expires to the tokens (lib/tokenLifetime.js)
  extendedTokenExpiration: 'allowApiTokens',
  // sharing a stored job, and loading the ones others shared, are part of the stored jobs
  allowStoredJobsShare: 'allowStoredJobs',
  allowStoredJobsViewAll: 'allowStoredJobs',
};

/**
 * What an option really gives, with the rules above : on when an option that includes it is on,
 * off when an option it needs is off, else its own value. The role editor and the profile's
 * Permissions view show the same.
 *
 * Args:
 *   options (object): the role's (or the user's) options.
 *   key (string): the option.
 *
 * Returns:
 *   object: { value (boolean), includedBy (string|null), needs (string|null) } - the option that
 *     gives it, or the one it is missing.
 */
export function effectiveRoleOption(options, key) {
  const by = roleOptionIncludedIn[key];
  if (by && options?.[by]) return { value: true, includedBy: by, needs: null };
  const need = roleOptionNeeds[key];
  if (need && !options?.[need]) return { value: false, includedBy: null, needs: need };
  return { value: !!options?.[key], includedBy: null, needs: null };
}

// every role option, in the groups' order
export const roleOptionKeys = [
  'showSettings',
  'showAppearanceSettings',
  'showConnectionsSettings',
  'showLogs',
  'showAuditLog',
  'allowBackupOps',
  'showDesigner',
  'allowFormDesign',
  'designAllForms',
  'allowPlaybookDesign',
  'designAllPlaybooks',
  'allowWorkflowDesign',
  'designAllWorkflows',
  'allowInventoryDesign',
  'allowVarsFileDesign',
  'showJobs',
  'showAllJobLogs',
  'manageAllJobs',
  'showExtravars',
  'showDebugButtons',
  'showArtifacts',
  'allowVerboseMode',
  'allowJobRelaunch',
  'allowJobDeletion',
  'allowScheduledJobs',
  'allowPlannedJobs',
  'allowStoredJobs',
  'allowStoredJobsShare',
  'allowStoredJobsViewAll',
  'allowLogin',
  'allowChat',
  'allowMcp',
  'allowFileUploads',
  'allowApiTokens',
  'extendedTokenExpiration',
];

// Options whose effective value is `true` when the key is absent from the yaml.
// Mirrors the fallbacks in server/src/models/user.model.js (getRolesAndOptions),
// plus `allowLogin` which is not defaulted there but is only ever tested as
// `=== false` in login.controller.js : an absent allowLogin allows login.
// The server also defaults `showExtraVars` (capital V) to true ; that casing
// variant is not exposed by this editor, so it is not listed here (unknown keys
// found in hand-written yaml are preserved verbatim by serializeRole).
const trueByDefaultOptions = [
  'allowFormDesign',
  'designAllForms',
  'allowPlaybookDesign',
  'designAllPlaybooks',
  'allowWorkflowDesign',
  'designAllWorkflows',
  'allowInventoryDesign',
  'allowVarsFileDesign',
  'allowVerboseMode',
  'showJobs',
  'showDebugButtons',
  'showExtravars',
  'showArtifacts',
  'allowStoredJobs',
  'allowFileUploads',
  'allowJobDeletion',
  'allowPlannedJobs',
  'allowLogin',
  'allowChat',
  'allowMcp',
];

// Options whose effective value defaults to the "is this an admin" check.
const adminByDefaultOptions = [
  'showSettings',
  'showDesigner',
  'showLogs',
  'allowBackupOps',
  'allowJobRelaunch',
  'showAllJobLogs',
  'allowScheduledJobs',
  'allowStoredJobsShare',
  'allowStoredJobsViewAll',
];

// Effective value of every option for a role that does not spell it out.
// LIMITATION : the server evaluates `isAdmin` over ALL roles of the logged-in
// user, not over the single role being edited, so judging it per role is an
// approximation. A user who also holds the 'admin' role gets the admin
// defaults on all of his roles, which this per-role view cannot express.
// Mind too that the server ANDs an option across all the roles a user matches,
// so an explicit false in one role wins over a default in another.
export function roleOptionDefaults(roleName) {
  const isAdmin = roleName === 'admin';
  const defaults = {};
  for (const key of roleOptionKeys) defaults[key] = false;
  for (const key of trueByDefaultOptions) defaults[key] = true;
  for (const key of adminByDefaultOptions) defaults[key] = isAdmin;
  return defaults;
}

// Translated label of a role option. The keys all follow the
// settings.settingsPage.roleOption<Key> convention, so derive the i18n key from
// the option name instead of maintaining a second map per editor.
/**
 * The description of a role the config must keep (admin, default) : fixed and translated, never
 * typed or stored ; '' for any other role.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   name (string): the role's name.
 *
 * Returns:
 *   string: its description, or ''.
 */
export function requiredRoleDescription(t, name) {
  if (name === 'admin') return t('settings.settingsPage.roleDescriptionAdmin');
  if (name === 'default' || name === 'public') return t('settings.settingsPage.roleDescriptionDefault');
  return '';
}

export function roleOptionLabel(t, key) {
  return t('settings.settingsPage.roleOption' + key.charAt(0).toUpperCase() + key.slice(1));
}

// Split a provider-prefixed entry ("local/admins") into { provider, name }.
// Missing prefix defaults to the 'local' provider ; entraid/ and azuread/ are both the
// Microsoft Entra ID provider (azuread).
export function parseProviderEntry(str) {
  // hand-edited YAML can hold non-string entries (numbers, maps) : stringify
  // defensively instead of throwing and killing the whole editor
  const s = typeof str === 'string' ? str : String(str ?? '');
  const idx = s.indexOf('/');
  if (idx === -1) return { provider: 'local', name: s };
  const provider = s.substring(0, idx);
  return { provider: provider === ENTRA_PREFIX ? ENTRA_TYPE : provider, name: s.substring(idx + 1) };
}

// an entry written back : Microsoft Entra ID as entraid/, an azuread/ of before included
export function formatProviderEntry(entry) {
  return `${providerPrefix(entry.provider)}/${entry.name}`;
}

// Map a stored role (schema shape) to the editable shape both editors use
// ({provider,name} member objects, all option flags materialized). Absent
// options are materialized with their EFFECTIVE value (the default the server
// would apply), not with false : showing them as off would misreport the live
// permissions of the role.
/**
 * A role's list of names as the editors keep it : its strings, trimmed, none empty.
 *
 * Args:
 *   list (any): the list from the yaml.
 *
 * Returns:
 *   string[]: the names.
 */
function listOf(list) {
  return Array.isArray(list) ? list.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

export function roleToEditable(r) {
  const defaults = roleOptionDefaults(r.name);
  const options = { ...defaults };
  for (const [k, v] of Object.entries(r.options || {})) {
    // Known flags are normalized to real booleans so the switches and the
    // serializer can't disagree on a hand-written non-boolean (yaml 1.2 parses
    // `showJobs: yes` as the string "yes", which the server reads as truthy but
    // a checkbox renders as off). Unknown flags are kept verbatim.
    options[k] = roleOptionKeys.includes(k) ? !!v : v;
  }
  // allowMcp absent : the server gives it the role's allowChat (user.model.js), so it shows that
  if (!r.options || r.options.allowMcp === undefined) options.allowMcp = options.allowChat;
  // allowApiTokens absent : a role from before it, whose extendedTokenExpiration gave the tokens -
  // the server gives it that value (user.model.js), so it shows that
  if (!r.options || r.options.allowApiTokens === undefined) options.allowApiTokens = !!options.extendedTokenExpiration;
  return {
    name: r.name || '',
    // what the role is for, in a few words (the roles list shows it)
    description: typeof r.description === 'string' ? r.description : '',
    groups: (r.groups || []).map(parseProviderEntry),
    users: (r.users || []).map(parseProviderEntry),
    // what the role may use (lib/resourceScope.js) : the credentials (regexes), the secret
    // stores and the runners, by name ; kept as they are, none when the role lists none
    credentials: listOf(r.credentials),
    secretStores: listOf(r.secretStores),
    runners: listOf(r.runners),
    options,
    // Remembered so serializeRole can tell a flag the admin actually has an
    // opinion about from one that merely shows its default. See serializeRole.
    _explicitOptions: Object.keys(r.options || {}),
  };
}

// Serialize an edited role back to the schema shape:
//  - groups is always present (empty array allowed),
//  - users only when non-empty,
//  - options only carries the flags this role has an opinion about,
//  - the default role never carries groups/users (the schema pins it),
//  - the role name is trimmed, like the member names : a stray space is
//    invisible in the editor but the server matches role names literally
//    (`roles: [operators]` in a form, `roles.includes("admin")` in
//    middleware.js), so ' operators ' would silently stop applying anywhere,
//  - member names are trimmed ; empty/never-filled rows are dropped.
//
// A flag is written when, and only when, it was already spelled out in the yaml
// or the user actually moved the switch away from the default shown to him.
// Both halves of that rule matter:
//  - writing a switched-off flag is what makes the round trip lossless, since
//    the server reads an absent option as "apply the default" and most defaults
//    are true, so an omitted flag would come back on ;
//  - NOT writing an untouched flag is what keeps roles composable. The server
//    ANDs each option across every role a user matches
//    (server/src/models/user.model.js, getRolesAndOptions), so an explicit
//    false beats another role's default. Materializing untouched defaults as
//    explicit false would turn "no opinion" into "deny" and, for a user holding
//    several roles, silently strip permissions granted by another role -- an
//    admin who also matches a plain role would lose settings access.
// Flags we don't know about (hand-written yaml, the showExtraVars casing variant) are
// passed through untouched.
export function serializeRole(r) {
  const name = (r.name || '').trim();
  const isDefault = name === 'default' || name === 'public';
  const role = { name };
  // written only when there is one, so a role without stays as it was in the yaml ; admin and
  // default have a fixed one (requiredRoleDescription), never stored
  const description = (r.description || '').trim();
  if (description && name !== 'admin' && name !== 'default' && name !== 'public') role.description = description;
  const clean = (list) =>
    (list || [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => formatProviderEntry({ provider: e.provider, name: e.name.trim() }));
  role.groups = isDefault ? [] : clean(r.groups);
  const users = isDefault ? [] : clean(r.users);
  if (users.length) role.users = users;
  // what the role may use : written when it lists any. Left out, the role limits nothing - so
  // dropping them (as a save once did) widened what its users may use
  for (const key of ['credentials', 'secretStores', 'runners']) {
    const list = listOf(r[key]);
    if (list.length) role[key] = list;
  }
  // The baseline MUST be derived from the role's CURRENT name, never from a copy
  // taken when it was loaded : roleOptionDefaults branches on `admin`, so a role
  // renamed across that boundary would be compared against the wrong defaults.
  // Renaming a plain role to `admin` then omitted every admin-gated flag, and the
  // server derives isAdmin from the name -- granting full admin while the editor
  // showed those switches off. Comparing against the current name writes the
  // explicit values needed to preserve exactly what the user saw. The trimmed
  // name is the one being written, so it is the one to branch on.
  const defaults = roleOptionDefaults(name);
  // allowMcp left out is read as the role's allowChat : it is written whenever it differs
  defaults.allowMcp = r.options?.allowChat === undefined ? defaults.allowChat : !!r.options.allowChat;
  const explicit = r._explicitOptions || [];
  const options = {};
  for (const k of roleOptionKeys) {
    const value = !!r.options?.[k];
    if (explicit.includes(k) || value !== defaults[k]) options[k] = value;
  }
  for (const [k, v] of Object.entries(r.options || {})) {
    if (!roleOptionKeys.includes(k)) options[k] = v;
  }
  if (Object.keys(options).length > 0) role.options = options;
  return role;
}
