// Disposing a Bootstrap popover while it fades out throws : the fade's end runs Bootstrap's own
// callback, which reads the state dispose() has already cleared ("Cannot convert undefined or
// null to object", Popover._isWithActiveTrigger). It happens when a page goes while one is on
// screen : a table cell's hover popover as its row is clicked to open another page (the mouse
// leaves it), an info popover open as a link is followed. So a popover on screen is hidden
// first and disposed once Bootstrap says it is hidden ; one that is not, at once.

// longer than any fade (Bootstrap's is 150ms) : disposed then, if the hidden event never comes
const FALLBACK_MS = 600;

/**
 * Disposes a popover, after it has finished hiding when it is on screen.
 *
 * Args:
 *   popover (Popover): the Bootstrap popover, or null.
 *   element (HTMLElement): the element it is attached to, where Bootstrap fires its events.
 *
 * Returns:
 *   undefined
 */
export function disposeWhenHidden(popover, element) {
  if (!popover) return;
  // never shown, or already gone : nothing is fading
  if (!popover.tip?.isConnected || !element) {
    popover.dispose();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    element.removeEventListener('hidden.bs.popover', finish);
    popover.dispose();
  };
  element.addEventListener('hidden.bs.popover', finish);
  // shown : starts the fade ; already fading out : does nothing, the fade under way ends it
  popover.hide();
  setTimeout(finish, FALLBACK_MS);
}
