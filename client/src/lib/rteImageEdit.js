/******************************************************************/
/*                                                                */
/*  The RTE images' YAML tab dialogs (AppRteImages) : a part of   */
/*  an image's draft set or added - its python, its ansible-core, */
/*  a collection, packages, its registry, its signing key.        */
/*                                                                */
/******************************************************************/

// a collection's name : namespace.name
export const COLLECTION_NAME = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

// ===========================================================================
// THE LISTS KEPT AS TEXT
// ===========================================================================

/**
 * Lines added to a list kept as text (the packages), each once, the ones it has kept in place.
 *
 * Args:
 *   text (string): the list, one per line.
 *   added (string): the ones to add.
 *   split (RegExp): what splits the added ones (lines ; for OS packages, spaces and commas too).
 *
 * Returns:
 *   string: the list with them, one per line.
 */
export function withLines(text, added, split) {
  const have = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of String(added || '')
    .split(split)
    .map((x) => x.trim())
    .filter(Boolean))
    if (!have.includes(l)) have.push(l);
  return have.join('\n');
}

// ===========================================================================
// A DIALOG APPLIED
// ===========================================================================

/**
 * Applies a YAML tab dialog to an image's draft (changed in place).
 *
 * Args:
 *   draft (object): the draft (AppRteImages draftOf).
 *   key (string): the dialog (rteArch, rtePython, rteCore, rteCollection, rtePythonPackages, rteOsPackages,
 *     rteRegistry, rteSigning).
 *   v (object): what it holds ({ arch, python, core, name, version, packages, path, credential, signing }).
 *   fit (object): { fits(version, python) : whether an ansible-core runs on a python,
 *     newestFor(python) : the newest release that does }.
 *
 * Returns:
 *   string: '' once applied ; 'collectionName' when the collection is no namespace.name.
 */
export function applyRteInsert(draft, key, v, fit) {
  switch (key) {
    case 'rteArch':
      draft.arch = v.arch;
      break;
    case 'rtePython':
      // python leads : an ansible-core that does not run on it takes the newest that does
      draft.python = v.python;
      if (!draft.ansible_core || !fit.fits(draft.ansible_core, v.python)) draft.ansible_core = fit.newestFor(v.python);
      break;
    case 'rteCore':
      draft.ansible_core = v.core;
      break;
    case 'rteCollection': {
      const name = String(v.name || '').trim();
      if (!COLLECTION_NAME.test(name)) return 'collectionName';
      const version = String(v.version || '').trim();
      // one already there takes the version given
      const have = draft.collections.find((c) => c.name.trim() === name);
      if (have) have.version = version;
      else draft.collections.push({ name, version });
      break;
    }
    case 'rtePythonPackages':
      draft.python_packages = withLines(draft.python_packages, v.packages, /\r?\n/);
      break;
    case 'rteOsPackages':
      draft.os_packages = withLines(draft.os_packages, v.packages, /[\s,]+/);
      break;
    case 'rteRegistry':
      draft.registry_credential = v.credential || '';
      draft.registry_path = String(v.path || '').trim();
      break;
    case 'rteSigning':
      // none : not signed
      draft.sign = !!v.signing;
      draft.sign_credential = v.signing || '';
      break;
  }
  return '';
}
