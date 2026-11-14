// An SSH credential logs in with a private key too (issue #1345) : the New credential dialog asks
// for the key and its passphrase on an SSH credential's Login step, both left empty to keep the
// stored ones, and says its password is optional with a key. A CyberArk credential keeps its
// client key as before, without a passphrase.
import { describe, it, expect } from 'vitest';
import getSettings, { credentialLabels } from '@/config/settings';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);

describe("an SSH credential's private key in the New credential dialog", () => {
  it('asks for the key on the Login step of an SSH credential, as a private key', () => {
    const key = field('client_key');
    expect(key.step).toBe('login');
    // an SSH one's, a CyberArk one's, an Entra ID one's signing in with a certificate ; no other
    expect(key.showWhen({ credential_type: 'ssh' })).toBe(true);
    expect(key.showWhen({ credential_type: 'cyberark' })).toBe(true);
    expect(key.showWhen({ credential_type: 'entraid', entra_auth: 'certificate' })).toBe(true);
    expect(key.showWhen({ credential_type: 'entraid', entra_auth: 'secret' })).toBe(false);
    expect(key.showWhen({ credential_type: 'userpass' })).toBe(false);
    expect(key.dialogLabel({ credential_type: 'ssh' })).toBe('settings.credentials.privateKey');
    expect(key.help({ credential_type: 'ssh' })).toBe('settings.credentials.privateKeyHelp');
    expect(key.help({ credential_type: 'ssh', id: 3 })).toBe('settings.credentials.privateKeyKeep');
    expect(key.placeholder({ credential_type: 'ssh' })).toMatch(/OPENSSH PRIVATE KEY/);
    // never filled from the record : the stored key is not sent back
    expect(key.initial({ client_key: '**********' })).toBe('');
  });

  it('a CyberArk credential keeps its client key as it was', () => {
    const key = field('client_key');
    expect(key.dialogLabel({ credential_type: 'cyberark' })).toBeNull();
    expect(key.help({ credential_type: 'cyberark' })).toBe('settings.secretStores.clientKeyHelp');
    expect(key.help({ credential_type: 'cyberark', id: 3 })).toBe('settings.credentials.clientKeyKeep');
  });

  it('asks for the passphrase of an SSH credential only, masked and never filled', () => {
    const phrase = field('key_passphrase');
    expect(phrase.type).toBe('password');
    expect(phrase.dependencyValues).toEqual(['ssh']);
    expect(phrase.required).toBe(false);
    expect(phrase.initial({ key_passphrase: '**********' })).toBe('');
    expect(phrase.help({})).toBe('settings.credentials.keyPassphraseHelp');
    expect(phrase.help({ id: 3 })).toBe('settings.credentials.keyPassphraseKeep');
  });

  it("says an SSH credential's password is optional with a key", () => {
    expect(credentialLabels((k) => k, 'ssh').passwordHelp).toBe('settings.credentials.sshPasswordHelp');
    expect(field('password').required).toBe(false);
  });
});
