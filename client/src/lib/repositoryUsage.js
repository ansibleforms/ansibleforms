/******************************************************************/
/*                                                                */
/*  What a repository is used for, as the repositories list       */
/*  reads it : the repositories Push all pushes.                  */
/*                                                                */
/******************************************************************/

// ===========================================================================
// WHAT PUSH ALL PUSHES
// ===========================================================================

/**
 * The repositories Push all pushes : the ones with changes not pushed yet, as a row's own Push is
 * enabled for (config/settings.js). None : the button stays greyed.
 *
 * Args:
 *   repos (object[]): the repositories, as the list shows them.
 *
 * Returns:
 *   object[]: the repositories to push.
 */
export const toPush = (repos) => (Array.isArray(repos) ? repos : []).filter((r) => !!r?.unpushed);
