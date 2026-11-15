// The job page's Relaunch : a plain button, or the split button the form's Submit is
// (BsDropdownButton) when the job offers a second choice - its failed hosts (an ended playbook job,
// an AWX, AAP or Ascender job template job : GET /api/v2/job/:id/relaunch-options). The menu's
// entries are built here, so the page only renders them.

/**
 * The entries of the Relaunch menu : a full relaunch, then each other choice the job offers. No
 * other choice : none, and the page shows the plain Relaunch button.
 *
 * Args:
 *   options (object|null): the job's relaunch options ({ failedHosts }).
 *   t (function): vue-i18n's t.
 *
 * Returns:
 *   object[]: [{ key, label, icon }] for BsDropdownButton ; [] without a second choice.
 */
export function relaunchActions(options, t) {
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
 *   scope (string): 'all' (or none) a full relaunch, 'failedHosts' the failed hosts only.
 *
 * Returns:
 *   object: the body (POST /api/v2/job/:id/relaunch).
 */
export function relaunchBody(scope) {
  return scope === 'failedHosts' ? { failedHostsOnly: true } : {};
}
