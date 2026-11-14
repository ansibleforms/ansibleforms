// A user and password or an api credential may carry an optional host and port (issue #1326) :
// the New credential dialog's Login step asks for them, never requires them, and says they are
// handed to the playbook and the expressions with the credential.
import { describe, it, expect } from 'vitest';
import getSettings, { HOST_CREDENTIAL_TYPES, OPTIONAL_HOST_CREDENTIAL_TYPES } from '@/config/settings';
import en from '@/locales/en';
import de from '@/locales/de';
import fr from '@/locales/fr';
import it_ from '@/locales/it';
import es from '@/locales/es';
import nl from '@/locales/nl';
import ca from '@/locales/ca';
import pt from '@/locales/pt';
import ja from '@/locales/ja';
import zh from '@/locales/zh';
import pl from '@/locales/pl';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);

describe("a credential's host and port", () => {
  it('are asked of a user and password and an api credential, as of the ones that connect', () => {
    for (const type of ['ssh', 'database', 'smtp', 'ldap', 'userpass', 'api']) {
      expect(field('host').dependencyValues).toContain(type);
      expect(field('port').dependencyValues).toContain(type);
    }
    expect(HOST_CREDENTIAL_TYPES).toEqual(expect.arrayContaining(OPTIONAL_HOST_CREDENTIAL_TYPES));
    // a git one, an SSO one or a runner's : none
    for (const type of ['git', 'entraid', 'oidc', 'vault', 'awx']) {
      expect(field('host').dependencyValues).not.toContain(type);
    }
  });

  it('stay optional for a user and password and an api credential', () => {
    for (const credential_type of OPTIONAL_HOST_CREDENTIAL_TYPES) {
      expect(field('host').requiredWhen({ credential_type })).toBe(false);
      expect(field('port').required).toBe(false);
    }
  });

  it('say where they go for those types, and keep the other types own help', () => {
    expect(field('host').help({ credential_type: 'userpass' })).toBe('settings.credentials.optionalHostHelp');
    expect(field('port').help({ credential_type: 'api' })).toBe('settings.credentials.optionalPortHelp');
    expect(field('host').help({ credential_type: 'smtp' })).toBe('settings.mail.mailServerHelp');
    expect(field('port').help({ credential_type: 'smtp' })).toBe('settings.mail.mailPortHelp');
    expect(field('host').help({ credential_type: 'ssh' })).toBeNull();
  });

  it('have their help in every language', () => {
    for (const locale of [en, de, fr, it_, es, nl, ca, pt, ja, zh, pl]) {
      expect(locale.settings.credentials.optionalHostHelp).toBeTruthy();
      expect(locale.settings.credentials.optionalPortHelp).toBeTruthy();
    }
  });
});
