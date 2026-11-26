'use strict';
// Declarative config seed : schema validation and environment interpolation.
//
// Pure helpers, no database access, so they are unit testable and so a broken seed
// is rejected before anything is written.
//
// The seed file itself carries no secrets : a secret is written as ${SOME_ENV_VAR}
// and resolved from the process environment at apply time, which is what lets the
// file live in git next to the rest of the deployment.
import Ajv from "ajv";
import { CHAT_PROVIDERS } from "../chat/vendors.js";
import { USAGE_TYPES, ONE_ONLY_FLAGS } from "./repoObjects/types.js";

const str = { type: "string" };
const bool = { type: "boolean" };
// a number that arrived through ${ENV} interpolation is a string by then, so both
// forms have to be accepted here ; the models coerce
const strOrInt = { type: ["string", "integer"] };

// Every section below is additionalProperties:false on purpose. A seed is applied
// unattended at startup, so a misspelled key must be an error the operator sees
// immediately, not a value that is silently dropped.

// Deprecated since 7, removed in 8 : the section for AWX connections. Its items are
// runners of type awx now (foldAwxIntoRunners) ; the shape is still validated as it was.
const awxItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "uri"],
  properties: {
    name: str,
    description: str,
    uri: str,
    is_default: bool,
    use_credentials: bool,
    username: str,
    password: str,
    token: str,
    ignore_certs: bool,
    ca_bundle: str,
  },
};

const credentialItem = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: str,
    description: str,
    user: str,
    password: str,
    host: str,
    port: strOrInt,
    db_name: str,
    db_type: str,
    secure: bool,
    is_database: bool,
    // what it is for (is_database follows it) ; without it, is_database decides
    credential_type: { type: "string", enum: ["userpass", "ssh", "git", "api", "database", "cyberark", "smtp", "ldap", "entraid", "oidc",
      "rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault", "registry"] },
    // a cyberark one's client certificate and key ; an entraid one's, signing in with them
    // instead of its secret when it sends mail through Microsoft 365 ; an ssh one's private key is
    // its client_key too (PEM or OpenSSH text, usually an env-var reference), and key_passphrase
    // the key's passphrase
    client_cert: str,
    client_key: str,
    key_passphrase: str,
    // an entraid credential's tenant, an oidc one's issuer ; an entraid or oidc one's redirect URL
    tenant_id: str,
    issuer: str,
    redirect_uri: str,
    // the address of the one server a runner's or a secret store's credential logs in to
    url: str,
    // an ldap credential's TLS, or a runner's or a secret store's for its url : certificates not
    // checked, the CA bundle
    ignore_certs: bool,
    ca_bundle: str,
    // a credential can take its user and password from a secret store instead of
    // carrying them here at all : the store's name and the place in it
    secret_store: str,
    secret_ref: str,
    // deprecated since 7, removed in 8 : the same as secret_store 'vault' + secret_ref
    vault_path: str,
  },
};

// Which fields a type uses is up to its provider (src/secrets/providers) ; the schema
// accepts them all so a seed can declare any store type.
const secretStoreItem = {
  type: "object",
  additionalProperties: false,
  // its url : its own, or its credential's
  required: ["name", "type"],
  properties: {
    name: str,
    type: str,
    description: str,
    url: str,
    token: str,
    credential: str,
    namespace: str,
    kv_version: strOrInt,
    default_mount: str,
    app_id: str,
    client_cert: str,
    client_key: str,
    ignore_certs: bool,
    ca_bundle: str,
    cache_ttl_seconds: strOrInt,
    // an object, or the same as JSON text
    extra: { type: ["object", "string"] },
    // a credential's secret typed in the app may be written to it, below this prefix
    write_enabled: bool,
    write_prefix: str,
    // a CyberArk's writes go through its PVWA : its address, the API user's credential and logon
    // method, the platform a new account gets (write_prefix : the safes it may write to)
    pvwa_url: str,
    pvwa_credential: str,
    pvwa_auth: { type: "string", enum: ["cyberark", "ldap", "radius", "windows"] },
    platform_id: str,
  },
};

// Where a job runs : an RTE (type rte, `token` is its RTE_TOKEN), AWX/AAP/Ascender
// (type awx : a token, or use_credentials with username and password), Semaphore or
// Rundeck (type semaphore / rundeck : a token and a project), or Jenkins (type jenkins : a
// username, its API token, and a folder as project if any)
const runnerItem = {
  type: "object",
  additionalProperties: false,
  // its uri : its own (an RTE always), or its credential's
  required: ["name", "type"],
  properties: {
    name: str,
    type: { type: "string", enum: ["rte", "awx", "semaphore", "rundeck", "jenkins"] },
    description: str,
    uri: str,
    // its own secrets : deprecated since 7.3 in favour of credential, removed in 8. The seed
    // turns them into a credential of its kind (foldRunnerSecretsIntoCredentials)
    token: str,
    use_credentials: bool,
    username: str,
    password: str,
    // a credential of the credentials section it signs in with, instead of its own
    credential: str,
    ignore_certs: bool,
    ca_bundle: str,
    is_default: bool,
    // turned off, no job goes to it (1, on, when not said)
    enabled: bool,
    // an awx runner that is an AAP or an Ascender ; none is AWX
    flavour: { type: "string", enum: ["aap", "ascender"] },
    // a semaphore runner's project id, a rundeck runner's project name, a jenkins runner's folder
    project: str,
    // an RTE's mode (RTE_MODE on it) : outbound (it dials the app), inbound (the app dials it),
    // or database (deprecated, the default before 7.3)
    rte_mode: { type: "string", enum: ["database", "outbound", "inbound"] },
    // a socket-mode RTE's settings (rte/socket/settings.js), sent over its socket ; they win over
    // the same variables set on the RTE : the playbooks it runs at once (0 no limit), its job files cache in MB
    // (0 keeps none), where it gets a job's files, how long a stop waits
    rte_max_jobs: { type: "integer", minimum: 0, maximum: 10000 },
    rte_cache_mb: { type: "integer", minimum: 0, maximum: 1048576 },
    rte_files: { type: "string", enum: ["transfer", "local"] },
    rte_drain_seconds: { type: "integer", minimum: 0, maximum: 86400 },
  },
};

