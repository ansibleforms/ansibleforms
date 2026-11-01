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
      "rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault"] },
    client_cert: str,
    client_key: str,
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
    use_for_config: bool,
    use_for_forms: bool,
    use_for_playbooks: bool,
    use_for_workflows: bool,
    use_for_inventories: bool,
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
    credential: str,
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

// Only the mail fields and the public url. The settings row also holds forms_yaml, the logo
// and the theme defaults - those are not seed material and stay editable, which is what the
// field-scoped refusal in settings.controller.js protects.
//
// All seven are required, for the reason spelled out above ldapSection: this is a single-row
// section, so declaring it means owning all of it.
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

const settingsSection = {
  type: "object",
  additionalProperties: false,
  required: ["mail_server", "mail_port", "mail_secure", "mail_username", "mail_password",
             "mail_from", "url"],
  properties: {
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
    oauth2: listSection(oauth2Item),
    repositories: listSection(repositoryItem),
    syslog_servers: listSection(syslogServerItem),
    notification_channels: listSection(notificationChannelItem),
    labels: listSection(labelItem),
    ldap: ldapSection,
    settings: settingsSection,
    chat: chatSection,
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validator = ajv.compile(seedSchema);

// ajv cannot express "unique by property", and duplicate names are not a harmless
// typo here : the second entry silently wins the upsert while the first is counted
// as declared, so a prune would spare a record nobody can see in the file.
function assertUniqueNames(doc) {
  for (const key of ["runners", "secret_stores", "credentials", "databases", "oauth2", "repositories", "syslog_servers", "notification_channels", "labels"]) {
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
  for (const item of doc.oauth2?.items || []) {
    if (!item.enable) continue;
    (byProvider[item.provider] = byProvider[item.provider] || []).push(item.name);
  }
  for (const [provider, names] of Object.entries(byProvider)) {
    if (names.length > 1) {
      throw new Error(`Seed file enables more than one '${provider}' oauth2 provider: ${names.sort().join(", ")}`);
    }
  }
}

// Validates the parsed seed document. Throws with every message combined, so one
// restart tells the operator everything that is wrong instead of the first thing.
export function validateSeed(doc) {
  if (!validator(doc)) {
    const details = (validator.errors || [])
      .map((e) => {
        // ajv's own message for additionalProperties is 'must NOT have additional
        // properties', which does not say WHICH one - useless when the whole point of
        // rejecting unknown keys is to point at the typo. The name is in params.
        const extra = e.params?.additionalProperty ? ` '${e.params.additionalProperty}'` : "";
        return `${e.instancePath || "/"} ${e.message}${extra}`;
      })
      .join(" ; ");
    throw new Error(`Seed file validation failed: ${details}`);
  }
  // the deprecated awx: items count as runners for the cross-item rules
  const folded = foldAwxIntoRunners(doc);
  assertUniqueNames(folded);
  assertSingletonFlags(folded);
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
