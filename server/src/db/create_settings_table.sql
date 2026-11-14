USE `AnsibleForms`;
CREATE TABLE `settings` (
  `encryption_check` text DEFAULT NULL,
  `url` varchar(250) DEFAULT NULL,
  `config_yaml` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logo` longtext DEFAULT NULL,
  `config_source` varchar(20) DEFAULT NULL,
  `default_language` varchar(5) DEFAULT NULL,
  `default_theme` varchar(10) DEFAULT NULL,
  `default_theme_color` varchar(7) DEFAULT NULL,
  `managed` tinyint(4) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

