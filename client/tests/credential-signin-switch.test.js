// A credential's sign-in changed (Private key to Password, No login to Login, Certificate to
// Secret, a token to a password) needs its new secret : nothing stored is it. Written to a secret
// store, a credential writes its password : a sign-in with none is never offered then, and a store
// that does not allow writing is not kept. The New credential dialog saves only the fields its
// final type shows, and the credential page shows and saves an SSO one's provider settings even
// when its client id and secret are read from a store.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings, {
  signInOffered,
  keepSignInWritable,
  keepWritableStore,
  credentialFieldShown,
} from '@/config/settings';

const credentials = getSettings((key) => key).credentials;
const field = (key) => credentials.fields.find((f) => f.key === key);
const read = (path) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const page = read('src/pages/admin/credential.vue');
const LOCALES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

// ------------------------------------------------------------------
// written to a secret store : only a sign-in with a password
// ------------------------------------------------------------------
describe('a credential written to a secret store', () => {
  it('is never offered a sign-in without a password', () => {
    expect(signInOffered('ssh_auth', 'key', true)).toBe(false);
    expect(signInOffered('smtp_auth', 'none', true)).toBe(false);
    expect(signInOffered('entra_auth', 'certificate', true)).toBe(false);
    expect(signInOffered('ssh_auth', 'password', true)).toBe(true);
    expect(signInOffered('smtp_auth', 'password', true)).toBe(true);
    expect(signInOffered('entra_auth', 'secret', true)).toBe(true);
    // pointing to a secret, or kept in the app : every choice
    expect(signInOffered('ssh_auth', 'key', false)).toBe(true);
    expect(signInOffered('smtp_auth', 'none', false)).toBe(true);
  });

  it('has its sign-in without a password set back to its password, of its own type only', () => {
    const ssh = { credential_type: 'ssh', ssh_auth: 'key' };
    expect(keepSignInWritable(ssh, true)).toBe(true);
    expect(ssh.ssh_auth).toBe('password');
    const smtp = { credential_type: 'smtp', smtp_auth: 'none' };
    keepSignInWritable(smtp, true);
    expect(smtp.smtp_auth).toBe('password');
    const entra = { credential_type: 'entraid', entra_auth: 'certificate' };
    keepSignInWritable(entra, true);
    expect(entra.entra_auth).toBe('secret');
    // not written : as chosen ; another type's choice is not its own
    const kept = { credential_type: 'ssh', ssh_auth: 'key' };
    expect(keepSignInWritable(kept, false)).toBe(false);
    expect(kept.ssh_auth).toBe('key');
    const other = { credential_type: 'userpass', ssh_auth: 'key', smtp_auth: 'none' };
    expect(keepSignInWritable(other, true)).toBe(false);
    expect(other).toMatchObject({ ssh_auth: 'key', smtp_auth: 'none' });
  });

  it('keeps a store that allows writing, or the only one that does, or none', () => {
    const stores = [{ name: '' }, { name: 'ro', write_enabled: 0 }, { name: 'rw', write_enabled: 1 }];
    const one = { secret_store: 'ro' };
    expect(keepWritableStore(one, stores, true)).toBe(true);
    expect(one.secret_store).toBe('rw');
    const two = { secret_store: 'ro' };
    keepWritableStore(two, [...stores, { name: 'rw2', write_enabled: true }], true);
    expect(two.secret_store).toBe('');
    const ok = { secret_store: 'rw' };
    expect(keepWritableStore(ok, stores, true)).toBe(false);
    expect(ok.secret_store).toBe('rw');
    // pointing to a secret, or the stores not loaded yet : as chosen
    const point = { secret_store: 'ro' };
    expect(keepWritableStore(point, stores, false)).toBe(false);
    const loading = { secret_store: 'ro' };
    expect(keepWritableStore(loading, undefined, true)).toBe(false);
    expect(loading.secret_store).toBe('ro');
  });

  it('the dialog offers only the sign-in with a password, and keeps its values consistent', () => {
    const writing = { secret_source: 'store', secret_action: 'write' };
    for (const [key, type, without] of [
      ['ssh_auth', 'ssh', 'key'],
      ['smtp_auth', 'smtp', 'none'],
      ['entra_auth', 'entraid', 'certificate'],
    ]) {
      expect(field(key).optionShown({ value: without }, { credential_type: type, ...writing })).toBe(false);
      expect(field(key).optionShown({ value: without }, { credential_type: type, secret_source: 'local' })).toBe(true);
    }
    const item = { credential_type: 'smtp', smtp_auth: 'none', secret_store: 'ro', ...writing };
    credentials.adjust(item, {
      secretstores: [
        { name: 'ro', write_enabled: 0 },
        { name: 'rw', write_enabled: 1 },
      ],
    });
    expect(item).toMatchObject({ smtp_auth: 'password', secret_store: 'rw' });
    // the dialog calls it as its values change, its radios show only what optionShown offers
    const dialog = read('src/components/AppAdminMulti.vue');
    expect(dialog).toContain('props.settings.adjust(item.value, parentLists.value || {})');
    expect(dialog).toContain('v-show="optionShown(field, opt)"');
    expect(dialog).toContain(':shown="(opt) => optionShown(field, opt)"');
  });

  it('the credential page does the same', () => {
    expect(page).toContain('keepSignInWritable(edit.value, writesToStore.value)');
    expect(page).toContain('keepWritableStore(edit.value, secretStores.value, writesToStore.value)');
    expect(page).toContain("signInShown('ssh_auth', opt)");
    expect(page).toContain("signInShown('smtp_auth', opt)");
    expect(page).toContain("signInShown('entra_auth', opt)");
  });
});

