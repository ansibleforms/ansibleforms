/******************************************************************/
/*                                                                */
/*  The settings menu's entries : its sections, and in each the   */
/*  pages with their title, icon and link. The settings sidebar   */
/*  (AppSidebar) shows those the user may open ; the start-up     */
/*  screen names a settings page by them (lib/pageSkeleton.js)    */
/*  before the page runs.                                         */
/*                                                                */
/******************************************************************/

/**
 * The settings menu, every entry (not filtered on the user's role options).
 *
 * Args:
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Array: [{ title, items: [{ title, icon, link }] }], in the menu's order.
 */
export function settingsMenu(t) {
  return [
    {
      // The instance itself : configure it, check its health, back it up. First,
      // because "where do I set the url / what version is this / is anything
      // broken" is what an admin opens this menu for most often.
      title: t('sidebar.sections.system'),
      items: [
        { title: t('sidebar.ansibleForms'), icon: 'toolbox', link: '/settings/general' },
        { title: t('sidebar.status'), icon: 'heart-pulse', link: '/settings/status' },
        // the database backups : the instance's own data, so with the instance
        { title: t('sidebar.backups'), icon: 'box-archive', link: '/settings/backups' },
      ],
    },
    {
      // How the instance looks : its defaults, its name, the logo in the top bar, the icon in the
      // browser tab, the header's links, the label beside the logo, the announcement
      title: t('sidebar.sections.appearance'),
      items: [
        { title: t('sidebar.defaults'), icon: 'display', link: '/settings/defaults' },
        { title: t('sidebar.name'), icon: 'font', link: '/settings/name' },
        { title: t('sidebar.logo'), icon: 'image', link: '/settings/logo' },
        { title: t('sidebar.icon'), icon: 'bookmark', link: '/settings/icon' },
        { title: t('sidebar.links'), icon: 'link', link: '/settings/links' },
        { title: t('sidebar.labels'), icon: 'tag', link: '/settings/labels' },
        { title: t('sidebar.announcement'), icon: 'bullhorn', link: '/settings/announcements' },
      ],
    },
    {
      // Who may sign in, and what they may do once in. Roles lives here rather
      // than with the other two config.yaml editors : sharing code is not a reason
      // to group them, and permissions belong next to users and groups.
      title: t('sidebar.sections.access'),
      items: [
        // what everyone accepts once before using the app, and who did
        { title: t('sidebar.disclaimer'), icon: 'file-signature', link: '/settings/disclaimer' },
        { title: t('sidebar.users'), icon: 'user', link: '/settings/users' },
        { title: t('sidebar.groups'), icon: 'users', link: '/settings/groups' },
        // 'user-shield' not 'users' : groups already own the people icon, and
        // roles are about what a member may do, not who the members are
        { title: t('sidebar.roles'), icon: 'user-shield', link: '/settings/roles' },
        { title: t('sidebar.ldap'), icon: 'address-book', link: '/settings/ldap' },
        { title: t('sidebar.oauth2'), icon: 'right-to-bracket', link: '/settings/sso' },
      ],
    },
    {
      // Outbound : the systems AnsibleForms reaches and the credentials for them.
      // Notifications belong here rather than under a section of its own - an smtp host,
      // a Slack or Teams webhook, a Telegram bot or any webhook is a system it reaches, the
      // same shape as runners and repositories, with the same 'test it' action.
      title: t('sidebar.sections.connections'),
      items: [
        // where forms and playbooks come from, what they log in with (and the stores that hold it),
        // the databases forms query (database credentials, a list of their own), where jobs run ;
        // then the rest
        {
          title: t('sidebar.repositories'),
          icon: 'fab,git',
          link: '/settings/repositories',
        },
        { title: t('sidebar.credentials'), icon: 'lock', link: '/settings/credentials' },
        { title: t('sidebar.secretStores'), icon: 'vault', link: '/settings/secret-stores' },
        { title: t('sidebar.databases'), icon: 'database', link: '/settings/databases' },
        { title: t('sidebar.runners'), icon: 'rocket', link: '/settings/runners' },
        { title: t('sidebar.ssh'), icon: 'key', link: '/settings/ssh' },
        { title: t('sidebar.notifications'), icon: 'bell', link: '/settings/notifications' },
        { title: t('sidebar.chat'), icon: 'comments', link: '/settings/chat' },
        { title: t('sidebar.mcp'), icon: 'robot', link: '/settings/mcp' },
        // where the server log and the audit entries are sent
        { title: t('sidebar.syslog'), icon: 'tower-broadcast', link: '/settings/syslog' },
      ],
    },
    {
      // What happened on the instance : who changed what (the audit log), and what
      // the server itself reported (the server log, for troubleshooting). Last : the
      // sections above are what you set up, these are read afterwards.
      title: t('sidebar.sections.logs'),
      items: [
        { title: t('sidebar.audit'), icon: 'clipboard-list', link: '/settings/audit-log' },
        { title: t('sidebar.logs'), icon: 'file-lines', link: '/settings/server-log' },
      ],
    },
  ];
}

/**
 * The settings menu's entry of a page : the one whose link starts its address.
 *
 * Args:
 *   path (string): the page's address (/settings/credentials/3).
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object|null: { title, icon, link }, or null for an address outside the menu.
 */
export function settingsEntry(path, t) {
  const items = settingsMenu(t).flatMap((s) => s.items);
  return items.find((i) => path === i.link || path.startsWith(i.link + '/')) || null;
}

/**
 * The settings menu's section of a page (System, Appearance, Access, ...) : the one holding its
 * entry.
 *
 * Args:
 *   path (string): the page's address (/settings/defaults).
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object|null: { title }, or null for an address outside the menu.
 */
export function settingsSection(path, t) {
  const section = settingsMenu(t).find((s) => s.items.some((i) => path === i.link || path.startsWith(i.link + '/')));
  return section ? { title: section.title } : null;
}

export default { settingsMenu, settingsEntry, settingsSection };
