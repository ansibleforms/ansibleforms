/******************************************************************/
/*                                                                */
/*  keepEdits : a record read again after something saved at     */
/*  once (Approve, Ask again), without throwing away what is      */
/*  being edited on its page. The page's form holds its own copy  */
/*  (edit) : read again, the record is the saved one and the form */
/*  keeps the words typed and not saved yet.                      */
/*                                                                */
/******************************************************************/

/**
 * Reads a record again, the form's unsaved edits kept as they are.
 *
 * Args:
 *   edit (Ref<object|null>): the form's copy of the record (as edited).
 *   reload (Function): the page's read of the record ; it sets edit from the saved record.
 *   saved (string[], optional): the fields that were just saved (the switch's) : taken from the
 *     record read again, so the form shows them as saved and they never count as an edit.
 *
 * Returns:
 *   Promise<void>: once read.
 */
export async function reloadKeepingEdits(edit, reload, saved = []) {
  const kept = edit.value ? { ...edit.value } : null;
  await reload();
  // the record is gone (or could not be read) : nothing to keep it on
  if (!kept || !edit.value) return;
  const fresh = edit.value;
  edit.value = { ...kept, ...Object.fromEntries(saved.filter((k) => k in fresh).map((k) => [k, fresh[k]])) };
}

export default { reloadKeepingEdits };
