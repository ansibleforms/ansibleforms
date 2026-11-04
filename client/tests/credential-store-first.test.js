// The New credential dialog asks where the user and password are kept before asking for them
// (issue #1314) : read from a secret store, none is typed - the Login step says where they come
// from instead - and none is sent.
import { describe, it, expect } from 'vitest';
import getSettings, { secretRefText } from '@/config/settings';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);
const steps = (item) => credentials.steps.filter((s) => typeof s.when !== 'function' || s.when(item)).map((s) => s.key);

describe('the New credential dialog', () => {
  it('asks where the secret is kept before the login', () => {
    expect(steps({ credential_type: 'userpass' })).toEqual(['credential', 'type', 'store', 'login']);
    // a secret store's own login, a CyberArk one : never read from a store, no Store step
    expect(steps({ credential_type: 'vault' })).toEqual(['credential', 'type', 'login']);
  });

  it('read from a secret store : no Login step for a plain login, kept for one with an address', () => {
    expect(steps({ credential_type: 'userpass', secret_source: 'store' })).toEqual(['credential', 'type', 'store']);
    expect(steps({ credential_type: 'git', secret_source: 'store' })).toEqual(['credential', 'type', 'store']);
    // an SSH or a database login still asks where it connects
    expect(steps({ credential_type: 'ssh', secret_source: 'store' })).toEqual(['credential', 'type', 'store', 'login']);
    expect(steps({ credential_type: 'database', secret_source: 'store' })).toEqual([
      'credential',
      'type',
      'store',
      'login',
    ]);
  });

  it('read from a secret store : no user nor password to type, a note in their place', () => {
    const fromStore = { credential_type: 'userpass', secret_source: 'store' };
    const local = { credential_type: 'userpass', secret_source: 'local' };
    expect(field('user').showWhen(fromStore)).toBe(false);
    expect(field('password').showWhen(fromStore)).toBe(false);
    expect(field('login_from_store').showWhen(fromStore)).toBe(true);
    expect(field('user').showWhen(local)).toBe(true);
    expect(field('password').showWhen(local)).toBe(true);
    expect(field('login_from_store').showWhen(local)).toBe(false);
    // a CyberArk credential has a client key, never a password
    expect(field('password').showWhen({ credential_type: 'cyberark', secret_source: 'local' })).toBe(false);
  });

  it('saved : the place in the store, no user, password nor note', () => {
    const saved = credentials.beforeSave({
      name: 'db',
      credential_type: 'userpass',
      secret_source: 'store',
      secret_store: 'vault',
      secret_ref: 'kv/db',
      user: 'typed',
      password: 'typed',
      login_from_store: undefined,
    });
    expect(saved).toEqual({ name: 'db', credential_type: 'userpass', secret_store: 'vault', secret_ref: 'kv/db' });
  });
});

describe('the reference of a secret, as the store chosen names it', () => {
  const ref = field('secret_ref');
  const lists = {
    secretstores: [
      { name: 'vault', type: 'vault' },
      { name: 'cyberark', type: 'cyberark_ccp' },
    ],
  };
  it('a CyberArk account for a CyberArk store, a path for a Vault, either before one is chosen', () => {
    expect(ref.placeholder({ secret_store: 'cyberark' }, {}, lists)).toBe(
      'settings.credentials.secretRefPlaceholderCyberArk',
    );
    expect(ref.help({ secret_store: 'cyberark' }, {}, lists)).toBe('settings.credentials.secretRefHelpCyberArk');
    expect(ref.placeholder({ secret_store: 'vault' }, {}, lists)).toBe(
      'settings.credentials.secretRefPlaceholderVault',
    );
    expect(ref.help({ secret_store: '' }, {}, lists)).toBe('settings.credentials.secretRefHelp');
    expect(secretRefText((k) => k, '', 'placeholder')).toBe('settings.credentials.secretRefPlaceholder');
  });

  it('a CyberArk or Vault login never reads from a store, a choice left from another type aside', () => {
    const left = { credential_type: 'cyberark', secret_source: 'store' };
    expect(field('user').showWhen(left)).toBe(true);
    expect(field('login_from_store').showWhen(left)).toBe(false);
    expect(steps(left)).toEqual(['credential', 'type', 'login']);
  });
});

