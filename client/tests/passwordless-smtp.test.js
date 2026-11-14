// A mail server that takes mail without a login (issue #1325) : an smtp credential with only its
// server (its user and password said optional), or a mail channel with no credential at all, then
// sending through its own server, port and TLS.
import { describe, it, expect } from 'vitest';
import getSettings, { credentialLabels, mailWithoutCredential } from '@/config/settings';

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

  it('says so : optional labels and a note for a relay', () => {
    const labels = credentialLabels(t, 'smtp');
    expect(labels.user).toBe('settings.credentials.userOptional');
    expect(labels.password).toBe('settings.credentials.passwordOptional');
    expect(labels.passwordHelp).toBe('settings.credentials.smtpLoginHelp');
    // the other types keep theirs
    expect(credentialLabels(t, 'userpass')).toMatchObject({ user: null, password: null, passwordHelp: null });
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

  it('the credential is optional ; without one, its own server (needed), port and TLS are asked', () => {
    expect(channelField('credential').required).toBeFalsy();
    expect(channelField('credential').requiredWhen).toBeUndefined();
    const relay = { type: 'mail', credential: '' };
    const withLogin = { type: 'mail', credential: 'o365' };
    for (const key of ['server', 'port', 'secure']) {
      expect(channelField(key).step).toBe('credentials');
      expect(channelField(key).showWhen(relay)).toBe(true);
      expect(channelField(key).showWhen(withLogin)).toBe(false);
      expect(channelField(key).showWhen({ type: 'webhook' })).toBe(false);
    }
    expect(channelField('server').requiredWhen(relay)).toBe(true);
    expect(channelField('server').requiredWhen(withLogin)).toBe(false);
  });
});
