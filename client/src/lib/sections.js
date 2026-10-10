// The four sections of the header (AppNav) a page belongs to, by its address : every page's
// title starts with its section, as the header names it (AppSettings) - Jobs › Running,
// Settings › Users › admin, Forms › All forms. A page outside them (profile, login) has none.

/**
 * The section a page belongs to.
 *
 * Args:
 *   path (String): the page's route path.
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object|null: { title, icon, to } as a crumb, or null for a page outside the sections.
 */
export function sectionOf(path, t) {
  if (path === '/jobs' || path.startsWith('/jobs/')) return { title: t('nav.jobs'), icon: 'history', to: '/jobs' };
  if (path === '/settings' || path.startsWith('/settings/')) {
    return { title: t('nav.settings'), icon: 'gear', to: '/settings/general' };
  }
  if (path === '/designer' || path.startsWith('/designer/')) {
    return { title: t('nav.designer'), icon: 'pen-to-square', to: '/designer' };
  }
  if (path === '/forms' || path.startsWith('/forms/'))
    return { title: t('nav.forms'), icon: 'rectangle-list', to: '/forms/all' };
  return null;
}
