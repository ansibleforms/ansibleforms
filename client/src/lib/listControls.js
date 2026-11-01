/******************************************************************/
/*                                                                */
/*  A list's controls on its page's title line, as their widths   */
/*  in pixels (as their labels make them, in English), for their  */
/*  placeholders while the list loads (AppSkeleton 'buttons') :   */
/*  the title line has their room from the first frame (wrapped   */
/*  to a row of their own as the real ones are), and the table    */
/*  does not move down when they come.                            */
/*                                                                */
/*  The table's own (BsDataTable's toolbar) : the search, Select  */
/*  all when its rows can be ticked, the columns, the export ;    */
/*  then the page's buttons (Add, Pull all ...).                  */
/*                                                                */
/******************************************************************/

// the table's toolbar : its search ('search' : 20rem, down to 10rem in a narrow line), Select all, the
// columns' menu, the export
const SELECT_ALL = 138;
const COLUMNS = 132;
const EXPORT = 140;

// the lists, by their word in the address : the buttons of their page (Add ..., the repositories'
// Pull all, the runners' Register) and whether their rows can be ticked (a bulk delete)
const LISTS = {
  users: { buttons: [121] },
  groups: { buttons: [133] },
  roles: { buttons: [116] },
  repositories: { buttons: [102, 167] },
  credentials: { buttons: [166] },
  'secret-stores': { buttons: [181] },
  databases: { buttons: [150] },
  runners: { buttons: [151, 139] },
  notifications: { buttons: [244] },
  syslog: { buttons: [192] },
  ldap: { buttons: [190], selectable: false },
  // Add SSO provider ; Add disclaimer
  sso: { buttons: [190] },
  disclaimer: { buttons: [160] },
  // Add announcement
  announcements: { buttons: [207] },
  backups: { buttons: [144], selectable: false },
  scheduled: { buttons: [158] },
  stored: { buttons: [166] },
  // the lists in a tab of a page : by the page's word and the tab's
  'ssh/known-hosts': { buttons: [178] },
};

/**
 * The table's controls on the title line.
 *
 * Args:
 *   selectable (boolean): its rows can be ticked (Select all).
 *
 * Returns:
 *   Array: their widths, 'search' for the search box.
 */
export function tableControls(selectable) {
  return ['search', ...(selectable ? [SELECT_ALL] : []), COLUMNS, EXPORT];
}

/**
 * A list page's controls on its title line : its table's, then its own buttons.
 *
 * Args:
 *   kind (string): the list's word in its address (users, credentials ... ; scheduled and stored
 *     for the jobs' ; page/tab for a list in a tab, sso/providers).
 *
 * Returns:
 *   Array|null: their widths ('search' for the search box) ; null for a list not known here.
 */
export function listControls(kind) {
  const list = LISTS[kind];
  if (!list) return null;
  return [...tableControls(list.selectable !== false), ...list.buttons];
}

export default { tableControls, listControls };
