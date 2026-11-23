/******************************************************************/
/*                                                                */
/*  __self__ as a playbook's repository : the repository the     */
/*  form (playbookRepository) or the workflow file (a node's      */
/*  playbook_repository) is read from, so it runs its playbook    */
/*  from its own root without naming itself.                      */
/*                                                                */
/******************************************************************/

// the keyword, on a form, a step or a workflow node
export const SELF_REPOSITORY = "__self__";

/**
 * The repository a playbook runs from, as it is named : __self__ is the repository the form or the
 * workflow is read from ; any other name is itself.
 *
 * Args:
 *   named (string): the playbookRepository (or playbook_repository) as written.
 *   own (string|null): the repository the form or the workflow file is in ; null : none.
 *
 * Returns:
 *   string: the repository ; __self__ again when it is in none (its launch is refused).
 */
export function selfRepository(named, own) {
  return named === SELF_REPOSITORY ? own || SELF_REPOSITORY : named;
}

export default { SELF_REPOSITORY, selfRepository };
