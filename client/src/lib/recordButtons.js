/******************************************************************/
/*                                                                */
/*  The buttons a record's page will have on its title line, as   */
/*  their widths, for their placeholders while the record loads   */
/*  (AppSkeleton 'buttons') : the title line keeps its height and */
/*  wraps as it will, and nothing moves when they come.           */
/*                                                                */
/*  Some depend on the record : one of the config seed (managed)  */
/*  has no Delete nor Save, a database credential a Test, ... The */
/*  record's row of its list, when the list was read in this tab  */
/*  (AppAdminMulti remembers it, lib/menuMemory.js), says which.  */
/*  Without it (a reload, a link), the usual case : a credential, */
/*  a secret store, a channel or a syslog server is made in the   */
/*  app (Delete and Save), a runner usually comes from the seed   */
/*  (only Test connection, which every runner has).               */
/*                                                                */
/******************************************************************/
import { remembered } from '@/lib/menuMemory';
import { RESERVED_ROLES } from '@/composables/useRoleSupport';

// the buttons' widths in pixels, as their labels make them (in English)
const W = {
  testConnection: 175,
  changePassword: 192,
  changeSecret: 150,
  delete: 103,
  save: 89,
  sendTest: 126,
  pull: 78,
  push: 88,
  reset: 95,
  runNow: 119,
  openInForm: 155,
};

// a list's rows by the api's type (AppAdminMulti) : the record pages' kinds
const ROW_TYPES = {
  credentials: 'credential',
  databases: 'database',
  runners: 'runner',
  repositories: 'repository',
  'secret-stores': 'secretstore',
  notifications: 'notificationchannel',
  syslog: 'syslogserver',
  ldap: 'ldapdirectory',
};

/**
 * Remembers the rows of a list, for its records' pages (called by AppAdminMulti).
 *
 * Args:
 *   type (string): the api's type (credential, runner ...).
 *   rows (Array): the rows read.
 */
export function rememberRows(type, rows) {
  remembered(`rows:${type}`).value = Array.isArray(rows) ? rows : null;
}

/**
 * The remembered row of a record.
 *
 * Args:
 *   kind (string): the record's kind, as in its address (credentials, runners ...).
 *   id (string|number): its number.
 *
 * Returns:
 *   Object|null: the row ; null when its list was not read in this tab.
 */
function rowOf(kind, id) {
  const type = ROW_TYPES[kind];
  if (!type) return null;
  const rows = remembered(`rows:${type}`).value;
  return (rows || []).find((r) => String(r.id) === String(id)) || null;
}

/**
 * The buttons a record's page will have on its title line.
 *
 * Args:
 *   kind (string): the record's kind, as in its address (credentials, runners, users ...,
 *     scheduled and stored for the jobs).
 *   id (string|number): its number, or its name (a role).
 *   isAdmin (boolean): the user is an admin (a runner is edited by admins only).
 *
 * Returns:
 *   number[]: the buttons' widths, in their order ; [] for none.
 */
export function recordButtons(kind, id, isAdmin = true) {
  const row = rowOf(kind, id);
  // the managed ones (the config seed) : read only, no Delete nor Save ; not known, a runner is
  // taken for one of the seed, the others for one made in the app
  const managed = row ? !!row.managed : kind === 'runners';
  const editable = (extra = []) => (managed ? [] : [...extra, W.delete, W.save]);
  switch (kind) {
    case 'credentials': {
      // its password in its Login tab ; a database one can be tested
      return [...(row?.is_database ? [W.testConnection] : []), ...editable()];
    }
    case 'databases':
      // its credential's connection : always tested
      return [W.testConnection, ...editable()];
    case 'runners':
      return [W.testConnection, ...(isAdmin ? editable() : [])];
    case 'secret-stores':
      return [W.testConnection, ...editable()];
    case 'ldap':
      // Test connection ; the default directory has no Delete
      return row?.name === 'default' ? [W.testConnection, W.save] : [W.testConnection, W.delete, W.save];
    case 'notifications':
    case 'syslog':
      return [W.sendTest, ...editable()];
    case 'repositories':
      return [W.pull, W.push, W.reset, W.delete, W.save];
    case 'sso':
      return [W.delete, W.save];
    case 'users':
      return [W.changePassword, W.delete, W.save];
    case 'groups':
      return [W.delete, W.save];
    case 'roles':
      return RESERVED_ROLES.includes(String(id)) ? [W.save] : [W.delete, W.save];
    case 'scheduled':
      return [W.runNow, W.delete, W.save];
    case 'stored':
      return [W.openInForm, W.delete, W.save];
    default:
      return [];
  }
}

export default { recordButtons, rememberRows };
