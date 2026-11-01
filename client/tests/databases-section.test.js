// Settings > Connections > Databases : the databases forms query (a field's dbConfig names one). A
// database is a record of its own (/api/v2/database) : its name, what it is, and the credential of
// type database it connects with, chosen as a runner chooses its credential. Its database type,
// database and host are its credential's, shown as columns ; no login and no password on it.
//
// What is pinned here : its place in the menu (right before Runners) and in the header search, the
// same role options as Credentials on its routes, its columns, its dialog and credential picker,
// its page (Test connection, Used by, Delete, Save) and its texts in every language.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TokenStorage from '@/lib/TokenStorage';
import router, { permissionGuard } from '@/router';
import { routePermission, mayOpen } from '@/lib/routePermission';
import { settingsMenu } from '@/lib/settingsMenu';
import { searchPages } from '@/config/searchPages';
import { recordButtons, rememberRows } from '@/lib/recordButtons';
import { forgetMenus } from '@/lib/menuMemory';
import getSettings, { isDatabaseCredential, DATABASES_PATH, DATABASE_TYPES } from '@/config/settings';
import { databaseFormRows } from '@/lib/formUseRows';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
// the keys themselves : what a text is, not how it reads
const t = (key, values) => (values ? `${key}:${Object.values(values).join(',')}` : key);
const all = getSettings(t);
const databases = all.databases;
const credentials = all.credentials;

// ------------------------------------------------------------------
// the menu and the header search
// ------------------------------------------------------------------
describe('the Databases entry', () => {
  it('is in Connections, right before Runners', () => {
    const connections = settingsMenu(t).find((s) => s.title === 'sidebar.sections.connections');
    const links = connections.items.map((i) => i.link);
    expect(links).toContain(DATABASES_PATH);
    expect(links.indexOf(DATABASES_PATH)).toBe(links.indexOf('/settings/runners') - 1);
    // after the credentials and their stores, as before
    expect(links.indexOf('/settings/secret-stores')).toBeLessThan(links.indexOf(DATABASES_PATH));
  });

  it('has the database icon and its own title', () => {
    const entry = settingsMenu(t)
      .flatMap((s) => s.items)
      .find((i) => i.link === DATABASES_PATH);
    expect(entry).toMatchObject({ title: 'sidebar.databases', icon: 'database' });
  });

  it('is found by the header search, before Runners too', () => {
    const links = searchPages(t, { showConnectionsSettings: true }).map((p) => p.link);
    expect(links.indexOf(DATABASES_PATH)).toBe(links.indexOf('/settings/runners') - 1);
  });
});

// ------------------------------------------------------------------
// the routes : the credentials' role options
// ------------------------------------------------------------------
describe('the Databases routes', () => {
  // the signed-in user's role options, as the guard reads them from the token
  const as = (options) => {
    vi.spyOn(TokenStorage, 'isAuthenticated').mockReturnValue(true);
    vi.spyOn(TokenStorage, 'getPayload').mockReturnValue({ user: { username: 'u', options } });
  };

  it('need what Credentials needs, the list and a database page alike', () => {
    const credentialsPermission = routePermission('/settings/credentials');
    expect(credentialsPermission).toEqual(['showSettings', 'showConnectionsSettings']);
    expect(routePermission(DATABASES_PATH)).toEqual(credentialsPermission);
    expect(routePermission(`${DATABASES_PATH}/3`)).toEqual(credentialsPermission);
    expect(routePermission(`${DATABASES_PATH}/3/used-by`)).toEqual(credentialsPermission);
  });

  it("open pages of their own, not the credentials'", () => {
    const list = router.resolve(DATABASES_PATH);
    const page = router.resolve(`${DATABASES_PATH}/3/used-by`);
    expect(list.matched[0].components.default).not.toBe(
      router.resolve('/settings/credentials').matched[0].components.default,
    );
    expect(page.matched[0].components.default).not.toBe(
      router.resolve('/settings/credentials/3').matched[0].components.default,
    );
    expect(page.params).toMatchObject({ id: '3', tab: 'used-by' });
  });

  it('show in the menu to a user with one of those options only', () => {
    expect(mayOpen(DATABASES_PATH, { showConnectionsSettings: true })).toBe(true);
    expect(mayOpen(DATABASES_PATH, { showSettings: true })).toBe(true);
    expect(mayOpen(DATABASES_PATH, { showJobs: true })).toBe(false);
  });

  it('send a user without them home ; with one, the page opens', async () => {
    const page = router.resolve(`${DATABASES_PATH}/3`);
    as({ showJobs: true });
    expect(await permissionGuard(page)).toEqual({ name: '/' });
    as({ showConnectionsSettings: true });
    expect(await permissionGuard(page)).toBe(true);
    vi.restoreAllMocks();
  });
});

