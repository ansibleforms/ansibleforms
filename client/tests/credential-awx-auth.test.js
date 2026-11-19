// An AWX, AAP or Ascender credential signs in with a token or with a user and its password : the
// New credential dialog's Login step asks which (Sign in with : Token or User and password, as an
// SSH one asks Password or Private key), then only that. A token one keeps no user.
import { describe, it, expect } from 'vitest';
import getSettings, { credentialLabels, awxUsesPassword, AWX_AUTH, AWX_CREDENTIAL_TYPES } from '@/config/settings';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);

describe('what an AWX, AAP or Ascender credential signs in with', () => {
  it('asks Token or User and password, a token by default, a user kept meaning password', () => {
    const choice = field('awx_auth');
    expect(choice.type).toBe('radio');
    expect(choice.titled).toBe(true);
    expect(choice.dependencyValues).toEqual(AWX_CREDENTIAL_TYPES);
    expect(choice.options.map((o) => o.value)).toEqual(AWX_AUTH);
    expect(choice.initial({})).toBe('token');
    expect(choice.initial({ user: 'admin' })).toBe('password');
  });

  it('asks the user only with a password, required then ; labels follow the choice', () => {
    const user = field('user');
    for (const type of AWX_CREDENTIAL_TYPES) {
      expect(user.showWhen({ credential_type: type, awx_auth: 'token' })).toBe(false);
      expect(user.showWhen({ credential_type: type, awx_auth: 'password' })).toBe(true);
      expect(user.requiredWhen({ credential_type: type, awx_auth: 'password' })).toBe(true);
    }
    const password = field('password');
    for (const awx_auth of AWX_AUTH) {
      expect(password.requiredWhen({ credential_type: 'aap', awx_auth })).toBe(true);
      // an existing one keeps its stored one when left empty
      expect(password.requiredWhen({ credential_type: 'aap', awx_auth, id: 3 })).toBe(false);
    }
    expect(password.requiredWhen({ credential_type: 'smtp', smtp_auth: 'password' })).toBe(true);
    expect(password.requiredWhen({ credential_type: 'userpass' })).toBe(false);
    expect(credentialLabels((k) => k, 'awx', 'token').password).toBe('settings.fields.token');
    expect(credentialLabels((k) => k, 'aap', 'password').password).toBe('settings.fields.password');
    expect(credentialLabels((k) => k, 'ascender', 'password').user).toBeNull();
    expect(awxUsesPassword({ credential_type: 'ssh', awx_auth: 'password' })).toBe(false);
  });

  it('saves no user for a token one', () => {
    const saved = credentials.beforeSave({ name: 'tower', credential_type: 'awx', awx_auth: 'token', user: 'x' });
    expect(saved.user).toBe('');
    expect(saved).not.toHaveProperty('awx_auth');
    const withUser = credentials.beforeSave({ name: 'tower', credential_type: 'awx', awx_auth: 'password', user: 'x' });
    expect(withUser.user).toBe('x');
  });
});

describe('what a git credential signs in with', () => {
  it('asks Token or Password : a token without a user, a user kept meaning password', () => {
    const choice = credentials.fields.find((f) => f.key === 'git_auth');
    expect(choice.type).toBe('radio');
    expect(choice.titled).toBe(true);
    expect(choice.options.map((o) => o.value)).toEqual(['token', 'password']);
    expect(choice.initial({})).toBe('token');
    expect(choice.initial({ user: 'me' })).toBe('password');
    const user = credentials.fields.find((f) => f.key === 'user');
    expect(user.showWhen({ credential_type: 'git', git_auth: 'token' })).toBe(false);
    expect(user.showWhen({ credential_type: 'git', git_auth: 'password' })).toBe(true);
    expect(user.requiredWhen({ credential_type: 'git', git_auth: 'password' })).toBe(true);
    expect(credentialLabels((k) => k, 'git', undefined, 'token').password).toBe('settings.fields.token');
    expect(credentialLabels((k) => k, 'git', undefined, 'password').password).toBeNull();
  });

  it('saves no user with a token, keeps it with a password', () => {
    const token = credentials.beforeSave({ name: 'g', credential_type: 'git', git_auth: 'token', user: 'me' });
    expect(token.user).toBe('');
    expect(token).not.toHaveProperty('git_auth');
    const password = credentials.beforeSave({ name: 'g', credential_type: 'git', git_auth: 'password', user: 'me' });
    expect(password.user).toBe('me');
  });
});
