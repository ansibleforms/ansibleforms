// A Refresh button says Refreshing… while it reads again (composables/useRefreshing.js).
//
// A refresh that comes back in 50 ms changed nothing the eye could see, so a click looked
// lost. The words stay at least a second, its two arrows turn meanwhile, and every page's
// Refresh goes through the same helper (AppRefreshButton, or useRefreshing directly).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useRefreshing, REFRESHING_MIN_MS } from '../src/composables/useRefreshing.js';

afterEach(() => vi.useRealTimers());

describe('useRefreshing', () => {
  it('says refreshing for at least a second when the reload is fast', async () => {
    vi.useFakeTimers();
    const { refreshing, refresh } = useRefreshing();
    const done = refresh(() => 'rows');
    expect(refreshing.value).toBe(true);
    await vi.advanceTimersByTimeAsync(REFRESHING_MIN_MS - 1);
    expect(refreshing.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toBe('rows');
    expect(refreshing.value).toBe(false);
  });

  it('stays while a slow reload runs, and no longer than it', async () => {
    vi.useFakeTimers();
    const { refreshing, refresh } = useRefreshing();
    const done = refresh(() => new Promise((resolve) => setTimeout(resolve, 3000)));
    await vi.advanceTimersByTimeAsync(2999);
    expect(refreshing.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(refreshing.value).toBe(false);
  });

  it('runs one reload at a time : a second click meanwhile does nothing', async () => {
    vi.useFakeTimers();
    const { refresh } = useRefreshing();
    const fn = vi.fn();
    const first = refresh(fn);
    expect(await refresh(fn)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(REFRESHING_MIN_MS);
    await first;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ends refreshing when the reload fails', async () => {
    vi.useFakeTimers();
    const { refreshing, refresh } = useRefreshing();
    const done = refresh(() => Promise.reject(new Error('down')));
    const failed = expect(done).rejects.toThrow('down');
    await vi.advanceTimersByTimeAsync(REFRESHING_MIN_MS);
    await failed;
    expect(refreshing.value).toBe(false);
  });
});

describe('the pages', () => {
  const files = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : f.endsWith('.vue') ? [p] : [];
    });

  it('draw no Refresh button of their own, all of them go through the helper', () => {
    const src = join(import.meta.dirname, '../src');
    const offenders = files(src).filter((p) => /<BsButton[^>]*icon="refresh"/.test(readFileSync(p, 'utf8')));
    expect(offenders.map((p) => p.slice(src.length + 1))).toEqual(['components/AppRefreshButton.vue']);
  });

  it('say Refreshing… in every language', async () => {
    for (const lang of ['en', 'es', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ja', 'zh']) {
      const text = (await import(`../src/locales/${lang}.js`)).default.common.refreshing;
      expect(text, lang).toMatch(/…$/);
    }
  });
});
