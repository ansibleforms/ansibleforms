USE `AnsibleForms`;
-- the patches applied to this database, and by which release : models/schema.model.js
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `name` varchar(64) NOT NULL,
  `version` varchar(32) NOT NULL,
  `applied_at` datetime NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