/**
 * The `awx:` section as runners of type awx : a seed written before 7 keeps working
 * (deprecated, removed in 8). Returns a new document ; the warning is the caller's.
 */
export function foldAwxIntoRunners(doc) {
  if (!doc?.awx) return doc;
  const { awx, ...rest } = doc;
  const runners = rest.runners ? { ...rest.runners } : { items: [] };
  runners.items = [...(runners.items || []), ...(awx.items || []).map((item) => ({ ...item, type: "awx" }))];
  if (awx.prune && runners.prune === undefined) runners.prune = awx.prune;
  return { ...rest, runners };
}

/**
 * A repository's use_for_config (deprecated since 7.8.0, removed in 8) as the three flags it is
 * now : use_for_roles, use_for_categories and use_for_constants, each the item's own when it
 * declares it. The one rule for the config seed's repositories (foldConfigFlag) and a
 * repositories: entries of a repository (lib/repoObjects/repositories.js).
 *
 * Args:
 *   item (object): the repository as declared.
 *   give (boolean): false : the item's use_for_config is on, but another repository has the three
 *     flags already (one repository holds each) - dropped, no flag given.
 *
 * Returns:
 *   object: the item, without use_for_config ; as it is when it does not declare it.
 */
export function foldConfigItem(item, give = true) {
  if (item?.use_for_config === undefined) return item;
  const { use_for_config: on, ...rest } = item;
  if (on && !give) return rest;
  return { use_for_roles: on, use_for_categories: on, use_for_constants: on, ...rest };
}

/**
 * The config seed's repositories' use_for_config folded (foldConfigItem). 7.3 read its configuration
 * from the first use_for_config repository and only warned about the others. The repository that
 * holds the three flags in the database already (the one the schema patch gave them to : the one
 * 7.3 read) keeps them when the seed declares use_for_config on it ; while it holds them, the
 * others declaring it get none. With none holding them, the first one that declares it (in the
 * file's order, the order a fresh database made them in) gets them. The others are listed as such,
 * warned by the caller, never a refusal of the seed. With the configuration kept in the database,
 * 7.3 read none of them (the database copy was served whole) : every use_for_config is dropped,
 * none gets the flags, as the schema patch gives none then (models/schema.model.js
 * splitConfigUsage). Returns a new document ; the warnings are the caller's.
 *
 * Args:
 *   doc (object): the seed document.
 *   held (string[]): the repositories holding use_for_roles, use_for_categories or
 *     use_for_constants in the database now ; none for a fresh one (and the schema check).
 *   opts (object): { inDatabase (true : the configuration is kept in the database, and it holds
 *     one) }.
 *
 * Returns:
 *   { doc: object, folded: string[], dropped: string[], holder: string|null }: the document, the
 *     repositories whose flag moved, those whose use_for_config was dropped, and the one that has the
 *     three flags from it.
 */
export function foldConfigFlag(doc, held = [], opts = {}) {
  const items = doc?.repositories?.items || [];
  if (!items.some((r) => r.use_for_config !== undefined)) return { doc, folded: [], dropped: [], holder: null };
  if (opts.inDatabase) {
    const dropped = items.filter((r) => r.use_for_config !== undefined).map((r) => r.name);
    const repositoryItems = items.map(({ use_for_config: _dropped, ...rest }) => rest);
    return { doc: { ...doc, repositories: { ...doc.repositories, items: repositoryItems } }, folded: [], dropped, holder: null };
  }
  // the one holding them now, unless this seed takes them off it (use_for_config: false)
  const turnedOff = new Set(items.filter((r) => r.use_for_config !== undefined && !r.use_for_config).map((r) => r.name));
  const current = held.filter((name) => !turnedOff.has(name));
  const declaring = items.filter((r) => r.use_for_config).map((r) => r.name);
  const holder = current.length ? (declaring.find((name) => current.includes(name)) ?? current[0]) : (declaring[0] ?? null);
  const folded = [];
  const dropped = [];
  const repositoryItems = items.map((r) => {
    if (r.use_for_config === undefined) return r;
    const give = !r.use_for_config || r.name === holder;
    (give ? folded : dropped).push(r.name);
    return foldConfigItem(r, give);
  });
  return { doc: { ...doc, repositories: { ...doc.repositories, items: repositoryItems } }, folded, dropped, holder };
}

/**
 * Whether a seeded runner carries its own secrets (a token, or a user and password) instead of
 * naming a credential : what foldRunnerSecretsIntoCredentials folds.
 *
 * Args:
 *   runner (object): a runner item of the seed.
 *
 * Returns:
 *   boolean: true when it does.
 */
export function runnerOwnsSecrets(runner) {
  return !runner.credential && !!(runner.token || runner.username || runner.password);
}

/**
 * A runner's own secrets in the seed (its token, or its user and password) as a credential of its
 * kind : deprecated since 7.3, removed in 8. Each such runner names a new credential of the
 * credentials section, called after it, carrying its address, its TLS and its secrets, so the
 * runner looks like one declared with `credential:` (its page then shows that credential). A
 * runner that already names a credential is left alone. Returns a new document and the names of
 * the runners folded ; the warning is the caller's.
 *
 * The name is the runner's, else <runner>-runner, then <runner>-runner-2 ... : never one the
 * seed's own credentials section declares, nor one in `reserved`. The caller reserves the
 * credentials already in the database that the seed does not own (made by hand) : declaring
 * their name would ADOPT them (applyListSection), overwriting somebody's credential with the
 * runner's token. A credential the seed owns already keeps its name : it is this one, from the
 * previous start.
 *
 * Args:
 *   doc (object): the seed document, validated.
 *   reserved (Iterable<string>): names the credentials must not take ; none by default.
 *
 * Returns:
 *   { doc: object, folded: string[] }: the document, and the runners whose secrets moved.
 */
