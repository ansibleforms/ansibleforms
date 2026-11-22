USE `AnsibleForms`;
CREATE TABLE `oauth2_providers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `provider` VARCHAR(50) NOT NULL, -- e.g., 'azuread', 'oidc', 'google', 'github'
  `name` VARCHAR(100) DEFAULT NULL, -- required name for the provider
  `description` VARCHAR(250) DEFAULT NULL, -- optional description for the provider
  `issuer` TEXT DEFAULT NULL,
  `tenant_id` TEXT DEFAULT NULL,
  `client_id` TEXT DEFAULT NULL,
  `client_secret` TEXT DEFAULT NULL,
  -- a credential of Connections > Credentials : its user the client id, its password the secret
  `credential` VARCHAR(250) DEFAULT NULL,
  `enable` TINYINT(4) DEFAULT NULL,
  -- the login page goes straight to it (one provider at most)
  `auto_login` TINYINT(4) DEFAULT 0,
  `groupfilter` VARCHAR(250) DEFAULT NULL,
  `redirect_uri` TEXT DEFAULT NULL,
  `scope` TEXT DEFAULT NULL,
  `auth_url` TEXT DEFAULT NULL,
  `token_url` TEXT DEFAULT NULL,
  `userinfo_url` TEXT DEFAULT NULL,
  `extra` JSON DEFAULT NULL, -- for any additional provider-specific config
  `managed` tinyint(4) DEFAULT 0,
  -- the repository and the file (sso/<file>.yaml) it comes from ; NULL for one kept in the app only
  -- (lib/repoObjects)
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  UNIQUE KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;