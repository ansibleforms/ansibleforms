USE `AnsibleForms`;
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
  -- Credentials for the login (none for an open relay), or an entraid one for Microsoft 365
  `server` varchar(250) DEFAULT NULL,
  `port` int(11) DEFAULT NULL,
  `secure` tinyint(4) DEFAULT 0,
  `from_address` varchar(250) DEFAULT NULL,
  `credential` varchar(250) DEFAULT NULL,
  -- mail with an entraid credential : Microsoft Graph or SMTP with OAuth2 (graph, smtp)
  `send_through` varchar(20) DEFAULT NULL,
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