export function foldRunnerSecretsIntoCredentials(doc, reserved = []) {
  const items = doc?.runners?.items || [];
  if (!items.some(runnerOwnsSecrets)) return { doc, folded: [] };
  const own = runnerOwnsSecrets;
  const credentials = doc.credentials ? { ...doc.credentials } : { items: [] };
  credentials.items = [...(credentials.items || [])];
  const taken = new Set([...credentials.items.map((c) => c.name), ...reserved]);
  const folded = [];
  const runnerItems = items.map((r) => {
    if (!own(r)) return r;
    let name = r.name;
    if (taken.has(name)) name = `${r.name}-runner`;
    for (let i = 2; taken.has(name); i++) name = `${r.name}-runner-${i}`;
    taken.add(name);
    const kind = r.type === "awx" ? r.flavour || "awx" : r.type;
    // a jenkins user and its API token ; an awx user and password (use_credentials) ; else a token
    const user = r.type === "jenkins" || (r.type === "awx" && r.use_credentials) ? r.username : undefined;
    const secret = r.type === "awx" && r.use_credentials ? r.password : r.token;
    const credential = { name, description: `The credential of the runner ${r.name}`, credential_type: kind };
    if (r.uri !== undefined) credential.url = r.uri;
    if (user !== undefined) credential.user = user;
    if (secret !== undefined) credential.password = secret;
    if (r.ignore_certs !== undefined) credential.ignore_certs = r.ignore_certs;
    if (r.ca_bundle !== undefined) credential.ca_bundle = r.ca_bundle;
    credentials.items.push(credential);
    folded.push(r.name);
    // its own secrets leave it : the credential carries them now
    const rest = { ...r };
    for (const key of ["token", "username", "password", "use_credentials"]) delete rest[key];
    return { ...rest, credential: name };
  });
  return { doc: { ...doc, runners: { ...doc.runners, items: runnerItems }, credentials }, folded };
}

// the settings' mail keys of before 7.6 (deprecated, removed in 8), as foldMailSettingsIntoChannel
// takes them
export const SEED_MAIL_KEYS = ["mail_server", "mail_port", "mail_secure", "mail_username", "mail_password", "mail_from"];

/**
 * Whether the seed's settings section still carries a mail key of before 7.6 : what
 * foldMailSettingsIntoChannel folds.
 *
 * Args:
 *   doc (object): the seed document, validated.
 *
 * Returns:
 *   boolean: true when it does.
 */
export function seedHasMailSettings(doc) {
  const settings = doc?.settings;
  return !!settings && SEED_MAIL_KEYS.some((key) => settings[key] !== undefined);
}

/**
 * The settings' mail keys of before 7.6 (mail_server, mail_port, mail_secure, mail_username,
 * mail_password, mail_from) as a mail channel and its smtp credential : deprecated since 7.6,
 * removed in 8. The settings row has no mail columns any more, the mail goes through the mail
 * channels (Connections > Notifications), so a seed written before keeps working : its mail keys
 * leave the settings section, and with a mail server set the notifications section gets
 * a mail channel, 'default', sending from mail_from, as the upgrade's move of the mail settings
 * makes it :
 *   - with a mail_username : the credentials section gets an smtp credential, 'mail-login',
 *     holding the server, port, TLS and login, which the channel names
 *   - without one (a relay) : no credential, the channel holds the server, port and TLS itself
 *     and sends without a login
 * Each declares the other's fields empty (a relay its credential, a login the channel's own
 * server, port and TLS) : a seed update writes only the keys it declares, so a channel switched
 * from one to the other would otherwise keep the old target.
 * The channel's is_active is not declared : the first mail channel made is the active one
 * (NotificationChannel.create), and an active channel made by hand stays it, as it was preferred
 * to the mail settings before.
 * Without a mail server (mail_server empty) nothing is declared : no mail, as before. The names :
 *   - the ones in `own` first : the records the seed already manages for these keys (the
 *     upgrade's move of the mail settings made them managed on a seeded instance, under
 *     default-2 or mail-login-2 when the names were taken), so the seed keeps declaring them
 *   - else 'default' and 'mail-login', or -2, -3... after them
 * Never a name the seed's own sections declare already, nor one in `reserved`. The caller
 * reserves every record made by hand (a mail channel 'default' or an smtp credential
 * 'mail-login' too, which the upgrade did not take either) : declaring their name would ADOPT
 * them (applyListSection), overwriting their server and login. Returns a new document ; the
 * warning is the caller's.
 *
 * Args:
 *   doc (object): the seed document, validated.
 *   reserved (object): { channels: Iterable<string>, credentials: Iterable<string> }, names the
 *     channel and the credential must not take ; none by default.
 *   own (object): { channel: string|null, credential: string|null }, the names of the records
 *     the seed manages for these keys, taken first when free ; none by default.
 *
 * Returns:
 *   { doc: object, folded: boolean, channel: string|null, credential: string|null }: the
 *     document, whether mail keys were folded, and the channel and credential declared for them
 *     (null without a mail server ; the credential null for a relay).
 */
