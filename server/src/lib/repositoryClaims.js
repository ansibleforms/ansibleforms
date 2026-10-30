// What a repository's claim leaves behind when it is released without the operation ending it.
//
// The claim (models/repository.model.js claim) is the one lock of a repository : status
// 'running'. The pull or the push it runs is said in its own column as well, pull_status or
// push_status 'running', so the repositories' Pull and Push badges each read their own
// operation. A claim released for its holder - a node that went away (releaseStaleClaims), a
// restored dump's claims (backup.model.js releaseRestoredRuntime) - must end that operation
// too, or its badge stays on running for ever, with nobody left to end it.

/**
 * The SET assignments that end, as failed, the pull or the push a released claim was running ;
 * the one not running keeps how it last ended. Each is followed by a comma, to sit in an UPDATE
 * of AnsibleForms.`repositories` before its other assignments (the claim_node cleared).
 *
 * Args:
 *   alias (string): the table's alias in the UPDATE, with its dot ("r."), or "" for none.
 *
 * Returns:
 *   string: the assignments, ending with ", ".
 */
export function releasedOperationsSql(alias = "") {
  return `${alias}pull_status = IF(${alias}pull_status = 'running', 'failed', ${alias}pull_status), ` +
    `${alias}push_status = IF(${alias}push_status = 'running', 'failed', ${alias}push_status), `
}
