/******************************************************************/
/*                                                                */
/*  A page's look while it loads, from its address alone : its    */
/*  frame (the left menu beside it), its title's steps and the    */
/*  shape of its content (AppSkeleton). The start-up screen draws */
/*  it before the page runs (AppLoadingScreen), and a settings    */
/*  page while it checks the user (AppSettingsPage), so the real  */
/*  page then takes the same spot.                                */
/*                                                                */
/*  A title step not known from the address (a record's name, a   */
/*  tab's) has a null title : a grey bar in its place (AppSettings)*/
/*                                                                */
/******************************************************************/
import { sectionOf } from '@/lib/sections';
import { settingsEntry } from '@/lib/settingsMenu';
import { statusFromSlug, ALL_JOBS } from '@/lib/jobsPath';
import { recordButtons } from '@/lib/recordButtons';
import { listControls } from '@/lib/listControls';
import { profileViews, profileMenuViews } from '@/config/profileViews';

// ------------------------------------------------------------------
// the settings pages, by the first word of their address
// ------------------------------------------------------------------
// the lists : a table (AppAdminMulti and the tables of their own)
const SETTINGS_LISTS = [
  'users',
  'groups',
  'roles',
  'repositories',
  'credentials',
  'secret-stores',
  'databases',
  'runners',
  'ldap',
  'sso',
  'disclaimer',
  'announcements',
  'notifications',
  'syslog',
  'audit-log',
  'backups',
];
// the pages in tabs : how many tabs they have
const SETTINGS_TABS = {
  general: 11,
  status: 2,
  links: 2,
  ssh: 2,
  chat: 4,
  mcp: 6,
};
// the pages whose content is not fields : the checks' rows, the server log's lines
const SETTINGS_SHAPES = {
  status: { shape: 'detail', count: 8 },
  'server-log': { shape: 'editor', count: 24 },
};

/**
 * The last step of a record's title : its tab, Details when the address names none (every
 * record page opens on it), else a grey bar (the tab's name is its page's).
 *
 * Args:
 *   tab (string|undefined): the tab in the address.
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object: the crumb.
 */
function recordTab(tab, t) {
  return !tab || tab === 'details'
    ? { title: t('settings.common.tabDetails'), icon: 'sliders' }
    : { title: null, icon: 'sliders' };
}

/**
 * The look of a settings page.
 *
 * Args:
 *   words (Array): the address's words after /settings.
 *   path (string): the address.
 *   section (Object): the Settings crumb.
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object|null: the page's look, null for an address outside the menu.
 */
function settingsPage(words, path, section, t) {
  const entry = settingsEntry(path, t);
  if (!entry) return null;
  const own = { title: entry.title, icon: entry.icon, to: entry.link };
  const [page, ...rest] = words;
  // a record of a list (/settings/users/3, /settings/roles/admin, /settings/users/ldap/jdoe) :
  // its name when the address carries it (not a number), then its tab ; its fields
  // (an SSO provider too : /settings/sso/2, beside the SSO page's tabs /settings/sso/providers)
  const record = SETTINGS_LISTS.includes(page) || (page === 'sso' && /^\d+$/.test(rest[0] || ''));
  if (record && rest.length) {
    const directory = ['ldap', 'azuread', 'oidc'].includes(rest[0]) && rest.length > 1;
    const word = directory ? rest[1] : rest[0];
    const name = /^\d+$/.test(word) ? null : decodeURIComponent(word);
    return {
      frame: 'settings',
      crumbs: [section, own, { title: name, icon: entry.icon }, recordTab(rest[directory ? 2 : 1], t)],
      tabs: 4,
      // a directory user's : Block sign-in and Forget ; a directory group's : none
      // its buttons (lib/recordButtons.js) ; a directory user's : Block sign-in and Forget, a
      // directory group's : none
      buttons: directory ? (page === 'users' ? [130, 100] : null) : recordButtons(page, word),
      parts: [{ shape: 'form', count: 3 }],
    };
  }
  if (SETTINGS_LISTS.includes(page)) {
    return {
      frame: 'settings',
      crumbs: [section, own],
      // the table's controls and the page's buttons on the title line (lib/listControls.js) ; the
      // audit log's filters (actors, actions, outcomes) and Refresh
      buttons: page === 'audit-log' ? [256, 352, 154, 110] : listControls(page),
      parts: [{ shape: 'table', count: 8 }],
    };
  }
  const tabs = SETTINGS_TABS[page] || 0;
  // a tab that is a list (the SSH page's known hosts ...) : its table, its
  // controls on the title line (lib/listControls.js)
  const tabList = rest[0] ? listControls(`${page}/${rest[0]}`) : null;
  return {
    frame: 'settings',
    // a page in tabs names its tab last
    crumbs: tabs ? [section, own, { title: null, icon: 'sliders' }] : [section, own],
    tabs,
    buttons: tabList,
    parts: [tabList ? { shape: 'table', count: 8 } : SETTINGS_SHAPES[page] || { shape: 'form', count: 4 }],
    // the server log fills the window, its card the scrolling pane
    fill: page === 'server-log',
  };
}

// ------------------------------------------------------------------
// the jobs pages
// ------------------------------------------------------------------

/**
 * The title of the jobs list of a status, as its page names it (pages/jobs.vue).
 *
 * Args:
 *   status (string|null): the status (running, approve ...) ; none, every job.
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object: { title, icon }.
 */
