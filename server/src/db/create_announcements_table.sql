-- the announcements under the header (Settings > Appearance > Announcements) : each with its
-- type, whether it is enabled and the moments it starts and ends showing (models/announcement.model.js)
USE `AnsibleForms`;
CREATE TABLE IF NOT EXISTS `announcements` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `message` varchar(500) NOT NULL,
  `level` varchar(10) NOT NULL DEFAULT 'info',
  `enabled` tinyint(4) NOT NULL DEFAULT 1,
  `start_at` datetime DEFAULT NULL,
  `end_at` datetime DEFAULT NULL,
  `created_by` varchar(250) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  -- its name : a seed's or a repository's announcement is found again by it ; none for one made
  -- in the app until a repository writes it
  `name` varchar(100) DEFAULT NULL,
  -- the repository and the file (announcements/<file>.yaml) it comes from ; NULL for one kept in the app only
  -- (lib/repoObjects)
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
