/******************************************************************/
/*                                                                */
/*  The playbooks a form or a workflow node may name : the        */
/*  Designer's Playbooks files, as the server lists them (the     */
/*  first repository used for playbooks, as it runs them, then    */
/*  each other one under its name). Without playbookRepository a  */
/*  playbook is named as the first repository runs it ; with one, */
/*  from that repository's root ; __self__ names the repository   */
/*  the form or the workflow file is in.                          */
/*                                                                */
/******************************************************************/

// a form's playbookRepository (a node's playbook_repository) naming its own repository
export const SELF_REPOSITORY = '__self__';

/**
 * The playbooks offered for a repository named (playbookRepository), or for none.
 *
 * Args:
 *   files (string[]): the playbook files, as /api/v2/files/playbooks lists them.
 *   repositories (object[]): its repositories ([{ name, prefix, folder }]).
 *   repository (string): the repository named ; none : the first one, as it runs them.
 *   self (string): the repository the form or the workflow file is in, for __self__.
 *
 * Returns:
 *   string[]: the names, sorted ; none for __self__ outside a repository used for playbooks.
 */
export function playbookChoices(files, repositories, repository = '', self = '') {
  const prefixes = (repositories || []).map((r) => r.prefix).filter(Boolean);
  const own = (p) => !prefixes.some((x) => p.startsWith(`${x}/`));
  const wanted = repository === SELF_REPOSITORY ? self : repository;
  const named = (repositories || []).find((r) => r.name === wanted);
  if (repository === SELF_REPOSITORY && !named) return [];
  let list;
  if (!named) list = (files || []).filter(own);
  else if (named.prefix)
    list = files.filter((p) => p.startsWith(`${named.prefix}/`)).map((p) => p.slice(named.prefix.length + 1));
  else list = files.filter(own).map((p) => (named.folder ? `${named.folder}/${p}` : p));
  return [...list].sort((a, b) => a.localeCompare(b));
}

export default { playbookChoices, SELF_REPOSITORY };
