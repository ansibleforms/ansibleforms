// What a repository is used for (lib/repositoryUsage.js) : its usage types in five groups, the
// Usage step's group boxes (three states, skipping the types another repository has and those of a
// later version), the one question asked when a save turns several object types on or off (a
// section per type, one Cancel and one confirm), the toast after, the repositories list's Usage
// column of badges, Pull all's order, and the Repository line of a linked object's page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// the server's preview, by type, and the toasts said after
let previews = {};
let unpushed = false;
const asked = [];
vi.mock('axios', () => ({
  default: {
    get: vi.fn(async (url) => {
      asked.push(url);
      const types = new URL(url, 'http://x').searchParams.get('types').split(',');
      return { data: { unpushed, types: Object.fromEntries(types.map((k) => [k, previews[k] || {}])) } };
    }),
  },
}));
const toasts = [];
vi.mock('vue-sonner', () => ({
  toast: { success: (m) => toasts.push(['success', m]), error: (m) => toasts.push(['error', m]) },
}));

import axios from 'axios';
import getSettings from '../src/config/settings.js';
import { confirmPrompt, answerConfirm } from '../src/lib/confirmPrompt.js';
import { htmlToText } from '../src/lib/dataTable.js';
import {
  USAGE_CATEGORIES,
  USAGE_TYPES,
  USAGE_FLAGS,
  typesOf,
  takenBy,
  categoryState,
  setCategory,
  usageChanges,
  confirmUsageChange,
  usageToast,
  usageBadges,
  usageSortValue,
  pullOrder,
  repositorySourceFields,
  activationLines,
  singleTypeSource,
  usageLabel,
  APPLY_ORDER,
} from '../src/lib/repositoryUsage.js';
import * as server from '../../server/src/lib/repoObjects/types.js';

