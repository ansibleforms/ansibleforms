import { mayOpen } from '@/lib/routePermission';

// The pages the header search finds, besides the forms.
//
// A page is offered only to a user who may open it : the role option of its route
// (lib/routePermission.js, the route's meta.permission), as in the left menus (AppSidebar,
// AppJobsSidebar) - so a result never bounces them back home.

/**
 * Lists the pages the user may open, for the header search.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   options (object): the role options of the signed-in user (profile.options).
 *
 * Returns:
 *   object[]: the pages, as { title, section, link, icon }.
 */
export function searchPages(t, options) {
  const settings = t('nav.settings');
  const pages = [
    // ---------------------------------------------------------------
    // the header menu
    // ---------------------------------------------------------------
    { title: t('nav.forms'), section: '', icon: 'rectangle-list', link: '/forms/all' },
    { title: t('nav.jobs'), section: '', icon: 'history', link: '/jobs/all' },
    { title: t('nav.designer'), section: '', icon: 'pen-to-square', link: '/designer' },
    { title: t('nav.profile'), section: '', icon: 'user-gear', link: '/profile' },
    { title: t('nav.apiDocs'), section: '', icon: 'code', link: '/api-docs' },

    // ---------------------------------------------------------------
    // the jobs menu
    // ---------------------------------------------------------------
    {
      title: t('sidebar.schedules'),
      section: t('nav.jobs'),
      icon: 'clock',
      link: '/jobs/schedules',
    },
    {
      title: t('sidebar.storedJobs'),
      section: t('nav.jobs'),
      icon: 'floppy-disk',
      link: '/jobs/stored',
    },

    // ---------------------------------------------------------------
    // the settings menu
    // ---------------------------------------------------------------
    {
      title: t('sidebar.ansibleForms'),
      section: settings,
      icon: 'toolbox',
      link: '/settings/general',
    },
    { title: t('sidebar.logo'), section: settings, icon: 'image', link: '/settings/logo' },
    {
      title: t('sidebar.status'),
      section: settings,
      icon: 'heart-pulse',
      link: '/settings/status',
    },
    {
      title: t('sidebar.backups'),
      section: settings,
      icon: 'database',
      link: '/settings/backups',
    },
    // edited in the designer (its Visual tab), no longer a settings page
    {
      title: t('sidebar.categories'),
      section: t('nav.designer'),
      icon: 'sitemap',
      link: '/designer/categories?tab=visual',
    },
    // edited in the designer (its Visual tab), no longer a settings page
    {
      title: t('sidebar.constants'),
      section: t('nav.designer'),
      icon: 'sliders-h',
      link: '/designer/constants?tab=visual',
    },
    { title: t('sidebar.users'), section: settings, icon: 'user', link: '/settings/users' },
    {
      title: t('sidebar.groups'),
      section: settings,
      icon: 'users',
      link: '/settings/groups',
    },
    {
      title: t('sidebar.roles'),
      section: settings,
      icon: 'user-shield',
      link: '/settings/roles',
    },
    {
      title: t('sidebar.ldap'),
      section: settings,
      icon: 'address-book',
      link: '/settings/ldap',
    },
    {
      title: t('sidebar.oauth2'),
      section: settings,
      icon: 'right-to-bracket',
      link: '/settings/sso',
    },
    {
      title: t('sidebar.mail'),
      section: settings,
      icon: 'envelope',
      link: '/settings/mailSettings',
    },
    {
      title: t('sidebar.credentials'),
      section: settings,
      icon: 'lock',
      link: '/settings/credentials',
    },
    {
      title: t('sidebar.secretStores'),
      section: settings,
      icon: 'vault',
      link: '/settings/secretStores',
    },
    { title: t('sidebar.ssh'), section: settings, icon: 'key', link: '/settings/ssh' },
    {
      title: t('sidebar.knownHosts'),
      section: settings,
      icon: 'server',
      link: '/settings/knownHosts',
    },
    {
      title: t('sidebar.runners'),
      section: settings,
      icon: 'rocket',
      link: '/settings/runners',
    },
    {
      title: t('sidebar.repositories'),
      section: settings,
      icon: 'fab,git',
      link: '/settings/repositories',
    },
    {
      title: t('sidebar.chat'),
      section: settings,
      icon: 'comments',
      link: '/settings/chat',
    },
    { title: t('sidebar.mcp'), section: settings, icon: 'robot', link: '/settings/mcp' },
    {
      title: t('sidebar.audit'),
      section: settings,
      icon: 'clipboard-list',
      link: '/settings/audit',
    },
    { title: t('sidebar.logs'), section: settings, icon: 'file-lines', link: '/settings/logs' },
  ];
  return pages.filter((p) => mayOpen(p.link, options));
}
