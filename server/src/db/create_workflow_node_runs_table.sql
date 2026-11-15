USE `AnsibleForms`;
CREATE TABLE `workflow_node_runs` (
  `job_id` int(11) NOT NULL,
  -- the node's identifier in its workflow (the designer's workflow file)
  `node` varchar(250) NOT NULL,
  -- successful, failed, canceled, skipped (or pending / running while the workflow runs)
  `status` varchar(20) NOT NULL,
  -- seconds the node ran, in the run that ran it
  `elapsed` decimal(12,3) DEFAULT NULL,
  -- the node's own job (a child of the workflow job), when it had one
  `node_job_id` int(11) DEFAULT NULL,
  -- 1 : carried over from the run this one relaunched from its failed node (it did not run)
  `carried` tinyint(4) NOT NULL DEFAULT 0,
  -- what the node passes on to the nodes after it (set_stats artifacts) : JSON
  `artifacts` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`job_id`, `node`),
  CONSTRAINT `FK_workflow_node_runs_jobs` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