// the key, with its values, as the text : what reaches the page is checked, not a translation
const t = (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key);
const settings = getSettings(t);
const read = (file) => readFileSync(join(import.meta.dirname, '../src', file), 'utf8');
const LANGS = ['en', 'es', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ja', 'zh'];

beforeEach(() => {
  previews = {};
  unpushed = false;
  asked.length = 0;
  toasts.length = 0;
  if (confirmPrompt.open) answerConfirm(false);
});

describe('the usage types', () => {
  it('are the 27 types of the server, in six groups, each flag once', () => {
    const pick = (u) => ({
      key: u.key,
      flag: u.flag,
      category: u.category,
      objects: !!u.objects,
      // the server refuses a second repository for an object type ; config and playbooks are
      // greyed on the others here only, as before (the server warns and uses the first one)
      oneOnly: !!u.oneOnly && !!u.objects,
    });
    expect(USAGE_TYPES.map(pick)).toEqual(server.USAGE_TYPES.map(pick));
    expect(USAGE_CATEGORIES).toEqual(server.CATEGORIES);
    expect(new Set(USAGE_FLAGS).size).toBe(27);
    // the Designer group in the Designer menu's order, Schedules last
    expect(typesOf('designer').map((u) => u.key)).toEqual([
      'categories',
      'constants',
      'forms',
      'inventories',
      'playbooks',
      'workflows',
    ]);
    // Schedules in a section of its own, Jobs, below the Designer
    expect(typesOf('jobs').map((u) => u.key)).toEqual(['schedules']);
    // Roles where Config was : Disclaimer, Roles, LDAP, SSO
    expect(typesOf('access').map((u) => u.key)).toEqual(['disclaimer', 'roles', 'ldap', 'sso']);
    expect(typesOf('connections').map((u) => u.key)).toEqual([
      'repositories',
      'credentials',
      'secret_stores',
      'runners',
      'notifications',
      'chat_assistant',
      'mcp',
      'syslog',
    ]);
  });

  it('forms, workflows and inventories may be on several repositories ; roles, categories, constants and playbooks one', () => {
    const one = (key) => !!USAGE_TYPES.find((u) => u.key === key).oneOnly;
    expect(['forms', 'workflows', 'inventories'].map(one)).toEqual([false, false, false]);
    expect(['roles', 'categories', 'constants', 'playbooks', 'schedules', 'credentials', 'runners'].map(one)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // the server refuses a second one for the three configuration keys too
    for (const key of ['roles', 'categories', 'constants']) {
      expect(server.USAGE_TYPES.find((u) => u.key === key).oneOnly).toBe(true);
    }
  });

  it('named as their menu items : Roles, Categories, Constants, Chat assistant', () => {
    const labels = Object.fromEntries(USAGE_TYPES.filter((u) => u.labelKey).map((u) => [u.key, u.labelKey]));
    expect(labels).toMatchObject({
      roles: 'sidebar.roles',
      categories: 'sidebar.categories',
      constants: 'sidebar.constants',
      chat_assistant: 'sidebar.chat',
    });
    expect(read('pages/admin/repository.vue')).toContain(
      "t('settings.repositories.configDeprecated', { key: usageLabel(t, d.key), file: d.file })",
    );
  });

  it('every type has its label and its hint, every group its name, in every language', async () => {
    for (const lang of LANGS) {
      const locale = (await import(`../src/locales/${lang}.js`)).default;
      const r = locale.settings.repositories;
      for (const u of USAGE_TYPES) {
        // its own label, or its menu item's (Notifications, Links)
        const label = u.labelKey ? u.labelKey.split('.').reduce((o, k) => o?.[k], locale) : r.usageTypes[u.key];
        expect(label, `${lang} ${u.key}`).toBeTruthy();
        expect(r.usageHints[u.key], `${lang} ${u.key}`).toBeTruthy();
      }
      for (const c of USAGE_CATEGORIES) expect(r.usageCategories[c], `${lang} ${c}`).toBeTruthy();
      for (const code of ['seed', 'registered', 'pending']) expect(r.usageKeptWhy[code]).toBeTruthy();
    }
  });
});

describe('a group box ticks every type of it that can be ticked', () => {
  const others = [
    { id: 1, name: 'creds', use_for_credentials: 1 },
    { id: 2, name: 'self', use_for_forms: 1 },
  ];

  it('a type another repository has is not this one to tick : its name said', () => {
    const credentials = USAGE_TYPES.find((u) => u.key === 'credentials');
    expect(takenBy(credentials, { id: 2, name: 'self' }, others)).toBe('creds');
    // the repository that has it : its own
    expect(takenBy(credentials, { id: 1, name: 'creds', use_for_credentials: 1 }, others)).toBeNull();
  });

  it('Connections : the credentials another repository has are skipped, every other type ticked', () => {
    const record = { id: 2, name: 'self' };
    expect(categoryState('connections', record, others)).toEqual({
      checked: false,
      indeterminate: false,
      disabled: false,
    });
    setCategory('connections', record, others, true);
    expect(USAGE_FLAGS.filter((f) => record[f])).toEqual([
      'use_for_repositories',
      'use_for_secret_stores',
      'use_for_runners',
      'use_for_notifications',
      'use_for_chat_assistant',
      'use_for_mcp',
      'use_for_syslog',
    ]);
    expect(categoryState('connections', record, others).checked).toBe(true);
    setCategory('connections', record, others, false);
    expect(record.use_for_runners).toBe(false);
  });

  it('some of a group ticked : half ticked ; every type taken : the group box greyed', () => {
    const record = { id: 3, name: 'new', use_for_forms: true };
    expect(categoryState('designer', record, []).indeterminate).toBe(true);
    // System : only General, which another repository has
    const taken = [{ id: 9, name: 'cfg', use_for_general: 1 }];
    expect(categoryState('system', record, taken).disabled).toBe(true);
    setCategory('system', record, taken, true);
    expect(record.use_for_general).toBeUndefined();
  });

  it('no type is of a later version any more : nothing coming soon, every one can be ticked', async () => {
    expect(USAGE_TYPES.some((u) => 'built' in u)).toBe(false);
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      expect(r.usageComingSoon).toBeUndefined();
      expect(r.usageComingSoonHint).toBeUndefined();
    }
    expect(read('components/AppRepositoryUsage.vue')).not.toContain('usageComingSoon');
  });

  it('the component draws the groups and is used by the dialog and the page', () => {
    const component = read('components/AppRepositoryUsage.vue');
    expect(component).toContain(':indeterminate.prop="categoryState(category, modelValue, others).indeterminate"');
    // a single list, one type per row, spaced and lined up as the Type tabs' options
    expect(component).toContain('class="form-check af-short-check"');
    expect(component).toContain('<span class="af-short-label">');
    expect(component).not.toContain('grid-template-columns');
    expect(read('components/AppAdminMulti.vue')).toMatch(
      /<AppRepositoryUsage\s+v-if="showField\(field\) && field.type === 'usage'"/,
    );
    expect(read('pages/admin/repository.vue')).toContain('<AppRepositoryUsage v-model="edit"');
  });

  it('repositories are deleted one by one, each asked its own question : no bulk delete', () => {
    expect(typeof settings.repositories.confirmDelete).toBe('function');
    const multi = read('components/AppAdminMulti.vue');
    // a list whose delete asks per record has no bulk delete, nor checkboxes for it
    expect(multi).toMatch(
      /const bulkDeleteAction = computed\(\(\) =>\s+typeof props\.settings\.confirmDelete === 'function' \? null : deleteAction\.value/,
    );
    expect(multi).toContain('!!bulkDeleteAction.value || !!props.settings.checkboxes');
    expect(multi).toContain('v-if="count && bulkDeleteAction" icon="trash" @click="bulkDelete"');
    expect(multi).not.toContain('v-if="count && deleteAction"');
  });
});

describe('one question when a save turns several object types on or off', () => {
  it('ticking all of Connections : a section per type, what is common said once, one Cancel / one Save', async () => {
    previews = {
      credentials: {
        written: ['git', 'api'],
        withoutSecret: ['git', 'api'],
        clashes: [],
        kept: [{ name: 'seeded', code: 'seed' }],
      },
      runners: { written: ['rte1'], clashes: ['rte2'], kept: [{ name: 'joined', code: 'registered' }] },
    };
    const was = { name: 'ops' };
    const now = { name: 'ops' };
    setCategory('connections', now, [], true);
    const all = [
      'credentials',
      'repositories',
      'secret_stores',
      'runners',
      'notifications',
      'syslog',
      'chat_assistant',
      'mcp',
    ];
    expect(usageChanges(was, now)).toEqual({ on: all, off: [] });
    const answer = confirmUsageChange(t, 'ops', was, now);
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    expect(asked).toEqual([`/api/v2/repository/ops/usage-preview?types=${all.join(',')}`]);
    expect(confirmPrompt.title).toBe('settings.repositories.usageChangeTitle');
    expect(confirmPrompt.message).toBe('settings.repositories.usageChangeQuestion {"name":"ops"}');
    expect(confirmPrompt.ok).toBe('settings.repositories.usageChangeButton');
    const d = confirmPrompt.details;
    const headings = d.filter((x) => x.heading).map((x) => x.heading);
    expect(headings).toEqual(
      all.map((key) => `settings.repositories.usageOnHeading {"type":"${usageLabel(t, key).split(' ')[0]}"}`),
    );
    const text = d.map((x) => x.heading || x).join('\n');
    // written as entries of the file the preview names : <key>.yaml when it names none
    expect(text).toContain(
      'settings.repositories.usageOnWrittenList {"type":"settings.repositories.usageTypes.credentials","name":"ops","file":"credentials.yaml","count":2}',
    );
    expect(text).toContain('settings.repositories.usageOnWithoutSecret {"names":"git, api"}');
    expect(text).toContain(
      'settings.repositories.usageOnKept {"names":"seeded (settings.repositories.usageKeptWhy.seed)"}',
    );
    expect(text).toContain('settings.repositories.usageOnClashes {"names":"rte2"}');
    expect(text).toContain('joined (settings.repositories.usageKeptWhy.registered)');
    // what follows : once, at the end
    expect(d.filter((x) => x === 'settings.repositories.usageOnAfter').length).toBe(1);
    expect(d[d.length - 1]).toBe('settings.repositories.usageOnAfter');
    answerConfirm(true);
    expect(await answer).toBe(true);
  });

  it('one on and one off : both sections, the pull and the unpushed warning once', async () => {
    unpushed = true;
    previews = { runners: { linked: 2 }, schedules: { written: [] } };
    const answer = confirmUsageChange(t, 'ops', { use_for_runners: 1 }, { use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    const d = confirmPrompt.details;
    expect(d.filter((x) => x.heading).length).toBe(2);
    expect(d).toContain(
      'settings.repositories.usageOffKept {"type":"settings.repositories.usageTypes.runners","count":2}',
    );
    expect(d.filter((x) => x === 'settings.repositories.usageOffPull').length).toBe(1);
    expect(d.filter((x) => x === 'settings.repositories.usageOffUnpushed').length).toBe(1);
    answerConfirm(false);
    expect(await answer).toBe(false);
  });

  it('a content type only (forms) : nothing is asked', async () => {
    expect(await confirmUsageChange(t, 'ops', {}, { use_for_forms: 1, use_for_workflows: 1 })).toBe(true);
    expect(asked).toEqual([]);
  });

  it('the toast says each type, in order ; a failure in red', () => {
    usageToast(t, {
      runners: { activated: { pull: 'pulled', written: ['a'], matched: [], kept: [] } },
      credentials: { activated: { pull: 'pulled', written: ['x', 'y'], matched: ['z'], kept: [] } },
    });
    expect(toasts[0][0]).toBe('success');
    expect(toasts[0][1].indexOf('usageTypes.credentials')).toBeLessThan(toasts[0][1].indexOf('usageTypes.runners'));
    usageToast(t, { credentials: { error: 'disk full' } });
    expect(toasts[1]).toEqual([
      'error',
      'settings.repositories.usageFailed {"type":"settings.repositories.usageTypes.credentials","error":"disk full"}',
    ]);
  });

  it('a pull that failed, files refused or the files not read in before letting go : in red, with why', () => {
    usageToast(t, { schedules: { deactivated: { pull: 'pulled', unlinked: 3, error: 'not read in: bad yaml' } } });
    expect(toasts[0][0]).toBe('error');
    expect(toasts[0][1]).toContain('settings.repositories.usageNotReadIn {"error":"bad yaml"}');
    usageToast(t, {
      credentials: {
        activated: {
          pull: 'pulled',
          written: [],
          matched: [],
          kept: [],
          refused: [{ file: 'a.yaml', reasons: ['bad'] }],
        },
      },
    });
    expect(toasts[1][0]).toBe('error');
    expect(toasts[1][1]).toContain('settings.repositories.usageRefused {"files":"a.yaml (bad)"}');
    // the server's reason once, never "not pulled (not pulled: ...)"
    usageToast(t, {
      schedules: { activated: { pull: 'not pulled: auth failed', written: [], matched: [], kept: [] } },
    });
    expect(toasts[2][0]).toBe('error');
    expect(toasts[2][1]).toContain('settings.repositories.usageNotPulled {"reason":"auth failed"}');
    // a repository let go of that was never cloned : said, not a failure
    usageToast(t, { schedules: { deactivated: { pull: 'not cloned', unlinked: 1 } } });
    expect(toasts[3][0]).toBe('success');
  });
});

describe("the repositories list's Usage column", () => {
  const field = settings.repositories.fields.find((f) => f.key === 'usage');

  it('one column of badges replaces the column per usage', () => {
    expect(settings.repositories.fields.filter((f) => /^use_for_/.test(f.key))).toEqual([]);
    expect(field).toMatchObject({
      step: 'usage',
      type: 'usage',
      label: 'settings.repositories.usageColumn',
      filterable: true,
    });
    expect(field.hidden).toBeUndefined();
    // and the dialog does not send it
    expect(settings.repositories.beforeSave({ name: 'a', usage: 'x', pull_scheduled: true })).toEqual({ name: 'a' });
  });

  it('a badge per type, in order, escaped, in the shape of the other row badges', () => {
    const html = field.render(null, { use_for_runners: 1, use_for_forms: 1, use_for_config: 0 });
    expect(html).toBe(
      '<span class="badge af-usage-badge me-1">settings.repositories.usageTypes.forms</span>' +
        '<span class="visually-hidden">, </span>' +
        '<span class="badge af-usage-badge me-1">settings.repositories.usageTypes.runners</span>',
    );
    expect(usageBadges((k) => (k.endsWith('forms') ? '<b>' : k), { use_for_forms: 1 })).toContain('&lt;b&gt;');
    expect(usageBadges(t, {})).toBe('');
    const css = read('styles/bootstrap-override.scss');
    expect(css).toMatch(/\.af-required-badge,\s*\.af-usage-badge \{/);
  });

  it('its plain text (CSV export, column filter, tooltip) keeps the names apart', () => {
    const tt = (k) => k.split('.').pop();
    const html = usageBadges(tt, { use_for_forms: 1, use_for_playbooks: 1, use_for_workflows: 1 });
    expect(htmlToText(html)).toBe('forms, playbooks, workflows');
    expect(htmlToText(usageBadges(tt, { use_for_forms: 1 }))).toBe('forms');
  });

  it('sorts by the types, a repository used for nothing last', () => {
    expect(usageSortValue(t, { use_for_forms: 1 })).toBe('settings.repositories.usageTypes.forms');
    expect(usageSortValue(t, {}) > usageSortValue(t, { use_for_general: 1 })).toBe(true);
    expect(field.sortValue({ use_for_forms: 1 })).toBe(usageSortValue(t, { use_for_forms: 1 }));
  });
});

describe('Pull all, and a linked object', () => {
  it('pulls the repositories holding objects first, credentials before runners, one after the other', () => {
    const [ordered, rest] = pullOrder([
      { name: 'forms', use_for_forms: 1 },
      { name: 'run', use_for_runners: 1 },
      { name: 'cred', use_for_credentials: 1 },
    ]);
    expect(ordered.map((r) => r.name)).toEqual(['cred', 'run']);
    expect(rest.map((r) => r.name)).toEqual(['forms']);
    // one after the other, then the rest at once, every outcome sorted into pulled, skipped and failed
    const page = read('pages/admin/repositories.vue');
    expect(page).toContain('for (const repo of ordered) {');
    expect(page).toContain('await pull(repo).then(');
    expect(page).toContain('sortPulls([...ordered, ...rest], settled)');
  });

  it('the page of every object kept in a repository shows where it comes from, with one component', () => {
    for (const page of [
      'pages/admin/credential.vue',
      'pages/admin/runner.vue',
      'pages/schedule.vue',
      'pages/admin/secret-store.vue',
      'pages/admin/notification-channel.vue',
      'pages/admin/sso-provider.vue',
      'pages/admin/syslog-server.vue',
      'pages/admin/label.vue',
    ]) {
      expect(read(page), page).toMatch(/<AppRepositorySource v-show="fieldShown\('source'\)" :record="\w+" \/>/);
      expect(read(page), page).toContain('...repositorySourceFields(t, ');
    }
    // the LDAP directory's page : its Details tab's top, the record its page loaded
    const ldap = read('pages/admin/ldap-directory.vue');
    expect(ldap).toContain('<template #tab-top-details="{ record, searching, matches }">');
    expect(ldap).toContain(':record="record"');
    expect(read('components/AppAdminSingle.vue')).toContain(':matches="matches" :record="item"');
    expect(repositorySourceFields(t, { repository: null })).toEqual([]);
    expect(repositorySourceFields(t, { repository: 'ops', repo_file: 'runners/a.yaml' })[0]).toEqual([
      'source',
      'settings.repositories.source',
      'settings.repositories.sourceRepository {"name":"ops"}',
      'runners/a.yaml',
    ]);
  });
});

describe('what the question can and cannot know', () => {
  it('a new repository : what the remote already has wins, said once ; an existing one : not said', async () => {
    let answer = confirmUsageChange(t, 'ops', null, { use_for_schedules: 1, use_for_runners: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    let d = confirmPrompt.details;
    expect(d.filter((x) => x === 'settings.repositories.usageOnNewRepository {"name":"ops"}').length).toBe(1);
    answerConfirm(false);
    await answer;
    answer = confirmUsageChange(t, 'ops', { name: 'ops' }, { use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    d = confirmPrompt.details;
    expect(d.join(' ')).not.toContain('usageOnNewRepository');
    answerConfirm(false);
    await answer;
  });

  it('a preview that cannot be read : one line says so, no counts of nothing ; the save can still go on', async () => {
    axios.get.mockRejectedValueOnce(new Error('Network Error'));
    const answer = confirmUsageChange(t, 'ops', { use_for_runners: 1 }, { use_for_general: 1, use_for_schedules: 1 });
    await vi.waitFor(() => expect(confirmPrompt.open).toBe(true));
    const d = confirmPrompt.details;
    expect(d[0]).toBe('settings.repositories.usagePreviewFailed');
    expect(d.filter((x) => x.heading)).toEqual([]);
    const text = d.join(' ');
    for (const key of ['usageOnWrittenList', 'usageOnWrittenFile', 'usageOnReadFile', 'usageOnGitWins', 'usageOffKept'])
      expect(text).not.toContain(key);
    // what is true of every type is still said
    expect(d).toContain('settings.repositories.usageOnAfter');
    expect(d).toContain('settings.repositories.usageOffPull');
    answerConfirm(true);
    expect(await answer).toBe(true);
  });
});

describe('why an object stays in the app', () => {
  it('every reason in one sentence, translated by its code ; a schedule is never kept for its cron', () => {
    const lines = activationLines(t, 'schedules', 'ops', {
      written: [],
      kept: [
        { name: 'Empty', code: 'noSchedule', reason: 'it has no valid cron, rrule or one_time_run' },
        { name: 'Broken', code: 'notWritten', error: 'disk full', reason: 'not written: disk full' },
      ],
    });
    expect(lines).toContain(
      'settings.repositories.usageOnKept {"names":"Empty (settings.repositories.usageKeptWhy.noSchedule), ' +
        'Broken (settings.repositories.usageKeptWhy.notWritten {\\"error\\":\\"disk full\\"})"}',
    );
    expect(lines.join(' ')).not.toContain('it has no valid');
    expect(lines.join(' ')).not.toContain('schedulesOnKept');
  });

  it('every code the server gives has its words in every language', async () => {
    const dir = join(import.meta.dirname, '../../server/src/lib/repoObjects');
    const codes = new Set();
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/\bcode: "(\w+)"/g)) codes.add(m[1]);
      const reasons = text.match(/KEPT_REASONS = \{([^}]*)\}/);
      if (reasons) for (const m of reasons[1].matchAll(/^\s*(\w+):/gm)) codes.add(m[1]);
    }
    expect([...codes]).toEqual(expect.arrayContaining(['seed', 'holder', 'noSchedule', 'notWritten']));
    for (const lang of LANGS) {
      const why = (await import(`../src/locales/${lang}.js`)).default.settings.repositories.usageKeptWhy;
      for (const code of codes) expect(why[code], `${lang}: ${code}`).toBeTruthy();
      expect(why.notWritten, lang).toContain('{error}');
    }
  });
});

describe('what the files of a repository give, read in by the turn-on', () => {
  it('the question lists each file with its objects ; the toast says how many were read in', () => {
    const lines = activationLines(t, 'syslog', 'ops', {
      written: [],
      readIn: [
        { file: 'playbooks/sub/syslog.yml', names: ['s'] },
        { file: 'objects/syslog.yaml', names: ['central', 'backup'] },
      ],
    });
    expect(lines).toContain(
      'settings.repositories.usageOnReadIn {"files":"playbooks/sub/syslog.yml (s); objects/syslog.yaml (central, backup)"}',
    );
    expect(activationLines(t, 'syslog', 'ops', { written: [] }).join(' ')).not.toContain('usageOnReadIn');
    usageToast(t, { syslog: { activated: { pull: 'pulled', created: 3, written: [], matched: [], kept: [] } } });
    expect(toasts.at(-1)[1]).toContain('"created":3');
  });
});

describe("a schedule's launch options no field of its file gives", () => {
  it('are said kept in the app only, before the Schedules usage is turned on', () => {
    const lines = activationLines(t, 'schedules', 'ops', { written: ['Nightly'], appOnly: ['Nightly (__custom__)'] });
    expect(lines).toContain('settings.repositories.usageOnAppOnly {"names":"Nightly (__custom__)"}');
    expect(activationLines(t, 'schedules', 'ops', { written: ['Nightly'] }).join(' ')).not.toContain('usageOnAppOnly');
  });
});

describe('the types the app has one of : the chat, the settings, the Appearance pages', () => {
  it('say their file : the app written to it, or the one in git applied ; the one the preview names', () => {
    expect(activationLines(t, 'chat_assistant', 'cfg', { written: ['Chat assistant'] })[0]).toBe(
      'settings.repositories.usageOnWrittenFile {"type":"sidebar.chat","name":"cfg","file":"chat_assistant.yaml"}',
    );
    expect(
      activationLines(t, 'defaults', 'cfg', { written: [], clashes: ['Defaults'], file: 'look/site.yml' })[0],
    ).toBe('settings.repositories.usageOnReadFile {"type":"sidebar.defaults","name":"cfg","file":"look/site.yml"}');
  });

  it("the config seed's chat : said staying with the seed, by its type, no file said written or read", () => {
    const lines = activationLines(t, 'chat_assistant', 'cfg', {
      written: [],
      files: 0,
      kept: [{ name: 'Chat assistant', whole: true, code: 'seed', reason: 'managed by the config seed' }],
    });
    expect(lines.join(' ')).not.toContain('usageOnReadFile');
    expect(lines.join(' ')).not.toContain('usageOnWrittenFile');
    expect(lines).toContain(
      'settings.repositories.usageOnKept {"names":"sidebar.chat (settings.repositories.usageKeptWhy.seed)"}',
    );
  });

  it('their pages say which repository holds them, the record pages which file', async () => {
    const axios = (await import('axios')).default;
    // read with the settings (source_<type>), never from the repositories a part of the settings
    // on its own cannot read
    axios.get.mockImplementationOnce(async (url) => ({
      data: url === '/api/v2/settings/' ? { source_logo: { repository: 'cfg', repo_file: 'logo.yaml' } } : {},
    }));
    expect(await singleTypeSource('logo')).toEqual({ repository: 'cfg', repo_file: 'logo.yaml' });
    axios.get.mockImplementationOnce(async () => ({ data: { source_mcp: null } }));
    expect(await singleTypeSource('mcp')).toBeNull();
    expect(await singleTypeSource('forms')).toBeNull();
    for (const [page, type] of [
      ['pages/admin/chat.vue', 'chat_assistant'],
      ['pages/admin/settings.vue', 'general'],
      ['pages/admin/mcp.vue', 'mcp'],
      ['pages/admin/name.vue', 'name'],
      ['pages/admin/links.vue', 'links'],
      ['pages/admin/defaults.vue', 'defaults'],
      ['pages/admin/logo.vue', 'logo'],
      ['pages/admin/favicon.vue', 'icon'],
    ]) {
      expect(read(page), page).toMatch(new RegExp(`<AppRepositorySource [^>]*type="${type}" />`));
    }
    for (const page of ['pages/admin/announcement.vue', 'pages/admin/disclaimer-version.vue']) {
      expect(read(page), page).toContain('<AppRepositorySource v-show="fieldShown(\'source\')" :record="record" />');
    }
  });

  it("the settings page shows what the server says is its own (one list, the server's)", () => {
    const page = read('pages/admin/settings.vue');
    expect(page).toContain('if (matched.has(e.name) || e.ownedElsewhere) return false;');
    expect(page).not.toContain('const OWNED_ELSEWHERE');
  });
});

describe('the fields the config seed manages : read only on the Appearance pages', () => {
  it('reads the fields the seed manages, and says which a page has', async () => {
    const axios = (await import('axios')).default;
    axios.get.mockImplementationOnce(async () => ({ data: { seed_managed_fields: '["app_name","logo"]' } }));
    const { useSeedManaged } = await import('../src/composables/useSeedManaged.js');
    const { seeded, loadSeedManaged } = useSeedManaged();
    await loadSeedManaged();
    expect(seeded('app_name')).toBe(true);
    expect(seeded('default_theme', 'logo')).toBe(true);
    expect(seeded('icon')).toBe(false);
  });

  it('each page shows the notice and locks its seeded fields, a seeded image cannot be uploaded nor removed', () => {
    expect(read('pages/admin/name.vue')).toContain(`<fieldset :disabled="seeded('app_name')">`);
    expect(read('pages/admin/links.vue')).toContain(`:disabled="seeded('header_links')"`);
    expect(read('pages/admin/links.vue')).toContain(`<fieldset :disabled="seeded('show_designer')">`);
    for (const f of ['default_language', 'forms_view', 'default_timezone', 'default_date_format']) {
      expect(read('pages/admin/defaults.vue')).toContain(`<fieldset :disabled="seeded('${f}')">`);
    }
    for (const [page, field] of [
      ['pages/admin/logo.vue', 'logo'],
      ['pages/admin/favicon.vue', 'icon'],
    ]) {
      expect(read(page)).toContain(`:disabled="!selectedFile || busy || seeded('${field}')"`);
      expect(read(page)).toContain(`:disabled="busy || seeded('${field}')"`);
      expect(read(page)).toContain(`<AppSeedNotice v-if="seeded('${field}')" />`);
    }
    expect(read('components/AppSeedNotice.vue')).toContain("t('settings.common.seedManagedNotice')");
  });
});

describe('the Appearance pages : one type and one key each, in the menu order', () => {
  it('Defaults, Logo, Icon, Name each a one-only type the app has one of, named as the sidebar names it', () => {
    for (const [key, label] of [
      ['defaults', 'sidebar.defaults'],
      ['logo', 'sidebar.logo'],
      ['icon', 'sidebar.icon'],
      ['name', 'sidebar.name'],
    ]) {
      expect(USAGE_TYPES.find((u) => u.key === key)).toMatchObject({
        flag: `use_for_${key}`,
        single: true,
        labelKey: label,
        oneOnly: true,
        objects: true,
      });
      expect(server.typeOf(key)).toMatchObject({ flag: `use_for_${key}`, oneOnly: true, objects: true });
    }
    expect(USAGE_TYPES.some((u) => u.key === 'branding')).toBe(false);
  });

  it('the Appearance types follow the sidebar order, every one of its menu items a type', () => {
    const page = read('config/searchPages.js');
    const order = ['defaults', 'logo', 'icon', 'name', 'links', 'labels', 'announcements'];
    const at = order.map((k) => page.indexOf(`'/settings/${k}'`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(typesOf('appearance').map((u) => u.key)).toEqual(order);
    expect(server.APPLY_ORDER.filter((k) => order.includes(k))).toEqual(order);
    expect(APPLY_ORDER.filter((k) => order.includes(k))).toEqual(order);
  });
});

describe('the header links : their own type, after Name', () => {
  it('Links is a type of Appearance the app has one of, after Name, in both lists and the apply order', () => {
    const appearance = typesOf('appearance').map((u) => u.key);
    expect(appearance).toEqual(['defaults', 'logo', 'icon', 'name', 'links', 'labels', 'announcements']);
    expect(server.USAGE_TYPES.filter((u) => u.category === 'appearance').map((u) => u.key)).toEqual(appearance);
    expect(USAGE_TYPES.find((u) => u.key === 'links')).toMatchObject({
      single: true,
      oneOnly: true,
      objects: true,
    });
    expect(server.APPLY_ORDER.indexOf('links')).toBe(server.APPLY_ORDER.indexOf('name') + 1);
    expect(read('pages/admin/links.vue')).toContain('<AppRepositorySource v-show="!searching" type="links" />');
  });

  it('the Usage step names Notifications and Links as their menu items do', () => {
    const tt = (key) => key;
    expect(usageBadges(tt, { use_for_notifications: 1, use_for_links: 1 })).toBe(
      '<span class="badge af-usage-badge me-1">sidebar.links</span>' +
        '<span class="visually-hidden">, </span>' +
        '<span class="badge af-usage-badge me-1">sidebar.notifications</span>',
    );
  });
});

describe('the MCP settings : one mcp: map, in Connections', () => {
  it('between Chat assistant and Syslog, named as its menu item, applied with the independent types', () => {
    expect(USAGE_TYPES.find((u) => u.key === 'mcp')).toMatchObject({
      flag: 'use_for_mcp',
      category: 'connections',
      labelKey: 'sidebar.mcp',
      single: true,
      oneOnly: true,
      objects: true,
    });
    expect(server.APPLY_ORDER.at(-1)).toBe('mcp');
    expect(
      activationLines(t, 'mcp', 'cfg', { written: ['MCP'], kept: [{ name: 'MCP_READ_ONLY', code: 'seed' }] }),
    ).toEqual(
      expect.arrayContaining([
        'settings.repositories.usageOnKept {"names":"MCP_READ_ONLY (settings.repositories.usageKeptWhy.seed)"}',
      ]),
    );
    // its page : the repository line, the seed's switches read only
    const page = read('pages/admin/mcp.vue');
    expect(page).toContain('<AppRepositorySource v-show="!searching" type="mcp" />');
    expect(page).toContain(':disabled="seeded(e.name) || (e.name !== \'ENABLE_MCP\' && !mcpOn)"');
  });

  it('its hint in every language ; Settings named General, as its menu item, under its general: key', async () => {
    const tt = (key) => key;
    expect(usageBadges(tt, { use_for_general: 1, use_for_mcp: 1 })).toBe(
      '<span class="badge af-usage-badge me-1">sidebar.ansibleForms</span>' +
        '<span class="visually-hidden">, </span>' +
        '<span class="badge af-usage-badge me-1">sidebar.mcp</span>',
    );
    expect(usageLabel(tt, 'general')).toBe('sidebar.ansibleForms');
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      expect(r.usageHints.mcp, lang).toContain('mcp:');
      expect(r.usageHints.general, lang).toContain('general:');
      expect(r.usageTypes.settings, lang).toBeUndefined();
    }
  });
});

describe('the keys follow the types', () => {
  it('Chat assistant under chat_assistant:, Notifications under notifications:, as on both sides', async () => {
    expect(USAGE_TYPES.find((u) => u.key === 'chat_assistant')).toMatchObject({
      flag: 'use_for_chat_assistant',
      labelKey: 'sidebar.chat',
      single: true,
    });
    expect(USAGE_TYPES.find((u) => u.key === 'notifications')).toMatchObject({
      flag: 'use_for_notifications',
      labelKey: 'sidebar.notifications',
    });
    // no file name nor folder of their own : read by their content
    for (const u of USAGE_TYPES) expect([u.file, u.folder, u.list], u.key).toEqual([undefined, undefined, undefined]);
    // the same key on both sides, a list type or one the app has one of alike
    for (const u of USAGE_TYPES.filter((x) => x.objects)) expect(!!server.typeOf(u.key).single, u.key).toBe(!!u.single);
    expect(server.USAGE_FLAGS).toEqual(expect.arrayContaining(['use_for_chat_assistant', 'use_for_notifications']));
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      // each hint names the key its files give, never a file name nor a folder
      for (const u of USAGE_TYPES.filter((x) => x.objects || ['roles', 'categories', 'constants'].includes(x.key))) {
        expect(r.usageHints[u.key], `${lang}: ${u.key}`).toContain(`${u.key}:`);
        expect(r.usageHints[u.key], `${lang}: ${u.key}`).not.toMatch(/\b[\w-]+\.yaml\b(?<!config\.yaml)/);
      }
      expect(r.usageHints.chat, lang).toBeUndefined();
      expect(r.usageHints.notification_channels, lang).toBeUndefined();
    }
  });
});

describe('the repositories : entries of a repositories: list', () => {
  it('first of Connections, named as its menu item, its question says the file they go to', () => {
    expect(USAGE_TYPES.find((u) => u.key === 'repositories')).toMatchObject({
      labelKey: 'sidebar.repositories',
      oneOnly: true,
    });
    expect(
      activationLines(t, 'repositories', 'hub', {
        written: ['a', 'b'],
        kept: [{ name: 'hub', code: 'holder' }],
        file: 'repositories.yaml',
      }),
    ).toEqual(
      expect.arrayContaining([
        'settings.repositories.usageOnWrittenList {"type":"sidebar.repositories","name":"hub","file":"repositories.yaml","count":2}',
        'settings.repositories.usageOnKept {"names":"hub (settings.repositories.usageKeptWhy.holder)"}',
      ]),
    );
    expect(read('pages/admin/repository.vue')).toContain(
      '<AppRepositorySource v-show="fieldShown(\'source\')" :record="repo" />',
    );
  });
});

describe('a form name defined in two forms repositories', () => {
  it("each repository's page says which copy is used and which skipped, in every language", async () => {
    const page = read('pages/admin/repository.vue');
    expect(page).toContain('v-for="d in repo.formDuplicates || []"');
    expect(page).toContain(
      "t('settings.repositories.formDuplicate', { name: d.name, used: d.used.place, skipped: d.skipped.place })",
    );
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      for (const p of ['{name}', '{used}', '{skipped}']) expect(r.formDuplicate, lang).toContain(p);
    }
  });
  it('one warning per duplicate, two in one file included : each keyed on its name and its place', () => {
    const page = read('pages/admin/repository.vue');
    const loop = page.slice(page.indexOf('v-for="d in repo.formDuplicates'));
    expect(loop.slice(0, loop.indexOf('>'))).toContain(':key="`${d.name}|${d.skipped.place}`"');
  });
});

describe('the New repository dialog', () => {
  // its usage step lists every category with each type's description : the default dialog
  // width wrapped them, so that step widens it ; the other steps keep the default width
  it('is the large dialog, the extra large one on its usage step only', () => {
    expect(settings.repositories.dialogSize).toBeUndefined();
    const sizes = Object.fromEntries(settings.repositories.steps.map((s) => [s.key, s.dialogSize]));
    expect(sizes).toEqual({ repository: undefined, credentials: undefined, usage: 'xl', schedule: undefined });
    const multi = readFileSync(join(import.meta.dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
    expect(multi).toMatch(
      /steps\.value\[stepIndex\.value\]\?\.dialogSize\) \|\| props\.settings\.dialogSize \|\| 'lg'/,
    );
    expect(multi).toMatch(/:size="dialogSize"/);
  });
});
