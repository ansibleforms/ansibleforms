-- disable foreign key checks to avoid errors when creating tables
SET FOREIGN_KEY_CHECKS=0;
-- create the database if it does not exist
CREATE DATABASE /*!32312 IF NOT EXISTS*/`AnsibleForms` /*!40100 DEFAULT CHARACTER SET utf8 */;
-- use the database
USE `AnsibleForms`;
-- create groups table
DROP TABLE IF EXISTS `groups`;
CREATE TABLE `groups`(
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `description` varchar(250) DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_AnsibleForms_groups_natural_key` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8;
-- create users table
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users`(
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `description` varchar(250) DEFAULT NULL,
  `group_id` int(11) NOT NULL,
  -- an admin blocked its sign-in (lib/signInGate.js)
  `blocked` tinyint(4) NOT NULL DEFAULT 0,
  -- its latest sign-in (lib/signInGate.js), NULL until it signs in
  `last_login` datetime DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_AnsibleForms_users_natural_key` (`username`),
    KEY `FK_users_group` (`group_id`),
    CONSTRAINT `FK_users_group` FOREIGN KEY (`group_id`) REFERENCES `groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8;
-- a local user's groups besides its first one (users.group_id)
DROP TABLE IF EXISTS `user_groups`;
CREATE TABLE `user_groups` (
  `user_id` int(11) NOT NULL,
  `group_id` int(11) NOT NULL,
    PRIMARY KEY (`user_id`,`group_id`),
    KEY `FK_user_groups_group` (`group_id`),
    CONSTRAINT `FK_user_groups_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `FK_user_groups_group` FOREIGN KEY (`group_id`) REFERENCES `groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create tokens table
DROP TABLE IF EXISTS `tokens`;
CREATE TABLE `tokens` (
  `username` varchar(250) NOT NULL,
  `username_type` varchar(10) NOT NULL,
  `refresh_token` text DEFAULT NULL,
  `timestamp` datetime NOT NULL DEFAULT current_timestamp(),
  `replaced_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create credentials table
DROP TABLE IF EXISTS `credentials`;
CREATE TABLE `credentials` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `user` varchar(250) DEFAULT NULL,
  `password` text DEFAULT NULL,
  `host` varchar(250) DEFAULT NULL,
  `port` int(11) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `secure` tinyint(4) DEFAULT NULL,
  `db_type` varchar(10) DEFAULT NULL,
  `db_name` varchar(255) DEFAULT NULL,  
  `is_database` tinyint(4) DEFAULT 1,
  `credential_type` varchar(20) DEFAULT NULL,
  -- a cyberark credential's client certificate and key (PEM)
  `client_cert` text DEFAULT NULL,
  `client_key` text DEFAULT NULL,
  -- an Entra ID credential's tenant (its user the client id, its password the client secret)
  `tenant_id` varchar(250) DEFAULT NULL,
  -- an Open ID credential's issuer (the provider's address)
  `issuer` varchar(500) DEFAULT NULL,
  -- an Entra ID or Open ID credential's redirect URL, as registered with its client (empty : the
  -- app's address and the type's callback path)
  `redirect_uri` varchar(1000) DEFAULT NULL,
  -- the address of the one server a runner's or a secret store's credential logs in to
  `url` varchar(1000) DEFAULT NULL,
  -- an ldap credential's TLS : certificates not checked, the CA bundle (its servers are host, its
  -- client certificate client_cert) ; a runner's or a secret store's for its url
  `ignore_certs` tinyint(4) DEFAULT NULL,
  `ca_bundle` text DEFAULT NULL,
  -- the SHA-256 of the ca_bundle an inbound RTE's certificate was stored as : the RTE may replace
  -- the bundle only while it still has that digest (cleared when an admin changes the bundle)
  `rte_cert_sha256` varchar(64) DEFAULT NULL,
  `vault_path` varchar(500) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  -- the secret store a credential reads its user and password from, and where in it
  `secret_store` varchar(250) DEFAULT NULL,
  `secret_ref` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_credentials_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create notification_channels table : where notifications go (Connections > Notifications) -
-- the SMTP servers (one of them active), Slack, Teams, Telegram and webhooks
-- keep in sync with create_notification_channels_table.sql, which the upgrade patch uses
DROP TABLE IF EXISTS `notification_channels`;
CREATE TABLE `notification_channels` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `description` text DEFAULT NULL,
  -- mail, slack, teams, telegram or webhook : which of the columns below it uses
  `type` varchar(20) NOT NULL DEFAULT 'mail',
  -- whether anything is sent to it
  `enabled` tinyint(4) DEFAULT 1,
  -- mail : the one the app sends its mail with (approval requests, job notifications)
  `is_active` tinyint(4) DEFAULT 0,
  -- mail : its host, port, TLS and from address, and an smtp credential of Connections >
  -- Credentials for the login (none for an open relay)
  `server` varchar(250) DEFAULT NULL,
  `port` int(11) DEFAULT NULL,
  `secure` tinyint(4) DEFAULT 0,
  `from_address` varchar(250) DEFAULT NULL,
  `credential` varchar(250) DEFAULT NULL,
  -- slack, teams : the incoming webhook's address, a secret (encrypted, never shown)
  `webhook_url` text DEFAULT NULL,
  -- telegram : the chat it posts in, the Bot API's address (empty : api.telegram.org)
  `chat_id` varchar(250) DEFAULT NULL,
  `api_url` varchar(500) DEFAULT NULL,
  -- telegram : the bot token ; webhook : the bearer token - the password of an api credential
  `token_credential` varchar(250) DEFAULT NULL,
  -- webhook : the address, method, extra headers (a JSON object), TLS check and the body (a
  -- JSON template)
  `url` varchar(1000) DEFAULT NULL,
  `method` varchar(10) DEFAULT NULL,
  `headers` text DEFAULT NULL,
  `verify_tls` tinyint(4) DEFAULT 1,
  `payload` text DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_notification_channels_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create syslog_servers table : the syslog servers the server log and the audit entries go to
-- keep in sync with create_syslog_servers_table.sql, which the upgrade patch uses
DROP TABLE IF EXISTS `syslog_servers`;
CREATE TABLE `syslog_servers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `description` text DEFAULT NULL,
  -- where it listens : a host and port (udp, tcp, tls), or a socket path (unix)
  `host` varchar(250) DEFAULT NULL,
  `port` int(11) DEFAULT NULL,
  `protocol` varchar(20) NOT NULL DEFAULT 'udp4',
  `path` varchar(250) DEFAULT NULL,
  -- the lowest level of the server log it gets ; audit entries are always sent
  `level` varchar(20) NOT NULL DEFAULT 'info',
  -- BSD (RFC 3164) or 5424, the name it gives the app, the host it says lines come from
  `type` varchar(20) DEFAULT NULL,
  `app_name` varchar(100) DEFAULT NULL,
  `source` varchar(250) DEFAULT NULL,
  -- what it gets : the server log (log), the audit entries (audit), or both
  `receives` varchar(10) NOT NULL DEFAULT 'both',
  `enabled` tinyint(4) DEFAULT 1,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_syslog_servers_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- the labels beside the header's logo (Settings > Appearance > Labels)
-- (keep in sync with src/db/create_labels_table.sql)
DROP TABLE IF EXISTS `labels`;
CREATE TABLE `labels` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  -- the text of the pill beside the logo (PRODUCTION, EU)
  `name` varchar(40) NOT NULL,
  -- its colour : one of the app's pill tones
  `color` varchar(20) NOT NULL DEFAULT 'grey',
  -- shown in the header, or kept hidden
  `enabled` tinyint(4) DEFAULT 1,
  -- its place among the labels, lowest first
  `position` int(11) NOT NULL DEFAULT 0,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_labels_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create secret_stores table : HashiCorp Vault, CyberArk, ... (one row per store)
-- keep in sync with create_secret_stores_table.sql, which the upgrade patch uses
DROP TABLE IF EXISTS `secret_stores`;
CREATE TABLE `secret_stores` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `type` varchar(20) NOT NULL,
  `description` text DEFAULT NULL,
  `url` varchar(500) NOT NULL,
  `token` text DEFAULT NULL,
  -- a credential whose password is the token (a Vault), or that holds the AppID and client
  -- certificate and key (a CyberArk), instead of the store's own
  `credential` varchar(250) DEFAULT NULL,
  `namespace` varchar(250) DEFAULT NULL,
  `kv_version` tinyint(4) DEFAULT 2,
  `default_mount` varchar(250) DEFAULT NULL,
  `app_id` varchar(250) DEFAULT NULL,
  `client_cert` text DEFAULT NULL,
  `client_key` text DEFAULT NULL,
  `ignore_certs` tinyint(4) DEFAULT 0,
  `ca_bundle` text DEFAULT NULL,
  `cache_ttl_seconds` int(11) DEFAULT 60,
  `extra` text DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_secret_stores_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- keep in sync with create_runners_table.sql, which the upgrade patch uses
DROP TABLE IF EXISTS `runners`;
CREATE TABLE `runners` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `type` varchar(20) NOT NULL,
  `description` text DEFAULT NULL,
  `uri` varchar(500) NOT NULL,
  `token` text DEFAULT NULL,
  `username` varchar(250) DEFAULT NULL,
  `password` text DEFAULT NULL,
  `use_credentials` tinyint(4) DEFAULT 0,
  -- a credential of Connections > Credentials it signs in with ; its own token, user and password
  -- only while it has none
  `credential` varchar(250) DEFAULT NULL,
  `ignore_certs` tinyint(4) DEFAULT 0,
  `ca_bundle` text DEFAULT NULL,
  `is_default` tinyint(4) DEFAULT 0,
  `flavour` varchar(20) DEFAULT NULL,
  `project` varchar(255) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  `node_id` varchar(250) DEFAULT NULL,
  -- an RTE : database (deprecated), outbound (it dials the app) or inbound (the app dials it)
  `rte_mode` varchar(10) DEFAULT NULL,
  -- turned off, no job goes to it (it stays listed, its settings kept)
  `enabled` tinyint(4) DEFAULT 1,
  -- an RTE that asked to join and waits for an admin's approval : since when, and what it said
  -- of itself (host, address, mode, version, the fingerprint of its token)
  `pending` tinyint(4) DEFAULT 0,
  `pending_since` datetime DEFAULT NULL,
  `pending_info` text DEFAULT NULL,
  -- the SHA-256 of the ca_bundle its RTE's certificate was stored as (a runner without a
  -- credential) : cleared when an admin changes the bundle
  `rte_cert_sha256` varchar(64) DEFAULT NULL,
  -- a socket-mode RTE's settings, sent to it over its socket (rte/socket/settings.js) : the
  -- playbooks it runs at once, its job files cache in MB, transfer or local files, and how long
  -- a stop waits ; they win over the same variables on the RTE, used when one is empty
  `rte_max_jobs` int(11) DEFAULT NULL,
  `rte_cache_mb` int(11) DEFAULT NULL,
  `rte_files` varchar(10) DEFAULT NULL,
  `rte_drain_seconds` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_runners_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create ldap table
DROP TABLE IF EXISTS `ldap`;
CREATE TABLE `ldap` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  -- a directory's name : 'main' keeps the short names (ldap/<group>, the bare username) ; any
  -- other's members are named ldap/<name>/<group> and <name>/<user>
  `name` varchar(100) NOT NULL DEFAULT 'main',
  -- what it is, for the list and its page
  `description` varchar(250) DEFAULT NULL,
  -- the order a bare username is looked up in, the lowest first
  `position` int(11) NOT NULL DEFAULT 1,
  -- the sign-in domains (user@domain) that go straight to this directory, comma separated
  `domains` varchar(1000) DEFAULT NULL,
  -- one or more servers, comma separated : the next one when one cannot be reached
  `server` varchar(250) DEFAULT NULL,
  `port` int(11) DEFAULT NULL,
  `ignore_certs` tinyint(4) DEFAULT NULL,
  `enable_tls` tinyint(4) DEFAULT NULL,
  `cert` text DEFAULT NULL,
  `ca_bundle` text DEFAULT NULL,
  `bind_user_dn` varchar(250) DEFAULT NULL,
  `bind_user_pw` text DEFAULT NULL,
  -- a credential of Connections > Credentials to bind with instead of the user and password above
  `credential` varchar(250) DEFAULT NULL,
  `search_base` varchar(250) DEFAULT NULL,
  `username_attribute` varchar(250) DEFAULT NULL,
  `groups_search_base` varchar(250) DEFAULT NULL,
  `groups_attribute` varchar(250) DEFAULT NULL,
  `group_class` varchar(250) DEFAULT NULL,
  `group_member_attribute` varchar(250) DEFAULT NULL,
  `group_member_user_attribute` varchar(250) DEFAULT NULL,
  `mail_attribute` varchar(250) DEFAULT NULL,
  `groupfilter` varchar(250) DEFAULT NULL,
  `enable` tinyint(4) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create chat_settings table : the model provider of the chat assistant (one row)
DROP TABLE IF EXISTS `chat_settings`;
CREATE TABLE `chat_settings` (
  `provider` varchar(20) DEFAULT NULL,
  `api_key` text DEFAULT NULL,
  `base_url` varchar(500) DEFAULT NULL,
  `model` varchar(200) DEFAULT NULL,
  `max_turns` int(11) DEFAULT 20,
  `max_tool_rounds` int(11) DEFAULT 6,
  `timeout_seconds` int(11) DEFAULT 60,
  `allow_job_status` tinyint(4) DEFAULT 1,
  `auth_type` varchar(20) DEFAULT NULL,
  `api_version` varchar(50) DEFAULT NULL,
  `request_user` varchar(100) DEFAULT NULL,
  `extra_headers` text DEFAULT NULL,
  `ignore_certs` tinyint(4) DEFAULT 0,
  -- an api credential whose password is the key, instead of api_key
  `credential` varchar(250) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create job_output and jobs tables
DROP TABLE IF EXISTS `job_output`;
DROP TABLE IF EXISTS `jobs`;
CREATE TABLE `jobs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `form` varchar(250) DEFAULT NULL,
  `target` varchar(250) DEFAULT NULL,
  `status` varchar(20) DEFAULT NULL,
  `start` datetime NOT NULL DEFAULT current_timestamp(),
  `end` datetime DEFAULT NULL,
  `user` varchar(250) DEFAULT NULL,
  `user_type` varchar(10) DEFAULT NULL,
  `job_type` varchar(20) DEFAULT NULL,
  `abort_requested` tinyint(4) DEFAULT NULL,
  `extravars` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `credentials` mediumtext DEFAULT NULL,
  `notifications` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `approval` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `step` varchar(250) DEFAULT NULL,
  `parent_id` int(11) DEFAULT NULL,
  `awx_id` int(11) DEFAULT NULL,
  `awx_artifacts` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `awx_workflow` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- added by a patch on an existing install ; keep both paths in sync (schema.model.js)
  `raw_form_data` longtext DEFAULT NULL,
  `pid` int(11) DEFAULT NULL,
  `host` varchar(255) DEFAULT NULL,
  `runner` varchar(250) DEFAULT NULL,
  -- what that runner was when the job ran (awx, aap, ascender, semaphore, rundeck, jenkins, rte)
  `runner_kind` varchar(20) DEFAULT NULL,
  -- its address in that product's web UI (an AWX job's page, a Jenkins build's console ...),
  -- kept so a runner removed or renamed later leaves the link (lib/runnerJobLinks.js)
  `runner_job_url` varchar(1000) DEFAULT NULL,
  `job_log` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tracker` varchar(250) DEFAULT NULL,
  PRIMARY KEY (`id`),
  -- the retention sweep selects on (parent_id, status, end) ; without this it full
  -- scans the largest table in the schema on every batch. Keep in sync with the
  -- patch in schema.model.js that adds it to an existing install.
  KEY `idx_jobs_retention` (`parent_id`, `status`, `end`)
) ENGINE=InnoDB AUTO_INCREMENT=47 DEFAULT CHARSET=utf8;
CREATE TABLE `job_output` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `output` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `timestamp` datetime NOT NULL DEFAULT current_timestamp(),
  `output_type` varchar(10) NOT NULL,
  `job_id` int(11) NOT NULL,
  `order` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `FK_job_output_jobs` (`job_id`),
  CONSTRAINT `FK_job_output_jobs` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1650 DEFAULT CHARSET=utf8;
-- create settings table
DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `mail_server` varchar(250) DEFAULT NULL,
  `mail_port` int(11) DEFAULT NULL,
  `mail_secure` tinyint(4) DEFAULT NULL,
  `mail_username` varchar(250) DEFAULT NULL,
  `mail_password` text DEFAULT NULL,
  `encryption_check` text DEFAULT NULL,
  `mail_from` varchar(250) DEFAULT NULL,
  `url` varchar(250) DEFAULT NULL,
  `forms_yaml` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logo` longtext DEFAULT NULL,
  -- the website icon (browser tab), a data url ; NULL : the bundled one
  `favicon` longtext DEFAULT NULL,
  -- Settings > Appearance : the name in the browser tab and on the sign-in page,
  -- the label beside the logo (PRODUCTION) and its colour, an announcement under the header
  -- until a date, the forms list's view and the time zone for everyone
  `app_name` varchar(100) DEFAULT NULL,
  `env_label` varchar(40) DEFAULT NULL,
  `env_label_show` tinyint(4) NOT NULL DEFAULT 1,
  `env_label_color` varchar(20) DEFAULT NULL,
  `banner_show` tinyint(4) NOT NULL DEFAULT 1,
  `disclaimer_enabled` tinyint(4) NOT NULL DEFAULT 0,
  -- the disclaimer version users accept, Restore's choice ; none : the latest
  `disclaimer_version` int(11) DEFAULT NULL,
  `forms_view` varchar(10) DEFAULT NULL,
  `default_timezone` varchar(64) DEFAULT NULL,
  `default_date_format` varchar(20) DEFAULT NULL,
  -- the header's own links (Settings > Appearance > Links), as JSON
  `header_links` text DEFAULT NULL,
  `config_source` varchar(20) DEFAULT NULL,
  `default_language` varchar(5) DEFAULT NULL,
  `default_theme` varchar(10) DEFAULT NULL,
  `default_theme_color` varchar(7) DEFAULT NULL,
  `vault_env_imported_at` datetime DEFAULT NULL,
  `syslog_env_imported_at` datetime DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- oauth2 providers table
USE `AnsibleForms`;
DROP TABLE IF EXISTS `oauth2_providers`;
CREATE TABLE `oauth2_providers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `provider` VARCHAR(50) NOT NULL, -- e.g., 'azuread', 'oidc', 'google', 'github'
  `name` VARCHAR(100) DEFAULT NULL, -- required name for the provider
  `description` VARCHAR(250) DEFAULT NULL, -- optional description for the provider
  `issuer` TEXT DEFAULT NULL,
  -- added by a patch on an existing install ; keep both paths in sync (schema.model.js)
  `tenant_id` TEXT DEFAULT NULL,
  `client_id` TEXT DEFAULT NULL,
  `client_secret` TEXT DEFAULT NULL,
  -- a credential of Connections > Credentials : its user the client id, its password the secret
  `credential` VARCHAR(250) DEFAULT NULL,
  `enable` TINYINT(4) DEFAULT NULL,
  -- the login page goes straight to it (one provider at most)
  `auto_login` tinyint(4) DEFAULT 0,
  `groupfilter` VARCHAR(250) DEFAULT NULL,
  `redirect_uri` TEXT DEFAULT NULL,
  `scope` TEXT DEFAULT NULL,
  `auth_url` TEXT DEFAULT NULL,
  `token_url` TEXT DEFAULT NULL,
  `userinfo_url` TEXT DEFAULT NULL,
  `extra` JSON DEFAULT NULL, -- for any additional provider-specific config
  `managed` tinyint(4) DEFAULT 0,
  UNIQUE KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create repositories table
DROP TABLE IF EXISTS `repositories`;
CREATE TABLE `repositories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `user` varchar(250) DEFAULT NULL,
  `password` text DEFAULT NULL,
  `uri` varchar(250) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `use_for_forms` tinyint(4) DEFAULT NULL,
  `use_for_playbooks` tinyint(4) DEFAULT NULL,
  -- added by a patch on an existing install ; keep both paths in sync (schema.model.js)
  `branch` varchar(250) DEFAULT NULL,
  `use_for_config` tinyint(4) DEFAULT 0,
  -- the workflows the designer builds (one repository only)
  `use_for_workflows` tinyint(4) DEFAULT 0,
  -- the inventories the playbook forms name (inventory: <name>)
  `use_for_inventories` tinyint(4) DEFAULT 0,
  `credential` varchar(250) DEFAULT NULL,
  `cron` varchar(50) DEFAULT NULL,
  `status` varchar(50) DEFAULT NULL,
  -- who holds the status='running' claim and since when (models/repository.model.js claim)
  `claim_node` varchar(250) DEFAULT NULL,
  `claim_since` datetime DEFAULT NULL,
  `pull_output` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `push_output` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- when the last pull (or clone, reset) and the last push ended, worked or not
  `pulled_at` datetime DEFAULT NULL,
  `pushed_at` datetime DEFAULT NULL,
  -- how the last pull (or clone, reset) and the last push ended (success, failed), each
  -- 'running' while it runs ; status is the lock (models/repository.model.js claim), else the
  -- last pull's
  `pull_status` varchar(50) DEFAULT NULL,
  `push_status` varchar(50) DEFAULT NULL,
  `head` varchar(50) DEFAULT NULL,    
  `rebase_on_start` tinyint(4) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_repositories_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
-- create schedule table
DROP TABLE IF EXISTS `schedule`;
CREATE TABLE `schedule` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `cron` VARCHAR(50) DEFAULT NULL,
  `form` VARCHAR(255) DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT NULL,
  `last_run` DATETIME DEFAULT NULL,
  `state` VARCHAR(50) DEFAULT NULL,
  -- turned off, its cron or one time run does not fire (Run now still does) ; its settings kept
  `enabled` TINYINT(4) DEFAULT 1,
  -- who launches it (state='running') and since when (models/schedule.model.js launch)
  `claim_node` varchar(250) DEFAULT NULL,
  `claim_since` datetime DEFAULT NULL,
  `queue_id` INT DEFAULT 0,  
  `extra_vars` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `output` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- added by a patch on an existing install ; keep both paths in sync (schema.model.js)
  `one_time_run` tinyint(4) DEFAULT 0,
  `run_at` datetime DEFAULT NULL,
  -- the user a planned job ("Run later") runs as ; NULL for an admin-level schedule
  `owner` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- a planned job's raw field values, for the launch validation when it fires
  `raw_form_data` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  UNIQUE KEY `uk_schedule_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- create audit table (append only : there is no update or delete path for a row,
-- only the retention sweep. Keep in sync with src/db/create_audit_table.sql, which
-- is what the patch for existing installs runs)
DROP TABLE IF EXISTS `audit`;
CREATE TABLE `audit` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actor` VARCHAR(255) DEFAULT NULL,
  `actor_type` VARCHAR(20) DEFAULT NULL,
  `ip` VARCHAR(45) DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(64) DEFAULT NULL,
  `target` VARCHAR(255) DEFAULT NULL,
  `outcome` VARCHAR(16) NOT NULL,
  `detail` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  KEY `idx_audit_created` (`created_at`),
  KEY `idx_audit_actor` (`actor`, `created_at`),
  KEY `idx_audit_action` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- default values are created at startup

-- stored jobs
-- This table used to be created only by a patch, which meant this file left its rows
-- behind while dropping everything they refer to (forms, users) - and a fresh install
-- with a grant that allows CREATE but not ALTER never got the table at all.
DROP TABLE IF EXISTS `stored_jobs`;
CREATE TABLE `stored_jobs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `form_name` VARCHAR(255) NOT NULL,
  `username` VARCHAR(255) NOT NULL,
  `form_data` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME DEFAULT NULL,
  `visibility` VARCHAR(10) NOT NULL DEFAULT 'private',
  UNIQUE KEY `uk_user_form_name` (`username`, `form_name`, `name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- the processes on this database (lib/nodes.js), what changed between them
-- (lib/epochs.js) and the designer lock (models/lock.model.js). Keep in sync with
-- create_nodes_table.sql, create_cache_epochs_table.sql and create_designer_lock_table.sql.
DROP TABLE IF EXISTS `nodes`;
CREATE TABLE `nodes` (
  `id` varchar(250) NOT NULL,
  `role` varchar(20) DEFAULT NULL,
  `version` varchar(50) DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  `is_worker` tinyint(4) DEFAULT 0,
  `info` text DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

DROP TABLE IF EXISTS `cache_epochs`;
CREATE TABLE `cache_epochs` (
  `name` varchar(64) NOT NULL,
  `version` bigint(20) NOT NULL DEFAULT 0,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

DROP TABLE IF EXISTS `designer_lock`;
CREATE TABLE `designer_lock` (
  `id` tinyint(4) NOT NULL,
  `data` mediumtext DEFAULT NULL,
  `created` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- failed logins, by account (user:<name>) and by address (ip:<address>) : lib/loginThrottle.js
-- (keep in sync with src/db/create_login_failures_table.sql, the patch for existing installs)
DROP TABLE IF EXISTS `login_failures`;
CREATE TABLE `login_failures` (
  `key` varchar(300) NOT NULL,
  `failures` int NOT NULL DEFAULT 0,
  `first_at` datetime NOT NULL,
  `locked_until` datetime DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- revoked tokens : logouts and password changes : lib/tokenRevocation.js
-- (keep in sync with src/db/create_token_revocations_table.sql)
DROP TABLE IF EXISTS `token_revocations`;
CREATE TABLE `token_revocations` (
  `key` varchar(300) NOT NULL,
  `revoked_before` bigint DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the LDAP and SSO users seen at sign-in : models/directoryUser.model.js
-- (keep in sync with src/db/create_directory_users_table.sql)
DROP TABLE IF EXISTS `directory_users`;
CREATE TABLE `directory_users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `type` varchar(20) NOT NULL,
  `username` varchar(250) NOT NULL,
  `external_id` varchar(250) DEFAULT NULL,
  `display_name` varchar(250) DEFAULT NULL,
  `email` varchar(250) DEFAULT NULL,
  `groups` longtext DEFAULT NULL,
  `roles` longtext DEFAULT NULL,
  `first_seen` datetime DEFAULT NULL,
  `last_login` datetime DEFAULT NULL,
  `blocked` tinyint(4) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_directory_users_type_username` (`type`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the patches applied, and by which release : models/schema.model.js
-- (keep in sync with src/db/create_schema_migrations_table.sql)
DROP TABLE IF EXISTS `schema_migrations`;
CREATE TABLE `schema_migrations` (
  `name` varchar(64) NOT NULL,
  `version` varchar(32) NOT NULL,
  `applied_at` datetime NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the announcements under the header : models/announcement.model.js
-- (keep in sync with src/db/create_announcements_table.sql)
DROP TABLE IF EXISTS `announcements`;
CREATE TABLE `announcements` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `message` varchar(500) NOT NULL,
  `level` varchar(10) NOT NULL DEFAULT 'info',
  `enabled` tinyint(4) NOT NULL DEFAULT 1,
  `start_at` datetime DEFAULT NULL,
  `end_at` datetime DEFAULT NULL,
  `created_by` varchar(250) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the disclaimer's versions and who accepted them : models/disclaimer.model.js
-- (keep in sync with src/db/create_disclaimer_tables.sql)
DROP TABLE IF EXISTS `disclaimer_versions`;
CREATE TABLE `disclaimer_versions` (
  `version` int(11) NOT NULL,
  `title` varchar(200) NOT NULL,
  `text` mediumtext NOT NULL,
  `checkbox_label` varchar(200) NOT NULL,
  `created_by` varchar(250) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
DROP TABLE IF EXISTS `disclaimer_acceptances`;
CREATE TABLE `disclaimer_acceptances` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(250) NOT NULL,
  `user_type` varchar(20) NOT NULL,
  `version` int(11) NOT NULL,
  `accepted_at` datetime NOT NULL,
  `ip` varchar(64) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_disclaimer_acceptances_user_version` (`username`, `user_type`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the API tokens issued : models/apiToken.model.js
-- (keep in sync with src/db/create_api_tokens_table.sql)
DROP TABLE IF EXISTS `api_tokens`;
CREATE TABLE `api_tokens` (
  `sid` varchar(64) NOT NULL,
  `username` varchar(250) NOT NULL,
  `username_type` varchar(20) NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `expires_at` datetime NOT NULL,
  `last_used_at` datetime DEFAULT NULL,
  PRIMARY KEY (`sid`),
  KEY `idx_api_tokens_user` (`username_type`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the RTE over a WebSocket (rte/socket) : the app node holding each runner's socket
-- (keep in sync with src/db/create_runner_leases_table.sql, the patch for existing installs)
DROP TABLE IF EXISTS `runner_leases`;
CREATE TABLE `runner_leases` (
  -- the runner whose socket is held (its name under Connections > Runners)
  `runner` varchar(250) NOT NULL,
  -- the app node holding it (lib/role.js nodeId) : only that node sends the runner its jobs
  `node_id` varchar(250) NOT NULL,
  -- renewed while the node holds the socket ; past it another node may take it over
  `expires_at` datetime NOT NULL,
  -- outbound (the RTE dialed in) or inbound (this node dialed the RTE)
  `direction` varchar(10) NOT NULL,
  -- the RTE on the other end (its node id) and what it said : version, contract, ansible,
  -- capacity, files mode (JSON) - any app node reads it for the Runners and Status pages
  `rte_id` varchar(250) DEFAULT NULL,
  `info` text DEFAULT NULL,
  PRIMARY KEY (`runner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- the join tokens an RTE adds itself as a runner with (Connections > Runners)
-- (keep in sync with src/db/create_runner_join_tokens_table.sql)
DROP TABLE IF EXISTS `runner_join_tokens`;
CREATE TABLE `runner_join_tokens` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  -- what it is for, as the admin named it (dmz-runners)
  `name` varchar(100) NOT NULL,
  -- the token's SHA-256 : the token itself is shown once, when it is made
  `token_hash` char(64) NOT NULL,
  -- the first characters, so a list can tell the tokens apart
  `prefix` varchar(16) NOT NULL,
  `created_by` varchar(250) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  -- after this it adds no runner any more ; NULL : never
  `expires_at` datetime DEFAULT NULL,
  -- how many runners may join with it ; NULL : any number
  `max_uses` int(11) DEFAULT NULL,
  `uses` int(11) NOT NULL DEFAULT 0,
  `last_used_at` datetime DEFAULT NULL,
  -- revoked by an admin : refused from then on
  `revoked` tinyint(4) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_runner_join_tokens_hash` (`token_hash`),
  UNIQUE KEY `uk_runner_join_tokens_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- a playbook's structured events (the af_events callback plugin) : the job page's grid and recap
-- (keep in sync with src/db/create_job_events_table.sql ; it references jobs, created above)
DROP TABLE IF EXISTS `job_events`;
CREATE TABLE `job_events` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `job_id` int(11) NOT NULL,
  -- its place among the job's events, from 1 (the af_events callback plugin's order)
  `order` int(11) NOT NULL,
  -- play, task, ok, changed, failed, skipped, unreachable, ignored or stats
  `type` varchar(20) NOT NULL,
  `play` varchar(500) DEFAULT NULL,
  `task` varchar(500) DEFAULT NULL,
  `host` varchar(250) DEFAULT NULL,
  -- seconds the host took on the task (a host result)
  `duration` decimal(10,3) DEFAULT NULL,
  -- when it happened, as the playbook saw it (unix seconds)
  `time` decimal(14,3) DEFAULT NULL,
  -- the result's message and fields, or the recap's counts : JSON, masked as the output
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- a host's or a loop item's whole result, as its details show it (a click on its output line) :
  -- JSON, masked as the output ; read one at a time, never with the list
  `result` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_job_events_order` (`job_id`, `order`),
  CONSTRAINT `FK_job_events_jobs` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- enable foreign key checks
SET FOREIGN_KEY_CHECKS=1;
