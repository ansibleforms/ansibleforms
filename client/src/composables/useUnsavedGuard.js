import { onMounted, onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { askToLeave } from '@/lib/unsavedPrompt';

/**
 * Warn before unsaved changes are thrown away.
 *
 * The designer implements both halves of this itself (a beforeunload listener and an
 * onBeforeRouteLeave that reuses its dirty modal). The three visual config editors -
 * Categories, Roles and Constants - were built from the same buffers and got neither, so
 * expanding eight roles, flipping thirty switches and then clicking Users in the sidebar
 * discarded everything silently. That is the same amount of work as a designer session.
 *
 * Leaving for another page asks in the app's Unsaved changes dialog (AppUnsavedDialog, one
 * for the whole app) : Save and leave (when the page says how it saves), Leave without
 * saving, or Cancel to stay. Closing or reloading the tab
 * can only ask in the browser's own words. The router guard and the reload guard have to be
 * registered separately - neither covers the other.
 *
 * @param {import('vue').Ref<boolean>} isDirty
 * @param {() => Promise<boolean|void>} [save] The page's own save (its Save button) : offered
 *   as Save and leave. It returns false (or throws) when the save was refused.
 */
export function useUnsavedGuard(isDirty, save = null) {
  function onBeforeUnload(e) {
    if (!isDirty.value) return;
    // the browser shows its own wording ; assigning returnValue is what triggers it
    e.preventDefault();
    e.returnValue = '';
  }

  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

  onBeforeRouteLeave(() => {
    if (!isDirty.value) return true;
    return askToLeave(save, () => isDirty.value);
  });
}

export default useUnsavedGuard;
