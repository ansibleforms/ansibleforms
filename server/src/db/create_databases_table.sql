USE `AnsibleForms`;
-- the databases forms query (Connections > Databases) : a field's dbConfig names one. Its name, what
-- it is, and the credential of type database it connects with (its engine, server, database and
-- login are the credential's)
CREATE TABLE `databases` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `description` text DEFAULT NULL,
  `credential` varchar(250) NOT NULL,
  `managed` tinyint(4) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_databases_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