export function foldMailSettingsIntoChannel(doc, reserved = {}, own = {}) {
  // step 1 : nothing to fold
  if (!seedHasMailSettings(doc)) return { doc, folded: false, channel: null, credential: null };
  const mail = doc.settings;
  const settings = { ...mail };
  for (const key of SEED_MAIL_KEYS) delete settings[key];
  // step 2 : no mail server, no mail : only the keys leave
  if (!String(mail.mail_server ?? "").trim()) {
    return { doc: { ...doc, settings }, folded: true, channel: null, credential: null };
  }
  // step 3 : free names, never one the seed declares nor one reserved
  const credentials = doc.credentials ? { ...doc.credentials } : { items: [] };
  credentials.items = [...(credentials.items || [])];
  const channels = doc.notifications ? { ...doc.notifications } : { items: [] };
  channels.items = [...(channels.items || [])];
  // the seed's own record's name when free, else the base or the first free one after it
  const free = (base, taken, ownName) => {
    if (ownName && !taken.has(ownName)) return ownName;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    return name;
  };
  const channel = free("default", new Set([...channels.items.map((c) => c.name), ...(reserved.channels || [])]), own.channel);
  const item = { name: channel, description: "From the config seed's mail settings", type: "mail" };
  if (mail.mail_from !== undefined) item.from_address = mail.mail_from;
  let credential = null;
  if (String(mail.mail_username ?? "").trim()) {
    // step 4 : a login : the smtp credential holds where the mail goes and as whom
    credential = free("mail-login", new Set([...credentials.items.map((c) => c.name), ...(reserved.credentials || [])]), own.credential);
    const cred = { name: credential, description: "The mail server of the config seed's settings", credential_type: "smtp", host: mail.mail_server, user: mail.mail_username };
    if (mail.mail_port !== undefined) cred.port = mail.mail_port;
    if (mail.mail_secure !== undefined) cred.secure = mail.mail_secure;
    if (mail.mail_password !== undefined) cred.password = mail.mail_password;
    credentials.items.push(cred);
    item.credential = credential;
    // its own server, port and TLS declared empty : a seed update writes only the keys it
    // declares, so a channel that was a relay before (the seed without mail_username) would keep
    // its own server next to the credential's
    Object.assign(item, { server: "", port: "", secure: false });
  } else {
    // step 4 : a relay : the channel's own server, port and TLS, no login
    item.server = mail.mail_server;
    if (mail.mail_port !== undefined) item.port = mail.mail_port;
    if (mail.mail_secure !== undefined) item.secure = mail.mail_secure;
    // its credential declared empty (none) : a seed update writes only the keys it declares, so
    // a channel that had a login before (the seed with mail_username) would keep naming that
    // credential, sending to its server as its user, or to nothing once the credential is pruned
    item.credential = "";
  }
  // step 5 : the mail channel
  channels.items.push(item);
  return { doc: { ...doc, settings, credentials, notifications: channels }, folded: true, channel, credential };
}

const oauth2Item = {
  type: "object",
  additionalProperties: false,
  required: ["name", "provider"],
  // its client : its own id and secret, or a credential of the credentials section
  anyOf: [{ required: ["client_id", "client_secret"] }, { required: ["credential"] }],
  properties: {
    name: str,
    description: str,
    provider: str,
    issuer: str,
    tenant_id: str,
    client_id: str,
    client_secret: str,
    credential: str,
    enable: bool,
    // the login page goes straight to it (one provider at most)
    auto_login: bool,
    groupfilter: str,
    redirect_uri: str,
    scope: str,
    auth_url: str,
    token_url: str,
    userinfo_url: str,
    extra: str,
  },
};

// One SSO provider as a repository holds it (lib/repoObjects/sso.js) : an item of the oauth2
// section, without its rule that the client secret or a credential be given - a provider of the
// app is written to git without its secret, which stays in the database (the model still checks
// a new provider has its client : OAuth2.assertClient)
export const ssoProviderItem = (({ anyOf: _client, ...item }) => item)(oauth2Item);

// ---------------------------------------------------------------------------------
// Values a file says otherwise than they are stored.
//
// A field's value as the config seed and a repository's files say it, when the database stores
// it under another (older) name : { field: { stored: { file, deprecated } } } - file the value a
// file says (and the app writes), deprecated the version since which the stored value said in a
// file is deprecated (still read, the same meaning ; said where it is read). The one map for the
// seed (lib/seed.js) and a repository's entries (lib/repoObjects/fields.js values).
// ---------------------------------------------------------------------------------

// an SSO provider's type : Microsoft Entra ID is entraid in a file ; the database, the sign-in and
// the API keep azuread, its name of before (a role's members say entraid/ the same way)
export const OAUTH2_VALUES = { provider: { azuread: { file: "entraid", deprecated: "7.8.0" } } };

/**
 * An object's values as a file says them : each stored value of a field the map names given its
 * file value (the app writes it so).
 *
 * Args:
 *   obj (object): the object, its values as stored.
 *   values (object): the map ({ field: { stored: { file } } }) ; none : the object as it is.
 *
 * Returns:
 *   object: a copy with the file values ; the object itself when the map changes nothing.
 */
export function fileValuesOf(obj, values = {}) {
  let out = obj;
  for (const [field, map] of Object.entries(values)) {
    const to = map[obj?.[field]]?.file;
    if (to !== undefined) out = { ...out, [field]: to };
  }
  return out;
}

/**
 * An object's values as they are stored : each file value of a field the map names given its
 * stored value ; a stored value a file still says (deprecated) kept, said once per field and value.
 *
 * Args:
 *   obj (object): the object, as a file (or the seed) gives it.
 *   values (object): the map ({ field: { stored: { file, deprecated } } }) ; none : the object as it
 *     is.
 *
 * Returns:
 *   object: { object (a copy with the stored values ; the object itself when the map changes
 *     nothing), deprecated ([{ field, value, use, since }] : the deprecated values it says) }.
 */
export function storedValuesOf(obj, values = {}) {
  let object = obj;
  const deprecated = [];
  for (const [field, map] of Object.entries(values)) {
    const value = obj?.[field];
    for (const [stored, { file, deprecated: since }] of Object.entries(map)) {
      if (value === file) object = { ...object, [field]: stored };
      else if (value === stored && since) deprecated.push({ field, value, use: file, since });
    }
  }
  return { object, deprecated };
}

/**
 * What a deprecated value says (storedValuesOf), the pull output's and the server log's words.
 *
 * Args:
 *   d (object): { field, value, use, since }.
 *
 * Returns:
 *   string: the notice.
 */
