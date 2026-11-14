// Mail through Microsoft 365 (issue #1207) : a Microsoft Entra ID credential signs in with its client
// secret or a certificate (its certificate and key asked instead of the secret), and a mail channel
// naming one asks how it sends, Microsoft Graph by default or SMTP with OAuth2.
import { describe, it, expect } from 'vitest';
import getSettings, { entraCertificate, credentialTypeOf, SEND_THROUGH } from '@/config/settings';

const settings = getSettings((key) => key);
const credentialField = (key) => settings.credentials.fields.find((f) => f.key === key);
const channelField = (key) => settings.notificationChannels.fields.find((f) => f.key === key);

describe('an Entra ID credential : a secret or a certificate', () => {
  it('Secret by default, Certificate for one that keeps a certificate', () => {
    const auth = credentialField('entra_auth');
    expect(auth.options.map((o) => o.value)).toEqual(['secret', 'certificate']);
    expect(auth.initial({})).toBe('secret');
    expect(auth.initial({ client_cert: '-----BEGIN CERTIFICATE-----' })).toBe('certificate');
  });

  it('a certificate : its certificate and key asked, not its secret', () => {
    const item = { credential_type: 'entraid', entra_auth: 'certificate' };
    expect(entraCertificate(item)).toBe(true);
    expect(credentialField('client_cert').showWhen(item)).toBe(true);
    expect(credentialField('client_key').showWhen(item)).toBe(true);
    expect(credentialField('password').showWhen(item)).toBe(false);
    const secret = { credential_type: 'entraid', entra_auth: 'secret' };
    expect(credentialField('client_cert').showWhen(secret)).toBe(false);
    expect(credentialField('password').showWhen(secret)).toBe(true);
  });

  it('saved : the choice never sent ; with the secret, no certificate kept', () => {
    const cert = settings.credentials.beforeSave({
      credential_type: 'entraid',
      entra_auth: 'certificate',
      client_cert: 'C',
      client_key: 'K',
      secret_source: 'local',
    });
    expect(cert).toMatchObject({ client_cert: 'C', client_key: 'K' });
    expect(cert.entra_auth).toBeUndefined();
    const secret = settings.credentials.beforeSave({
      credential_type: 'entraid',
      entra_auth: 'secret',
      client_cert: 'C',
      password: 'p',
      secret_source: 'local',
    });
    expect(secret).toMatchObject({ client_cert: '', client_key: null, password: 'p' });
    // a CyberArk one keeps its certificate
    expect(settings.credentials.beforeSave({ credential_type: 'cyberark', client_cert: 'C' }).client_cert).toBe('C');
  });
});

describe('a mail channel with an Entra ID credential', () => {
  const lists = {
    credentials: [
      { name: 'm365', credential_type: 'entraid' },
      { name: 'smtp-login', credential_type: 'smtp' },
    ],
  };

  it('offers the smtp and the entraid credentials', () => {
    const choose = channelField('credential').choicesWhen;
    expect(choose({ name: 'm365', credential_type: 'entraid' })).toBe(true);
    expect(choose({ name: 'smtp-login', credential_type: 'smtp' })).toBe(true);
    expect(choose({ name: 'api', credential_type: 'api' })).toBe(false);
  });

  it('Send through : shown for an entraid credential only, Microsoft Graph by default', () => {
    const through = channelField('send_through');
    expect(through.options.map((o) => o.value)).toEqual(SEND_THROUGH);
    expect(through.initial({})).toBe('graph');
    expect(through.initial({ send_through: 'smtp' })).toBe('smtp');
    expect(through.showWhen({ type: 'mail', credential: 'm365' }, lists)).toBe(true);
    expect(through.showWhen({ type: 'mail', credential: 'smtp-login' }, lists)).toBe(false);
    expect(through.showWhen({ type: 'mail', credential: '' }, lists)).toBe(false);
    expect(credentialTypeOf(lists.credentials, 'm365')).toBe('entraid');
    expect(credentialTypeOf(lists.credentials, 'nope')).toBe('');
  });
});
