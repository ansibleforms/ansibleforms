USE `AnsibleForms`;
CREATE TABLE `repositories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `branch` varchar(250) DEFAULT NULL,
  `user` varchar(250) DEFAULT NULL,
  `password` text DEFAULT NULL,
  `uri` varchar(250) DEFAULT NULL,
  `description` text NOT NULL,
  `use_for_forms` tinyint(4) DEFAULT NULL,
  `use_for_playbooks` tinyint(4) DEFAULT NULL,  
  `cron` varchar(50) DEFAULT NULL,  
  `status` varchar(50) DEFAULT NULL,
  -- who holds the status='running' claim and since when (models/repository.model.js claim)
  `claim_node` varchar(250) DEFAULT NULL,
  `claim_since` datetime DEFAULT NULL,
  -- what git said on the last pull (or clone, reset), and on the last push (models/repository.model.js)
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
