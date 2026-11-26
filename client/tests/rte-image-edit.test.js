// The RTE images' YAML tab dialogs : each sets or adds its part of an image's draft.
import { describe, it, expect } from 'vitest';
import { withLines, applyRteInsert } from '@/lib/rteImageEdit';
import { DESIGNER_ACTIONS } from '@/config/designerActions';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

const TABLE = { 2.18: ['3.11', '3.12', '3.13'], 2.22: ['3.13', '3.14'] };
const fit = {
  fits: (v, p) => !v || !TABLE[v] || TABLE[v].includes(p),
  newestFor: (p) =>
    Object.keys(TABLE)
      .filter((r) => TABLE[r].includes(p))
      .sort()
      .reverse()[0] || '',
};
const draft = () => ({
  python: '3.13',
  ansible_core: '2.18',
  collections: [{ name: 'netapp.ontap', version: '' }],
  python_packages: 'netapp-lib',
  os_packages: 'sshpass',
  registry_credential: '',
  registry_path: '',
  sign: false,
  sign_credential: '',
});

describe('the RTE images YAML tab dialogs', () => {
  it('Python leads : an ansible-core that does not run on it takes the newest that does', () => {
    const d = draft();
    applyRteInsert(d, 'rtePython', { python: '3.14' }, fit);
    expect([d.python, d.ansible_core]).toEqual(['3.14', '2.22']);
    applyRteInsert(d, 'rtePython', { python: '3.13' }, fit);
    expect(d.ansible_core).toBe('2.22');
    applyRteInsert(d, 'rteCore', { core: '2.18' }, fit);
    expect(d.ansible_core).toBe('2.18');
  });

  it('a collection added once, its version set ; a name that is no namespace.name refused', () => {
    const d = draft();
    expect(applyRteInsert(d, 'rteCollection', { name: 'community.vmware', version: '5.7.0' }, fit)).toBe('');
    expect(applyRteInsert(d, 'rteCollection', { name: ' netapp.ontap ', version: '23.1.0' }, fit)).toBe('');
    expect(d.collections).toEqual([
      { name: 'netapp.ontap', version: '23.1.0' },
      { name: 'community.vmware', version: '5.7.0' },
    ]);
    expect(applyRteInsert(d, 'rteCollection', { name: 'vmware' }, fit)).toBe('collectionName');
    expect(d.collections).toHaveLength(2);
  });

  it('packages added each once : python ones by line, OS ones by line, space or comma', () => {
    expect(withLines('a\nb', 'b\nc', /\r?\n/)).toBe('a\nb\nc');
    const d = draft();
    applyRteInsert(d, 'rtePythonPackages', { packages: 'netapp-lib\nnetapp-ontap==9.16.1.0' }, fit);
    expect(d.python_packages).toBe('netapp-lib\nnetapp-ontap==9.16.1.0');
    applyRteInsert(d, 'rteOsPackages', { packages: 'sshpass, git curl' }, fit);
    expect(d.os_packages).toBe('sshpass\ngit\ncurl');
  });

  it('the registry by name with the path, and the signing key ; none : not signed', () => {
    const d = draft();
    applyRteInsert(d, 'rteRegistry', { credential: 'ghcr', path: ' af/rte-netapp ' }, fit);
    expect([d.registry_credential, d.registry_path]).toEqual(['ghcr', 'af/rte-netapp']);
    applyRteInsert(d, 'rteSigning', { signing: 'cosign-key' }, fit);
    expect([d.sign, d.sign_credential]).toEqual([true, 'cosign-key']);
    applyRteInsert(d, 'rteSigning', { signing: '' }, fit);
    expect(d.sign).toBe(false);
  });

  it('each dialog a toolbar action of the YAML tab, with its texts in every language', async () => {
    const keys = [
      'rtePython',
      'rteCore',
      'rteCollection',
      'rtePythonPackages',
      'rteOsPackages',
      'rteRegistry',
      'rteSigning',
    ];
    const page = readFileSync(path.join(SRC, 'components/AppRteImages.vue'), 'utf8');
    for (const k of keys) {
      expect(DESIGNER_ACTIONS[k], k).toBeTruthy();
      expect(page).toContain(`'${k}'`);
    }
    expect(page).toMatch(/show: props\.view === 'yaml'/);
    for (const lang of ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl']) {
      const rte = (await import(`../src/locales/${lang}.js`)).default.designer.rte;
      for (const k of keys) expect(rte[DESIGNER_ACTIONS[k].title.split('.').pop()], `${lang} ${k}`).toBeTruthy();
      for (const k of ['fixYamlFirst', 'collectionName', 'signingHelp', 'registryPath'])
        expect(rte[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});
