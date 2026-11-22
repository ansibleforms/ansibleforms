// A new secret store (Connections > Secret stores, New, its Options) : Allow writing on from the
// start, its write prefix then asked ; an existing one keeps what it has.
import { describe, it, expect } from 'vitest';
import getSettings from '@/config/settings';

const all = getSettings((key) => key);
const field = (key) => all.secretStores.fields.find((f) => f.key === key);

describe("a secret store's Allow writing", () => {
  it('is on for a new store', () => {
    expect(field('write_enabled').initial({})).toBe(true);
    expect(field('write_enabled').initial(undefined)).toBe(true);
  });

  it('keeps what an existing store has', () => {
    expect(field('write_enabled').initial({ write_enabled: 0 })).toBe(false);
    expect(field('write_enabled').initial({ write_enabled: 1 })).toBe(true);
  });

  it('asks the write prefix while it is on', () => {
    expect(field('write_prefix').requiredWhen({ write_enabled: true })).toBe(true);
    expect(field('write_prefix').showWhen({ write_enabled: false })).toBe(false);
  });
});
