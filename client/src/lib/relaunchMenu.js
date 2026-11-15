// The job page's Relaunch : a plain button, or the split button the form's Submit is
// (BsDropdownButton) when the job offers a second choice - its failed hosts (an ended playbook job,
// an AWX, AAP or Ascender job template job), or its failed node (a failed workflow job : the
// designer's, or an Ascender's) - GET /api/v2/job/:id/relaunch-options. The menu's entries are
// built here, so the page only renders them.

/**
 * The entries of the Relaunch menu : a full relaunch, then each other choice the job offers. No
 * other choice : none, and the page shows the plain Relaunch button.
 *
 * Args:
 *   options (object|null): the job's relaunch options ({ failedHosts, fromFailedNode }).
 *   t (function): vue-i18n's t.
 *
 * Returns:
 *   object[]: [{ key, label, icon }] for BsDropdownButton ; [] without a second choice.
 */
export function relaunchActions(options, t) {
  // a failed workflow job : from its first node (a full relaunch), or from its failed node
  if (options?.fromFailedNode) {
    return [
      { key: 'all', label: t('jobs.relaunchFromFirstNode'), icon: 'redo' },
      { key: 'failedNode', label: t('jobs.relaunchFromFailedNode'), icon: 'diagram-project' },
    ];
  }
  const extra = [];
  const hosts = options?.failedHosts;
  if (Array.isArray(hosts) && hosts.length) {
    extra.push({
      key: 'failedHosts',
      label: t('jobs.relaunchFailedHosts', { count: hosts.length }),
      icon: 'server',
    });
  }
  if (!extra.length) return [];
  return [{ key: 'all', label: t('jobs.relaunchAllHosts'), icon: 'redo' }, ...extra];
}

/**
 * The body of the relaunch call for a choice of the menu.
 *
 * Args:
 *   scope (string): 'all' (or none) a full relaunch, 'failedHosts' the failed hosts only,
 *     'failedNode' a workflow from its failed node.
 *
 * Returns:
 *   object: the body (POST /api/v2/job/:id/relaunch).
 */
export function relaunchBody(scope) {
  if (scope === 'failedHosts') return { failedHostsOnly: true };
  if (scope === 'failedNode') return { fromFailedNode: true };
  return {};
}
