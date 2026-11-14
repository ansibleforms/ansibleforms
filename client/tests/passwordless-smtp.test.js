// A mail server that takes mail without a login (issue #1325) : an smtp credential with only its
// server (its user and password said optional), or a mail channel with no credential at all, then
// sending through its own server, port and TLS.
import { describe, it, expect } from 'vitest';
import getSettings, { credentialLabels, mailWithoutCredential, mailOwnServer, SMTP_AUTH } from '@/config/settings';

const t = (key) => key;
const settings = getSettings(t);
const credentialField = (key) => settings.credentials.fields.find((f) => f.key === key);
const channelField = (key) => settings.notificationChannels.fields.find((f) => f.key === key);

describe('an smtp credential without a login', () => {
  it('needs only its mail server : the user and password are optional', () => {
    const smtp = { credential_type: 'smtp', secret_source: 'local' };
    expect(credentialField('host').requiredWhen(smtp)).toBe(true);
    expect(credentialField('user').required).toBe(false);
    expect(credentialField('password').required).toBe(false);
  });

  it('asks No login or Password : a relay by default, a user kept meaning password', () => {
    const choice = credentialField('smtp_auth');
    expect(choice.type).toBe('radio');
    expect(choice.alignHints).toBe(true);
    expect(choice.options.map((o) => o.value)).toEqual(SMTP_AUTH);
    expect(choice.initial({})).toBe('none');
    expect(choice.initial({ user: 'mailer' })).toBe('password');
  });

  it('a relay : no user nor password asked or kept ; with a password, the user needed', () => {
    const relay = { credential_type: 'smtp', smtp_auth: 'none', secret_source: 'local' };
    const login = { credential_type: 'smtp', smtp_auth: 'password', secret_source: 'local' };
    expect(credentialField('user').showWhen(relay)).toBe(false);
    expect(credentialField('password').showWhen(relay)).toBe(false);
    expect(credentialField('user').showWhen(login)).toBe(true);
    expect(credentialField('user').requiredWhen(login)).toBe(true);
    const saved = settings.credentials.beforeSave({ name: 'relay', host: 'mx', ...relay, user: 'x', password: 'y' });
    expect(saved).toMatchObject({ user: '', password: '' });
    // plain labels now : the choice says it
    expect(credentialLabels(t, 'smtp')).toMatchObject({ user: null, password: null, passwordHelp: null });
    expect(credentialLabels(t, 'rte').passwordHelp).toBe('settings.credentials.rteTokenHelp');
  });
});

describe('a mail channel without a credential', () => {
  it('is one : mail, and no credential named', () => {
    expect(mailWithoutCredential({ type: 'mail' })).toBe(true);
    expect(mailWithoutCredential({ type: 'mail', credential: ' ' })).toBe(true);
    expect(mailWithoutCredential({ type: 'mail', credential: 'o365' })).toBe(false);
    expect(mailWithoutCredential({ type: 'slack' })).toBe(false);
  });

  it('its page shows and saves its own server without a credential, or with an smtp one without a server', () => {
    const credentials = [
      { name: 'smtp-login', credential_type: 'smtp', host: 'smtp.example.com' },
      { name: 'old-login', credential_type: 'smtp', host: '' },
      { name: 'o365', credential_type: 'entraid' },
    ];
    expect(mailOwnServer({ type: 'mail' }, credentials)).toBe(true);
    expect(mailOwnServer({ type: 'mail', credential: 'old-login' }, credentials)).toBe(true);
    // the credential's server is where it sends ; Microsoft 365 has none of its own
    expect(mailOwnServer({ type: 'mail', credential: 'smtp-login' }, credentials)).toBe(false);
    expect(mailOwnServer({ type: 'mail', credential: 'o365' }, credentials)).toBe(false);
    // a credential not in the list (not loaded) : left as stored, never sent
    expect(mailOwnServer({ type: 'mail', credential: 'unknown' }, credentials)).toBe(false);
    expect(mailOwnServer({ type: 'webhook' }, credentials)).toBe(false);
  });

  it('the wizard asks a mail channel only its credential, needed ; no server, port or TLS', () => {
    const credential = channelField('credential');
    expect(credential.step).toBe('credentials');
    expect(credential.requiredWhen({ type: 'mail' })).toBe(true);
    expect(credential.requiredWhen({ type: 'webhook' })).toBe(false);
    for (const key of ['server', 'port', 'secure']) expect(channelField(key)).toBeUndefined();
  });
});
