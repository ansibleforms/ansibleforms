USE `AnsibleForms`;
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
  -- the repository and the file (syslog/<file>.yaml) it comes from ; NULL for one kept in the app only
  -- (lib/repoObjects)
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_syslog_servers_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
