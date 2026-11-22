USE `AnsibleForms`;
CREATE TABLE `schedule` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  -- a schedule is timed by one of cron, rrule and one_time_run (the moment of its one run)
  `one_time_run` DATETIME DEFAULT NULL,
  `cron` VARCHAR(50) DEFAULT NULL,
  `form` VARCHAR(255) DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT NULL,
  `last_run` DATETIME DEFAULT NULL,
  `state` VARCHAR(50) DEFAULT NULL,
  -- turned off, its cron or one time run does not fire (Run now still does) ; its settings kept
  `enabled` TINYINT(4) DEFAULT 1,
  -- who launches it (state='running') and since when (models/schedule.model.js launch)
  `claim_node` varchar(250) DEFAULT NULL,
  `claim_since` datetime DEFAULT NULL,
  `queue_id` INT DEFAULT 0,  
  `extra_vars` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `output` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- the user a planned job ("Run later") runs as ; NULL for an admin-level schedule
  `owner` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- a planned job's raw field values, for the launch validation when it fires
  `raw_form_data` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- what it is for, in a few words
  `description` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- timed by an iCal rrule instead of a cron or a one time run
  `rrule` TEXT DEFAULT NULL,
  -- the schedules repository and the file (schedules/<file>.yaml) it comes from ; NULL for one
  -- kept in the app only
  `repository` varchar(250) DEFAULT NULL,
  `repo_file` varchar(500) DEFAULT NULL,
  -- its file's prompts as the reserved extra vars a job reads (__limit__, __tags__ ...), JSON
  `launch_options` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- the stored job a planned job's values came from ; NULL for a schedule
  `stored_job_id` int(11) DEFAULT NULL,
  -- how it ends (lib/scheduleEnd.js) : never, on a date (end_at) or after a number of runs
  -- (end_count) ; then turned off or removed (end_action). A one-time run has none
  `ends` VARCHAR(10) NOT NULL DEFAULT 'never',
  `end_at` DATETIME DEFAULT NULL,
  `end_count` INT DEFAULT NULL,
  `end_action` VARCHAR(10) NOT NULL DEFAULT 'disable',
  -- the jobs it started (jobs.schedule_id), counted toward end_count
  `run_count` INT NOT NULL DEFAULT 0,
  -- a one-time run removed after it started its job ; else turned off and kept
  `remove_after_run` TINYINT(4) NOT NULL DEFAULT 1,
  UNIQUE KEY `uk_schedule_natural_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
