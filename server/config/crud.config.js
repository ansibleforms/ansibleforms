// Central config for all CRUD models
const crudConfigs = {

  oauth2: {
    table: 'AnsibleForms.oauth2_providers',
    fields: [
      { name: 'id', isKey: true },
      { name: 'provider', required: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'description' },
      { name: 'issuer' },
      { name: 'tenant_id'},
      // required unless a credential gives them (OAuth2.assertClient)
      { name: 'client_id' },
      { name: 'client_secret', isEncrypted: true },
      // a credential of Connections > Credentials : its user the client id, its password the secret
      { name: 'credential' },
      { name: 'enable', isBoolean: true },
      // the login page goes straight to it (Skip the login page) : one provider at most
      { name: 'auto_login', isBoolean: true },
      { name: 'groupfilter' },
      { name: 'redirect_uri' },
      { name: 'scope' },
      { name: 'auth_url' },
      { name: 'token_url' },
      { name: 'userinfo_url' },
      { name: 'extra' },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: false
  },
  credential: {
    table: 'AnsibleForms.credentials',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'user' },
      { name: 'password', isEncrypted: true },
      { name: 'host' },
      { name: 'port' },
      { name: 'db_name' },
      { name: 'secure', isBoolean: true },
      { name: 'is_database', isBoolean: true, setDefault: true },
      // what it is for : ssh, git, api or database (is_database follows it)
      { name: 'credential_type' },
      // a cyberark credential's client certificate and key (PEM) : how its AppID is restricted ;
      // an entraid one's certificate and key, signing in with it instead of its secret (mail) ;
      // an ssh credential's private key (PEM or OpenSSH) is its client_key too
      { name: 'client_cert' },
      { name: 'client_key', isEncrypted: true },
      // the passphrase of an ssh credential's private key
      { name: 'key_passphrase', isEncrypted: true },
      // an entraid credential's tenant
      { name: 'tenant_id' },
      // an oidc credential's issuer ; an entraid or oidc one's redirect URL
      { name: 'issuer' },
      { name: 'redirect_uri' },
      // the address of the one server a runner's or a secret store's credential logs in to : that
      // record's address and TLS are the credential's
      { name: 'url' },
      // an ldap credential's TLS : certificates not checked, the CA bundle (its client certificate
      // is client_cert) ; a runner's or a secret store's for its url
      { name: 'ignore_certs', isBoolean: true },
      { name: 'ca_bundle' },
      // the digest of the ca_bundle an RTE's certificate was stored as : written by the RTE hub
      // only (Credential.update strips it from any other write), read freely
      { name: 'rte_cert_sha256' },
      { name: 'description' },
      { name: 'db_type' },
      { name: 'vault_path' },
      { name: 'secret_store' },
      { name: 'secret_ref' },
      { name: 'managed', isBoolean: true },
      // the credentials repository and the file (credentials/<file>.yaml) it comes from : written
      // by lib/repoObjects alone (isRepoLink : never from a request body), NULL for one kept in the
      // app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  // Where a job runs : an RTE (runtime environment container) for playbooks, AWX/AAP/Ascender
  // for templates. Which fields a type uses is up to its runner in src/runners.
  runner: {
    table: 'AnsibleForms.runners',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'type', required: true },
      { name: 'description' },
      // its own address : an RTE's, or an other type's until its credential carries one
      // (setDefault : the column is NOT NULL)
      { name: 'uri', setDefault: true },
      { name: 'token', isEncrypted: true },
      { name: 'username' },
      { name: 'password', isEncrypted: true },
      { name: 'use_credentials', isBoolean: true },
      // a credential of Connections > Credentials it signs in with (Runner.withCredential) ; its own
      // token, user and password above only while it has none
      { name: 'credential' },
      { name: 'ignore_certs', isBoolean: true },
      { name: 'ca_bundle' },
      { name: 'is_default', isBoolean: true },
      // an awx runner : AWX (none), 'aap' or 'ascender' - which product it is
      { name: 'flavour' },
      // a semaphore runner : the project id ; a rundeck runner : the project name
      { name: 'project' },
      { name: 'managed', isBoolean: true },
      { name: 'node_id' },
      // an RTE : how it talks to the app - database (deprecated), outbound (it dials the app) or
      // inbound (the app dials it) ; none : database
      { name: 'rte_mode' },
      // turned off, no job goes to it
      { name: 'enabled', isBoolean: true },
      // an RTE that asked to join, waiting for an admin's approval : since when, and what it said
      // of itself (host, address, mode, version, its token's fingerprint), as JSON
      { name: 'pending', isBoolean: true },
      { name: 'pending_since' },
      { name: 'pending_info' },
      // the digest of the ca_bundle its RTE's certificate was stored as : the RTE hub's only
      { name: 'rte_cert_sha256' },
      // a socket-mode RTE's settings, sent over its socket (rte/socket/settings.js) ; empty : the
      // default
      { name: 'rte_max_jobs' },
      { name: 'rte_cache_mb' },
      { name: 'rte_files' },
      { name: 'rte_drain_seconds' },
      // the runners repository and the file (runners/<file>.yaml) it comes from : written by
      // lib/repoObjects alone (isRepoLink : never from a request body)
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  // The databases forms query (Connections > Databases) : a field's dbConfig names one. A name of
  // its own and the credential of type database it connects with, as a runner names the credential
  // it signs in with : its engine, server, database and login are the credential's
  // (models/database.model.js)
  database: {
    table: 'AnsibleForms.databases',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'description' },
      // a credential of Connections > Credentials, of type database
      { name: 'credential', required: true },
      { name: 'managed', isBoolean: true },
      // the databases repository and the file it comes from : written by lib/repoObjects alone
      // (isRepoLink : never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  // Where notifications go (Connections > Notifications) : SMTP servers (one active, the one the
  // app sends its mail with), Slack, Teams, Telegram and webhooks (models/notificationChannel)
  notificationchannel: {
    table: 'AnsibleForms.notification_channels',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'description' },
      { name: 'type', required: true },
      { name: 'enabled', isBoolean: true },
      { name: 'is_active', isBoolean: true },
      { name: 'server' },
      { name: 'port' },
      { name: 'secure', isBoolean: true },
      { name: 'from_address' },
      // an smtp credential, or an entraid one for Microsoft 365 : then how it sends (graph, smtp)
      { name: 'credential' },
      { name: 'send_through' },
      { name: 'webhook_url', isEncrypted: true },
      { name: 'chat_id' },
      { name: 'api_url' },
      { name: 'token_credential' },
      { name: 'url' },
      { name: 'method' },
      { name: 'headers' },
      { name: 'verify_tls', isBoolean: true },
      { name: 'payload' },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  // the syslog servers the server log and the audit entries are sent to (Connections > Syslog,
  // lib/syslogServers.js)
  // the labels beside the header's logo (Settings > Appearance > Labels) : PRODUCTION, EU...
  label: {
    table: 'AnsibleForms.labels',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'color' },
      { name: 'enabled', isBoolean: true },
      { name: 'position' },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  syslogserver: {
    table: 'AnsibleForms.syslog_servers',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'description' },
      { name: 'host' },
      { name: 'port' },
      { name: 'protocol' },
      { name: 'path' },
      { name: 'level' },
      { name: 'type' },
      { name: 'app_name' },
      { name: 'source' },
      { name: 'receives' },
      { name: 'enabled', isBoolean: true },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  // HashiCorp Vault, CyberArk, ... : where credentials read their user and password from.
  // Which fields a type uses is up to its provider in src/secrets/providers.
  secretstore: {
    table: 'AnsibleForms.secret_stores',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'type', required: true },
      { name: 'description' },
      // its own address : empty once its credential carries one (setDefault : the column is NOT NULL)
      { name: 'url', setDefault: true },
      { name: 'token', isEncrypted: true },
      // a credential of Connections > Credentials whose password is a Vault's token, instead
      // of its own token
      { name: 'credential' },
      { name: 'namespace' },
      { name: 'kv_version' },
      { name: 'default_mount' },
      { name: 'app_id' },
      { name: 'client_cert' },
      { name: 'client_key', isEncrypted: true },
      { name: 'ignore_certs', isBoolean: true },
      { name: 'ca_bundle' },
      { name: 'cache_ttl_seconds' },
      { name: 'extra' },
      // a credential's secret may be written to it, below its prefix (secrets/providers write)
      { name: 'write_enabled', isBoolean: true },
      { name: 'write_prefix' },
      // a CyberArk's writes : its PVWA, the API user's credential and logon method, the platform of
      // a new account
      { name: 'pvwa_url' },
      { name: 'pvwa_credential' },
      { name: 'pvwa_auth' },
      { name: 'platform_id' },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  groups: {
    table: 'AnsibleForms.groups',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      // what the group is for, or who owns it
      { name: 'description' },
      // the groups repository and the file it comes from : written by lib/repoObjects alone
      // (isRepoLink : never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  users: {
    table: 'AnsibleForms.users',
    fields: [
      { name: 'id', isKey: true },
      { name: 'username', isNaturalKey: true, required: true },
      { name: 'password', required: true }, // Special handling needed - async hashing
      { name: 'email', setDefault: true }, // Default to empty string
      // who the user is or what the account is for (a service account)
      { name: 'description' },
      { name: 'group_id', required: true },
      // its sign-in blocked by an admin : read with the user, written by User.setBlocked alone
      // (POST /api/v2/user/:id/block), never by a create or an update
      { name: 'blocked' },
      // its latest sign-in : read with the user, written by User.recordSignIn alone (at each
      // sign-in, lib/signInGate.js), never by a create or an update
      { name: 'last_login', isDatetime: true },
      // the users repository and the file it comes from : written by lib/repoObjects alone
      // (isRepoLink : never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: false
  },
  repositories: {
    table: 'AnsibleForms.repositories',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      { name: 'uri', required: true },
      { name: 'branch' },
      { name: 'user' },
      { name: 'password', isEncrypted: true, setDefault: true },
      { name: 'description' },
      // the roles, the categories and the constants, each from its own file (lib/configKeys.js) ;
      // the Config usage of before (use_for_config) is split into them
      { name: 'use_for_roles', isBoolean: true },
      { name: 'use_for_categories', isBoolean: true },
      { name: 'use_for_constants', isBoolean: true },
      { name: 'use_for_forms', isBoolean: true },
      { name: 'use_for_playbooks', isBoolean: true },
      { name: 'use_for_workflows', isBoolean: true },
      { name: 'use_for_inventories', isBoolean: true },
      // the schedules in its schedules folder, one YAML file each (models/scheduleRepo.model.js)
      { name: 'use_for_schedules', isBoolean: true },
      // the objects it holds, one YAML file each in the type's folder (lib/repoObjects) : one
      // repository at most per type ; those of a later version are refused when turned on
      { name: 'use_for_repositories', isBoolean: true },
      { name: 'use_for_credentials', isBoolean: true },
      { name: 'use_for_secret_stores', isBoolean: true },
      { name: 'use_for_databases', isBoolean: true },
      { name: 'use_for_groups', isBoolean: true },
      { name: 'use_for_users', isBoolean: true },
      { name: 'use_for_runners', isBoolean: true },
      { name: 'use_for_notifications', isBoolean: true },
      { name: 'use_for_sso', isBoolean: true },
      { name: 'use_for_ldap', isBoolean: true },
      { name: 'use_for_syslog', isBoolean: true },
      { name: 'use_for_chat_assistant', isBoolean: true },
      { name: 'use_for_mcp', isBoolean: true },
      { name: 'use_for_ssh', isBoolean: true },
      { name: 'use_for_disclaimer', isBoolean: true },
      { name: 'use_for_defaults', isBoolean: true },
      { name: 'use_for_logo', isBoolean: true },
      { name: 'use_for_icon', isBoolean: true },
      { name: 'use_for_name', isBoolean: true },
      { name: 'use_for_links', isBoolean: true },
      { name: 'use_for_labels', isBoolean: true },
      { name: 'use_for_announcements', isBoolean: true },
      { name: 'use_for_general', isBoolean: true },
      // a credential of Connections > Credentials : the user and password git uses
      { name: 'credential' },
      { name: 'rebase_on_start', isBoolean: true },
      { name: 'cron' },
      { name: 'status' },
      // what git said on the last pull (or clone, reset), and on the last push
      { name: 'pull_output' },
      { name: 'push_output' },
      // when the last pull and the last push ended
      { name: 'pulled_at' },
      { name: 'pushed_at' },
      // how the last pull (or clone, reset) and the last push ended, each 'running' while it
      // runs ; status is the lock any git operation takes, else the last pull's
      { name: 'pull_status' },
      { name: 'push_status' },
      { name: 'head' },
      { name: 'managed', isBoolean: true },
      // the repositories repository and its repositories.yaml it comes from : written by
      // lib/repoObjects alone (isRepoLink : never from a request body)
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  ldap: {
    table: 'AnsibleForms.ldap',
    fields: [
      { name: 'id', isKey: true },
      // 'default' keeps its members' short names ; any other's are <name>/<member>
      { name: 'name', isNaturalKey: true, required: true },
      // the order a bare username is looked up in, and the domains that go straight to it
      { name: 'position' },
      { name: 'domains' },
      // one or more servers, comma separated
      { name: 'server', required: true },
      { name: 'port', required: true },
      { name: 'ignore_certs', isBoolean: true },
      { name: 'enable_tls', isBoolean: true },
      { name: 'cert' },
      { name: 'ca_bundle' },
      { name: 'bind_user_dn', required: true },
      { name: 'bind_user_pw', isEncrypted: true, required: true },
      // a credential of Connections > Credentials, bound with instead of the user and password
      { name: 'credential' },
      { name: 'search_base', required: true },
      { name: 'username_attribute', required: true },
      { name: 'groups_attribute' },
      { name: 'enable', isBoolean: true },
      { name: 'groups_search_base' },
      { name: 'group_class' },
      { name: 'group_member_attribute' },
      { name: 'group_member_user_attribute' },
      { name: 'mail_attribute' },
      { name: 'managed', isBoolean: true },
      // the repository and the file it comes from : written by lib/repoObjects alone (isRepoLink :
      // never from a request body), NULL for one kept in the app only
      { name: 'repository', isRepoLink: true },
      { name: 'repo_file', isRepoLink: true }
    ],
    allowCache: false
  },
  schedule: {
    table: 'AnsibleForms.schedule',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', isNaturalKey: true, required: true },
      // its timing, one of three : the moment of its one run, a cron, or an iCal rrule (below)
      { name: 'one_time_run', isDatetime: true },
      { name: 'cron' },
      { name: 'extra_vars' },
      { name: 'form' },
      { name: 'output' },
      { name: 'status' },
      { name: 'state' },
      // turned off, its cron or one time run does not fire
      { name: 'enabled', isBoolean: true },
      { name: 'last_run', isDatetime: true },
      { name: 'queue_id' },
      // who planned it, as a JSON user object : set ONLY by Schedule.plan, never from a
      // request body (the controller drops it). Empty = an admin-level schedule.
      { name: 'owner' },
      // a planned run's raw field values (Schedule.plan), for the launch validation when it
      // fires. Missing here, it was dropped on insert and never read back, and a planned run
      // of a form under 'enforce' failed with "no rawFormData was sent" (#1063)
      { name: 'raw_form_data' },
      // what it is for, in a few words
      { name: 'description' },
      // timed by an iCal rrule, instead of a cron or a one time run
      { name: 'rrule' },
      // the schedules repository and the file it comes from : set by models/scheduleRepo.model.js
      // alone, never from a request body (Schedule.create and update drop them)
      { name: 'repository' },
      { name: 'repo_file' },
      // its file's prompts as the reserved extra vars a job reads (JSON) : the file's, never a
      // request body's
      { name: 'launch_options' },
      // the stored job a planned run's values came from (Schedule.plan, checked by
      // lib/storedJobUse.js) : its last use is written when the run fires. Set ONLY by
      // Schedule.plan, never by a schedule's create or update (a schedule keeps its own copy)
      { name: 'stored_job_id' },
      // how it ends (lib/scheduleEnd.js, checked by Schedule.create and update) : never, on a
      // date (end_at) or after a number of runs (end_count), then turned off or removed
      // (end_action) ; none for a one time run
      { name: 'ends' },
      { name: 'end_at', isDatetime: true },
      { name: 'end_count' },
      { name: 'end_action' },
      // the jobs it started (jobs.schedule_id), counted by Schedule.launch alone : a request's is
      // dropped (lib/scheduleEnd.js checkEnd)
      { name: 'run_count' },
      // a one time run removed after its run (the default), else turned off and kept
      { name: 'remove_after_run', isBoolean: true }
    ],
    allowCache: true,
    cacheTTL: 3600
  },
  stored_jobs: {
    table: 'AnsibleForms.stored_jobs',
    fields: [
      { name: 'id', isKey: true },
      { name: 'name', required: true },
      { name: 'description' },
      { name: 'form_name', required: true },
      { name: 'username', required: true },
      { name: 'form_data', required: true },
      { name: 'created_at', isDatetime: true },
      { name: 'expires_at', isDatetime: true },
      // private or shared (lib/storedJobScope.js)
      { name: 'visibility' },
      // when a job was last launched from it : set by the launch only (lib/storedJobUse.js),
      // never from a request body (the controller drops it) ; none until the first one
      { name: 'last_used_at', isDatetime: true },
      // removed once unused for this many days, at most the setting's (lib/storedJobExpiry.js) ;
      // none follows the setting (STORED_JOB_UNUSED_DAYS)
      { name: 'unused_days' }
    ],
    allowCache: false
  }
};

export default crudConfigs;
