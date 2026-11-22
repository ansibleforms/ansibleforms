USE `AnsibleForms`;
-- the LDAP and SSO users seen at sign-in : who they are and what the directory gave them the last
-- time, for their page in Settings > Users, and whether an admin blocked their sign-in
-- (models/directoryUser.model.js). The directory stays the source of truth ; this is a record.
-- (keep in sync with create_schema_and_tables.sql)
CREATE TABLE IF NOT EXISTS `directory_users` (
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
  -- what the user is, as an admin or its repository entry says
  `description` varchar(250) DEFAULT NULL,
  -- the repository and the file it comes from ; NULL for one kept in the app only
  -- (lib/repoObjects)
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_directory_users_type_username` (`type`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