describe('the reference field', () => {
  it('shows once a store is chosen, never before', () => {
    const ref = field('secret_ref');
    expect(ref.showWhen({ credential_type: 'userpass', secret_source: 'store', secret_store: '' })).toBe(false);
    expect(ref.showWhen({ credential_type: 'userpass', secret_source: 'store', secret_store: 'vault' })).toBe(true);
    expect(ref.showWhen({ credential_type: 'userpass', secret_source: 'local', secret_store: 'vault' })).toBe(false);
  });
});

describe('writing a credential to a secret store', () => {
  const item = {
    credential_type: 'userpass',
    secret_source: 'store',
    secret_action: 'write',
    secret_store: 'vault',
    secret_ref: 'secret/ansibleforms/db',
  };

  it('asks the user and password in the Login step, says where they are written', () => {
    expect(steps(item)).toEqual(['credential', 'type', 'store', 'login']);
    expect(field('user').showWhen(item)).toBe(true);
    expect(field('password').showWhen(item)).toBe(true);
    expect(field('login_written_note').showWhen(item)).toBe(true);
    expect(field('login_from_store').showWhen(item)).toBe(false);
    expect(field('secret_overwrite').showWhen(item)).toBe(true);
    expect(field('secret_overwrite').showWhen({ ...item, secret_action: 'point' })).toBe(false);
  });

  it('offers only the stores that allow writing', () => {
    const choices = (r) =>
      [{ name: '' }, { name: 'vault', write_enabled: 1 }, { name: 'ro', write_enabled: 0 }]
        .filter((s) => field('secret_store').choicesWhen(s, r))
        .map((s) => s.name);
    expect(choices(item)).toEqual(['', 'vault']);
    expect(choices({ ...item, secret_action: 'point' })).toEqual(['', 'vault', 'ro']);
  });

  it('none allows writing : the dropdown still shown, saying so ; pointed to, its button only', () => {
    expect(field('secret_store').emptyText(item)).toBe('settings.credentials.noWritableStore');
    expect(field('secret_store').emptyText({ ...item, secret_action: 'point' })).toBe('');
  });

  it('the reference shown before a store is chosen when writing, as when pointing once one is', () => {
    expect(field('secret_ref').showWhen({ ...item, secret_store: '' })).toBe(true);
    expect(field('secret_ref').showWhen({ ...item, secret_action: 'point', secret_store: '' })).toBe(false);
  });

  it('saved : asks the server to write them, overwrite as ticked, no note sent', () => {
    const saved = credentials.beforeSave({
      name: 'db',
      ...item,
      user: 'svc',
      password: 'p',
      secret_overwrite: true,
      login_written_note: undefined,
    });
    expect(saved).toEqual({
      name: 'db',
      credential_type: 'userpass',
      secret_store: 'vault',
      secret_ref: 'secret/ansibleforms/db',
      user: 'svc',
      password: 'p',
      secret_write: true,
      secret_overwrite: true,
    });
  });
});

describe('the Store step : Database or Secret store, then point or write', () => {
  it('the sub-choice shows under Secret store only, pointing when none is chosen', () => {
    expect(field('secret_source').options.map((o) => o.value)).toEqual(['local', 'store']);
    expect(field('secret_action').options.map((o) => o.value)).toEqual(['point', 'write']);
    expect(field('secret_action').showWhen({ secret_source: 'store' })).toBe(true);
    expect(field('secret_action').showWhen({ secret_source: 'local' })).toBe(false);
    // no action chosen yet : read from the store, nothing typed
    expect(field('user').showWhen({ credential_type: 'userpass', secret_source: 'store' })).toBe(false);
  });
});
