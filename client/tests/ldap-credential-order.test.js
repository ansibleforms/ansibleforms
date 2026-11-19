// A new ldap credential (Connections > Credentials, New, its Login step) : with Use TLS on, its
// TLS fields (Ignore certs, Certificate, CA bundle) right after the switch, before its bind user
// and its password ; the bind password says whose it is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings from '@/config/settings';

const multi = readFileSync(resolve(__dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
const all = getSettings((key) => key);
const field = (key) => all.credentials.fields.find((f) => f.key === key);

describe("an ldap credential's login step", () => {
  it('places its TLS fields before its bind user, for an ldap one only', () => {
    for (const key of ['ignore_certs', 'client_cert', 'ca_bundle']) {
      expect(field(key).placeBefore({ credential_type: 'ldap' }), key).toBe('user');
      expect(field(key).placeBefore({ credential_type: 'cyberark' }), key).toBeNull();
    }
    // the dialog moves them there, in their own order
    expect(multi).toMatch(/typeof f\.placeBefore === 'function' && f\.placeBefore\(item\.value \|\| \{\}\)/);
    expect(multi).toMatch(/rest\.splice\(last === -1 \? at : last \+ 1, 0, f\)/);
  });

  it("names its password the bind user's", () => {
    expect(field('password').dialogLabel({ credential_type: 'ldap' })).toBe('settings.ldap.bindPassword');
  });

  it('has the words in every language', async () => {
    for (const lang of ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl']) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      expect(m.settings.ldap.bindPassword, lang).toBeTruthy();
    }
  });
});