function jobsListTitle(status, t) {
  const titles = {
    running: { title: t('jobs.menu.running'), icon: 'play' },
    approve: { title: t('jobs.menu.approve'), icon: 'hourglass-half' },
    success: { title: t('jobs.menu.success'), icon: 'check' },
    failed: { title: t('jobs.menu.failed'), icon: 'xmark' },
    aborted: { title: t('jobs.menu.aborted'), icon: 'ban' },
    rejected: { title: t('jobs.menu.rejected'), icon: 'thumbs-down' },
    abandoned: { title: t('jobs.menu.abandoned'), icon: 'plug-circle-xmark' },
  };
  return titles[status] || { title: t('jobs.menu.all'), icon: 'list' };
}

/**
 * The look of a jobs page.
 *
 * Args:
 *   words (Array): the address's words after /jobs.
 *   section (Object): the Jobs crumb.
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Object|null: the page's look.
 */
function jobsPage(words, section, t) {
  const [first, id] = words;
  // a job : its number is its title ; its facts, then its output
  if (/^\d+$/.test(first || '')) {
    return {
      frame: 'jobs',
      crumbs: [section, { title: t('jobs.jobTitle', { id: '#' + first }), icon: 'file-lines', to: `/jobs/${first}` }],
      parts: [
        { shape: 'facts', count: 6 },
        { shape: 'output', count: 14 },
      ],
    };
  }
  // the scheduled and the stored jobs : their list, or one of them in tabs
  const future = {
    scheduled: { title: t('jobs.menu.scheduled'), icon: 'clock', to: '/jobs/scheduled', tabs: 3 },
    stored: { title: t('jobs.menu.stored'), icon: 'floppy-disk', to: '/jobs/stored', tabs: 2 },
  }[first];
  if (future) {
    const own = { title: future.title, icon: future.icon, to: future.to };
    if (!id) {
      return {
        frame: 'jobs',
        crumbs: [section, own],
        buttons: listControls(first),
        parts: [{ shape: 'table', count: 8 }],
      };
    }
    return {
      frame: 'jobs',
      crumbs: [section, own, { title: null, icon: future.icon }, recordTab(words[2], t)],
      tabs: future.tabs,
      // its buttons (lib/recordButtons.js)
      buttons: recordButtons(first, id),
      parts: [{ shape: 'form', count: 3 }],
    };
  }
  // the jobs list : every job, or those of a status
  const status = first && first !== ALL_JOBS ? statusFromSlug(first) : null;
  const own = jobsListTitle(status, t);
  // its search, columns and Refresh on the title line (pages/jobs.vue)
  return {
    frame: 'jobs',
    list: true,
    crumbs: [section, own],
    buttons: ['search', 132, 110],
    parts: [{ shape: 'table', count: 10 }],
  };
}

// ------------------------------------------------------------------
// the page of an address
// ------------------------------------------------------------------

/**
 * The look of the page at an address, while it loads.
 *
 * Args:
 *   path (string): the address, without the app's base (/settings/users/3).
 *   i18n (Object): { t, locale } - vue-i18n's translate function and the language (the
 *     profile's menu is sorted in it).
 *   options (object): the user's role options (the profile's menu).
 *
 * Returns:
 *   Object|null: { frame, crumbs, tabs, buttons, parts: [{ shape, count, card, wide }], bare, fill } - frame the left
 *     menu beside it ('settings', 'jobs', 'form', 'profile', 'designer'), crumbs the title's
 *     steps (the section first), tabs how many tabs above the card, buttons the widths of those
 *     on the title line, parts the content's
 *     placeholders (card : in a card of their own, on a page without the card ; wide : fields
 *     across the card) ; fill : the page fills the window (af-fill-page) ; null when the address
 *     names no known page.
 */
export function pageSkeleton(path, { t, locale }, options) {
  const clean = path.replace(/\/+$/, '') || '/';
  const words = clean.split('/').filter(Boolean);
  const section = sectionOf(clean, t);
  if (words[0] === 'settings' && words.length > 1) return settingsPage(words.slice(1), clean, section, t);
  if (words[0] === 'jobs') return jobsPage(words.slice(1), section, t);
  // a form : its name is known once it is read (the address carries its slug)
  if (words[0] === 'form' && words[1]) {
    const forms = sectionOf('/forms', t);
    return {
      frame: 'form',
      // the form's title has no icon of its own (pages/form.vue)
      crumbs: [forms, { title: null, icon: null }],
      parts: [{ shape: 'form', count: 5, wide: true }],
    };
  }
  // the profile : the view the address names, else the first of the menu
  if (words[0] === 'profile') {
    const views = profileMenuViews(
      profileViews(t, () => options),
      locale,
    );
    const view = views.find((v) => v.name === words[1]) || views[0];
    return {
      frame: 'profile',
      view: view.name,
      bare: true,
      crumbs: [section, { title: view.label(), icon: view.icon, to: `/profile/${view.name}` }],
      parts: [{ shape: 'detail', count: 4, card: true }],
    };
  }
  // the designer : its title until it is started, its editor's lines
  if (words[0] === 'designer') {
    return { frame: 'designer', crumbs: [section], parts: [{ shape: 'editor', count: 40 }], fill: true };
  }
  return null;
}

export default { pageSkeleton };