export const deprecatedValueNotice = (d) => `${d.field}: ${d.value} is deprecated since ${d.since} and removed in 8: read as ${d.field}: ${d.use}, declare that instead`;

/**
 * The config seed's sso items with their values as stored (storedValuesOf, OAUTH2_VALUES) :
 * provider: entraid applied as azuread, provider: azuread still read, listed as deprecated (warned
 * by the caller). Returns a new document.
 *
 * Args:
 *   doc (object): the seed document.
 *
 * Returns:
 *   { doc: object, deprecated: { name, notice }[] }: the document, and each item's deprecated value
 *     with what it says.
 */
export function foldOauth2Values(doc) {
  if (!Array.isArray(doc?.sso?.items)) return { doc, deprecated: [] };
  const deprecated = [];
  const items = doc.sso.items.map((item) => {
    const stored = storedValuesOf(item, OAUTH2_VALUES);
    deprecated.push(...stored.deprecated.map((d) => ({ name: item?.name, notice: deprecatedValueNotice(d) })));
    return stored.object;
  });
  return { doc: { ...doc, sso: { ...doc.sso, items } }, deprecated };
}

const repositoryItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "uri"],
  properties: {
    name: str,
    description: str,
    uri: str,
    branch: str,
    user: str,
    password: str,
    // a credential of the credentials section (or the app), used instead of user/password
    credential: str,
    // what the app reads from it : every usage type's flag (lib/repoObjects/types.js)
    ...Object.fromEntries(USAGE_TYPES.map((t) => [t.flag, bool])),
    // deprecated since 7.8.0, removed in 8 : the roles, the categories and the constants at once
    // (foldConfigFlag)
    use_for_config: bool,
    rebase_on_start: bool,
    cron: str,
    // status, pull_status, push_status, pull_output, push_output, pulled_at, pushed_at and head
    // are runtime state written by git, never declared
  },
};

// a syslog server of Connections > Syslog : where the server log and the audit entries go
const syslogServerItem = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: str,
    description: str,
    host: str,
    port: strOrInt,
    protocol: { type: "string", enum: ["udp4", "udp6", "tcp4", "tcp6", "tls4", "tls6", "unix", "unix-connect"] },
    path: str,
    level: { type: "string", enum: ["emerg", "alert", "crit", "error", "warning", "notice", "info", "debug"] },
    type: { type: "string", enum: ["BSD", "5424"] },
    app_name: str,
    source: str,
    receives: { type: "string", enum: ["log", "audit", "both"] },
    enabled: bool,
  },
};

// a notification channel of Connections > Notifications : an SMTP server, Slack, Teams, Telegram or
// a webhook ; which fields apply is up to its type (models/notificationChannel)
const notificationChannelItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type"],
  properties: {
    name: str,
    description: str,
    type: { type: "string", enum: ["mail", "slack", "teams", "telegram", "webhook"] },
    enabled: bool,
    is_active: bool,
    server: str,
    port: strOrInt,
    secure: bool,
    from_address: str,
    // mail : an smtp credential, or an entraid one (Microsoft 365, sending as from_address)
    credential: str,
    // mail with an entraid credential : Microsoft Graph (the default) or SMTP with OAuth2
    send_through: { type: "string", enum: ["graph", "smtp"] },
    webhook_url: str,
    chat_id: strOrInt,
    api_url: str,
    token_credential: str,
    url: str,
    method: { type: "string", enum: ["POST", "PUT"] },
    headers: str,
    verify_tls: bool,
    payload: str,
  },
};

const listSection = (item) => ({
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    // false (the default) releases undeclared managed records ; true deletes them
    prune: bool,
    items: { type: "array", items: item },
  },
});

// EVERY field is required, and that is the point.
//
// ldap and settings are single-row sections: the `managed` flag is one flag on one row, so
// the API refuses the WHOLE row. If the seed were allowed to declare a subset, it would
// freeze fields it never writes - a seed setting only `url` made the Mail page answer 403
// for SMTP changes that nothing would ever revert, and a seed omitting `enable` produced a
// managed, disabled LDAP that could not be switched on from anywhere.
//
// Requiring everything is verbose, but it makes the file the complete truth about the row
// and the refusal honest. It also removes the earlier trap in the other direction: nothing
// is silently defaulted, so the seed cannot blank a field the operator forgot to think about.
// The chat assistant's model provider - a single row too, so every field is required for
// the same reason as ldap. `api_key` is written as ${SOME_ENV_VAR} like every secret.
const chatSection = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "api_key", "base_url", "model", "max_turns", "max_tool_rounds",
             "timeout_seconds", "allow_job_status"],
  properties: {
    provider: { type: "string", enum: ["", ...CHAT_PROVIDERS] },
    api_key: str,
    // an api credential of the credentials section whose password is the key, instead of api_key
    // (optional : omitted leaves the column alone)
    credential: str,
    base_url: str,
    model: str,
    max_turns: strOrInt,
    max_tool_rounds: strOrInt,
    timeout_seconds: strOrInt,
    allow_job_status: bool,
    // how to talk to an OpenAI-compatible provider or a proxy. Optional, unlike the rest :
    // omitted means "leave the column alone", like ldap's groupfilter
    auth_type: { type: "string", enum: ["", "bearer", "api-key", "x-api-key", "none"] },
    api_version: str,
    request_user: str,
    ignore_certs: bool,
    extra_headers: { type: ["object", "string"] },
  },
};

