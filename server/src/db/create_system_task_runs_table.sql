USE `AnsibleForms`;
CREATE TABLE `system_task_runs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  -- the task that ran (lib/systemTasks.js SYSTEM_TASKS : jobCleanup, nightlyBackup ...)
  `task_key` varchar(50) NOT NULL,
  -- when the run started and ended, in UTC, to the millisecond (its duration)
  `started_at` datetime(3) NOT NULL,
  `ended_at` datetime(3) DEFAULT NULL,
  -- success or failed
  `outcome` varchar(10) NOT NULL,
  -- what it did, in a few words (removed 120 jobs), or the error
  `result` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  -- the node that ran it (the worker's name, lib/role.js nodeId)
  `node` varchar(250) DEFAULT NULL,
  -- who started it with Run now, as the Jobs list names a user (admin (local)) ; NULL for a
  -- timed run, a hub loop's timed failure or hourly summary
  `launched_by` varchar(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_system_task_runs_task` (`task_key`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