// ------------------------------------------------------------------
// the list
// ------------------------------------------------------------------
describe('the Databases list', () => {
  it('reads its own api', () => {
    expect(databases.type).toBe('database');
    expect(read('src/pages/admin/databases.vue')).toMatch(/\/api\/v2\/database\/\$\{item\.id\}\/check/);
  });

  it('has its columns in their order : Host and Used by in the column picker, never a password', () => {
    const columns = databases.fields.filter((f) => !f.noTable);
    expect(columns.map((f) => f.key)).toEqual([
      'id',
      'name',
      'description',
      'db_type',
      'db_name',
      'host',
      'used_by_count',
    ]);
    expect(columns.filter((f) => !f.hidden).map((f) => f.key)).toEqual(['name', 'description', 'db_type', 'db_name']);
    expect(databases.fields.some((f) => /password|user|secret/.test(f.key))).toBe(false);
    // named as a credential's dialog names them
    expect(databases.fields.find((f) => f.key === 'db_type').label).toBe('settings.credentials.databaseType');
    expect(databases.fields.find((f) => f.key === 'db_name').label).toBe('settings.credentials.database');
  });

  it("shows its credential's database type, database and host", () => {
    const field = (key) => databases.fields.find((f) => f.key === key);
    expect(field('db_type').render('postgres')).toBe('PostgreSQL');
    expect(field('db_name').render('cmdb')).toBe('cmdb');
    expect(field('host').render('db1', { port: 5432 })).toBe('db1:5432');
    expect(field('host').render('db1', {})).toBe('db1');
    // a cell's html is escaped
    expect(field('host').render('<b>x</b>', {})).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it("shares the database types with the credentials' dropdown", () => {
    expect(credentials.fields.find((f) => f.key === 'db_type').values).toBe(DATABASE_TYPES);
  });

  it('opens a row on its page, and sends nothing of its credential back', () => {
    expect(databases.openPage({ id: 7 })).toBe('/settings/databases/7');
    const saved = databases.beforeSave({
      name: 'x',
      credential: 'c',
      db_type: 'mysql',
      host: 'h',
      port: 1,
      used_by_count: 2,
    });
    expect(saved).toEqual({ name: 'x', credential: 'c' });
  });
});

// ------------------------------------------------------------------
// the dialog and its credential picker
// ------------------------------------------------------------------
describe("a database's dialog", () => {
  const inputs = databases.fields.filter((f) => !f.noInput);
  const credential = databases.fields.find((f) => f.key === 'credential');

  it('asks its name, its description and its credential only', () => {
    expect(inputs.map((f) => f.key)).toEqual(['name', 'description', 'credential']);
    expect(credential.required).toBe(true);
  });

  it("is a wizard, as a runner's : the database, then its credential", () => {
    expect(databases.steps.map((s) => s.key)).toEqual(['database', 'credentials']);
    expect(databases.steps[1].label).toBe(all.runners.steps.find((s) => s.key === 'credentials').label);
    // a field with no step is on the first one
    expect(inputs.filter((f) => f.key !== 'credential').every((f) => !f.step)).toBe(true);
    expect(credential.step).toBe('credentials');
  });

  it('shows its credential on a Credentials tab of its own on its page, as a runner does', () => {
    expect(inputs.filter((f) => f.key !== 'credential').every((f) => f.tab === 'details')).toBe(true);
    expect(credential.tab).toBe('credential');
    const page = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/admin/database.vue'),
      'utf8',
    );
    expect(page).toMatch(/\{ key: 'details'[^\n]*\n[^\n]*\n\s*\{ key: 'credential'[^\n]*\n\s*\{ key: 'used-by'/);
    // labelled as the runner's page labels its own
    expect(page).toMatch(/\{ key: 'credential', label: t\('settings\.runners\.stepAuth'\)/);
  });

  it('offers the database credentials, as a runner offers those of its kind', () => {
    const choices = [
      { name: 'cmdb', credential_type: 'database', is_database: 1 },
      { name: 'ssh-root', credential_type: 'ssh', is_database: 0 },
      // one from before the types : its database flag
      { name: 'old-db', is_database: 1 },
      { name: 'old-login', is_database: 0 },
    ];
    expect(choices.filter((c) => credential.choicesWhen(c)).map((c) => c.name)).toEqual(['cmdb', 'old-db']);
    expect(choices.filter((c) => credential.valuesFrom.filter(c)).map((c) => c.name)).toEqual(['cmdb', 'old-db']);
    expect(isDatabaseCredential({ credential_type: 'ssh', is_database: 1 })).toBe(false);
  });

  it("has New credential, of type database, as the runners' picker", () => {
    const runnerCredential = all.runners.fields.find((f) => f.key === 'credential');
    expect(credential.createWith).toBe(runnerCredential.createWith);
    expect(credential.createLabel).toBe(runnerCredential.createLabel);
    expect(credential.createDefaults).toEqual({ credential_type: 'database' });
  });

  it('leaves Credentials as they are : the database type and its fields still there', () => {
    const types = credentials.fields.find((f) => f.key === 'credential_type').options.map((o) => o.value);
    expect(types).toContain('database');
    expect(credentials.fields.find((f) => f.key === 'db_name').dependencyValues).toEqual(['database']);
  });
});

// ------------------------------------------------------------------
// its page
// ------------------------------------------------------------------
describe('a database page', () => {
  it('has Test connection, Delete and Save', () => {
    forgetMenus();
    expect(recordButtons('databases', 9)).toHaveLength(3);
    rememberRows('database', [{ id: 1, managed: 1 }]);
    expect(recordButtons('databases', 1)).toHaveLength(1);
  });

  it('has the Details and Used by tabs, its actions Test connection and Delete', () => {
    const page = read('src/pages/admin/database.vue');
    expect(page).toMatch(/key: 'details'/);
    expect(page).toMatch(/key: 'used-by'/);
    expect(page).toMatch(/actions: list\.actions\.filter\(\(a\) => a\.name !== 'edit'\)/);
    expect(databases.actions.map((a) => a.name)).toEqual(['edit', 'test', 'delete']);
  });

  it('lists the forms naming it, or its credential, in dbConfig', () => {
    const forms = [
      { name: 'Servers', description: '', credentials: [{ name: 'cmdb', where: 'field srv (dbConfig)' }] },
      { name: 'Old', description: '', credentials: [{ name: 'cmdb-login', where: 'field srv (dbConfig)' }] },
      // a credential handed to a playbook : no query
      { name: 'Deploy', description: '', credentials: [{ name: 'cmdb-login', where: 'credentials: db' }] },
      { name: 'Other', description: '', credentials: [{ name: 'elsewhere', where: 'field x (dbConfig)' }] },
    ];
    // a form naming the database and its credential : one row all the same
    forms.push({
      name: 'Both',
      description: '',
      credentials: [
        { name: 'cmdb', where: 'field a (dbConfig)' },
        { name: 'cmdb-login', where: 'field b (dbConfig)' },
      ],
    });
    const rows = databaseFormRows(forms, { name: 'cmdb', credential: 'cmdb-login' });
    expect(rows.map((r) => [r.name, r.fields])).toEqual([
      ['Servers', 'srv'],
      ['Old', 'srv'],
      ['Both', 'a, b'],
    ]);
    expect(rows[0].to).toBe('/designer/forms/servers');
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("is listed on its credential's Used by tab", () => {
    const page = read('src/pages/admin/credential.vue');
    expect(page).toMatch(/axios\.get\('\/api\/v2\/database\/', auth\)/);
    expect(page).toMatch(/kind: 'database', to: `\/settings\/databases\/\$\{r\.id\}`/);
  });
});

// ------------------------------------------------------------------
// the texts
// ------------------------------------------------------------------
describe('the Databases texts', () => {
  it('are in every language', async () => {
    for (const code of ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl']) {
      const { default: messages } = await import(`../src/locales/${code}.js`);
      expect(messages.sidebar.databases, code).toBeTruthy();
      expect(messages.settings.linked.database, code).toBeTruthy();
      for (const key of ['label', 'description', 'nameHelp', 'credential', 'credentialHelp', 'noUse', 'field']) {
        expect(messages.settings.databases[key], `${code} ${key}`).toBeTruthy();
      }
      for (const action of ['database_create', 'database_update', 'database_delete', 'database_check_create']) {
        expect(messages.audit.actionLabels[action], `${code} ${action}`).toBeTruthy();
      }
    }
  });
});

describe('the settings menu icons', () => {
  // Databases took the database icon : Backups, the instance's own data, has the archive box (as
  // the General page's backups group), so no two menu items look alike
  it('gives Databases and Backups icons of their own', () => {
    const items = settingsMenu(t).flatMap((s) => s.items || s.children || []);
    const icon = (key) => items.find((i) => i.title === key)?.icon;
    expect(icon('sidebar.backups')).toBe('box-archive');
    expect(icon('sidebar.databases')).toBe('database');
  });
});

describe("a database's page toolbar", () => {
  // the Used by table puts its filter, Columns, Export CSV and pager in the page's own toolbar :
  // mounted on a hidden tab, they showed on Details and Credentials too
  const read = (rel) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
  it('shows the Used by table only while its tab is shown, or the search covers every tab', () => {
    expect(read('../src/components/AppAdminSingle.vue')).toMatch(
      /:name="'tab-top-' \+ tab\.key"[^>]*:active="activeTab === tab\.key"/,
    );
    const page = read('../src/pages/admin/database.vue');
    expect(page).toMatch(/#tab-top-used-by="\{ active, searching \}"/);
    expect(page).toMatch(/<AppLinkedTable\s+v-if="active \|\| searching"/);
    // its count on the tab, as the credential's page shows its own
    expect(page).toMatch(
      /\{ key: 'used-by', label: t\('settings\.linked\.usedBy'\), icon: 'link', count: usedBy\.value\.length \}/,
    );
  });
});

describe("a database's page fields", () => {
  // as long as a secret store's (40rem, AppAdminSingle's wide tabs), not the 20rem of a narrow page
  it('are wide on its Details and Credentials tabs', () => {
    const page = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/admin/database.vue'),
      'utf8',
    );
    expect(page).toMatch(/wideTabs: \['details', 'credential'\]/);
  });
});

describe("a database's Used by table", () => {
  // the forms that query it : their name and description, nothing about how they name it
  it('has the name, the description and the fields columns', () => {
    const page = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/admin/database.vue'),
      'utf8',
    );
    const columns = /const usedByColumns = computed\(\(\) => \[([\s\S]*?)\]\);/.exec(page)[1];
    expect([...columns.matchAll(/key: '([a-z_]+)'/g)].map((m) => m[1])).toEqual(['name', 'description', 'fields']);
    // the name is the form's : labelled Form
    expect(columns).toMatch(/\{ key: 'name', label: t\('settings\.fields\.form'\) \}/);
  });
});