const ldapSection = {
  type: "object",
  additionalProperties: false,
  required: ["server", "port", "ignore_certs", "enable_tls", "cert", "ca_bundle",
             "bind_user_dn", "bind_user_pw", "search_base", "username_attribute",
             "groups_attribute", "enable", "groups_search_base", "group_class",
             "group_member_attribute", "group_member_user_attribute", "mail_attribute"],
  properties: {
    server: str,
    port: strOrInt,
    ignore_certs: bool,
    enable_tls: bool,
    cert: str,
    ca_bundle: str,
    bind_user_dn: str,
    bind_user_pw: str,
    // a credential of the credentials section to bind with instead (optional : the user and
    // password above are still declared)
    // what it is, for the list and its page
    description: str,
    credential: str,
    search_base: str,
    username_attribute: str,
    groups_attribute: str,
    enable: bool,
    groups_search_base: str,
    group_class: str,
    group_member_attribute: str,
    group_member_user_attribute: str,
    mail_attribute: str,
    // The one field NOT in `required`, and the only exception to the rule above. It arrives
    // after seed files are already in use : requiring it would reject every seed written
    // before it existed, on upgrade, with a validation error about a field the operator has
    // never heard of. Omitted means "leave the column alone" - applyLdap only writes keys
    // the seed declared - which is the same as the empty filter it defaults to.
    groupfilter: str,
  },
};

// One LDAP directory as a repository holds it (lib/repoObjects/ldap.js, one file per directory) :
// the fields of the ldap section above, and the directory's own - its name (main is the one the
// ldap section is), its place in the lookup order, its sign-in domains. Only the name is required :
// a file declares what it owns, as the list sections' items do, so the main directory's file is the
// ldap section with `name: main`.
export const ldapDirectoryItem = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$" },
    position: strOrInt,
    domains: str,
    ...ldapSection.properties,
  },
};

// The chat assistant's settings as a repository holds them (lib/repoObjects/chatAssistant.js, its chat_assistant: map) :
// what the Chat assistant page saves - its switch (enable_chat : the ENABLE_CHAT environment
// setting, named as its variable in lower case, as the Defaults page's default_language) first, then
// the chat section's fields - none required : a file declares what it owns, its api key left out
// when the app's stays in the database. The config seed's chat section stays as it is : the switch
// is an environment setting, never the seed's (lib/seed.js applies the provider row only).
export const chatFileItem = (({ required: _all, properties, ...section }) => ({ ...section, properties: { enable_chat: bool, ...properties } }))(chatSection);

// The Settings > Appearance pages a repository holds one file each of (lib/repoObjects/defaults.js,
// logo.js, icon.js, name.js) and the config seed one section each of : what each page saves, and
// nothing else. Every field optional : what is not declared is left alone. What the seed declares
// is its own, field by field : read only in the app (lib/seedManaged.js), released when it is no
// longer declared or the seed is turned off.
const appearanceSection = (properties) => ({ type: "object", additionalProperties: false, properties });

// Settings > Appearance > Defaults : the theme and its colour, the forms view, the time zone, the
// date format, the language (a repository's defaults: map, the seed's defaults section)
export const defaultsSection = appearanceSection({
  default_theme: { type: "string", enum: ["system", "light", "dark"] },
  default_theme_color: str,
  default_forms_view: str,
  default_timezone: str,
  default_date_format: str,
  default_language: str,
});

// Settings > Appearance > Logo and Icon : an image file's path, relative to the seed file (or the
// repository's logo: and icon: maps), read as binary and checked as an upload is ; empty : the
// bundled one
export const logoSection = appearanceSection({ logo: str });
export const iconSection = appearanceSection({ icon: str });

// Settings > Appearance > Name : the app's name (a repository's name: map, the seed's name section)
export const nameSection = appearanceSection({ app_name: str });

// The header's links (Settings > Appearance > Links) : its own links and whether the Designer's
// shows. Every field optional ; what the seed declares is its own, field by field, as the other
// Appearance pages' (lib/seedManaged.js).
export const linksSection = appearanceSection({
  // { label, url, icon, newTab, id, parent } each, as Settings > Appearance > Links keeps them
  header_links: { type: ["array", "string"] },
  show_designer: bool,
});

// the seed's sections held field by field, one per Settings > Appearance page, in the menu's
// order (lib/seedManaged.js) : the seed key of each, its schema
export const APPEARANCE_SECTIONS = { defaults: defaultsSection, logo: logoSection, icon: iconSection, name: nameSection, links: linksSection };

// the keys of those sections named otherwise than the field they set (lib/repoObjects/yamlKeys.js),
// { key: field } per section : the forms view is default_forms_view in a file, as its siblings,
// and forms_view in the settings row, the API and the page (the fields the seed holds by that name)
export const APPEARANCE_KEYS = { defaults: { default_forms_view: "forms_view" } };

// The MCP server's settings (Settings > Connections > MCP) : its switch and its options, keyed by
// their environment variable names in lower case (enable_mcp, mcp_read_only ...), as a repository's
// controller_mcp: map holds them.
// What the seed declares is its own, variable by variable, as the Appearance pages' fields
// (lib/seedManaged.js) ; each checked as the page's Save checks it when applied.
// The SSH page (Settings > Connections > SSH) : the app's private key (its public key made from
// it) and the known hosts, the servers it trusts, one line of a known_hosts file each. A repository's
// controller_ssh: map holds the same, its private key an ${ENV} reference only ; either left out
// stays as the app has it, an empty known_hosts list clears them.
export const sshSection = {
  type: "object",
  additionalProperties: false,
  properties: {
    private_key: { type: "string", minLength: 1 },
    known_hosts: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

export const mcpSection = {
  type: "object",
  propertyNames: { pattern: "^(enable_mcp|mcp_[a-z0-9_]+)$" },
  additionalProperties: { type: ["string", "number", "boolean"] },
};

// An announcement under the header (Settings > Appearance > Announcements) : named, so a seed or a
// repository finds it again ; its message, type, switch, and when it starts and ends showing (ISO
// moments, UTC when they carry no zone)
const announcementItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "message"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    message: str,
    level: { type: "string", enum: ["info", "warning", "danger"] },
    enabled: bool,
    start_at: str,
    end_at: str,
  },
};

