// An SSH credential logs in with its password or with a private key (issue #1345) : the New
// credential dialog's Login step asks which (Log in with : Password or Private key, as an Entra ID
// one asks Secret or Certificate), then only that : the password, or the key and its passphrase,
// both left empty on an existing one to keep the stored ones. Never both : the other is dropped on
// save. A CyberArk credential keeps its client key as before, without a passphrase.
import { describe, it, expect } from 'vitest';
import getSettings, { credentialLabels, sshUsesKey, SSH_AUTH } from '@/config/settings';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);

describe("an SSH credential's private key in the New credential dialog", () => {
  it('asks for the key on the Login step of an SSH credential, as a private key', () => {
    const key = field('client_key');
    expect(key.step).toBe('login');
    // an SSH one's logging in with a key, a CyberArk one's, an Entra ID one's signing in with a
    // certificate ; no other
    expect(key.showWhen({ credential_type: 'ssh', ssh_auth: 'key' })).toBe(true);
    expect(key.showWhen({ credential_type: 'ssh', ssh_auth: 'password' })).toBe(false);
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
    expect(phrase.showWhen({ credential_type: 'ssh', ssh_auth: 'key' })).toBe(true);
    expect(phrase.showWhen({ credential_type: 'ssh', ssh_auth: 'password' })).toBe(false);
    expect(phrase.showWhen({ credential_type: 'cyberark', ssh_auth: 'key' })).toBe(false);
    expect(phrase.required).toBe(false);
    expect(phrase.initial({ key_passphrase: '**********' })).toBe('');
    expect(phrase.help({})).toBe('settings.credentials.keyPassphraseHelp');
    expect(phrase.help({ id: 3 })).toBe('settings.credentials.keyPassphraseKeep');
  });

  it('asks what an SSH credential logs in with : its password by default, a key it keeps', () => {
    const choice = field('ssh_auth');
    expect(choice.type).toBe('radio');
    expect(choice.step).toBe('login');
    expect(choice.dependencyValues).toEqual(['ssh']);
    expect(choice.options.map((o) => o.value)).toEqual(SSH_AUTH);
    expect(choice.initial({})).toBe('password');
    expect(choice.initial({ client_key: '**********' })).toBe('key');
  });

  it('asks the password or the key, never both ; a new key credential needs its key', () => {
    const password = field('password');
    expect(password.showWhen({ credential_type: 'ssh', ssh_auth: 'password' })).toBe(true);
    expect(password.showWhen({ credential_type: 'ssh', ssh_auth: 'key' })).toBe(false);
    expect(credentialLabels((k) => k, 'ssh').passwordHelp).toBeNull();
    // a new one with its password : the password needed ; with a key, or an existing one, not
    expect(password.requiredWhen({ credential_type: 'ssh', ssh_auth: 'password' })).toBe(true);
    expect(password.requiredWhen({ credential_type: 'ssh', ssh_auth: 'key' })).toBe(false);
    expect(password.requiredWhen({ credential_type: 'ssh', ssh_auth: 'password', id: 3 })).toBe(false);
    const key = field('client_key');
    expect(key.requiredWhen({ credential_type: 'ssh', ssh_auth: 'key' })).toBe(true);
    expect(key.requiredWhen({ credential_type: 'ssh', ssh_auth: 'key', id: 3 })).toBe(false);
    expect(sshUsesKey({ credential_type: 'userpass', ssh_auth: 'key' })).toBe(false);
  });

  it('saves only what it logs in with : the key drops the password, the password drops the key', () => {
    const base = { name: 'srv', credential_type: 'ssh', user: 'root', host: 'h' };
    const withKey = credentials.beforeSave({
      ...base,
      ssh_auth: 'key',
      password: 'typed',
      client_key: 'KEY',
      key_passphrase: 'pp',
    });
    expect(withKey).toMatchObject({ client_key: 'KEY', key_passphrase: 'pp' });
    expect(withKey).not.toHaveProperty('password');
    expect(withKey).not.toHaveProperty('ssh_auth');
    const withPassword = credentials.beforeSave({
      ...base,
      ssh_auth: 'password',
      password: 'pw',
      client_key: 'KEY',
      key_passphrase: 'pp',
    });
    expect(withPassword).toMatchObject({ password: 'pw' });
    expect(withPassword).not.toHaveProperty('client_key');
    expect(withPassword).not.toHaveProperty('key_passphrase');
  });
});
