// A new LDAP directory (Settings > Access > LDAP, New) : on from the start, so its dialog asks no
// Enabled switch ; it is turned off on the directory's own page (ldap-directory.vue).
import { describe, it, expect } from 'vitest';
import getSettings from '@/config/settings';

const all = getSettings((key) => key);
const field = (key) => all.ldapDirectories.fields.find((f) => f.key === key);

describe('a new LDAP directory', () => {
  it('asks no Enabled switch in its New dialog', () => {
    expect(field('enable').noInput).toBe(true);
  });

  it('is on from the start, and the list still shows the column', () => {
    expect(field('enable').initial()).toBe(true);
    expect(field('enable').noTable).toBeFalsy();
  });
});