// A version of the disclaimer users accept (Settings > Access > Disclaimer) : its number, title,
// text and checkbox label, and whether it is the one in force (enabled : the disclaimer on, this
// version asked). A changed text is a correction of that version ; with ask_again: true, everyone
// who accepted it is asked again - as the app's save offers both. Acceptances are never declared.
export const disclaimerItem = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { type: "integer", minimum: 1 },
    title: str,
    text: str,
    checkbox_label: str,
    enabled: bool,
    ask_again: bool,
  },
};

// a section of named items the seed makes or changes (never deletes : they are not managed)
const itemsSection = (item) => ({
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: item } },
});

// The public url, and the mail fields of before 7.6 (deprecated, removed in 8 : the settings row
// has no mail columns any more, foldMailSettingsIntoChannel makes them a mail channel and its
// smtp credential). The settings row also holds config_yaml, the logo and the theme defaults -
// those are not seed material and stay editable, which is what the field-scoped refusal in
// settings.controller.js protects.
//
// The url is required, for the reason spelled out above ldapSection: this is a single-row
// section, so declaring it means owning all of it. The mail fields are optional now.
// a database of Connections > Databases : the databases forms query (a field's dbConfig names one).
// Its name, what it is, and the credential of type database it connects with (of the credentials
// section, or one made in the app), which holds its engine, server, database and login
const databaseItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "credential"],
  properties: {
    name: str,
    description: str,
    credential: { type: "string", minLength: 1 },
  },
};

// a label beside the header's logo (Settings > Appearance > Labels) : its text, its colour (one
// of the app's pill tones), shown or not, its place among the others (lowest first)
const labelItem = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 40 },
    color: { type: "string", enum: ["blue", "green", "amber", "orange", "red", "grey"] },
    enabled: bool,
    position: { type: "integer" },
  },
};

// a local group of Settings > Access > Groups : its name, what it is for, and the local users in
// it (their usernames) - a group holds its members, the users' entries say nothing of their groups
export const groupItem = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: str,
    users: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

// a user of Settings > Access > Users : a local one (type local, the default) with its email, what
// it is, its password as an ${ENV} reference (hashed when read ; none : set in the app) and its
// sign-in blocked or not ; or one of a directory (ldap, entraid, oidc), of which only what the app
// owns is said - what it is and whether it is blocked : the rest comes from its directory
export const userItem = {
  type: "object",
  additionalProperties: false,
  required: ["username"],
  properties: {
    username: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["local", "ldap", "entraid", "oidc"] },
    email: str,
    description: str,
    password: str,
    blocked: bool,
  },
};

const settingsSection = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    // deprecated since 7.6, removed in 8 : a mail channel (foldMailSettingsIntoChannel)
    mail_server: str,
    mail_port: strOrInt,
    mail_secure: bool,
    mail_username: str,
    mail_password: str,
    mail_from: str,
    url: str,
  },
};

export const seedSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    awx: listSection(awxItem),
    secret_stores: listSection(secretStoreItem),
    runners: listSection(runnerItem),
    credentials: listSection(credentialItem),
    databases: listSection(databaseItem),
    // the local groups (their members) and the users, local and of a directory : applied through
    // the repository types' descriptors (lib/repoObjects/groups.js, users.js), made or changed
    groups: listSection(groupItem),
    users: listSection(userItem),
    sso: listSection(oauth2Item),
    repositories: listSection(repositoryItem),
    syslog: listSection(syslogServerItem),
    notifications: listSection(notificationChannelItem),
    labels: listSection(labelItem),
    ldap: ldapSection,
    settings: settingsSection,
    chat_assistant: chatSection,
    defaults: defaultsSection,
    logo: logoSection,
    icon: iconSection,
    name: nameSection,
    links: linksSection,
    mcp: mcpSection,
    ssh: sshSection,
    announcements: itemsSection(announcementItem),
    disclaimer: itemsSection(disclaimerItem),
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validator = ajv.compile(seedSchema);

// ajv cannot express "unique by property", and duplicate names are not a harmless
// typo here : the second entry silently wins the upsert while the first is counted
// as declared, so a prune would spare a record nobody can see in the file.
function assertUniqueNames(doc) {
  for (const key of ["runners", "secret_stores", "credentials", "databases", "sso", "repositories", "syslog", "notifications", "labels", "announcements"]) {
    const items = doc[key]?.items;
    if (!Array.isArray(items)) continue;
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
      if (seen.has(item.name)) duplicates.add(item.name);
      seen.add(item.name);
    }
    if (duplicates.size) {
      throw new Error(`Seed file declares duplicate ${key} names: ${[...duplicates].sort().join(", ")}`);
    }
  }
}

/**
 * Flags that only ONE record may hold. Two items claiming the same one never converge:
 * each apply zeroes the others and sets the last, so the next boot finds the earlier one
 * differing, updates it, and the flag alternates for ever - an "updated" count and an
 * audit row on every restart, with the effective default flapping. ajv cannot express
 * this, same as the duplicate-name rule.
 */
