// The radio and select choices the settings fields and the admin pages both offer are defined once,
// in config/settings.js : the CyberArk PVWA logon methods (secret store), what a credential does
// with a secret store and what an Entra ID one signs in with (credential), and how a mail channel
// through Microsoft 365 sends (notification channel). A page never rebuilds its own copy, so the
// dialog and the page cannot drift apart.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import getSettings, {
  PVWA_AUTH,
  ENTRA_AUTH,
  SEND_THROUGH,
  sendThroughOptionList,
  entraAuthOptionList,
  secretActionOptionList,
} from '@/config/settings';
import { blocksOf, withoutComments } from './vueSource.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// the translation : each key as it is, so a label shows which key it reads
const t = (key) => key;
const settings = getSettings(t);
const field = (section, key) => settings[section].fields.find((f) => f.key === key);

/**
 * The scripts of an admin page, its comments cut out.
 *
 * Args:
 *   file (string): the page's file name under src/pages/admin.
 *
 * Returns:
 *   string: its script blocks, joined.
 */
const script = (file) =>
  withoutComments(
    blocksOf(readFileSync(join(import.meta.dirname, '../src/pages/admin', file), 'utf8'), 'script').join('\n'),
    '//',
    '\n',
  );

/**
 * The template of an admin page, its comments cut out.
 *
 * Args:
 *   file (string): the page's file name under src/pages/admin.
 *
 * Returns:
 *   string: its template blocks, joined.
 */
const template = (file) =>
  withoutComments(
    blocksOf(readFileSync(join(import.meta.dirname, '../src/pages/admin', file), 'utf8'), 'template').join('\n'),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the option lists shared by the settings and the admin pages', () => {
  it('the settings fields offer the exported lists, labels and values unchanged', () => {
    expect(field('secretStores', 'pvwa_auth').values).toBe(PVWA_AUTH);
    expect(PVWA_AUTH.map((o) => o.name)).toEqual(['cyberark', 'ldap', 'radius', 'windows']);
    expect(field('credentials', 'secret_action').options).toEqual(secretActionOptionList(t));
    expect(secretActionOptionList(t).map((o) => o.value)).toEqual(['point', 'write']);
    expect(field('credentials', 'entra_auth').options).toEqual(entraAuthOptionList(t));
    expect(ENTRA_AUTH).toEqual(['secret', 'certificate']);
    expect(field('notificationChannels', 'send_through').options).toEqual(sendThroughOptionList(t));
    expect(SEND_THROUGH).toEqual(['graph', 'smtp']);
  });

  it('the secret store page imports the PVWA logon methods, never its own copy', () => {
    const code = script('secret-store.vue');
    expect(code).toMatch(/import getSettings, \{[^}]*\bPVWA_AUTH\b[^}]*\} from '@\/config\/settings'/);
    expect(code).not.toMatch(/const PVWA_AUTH\b/);
  });

  it('the credential page builds its secret action and Entra sign-in choices from settings', () => {
    const code = script('credential.vue');
    expect(code).toContain('entraAuthOptionList(t)');
    expect(code).toContain('secretActionOptionList(t)');
    expect(code).not.toContain('entraSignIn_');
    expect(template('credential.vue')).not.toContain('settings.credentials.secretPoint');
  });

  it('the notification channel page builds its send through choices from settings', () => {
    const code = script('notification-channel.vue');
    expect(code).toContain('sendThroughOptionList(t)');
    expect(code).not.toContain('sendThrough_');
  });
});