// ------------------------------------------------------------------
// the New credential dialog : only what the final type shows
// ------------------------------------------------------------------
describe('the New credential dialog saves only what its final type shows', () => {
  it('drops a host and port typed for an SSH one, then Git chosen', () => {
    const saved = credentials.beforeSave({
      name: 'g',
      credential_type: 'git',
      git_auth: 'token',
      password: 'tok',
      host: 'srv',
      port: 22,
      secret_source: 'local',
    });
    expect(saved).not.toHaveProperty('host');
    expect(saved).not.toHaveProperty('port');
    expect(saved.password).toBe('tok');
  });

  it("drops a CyberArk one's client key and certificate, then User and password chosen", () => {
    const saved = credentials.beforeSave({
      name: 'u',
      credential_type: 'userpass',
      user: 'me',
      password: 'pw',
      client_cert: 'C',
      client_key: 'K',
      secret_source: 'local',
    });
    expect(saved).not.toHaveProperty('client_key');
    expect(saved).not.toHaveProperty('client_cert');
    expect(saved).toMatchObject({ user: 'me', password: 'pw' });
  });

  it("drops a database's engine and name, then SSH chosen", () => {
    const saved = credentials.beforeSave({
      name: 's',
      credential_type: 'ssh',
      ssh_auth: 'password',
      user: 'root',
      password: 'pw',
      host: 'h',
      db_type: 'mysql',
      db_name: 'x',
      secret_source: 'local',
    });
    expect(saved).not.toHaveProperty('db_type');
    expect(saved).not.toHaveProperty('db_name');
    expect(saved).toMatchObject({ host: 'h', user: 'root', password: 'pw' });
  });

  it('still saves the optional host behind its switch, and what a store-backed one keeps', () => {
    const api = credentials.beforeSave({
      name: 'a',
      credential_type: 'api',
      password: 'tok',
      with_host: true,
      optional_host: 'api.example.com',
      optional_port: 443,
      secret_source: 'local',
    });
    expect(api).toMatchObject({ host: 'api.example.com', port: 443 });
    const store = credentials.beforeSave({
      name: 'e',
      credential_type: 'entraid',
      entra_auth: 'secret',
      tenant_id: 'T',
      redirect_uri: 'https://af/cb',
      user: 'id',
      password: 'pw',
      secret_source: 'store',
      secret_action: 'point',
      secret_store: 'vault',
      secret_ref: 'kv/entra',
    });
    expect(store).toMatchObject({ tenant_id: 'T', redirect_uri: 'https://af/cb', secret_store: 'vault' });
    expect(store).not.toHaveProperty('user');
    expect(store).not.toHaveProperty('password');
  });

  it('decides as the dialog does', () => {
    expect(credentialFieldShown(field('host'), { credential_type: 'git' })).toBe(false);
    expect(credentialFieldShown(field('tenant_id'), { credential_type: 'entraid' })).toBe(true);
    expect(credentialFieldShown(field('tenant_id'), { credential_type: 'oidc' })).toBe(false);
    expect(credentialFieldShown(field('name'), { credential_type: 'git' })).toBe(true);
    expect(credentialFieldShown(field('id'), {})).toBe(true);
  });
});