function assertSingletonFlags(doc) {
  // one default runner per type : the default rte for playbooks, the default awx for templates
  const defaultsByType = {};
  for (const item of doc.runners?.items || []) {
    if (!item.is_default) continue;
    (defaultsByType[item.type] = defaultsByType[item.type] || []).push(item.name);
  }
  for (const [type, names] of Object.entries(defaultsByType)) {
    if (names.length > 1) {
      throw new Error(`Seed file declares is_default on more than one runner of type ${type}: ${names.sort().join(", ")}`);
    }
  }
  const byProvider = {};
  // by the provider's type as stored (entraid and azuread are one), named as a file says it
  for (const item of doc.sso?.items || []) {
    if (!item.enable) continue;
    const provider = fileValuesOf(storedValuesOf(item, OAUTH2_VALUES).object, OAUTH2_VALUES).provider;
    (byProvider[provider] = byProvider[provider] || []).push(item.name);
  }
  for (const [provider, names] of Object.entries(byProvider)) {
    if (names.length > 1) {
      throw new Error(`Seed file enables more than one '${provider}' SSO provider: ${names.sort().join(", ")}`);
    }
  }
  // one repository per object type (the schedules, the credentials ...) : the objects are written
  // back to it, they cannot go to two
  for (const flag of ONE_ONLY_FLAGS) {
    const names = (doc.repositories?.items || []).filter((item) => item[flag]).map((item) => item.name);
    if (names.length > 1) {
      throw new Error(`Seed file declares ${flag} on more than one repository: ${names.sort().join(", ")}`);
    }
  }
  // one disclaimer version of each number, one at most in force
  const versions = (doc.disclaimer?.items || []).map((item) => item.version);
  const twice = versions.filter((v, i) => versions.indexOf(v) !== i);
  if (twice.length) throw new Error(`Seed file declares disclaimer version ${[...new Set(twice)].join(", ")} more than once`);
  const enabled = (doc.disclaimer?.items || []).filter((item) => item.enabled).map((item) => item.version);
  if (enabled.length > 1) throw new Error(`Seed file enables more than one disclaimer version: ${enabled.join(", ")}`);
}

/**
 * The messages of a schema validation, one string : each error's path and message, the key an
 * additionalProperties error is about named (ajv's own message does not say which one).
 *
 * Args:
 *   errors (object[]): ajv's errors.
 *
 * Returns:
 *   string: the messages, apart by ' ; '.
 */
export function schemaErrors(errors) {
  return (errors || [])
    .map((e) => {
      // ajv's own message for additionalProperties is 'must NOT have additional
      // properties', which does not say WHICH one - useless when the whole point of
      // rejecting unknown keys is to point at the typo. The name is in params.
      const extra = e.params?.additionalProperty ? ` '${e.params.additionalProperty}'` : "";
      return `${e.instancePath || "/"} ${e.message}${extra}`;
    })
    .join(" ; ");
}

/**
 * A validator of one item of a list section (credentials, runners ...), as the seed checks it :
 * what the repository-backed objects check their files with (lib/repoObjects).
 *
 * Args:
 *   section (string|object): the section (credentials), or an item's own schema (an LDAP
 *     directory's, ldapDirectoryItem).
 *
 * Returns:
 *   object: { validate (function : item => string[] of errors), keys (the item's fields, in
 *     the schema's order), schema (its JSON schema) }.
 */
export function itemValidator(section) {
  const schema = typeof section === "string" ? seedSchema.properties[section].properties.items.items : section;
  const check = ajv.compile(schema);
  return {
    schema,
    keys: Object.keys(schema.properties),
    validate: (item) => (check(item) ? [] : [schemaErrors(check.errors)]),
  };
}

// Validates the parsed seed document. Throws with every message combined, so one
// restart tells the operator everything that is wrong instead of the first thing.
// opts : { held, inDatabase } - the repositories holding the configuration's keys in the database
// now and whether it is kept there, as the apply folds use_for_config with them (foldConfigFlag) :
// a seed is refused only for what the apply would really give ; none (a fresh database) as before
// The seed's sections named as the repository's keys since 7.8.0 (controller_sso:, controller_syslog:,
// controller_notifications:, controller_chat_assistant:) : their names before, still read,
// deprecated and removed in 8. { old name: section }
export const SECTION_ALIASES = { oauth2: "sso", syslog_servers: "syslog", notification_channels: "notifications", chat: "chat_assistant" };

/**
 * The seed with its sections under their names : a section given by its name before
 * (SECTION_ALIASES) read as its section.
 *
 * Args:
 *   doc (object): the seed.
 *
 * Returns:
 *   object: { doc (the seed, its sections renamed), renamed ([old, section] pairs, to be said) }.
 *
 * Raises:
 *   Error: a section given by both names.
 */
export function foldSectionAliases(doc) {
  if (!doc || typeof doc !== "object") return { doc, renamed: [] };
  const renamed = Object.entries(SECTION_ALIASES).filter(([old]) => Object.hasOwn(doc, old));
  if (!renamed.length) return { doc, renamed };
  const both = renamed.filter(([, section]) => Object.hasOwn(doc, section));
  if (both.length) throw new Error(`Seed file validation failed: ${both.map(([old, section]) => `${section}: and ${old}: are the same section, give it once as ${section}:`).join("; ")}`);
  const out = { ...doc };
  for (const [old, section] of renamed) {
    out[section] = out[old];
    delete out[old];
  }
  return { doc: out, renamed };
}

export function validateSeed(doc, opts = {}) {
  // a section by its name before : checked as its section (said when the seed is applied)
  doc = foldSectionAliases(doc).doc;
  if (!validator(doc)) {
    const details = schemaErrors(validator.errors);
    throw new Error(`Seed file validation failed: ${details}`);
  }
  // the deprecated awx: items count as runners for the cross-item rules, and the deprecated mail
  // keys of the settings as the channel and credential they become
  const folded = foldMailSettingsIntoChannel(foldAwxIntoRunners(doc)).doc;
  // a repository's use_for_config counts as the three flags it is now
  const flags = foldConfigFlag(folded, opts.held || [], { inDatabase: !!opts.inDatabase }).doc;
  assertUniqueNames(flags);
  assertSingletonFlags(flags);
  return true;
}

// Replaces ${VAR} in every string value with the environment variable of that name.
// Unresolved references are collected and reported together : applying a seed with a
// literal '${SEED_LDAP_PW}' as the bind password would store that string as the
// credential, so this has to be an error rather than a warning.
export function interpolateEnv(value, env = process.env) {
  const missing = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
        if (env[name] === undefined) {
          missing.add(name);
          return match;
        }
        return env[name];
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  const result = walk(value);
  if (missing.size > 0) {
    throw new Error(`Seed file references undefined environment variables: ${[...missing].sort().join(", ")}`);
  }
  return result;
}

export default { seedSchema, validateSeed, interpolateEnv };
