// lib/popoverDispose.js : a popover on screen is disposed only once Bootstrap says it is hidden,
// never in the middle of its fade, where Bootstrap's own end-of-fade callback throws.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { disposeWhenHidden } from '../src/lib/popoverDispose.js';

// a stand-in for Bootstrap's Popover : its tip in the page or not, hide() and dispose() counted
function fakePopover({ shown }) {
  const tip = document.createElement('div');
  if (shown) document.body.appendChild(tip);
  return { tip, hide: vi.fn(), dispose: vi.fn() };
}

describe('disposeWhenHidden', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('disposes a popover that is not on screen at once', () => {
    const popover = fakePopover({ shown: false });
    disposeWhenHidden(popover, document.createElement('span'));
    expect(popover.hide).not.toHaveBeenCalled();
    expect(popover.dispose).toHaveBeenCalledTimes(1);
  });

  it('hides a popover on screen, and disposes it only when it is hidden', () => {
    const popover = fakePopover({ shown: true });
    const el = document.createElement('span');
    disposeWhenHidden(popover, el);
    expect(popover.hide).toHaveBeenCalledTimes(1);
    expect(popover.dispose).not.toHaveBeenCalled();
    el.dispatchEvent(new Event('hidden.bs.popover'));
    expect(popover.dispose).toHaveBeenCalledTimes(1);
    // the fallback after it does not dispose it a second time
    vi.advanceTimersByTime(1000);
    expect(popover.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes it after a while when the hidden event never comes', () => {
    const popover = fakePopover({ shown: true });
    disposeWhenHidden(popover, document.createElement('span'));
    vi.advanceTimersByTime(1000);
    expect(popover.dispose).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a popover', () => {
    expect(() => disposeWhenHidden(null, null)).not.toThrow();
  });
});
