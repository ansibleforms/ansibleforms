USE `AnsibleForms`;
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
  -- the repository and the file (labels/<file>.yaml) it comes from ; NULL for one kept in the app only
  -- (lib/repoObjects)
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_AnsibleForms_labels_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
