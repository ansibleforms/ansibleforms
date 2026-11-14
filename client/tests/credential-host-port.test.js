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
  it('the shared host and port : for the ones that connect, not behind a switch', () => {
    for (const credential_type of ['ssh', 'database', 'smtp', 'ldap']) {
      expect(field('host').showWhen({ credential_type })).toBe(true);
      expect(field('port').showWhen({ credential_type })).toBe(true);
    }
    expect(HOST_CREDENTIAL_TYPES).toEqual(expect.arrayContaining(OPTIONAL_HOST_CREDENTIAL_TYPES));
    // a git one, an SSO one or a runner's : none ; a user and password or an api one : its own
    for (const credential_type of ['git', 'entraid', 'oidc', 'vault', 'awx', 'userpass', 'api']) {
      expect(field('host').showWhen({ credential_type })).toBe(false);
    }
  });

  it('a user and password or an api one : a switch after the password, then its host and port', () => {
    const fields = credentials.fields.map((f) => f.key);
    expect(fields.indexOf('with_host')).toBeGreaterThan(fields.indexOf('password'));
    expect(fields.indexOf('optional_host')).toBe(fields.indexOf('with_host') + 1);
    expect(fields.indexOf('optional_port')).toBe(fields.indexOf('with_host') + 2);
    for (const credential_type of OPTIONAL_HOST_CREDENTIAL_TYPES) {
      expect(field('with_host').showWhen({ credential_type })).toBe(true);
      expect(field('optional_host').showWhen({ credential_type, with_host: false })).toBe(false);
      expect(field('optional_host').showWhen({ credential_type, with_host: true })).toBe(true);
      expect(field('optional_port').showWhen({ credential_type, with_host: true })).toBe(true);
    }
    expect(field('with_host').showWhen({ credential_type: 'ssh' })).toBe(false);
    // on when a host is kept
    expect(field('with_host').initial({ host: 'api.example.com' })).toBe(true);
    expect(field('with_host').initial({})).toBe(false);
  });

  it('saved as host and port when on, none when off', () => {
    const base = { name: 'api', credential_type: 'api', password: 'tok' };
    const on = credentials.beforeSave({
      ...base,
      with_host: true,
      optional_host: ' api.example.com ',
      optional_port: 8443,
    });
    expect(on).toMatchObject({ host: 'api.example.com', port: 8443 });
    expect(on).not.toHaveProperty('optional_host');
    const off = credentials.beforeSave({
      ...base,
      with_host: false,
      optional_host: 'api.example.com',
      optional_port: 8443,
    });
    expect(off).toMatchObject({ host: '', port: null });
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