// ------------------------------------------------------------------
// the credential page : its sign-in changed needs its new secret
// ------------------------------------------------------------------
describe("the credential page's sign-in changed", () => {
  it('needs the new secret : a warning and no save, the field required', () => {
    expect(page).toMatch(
      /passwordRequired\.value && !newPassword\.value\)\s*\{\s*toast\.warning\(t\('settings\.credentials\.signInSecretRequired'/,
    );
    expect(page).toMatch(/clientKeyRequired\.value && \(!e\.client_cert\.trim\(\) \|\| !e\.client_key\.trim\(\)\)/);
    expect(page).toContain(':required="passwordRequired"');
    expect(page).toContain(':required="clientKeyRequired"');
    // left empty, the stored one is kept : only while the sign-in is the stored one
    expect(page).toMatch(/if \(passwordRequired\.value\) return own;/);
  });

  it('compares each type with its own stored sign-in', () => {
    expect(page).toMatch(/edit\.value\[key\] !== editable\(credential\.value\)\[key\]/);
    for (const key of ['ssh_auth', 'smtp_auth', 'entra_auth', 'awx_auth', 'git_auth']) {
      expect(page).toContain(`'${key}'`);
    }
  });

  it('says so in every language, on one line', async () => {
    for (const code of LOCALES) {
      const { default: messages } = await import(`../src/locales/${code}.js`);
      const text = messages.settings.credentials.signInSecretRequired;
      expect(text, code).toContain('{field}');
      expect(text.length, code).toBeLessThanOrEqual(80);
      expect(text, code).not.toContain('—');
    }
  });
});

// ------------------------------------------------------------------
// the credential page : an SSO one read from a store, an SSH one's passphrase
// ------------------------------------------------------------------
describe('the credential page', () => {
  it("shows and saves an SSO one's tenant, issuer and redirect URL when read from a store", () => {
    // sent whatever the store : before the store's branches, not in the app's only
    const save = page.slice(page.indexOf('async function save()'), page.indexOf('async function testConnection'));
    const tenant = save.indexOf("data.tenant_id = e.credential_type === 'entraid'");
    expect(tenant).toBeGreaterThan(-1);
    expect(tenant).toBeLessThan(save.indexOf('if (fromStore.value)'));
    // shown outside the fields typed only
    const template = page.slice(page.indexOf('<template>'));
    const typedOnly = template.indexOf('<template v-if="!fromStore">');
    expect(template.indexOf('v-model="edit.tenant_id"')).toBeLessThan(typedOnly);
    expect(template.indexOf('v-model="edit.issuer"')).toBeLessThan(typedOnly);
    expect(template.indexOf('v-model="edit.redirect_uri"')).toBeLessThan(typedOnly);
    // the sign-in choice and the certificate after them, not inside the typed block
    expect(template.indexOf('name="entra-auth"')).toBeGreaterThan(template.indexOf('</template>', typedOnly));
  });

  it("clears an SSH one's passphrase when a new key is pasted without one", () => {
    expect(page).toMatch(/data\.client_key = e\.client_key;\s*data\.key_passphrase = e\.key_passphrase \|\| null;/);
    // the stored key kept : an empty passphrase keeps the stored one
    expect(page).toMatch(/\} else if \(e\.key_passphrase\) data\.key_passphrase = e\.key_passphrase;/);
  });
});
