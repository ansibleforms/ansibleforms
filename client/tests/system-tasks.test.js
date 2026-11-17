// Jobs > System : the app's own maintenance tasks (the job retention, the nightly backup, the
// expired tokens ...), under Future after Scheduled and Stored, for an admin only (the route's
// showSettings, the api's guard). The list is the scheduled jobs' table, a row opening the task's
// page : Details, Schedule then Runs, a nightly task's cron changed on its Schedule tab as a
// schedule's (its editor, Save and Revert). Read from the sources and the config, as the other page
// tests do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';
import { routePermission, mayOpen } from '@/lib/routePermission';
import getSettings from '@/config/settings';
import i18n from '@/plugins/i18n';
import { taskName, taskDescription, taskTiming, taskTimingCell, runDuration } from '@/lib/systemTasks';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const sidebar = read('src/components/AppJobsSidebar.vue');
const page = withoutComments(read('src/pages/system-task.vue'));
const LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
// the tasks the server declares (server/src/lib/systemTasks.js SYSTEM_TASKS)
const serverTasks = read('../server/src/lib/systemTasks.js');
const TASK_KEYS = [...serverTasks.matchAll(/^ {4}key: '(\w+)',$/gm)].map((m) => m[1]);
// a translate function that answers the key, so a test sees which text was asked for
const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe('the Jobs menu', () => {
  it('has System under Future, after Scheduled and Stored, with a count', () => {
    const future = sidebar.slice(sidebar.indexOf('const future = ['), sidebar.indexOf('].filter'));
    const links = [...future.matchAll(/link: '([^']+)'/g)].map((m) => m[1]);
    expect(links).toEqual(['/jobs/scheduled', '/jobs/stored', '/jobs/system']);
    expect(future).toMatch(/title: t\('jobs\.menu\.system'\),\s*icon: 'gears',/);
    expect(future).toMatch(/badge: futureCounts\.value\.system,/);
    // the count : the tasks the api lists
    expect(sidebar).toMatch(/read\('\/jobs\/system', '\/api\/v2\/system\/tasks'\)/);
  });

  it('shows it to an admin only : the route asks for the settings, as the api', () => {
    expect(routePermission('/jobs/system')).toBe('showSettings');
    expect(routePermission('/jobs/system/jobCleanup')).toBe('showSettings');
    expect(routePermission('/jobs/system/jobCleanup/runs')).toBe('showSettings');
    expect(mayOpen('/jobs/system', { showSettings: true })).toBe(true);
    expect(mayOpen('/jobs/system', { showJobs: true, allowScheduledJobs: true, allowStoredJobs: true })).toBe(false);
    expect(mayOpen('/jobs/system', {})).toBe(false);
  });
});

describe('the list', () => {
  const list = getSettings(t).system_tasks;

  it('reads the tasks by their key, and opens a task on its page', () => {
    expect(list.type).toBe('system/tasks');
    expect(list.idKey).toBe('key');
    expect(list.openPage({ key: 'jobCleanup' })).toBe('/jobs/system/jobCleanup');
  });

  it('is read only : no Add, no row menu, nothing to tick', () => {
    expect(list.noCreate).toBe(true);
    expect(list.actions).toEqual([]);
    expect(list.selectable).toBe(false);
  });

  it("has the scheduled jobs' columns : name, when it runs, last run, status, next run", () => {
    const shown = list.fields.filter((f) => !f.hidden).map((f) => f.key);
    expect(shown).toEqual(['name', 'cron', 'last_run', 'status', 'next_run']);
  });

  it('says when a task runs in words, its cron on hover', () => {
    const cron = list.fields.find((f) => f.key === 'cron');
    const cell = cron.render('30 2 * * *', { key: 'jobCleanup', cron: '30 2 * * *', enabled: true });
    expect(cell).toMatch(/data-af-popover="30 2 \* \* \*"/);
    expect(cell).toMatch(/02:30/);
  });

  it("shows how the last run went as a schedule's pill, a dash when it never ran", () => {
    const status = list.fields.find((f) => f.key === 'status');
    expect(status.render(undefined, { last_run: { outcome: 'success' } })).toMatch(/af-pill-green/);
    expect(status.render(undefined, { last_run: { outcome: 'failed' } })).toMatch(/af-pill-red/);
    expect(status.render(undefined, { last_run: null })).toMatch(/af-pill-empty/);
  });
});

describe('a task in words', () => {
  it('its name and description from the locales by its key, the server words for an unknown key', () => {
    const tr = i18n.global.t;
    expect(taskName(tr, { key: 'jobCleanup', name: 'Server name' })).toBe('Job cleanup');
    expect(taskDescription(tr, { key: 'jobCleanup' })).toMatch(/finished jobs/);
    expect(taskName(tr, { key: 'notATask', name: 'Server name' })).toBe('Server name');
  });

  it('when it runs : its cron in words, every so many seconds, or off', () => {
    expect(taskTiming(t, { cron: '0 * * * *', enabled: true }, 'en')).toBe('Every hour');
    expect(taskTiming(t, { cron: null, interval_seconds: 60, enabled: true })).toBe(
      'jobs.system.everySeconds {"n":60}',
    );
    expect(taskTiming(t, { cron: null, interval_seconds: 60, enabled: false })).toBe('jobs.system.off');
    expect(taskTimingCell(t, { cron: null, interval_seconds: 60, enabled: false })).not.toMatch(/popover/);
  });

  it('how long a run took : milliseconds under a second, else as a job', () => {
    expect(runDuration(5)).toBe('5 ms');
    expect(runDuration(2500)).toBe('3s');
    expect(runDuration(125000)).toBe('2m 05s');
    expect(runDuration(null)).toBe('–');
  });
});

describe("a task's page", () => {
  it('reads the task with its runs', () => {
    expect(page).toMatch(/axios\.get\(`\/api\/v2\/system\/tasks\/\$\{encodeURIComponent\(taskKey\.value\)\}`\)/);
  });

  it('has Details, Schedule then Runs, the runs counted on their tab', () => {
    const keys = [...page.slice(page.indexOf('const tabs = computed')).matchAll(/\{ key: '(\w+)', label:/g)]
      .slice(0, 3)
      .map((m) => m[1]);
    expect(keys).toEqual(['details', 'schedule', 'runs']);
    expect(page).toMatch(
      /key: 'runs', label: t\('jobs\.system\.tabRuns'\), icon: 'history', count: runs\.value\.length/,
    );
  });

  it('starts its Details with the name, then the description, then the facts, each label bold', () => {
    const details = page.slice(
      page.indexOf('v-if="tabShown(\'details\')"'),
      page.indexOf('v-if="tabShown(\'schedule\')"'),
    );
    const order = [...details.matchAll(/fieldShown\('(\w+)'\)/g)].map((m) => m[1]);
    expect(order).toEqual(['name', 'description', 'lastLaunch', 'result', 'lastRun', 'nextRun', 'setting']);
    expect((details.match(/class="form-label fw-bold"/g) || []).length).toBe(5);
  });

  it('shows on its Schedule tab, for the tasks the app times, when it runs and its next three runs, read only', () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'schedule\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));
    const fixed = tab.slice(tab.indexOf('<template v-else>'));
    expect([...fixed.matchAll(/fieldShown\('(\w+)'\)/g)].map((m) => m[1])).toEqual(['timing', 'nextRuns']);
    expect(fixed).not.toMatch(/<input|<select|v-model|BsCron/);
  });

  it("splits its last run as a schedule's page : the badge with its error on hover, then the date", () => {
    expect(page).toMatch(
      /<span :title="launchError \|\| undefined" v-html="statusPill\(t, lastRun\?\.outcome\)"><\/span>/,
    );
    expect(page).toMatch(/lastRun\.value\?\.outcome === 'failed' \? lastRun\.value\.result/);
    expect(page).toMatch(/\{\{ lastRun\?\.started_at \? Helpers\.formatServerDate\(lastRun\.started_at\) : '–' \}\}/);
  });

  it("has the Scheduled list's columns in its order : Last run, Status, Next run", () => {
    const list = getSettings(t).system_tasks.fields.map((f) => f.key);
    expect(list.slice(list.indexOf('last_run'))).toEqual(['last_run', 'status', 'next_run']);
  });

  it('says where its setting is changed, or that the environment sets it', () => {
    expect(page).toMatch(/<router-link v-if="setting\.editable && setting\.link" :to="setting\.link">/);
    expect(page).toMatch(/t\('jobs\.system\.settingEnv'\)/);
  });

  it("has no Delete, and edits nothing but a nightly task's cron", () => {
    expect(page).not.toMatch(/icon="trash"/);
    expect(page).not.toMatch(/axios\.(post|delete)/);
    expect([...page.matchAll(/v-model="(\w+)"/g)].map((m) => m[1]).sort()).toEqual(['cronEdit', 'search']);
  });

  it('lists the runs in the linked table of the other Runs tabs, a row opening nothing', () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'runs\')"'));
    expect(tab).toMatch(/<AppLinkedTable/);
    expect(tab).not.toMatch(/:to=/);
    expect(tab).toMatch(/<template #cell-outcome="\{ row \}"><AppStatusPill :status="row\.outcome" \/><\/template>/);
  });
});

describe("a nightly task's Schedule tab", () => {
  const tab = page.slice(page.indexOf('v-if="tabShown(\'schedule\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));
  // each task's declaration on the server, by its key ; the nightly ones have a schedule setting
  const declared = serverTasks
    .split(/^ {4}key: '/m)
    .slice(1)
    .map((chunk) => ({ key: chunk.slice(0, chunk.indexOf("'")), schedule: /schedule: scheduleSetting\(/.test(chunk) }));
  const NIGHTLY = declared.filter((d) => d.schedule).map((d) => d.key);

  it('the five nightly tasks have a cron setting, the tasks the app needs often none', () => {
    expect(NIGHTLY.sort()).toEqual([
      'auditCleanup',
      'jobCleanup',
      'nightlyBackup',
      'storedJobsCleanup',
      'tokenCleanup',
    ]);
    const fixed = declared
      .filter((d) => !d.schedule)
      .map((d) => d.key)
      .sort();
    expect(fixed).toEqual(['abandonedJobs', 'configSeedReload', 'deadNodes', 'scheduleEnds']);
  });

  it("shows a nightly task's cron in a schedule's editor, no line under it while it may be changed", () => {
    expect(page).toMatch(/const scheduleOwned = computed\(\(\) => !!task\.value\?\.schedule_env\);/);
    expect(tab).toMatch(/<div v-if="scheduleOwned" v-show="fieldShown\('cron'\)" class="af-system-cron mb-0">/);
    expect(tab).toMatch(
      /<BsCron v-model="cronEdit" icon="stopwatch" :hasError="!!cronError" :disabled="!scheduleEditable" \/>/,
    );
    // a line only for its error, or when the environment sets it
    expect(tab).toMatch(/<div v-if="cronError" class="invalid-feedback d-block">/);
    expect(tab).toMatch(/<div v-else-if="!scheduleEditable" class="form-text">/);
    // a schedule's own editor, the same width
    const schedule = withoutComments(read('src/pages/schedule.vue'));
    expect(schedule).toMatch(/<BsCron\s+v-model="edit\.cron"\s+icon="stopwatch"/);
    expect(page).toMatch(/\.af-system-cron \{\s*max-width: 40rem;/);
  });

  it('pinned by the environment : the editor read only, one line naming the variable', () => {
    expect(page).toMatch(
      /const scheduleEditable = computed\(\(\) => scheduleOwned\.value && !!task\.value\?\.editable_schedule\);/,
    );
    expect(tab).toMatch(/t\('jobs\.system\.scheduleEnv', \{ env: task\.schedule_env \}\)/);
    // no Save, no Revert then
    expect(page).toMatch(/<template v-if="task && scheduleEditable" #actions>/);
  });

  it('BsCron greys out every preset, field and the expression when disabled', () => {
    const cron = read('src/components/BsCron.vue');
    expect(cron).toMatch(/disabled: \{ type: Boolean, default: false \}/);
    expect(cron).toMatch(/<fieldset :disabled="disabled">/);
  });

  it('saves with Save, orange while changed, undoes with Revert, and asks before leaving', () => {
    const actions = page.slice(page.indexOf('#actions>'), page.indexOf('</AppSettings>'));
    expect(actions).toMatch(/<BsButton icon="clock-rotate-left" :disabled="!dirty" @click="revert\(\)">/);
    // the save icon : orange while enabled (BsButton), grey while nothing changed
    expect(actions).toMatch(/<BsButton icon="save" :disabled="!dirty" @click="save\(\)">/);
    expect(actions.indexOf('revert()')).toBeLessThan(actions.indexOf('save()'));
    expect(page).toMatch(/useUnsavedGuard\(\s*dirty,/);
    expect(page).toMatch(
      /axios\.put\(`\/api\/v2\/system\/tasks\/\$\{encodeURIComponent\(taskKey\.value\)\}\/schedule`, \{\s*cron: cronEdit\.value\.trim\(\),/,
    );
  });

  it('reads the task again after a save : its last run, next run and next runs follow', () => {
    const save = page.slice(page.indexOf('async function save()'), page.indexOf('function revert()'));
    expect(save).toMatch(/await axios\.put[\s\S]*await load\(\);/);
    expect(page).toMatch(/cronEdit\.value = task\.value\?\.cron \|\| '';\s*loaded\.value = true;/);
  });

  it('refuses a cron of other than 5 fields before sending it, as the server does', () => {
    expect(page).toMatch(/\.length !== 5\) return t\('jobs\.system\.cronFiveFields'\)/);
  });
});

describe('the texts', () => {
  it('the server declares the tasks the locales name', () => {
    expect(TASK_KEYS.length).toBeGreaterThanOrEqual(9);
  });

  it('every language names each task and says what it does, on one line', async () => {
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default;
      const wide = ['ja', 'zh'].includes(lang) ? 2 : 1;
      expect(texts.jobs.menu.system, lang).toBeTruthy();
      for (const key of TASK_KEYS) {
        const task = texts.jobs.system.tasks[key];
        expect(task?.name, `${lang} ${key}`).toBeTruthy();
        expect(task.name.length * wide, `${lang} ${key}`).toBeLessThanOrEqual(34);
        expect(task.description.length * wide, `${lang} ${key}`).toBeLessThanOrEqual(90);
      }
      for (const key of [
        'description',
        'timing',
        'result',
        'setting',
        'settingChange',
        'settingEnv',
        'noRuns',
        'cronFiveFields',
      ]) {
        expect(texts.jobs.system[key], `${lang} ${key}`).toBeTruthy();
        expect(texts.jobs.system[key].length * wide, `${lang} ${key}`).toBeLessThanOrEqual(90);
      }
      // the line under the editor, its variable's name in it (the longest : STORED_JOB_CLEANUP_CRON)
      const pinned = texts.jobs.system.scheduleEnv.replace('{env}', 'STORED_JOB_CLEANUP_CRON');
      expect(texts.jobs.system.scheduleEnv, lang).toMatch(/\{env\}/);
      expect(pinned.length * wide, lang).toBeLessThanOrEqual(90);
      // a toolbar button : a word or two
      expect(texts.jobs.system.revert.length * wide, lang).toBeLessThanOrEqual(14);
    }
  });
});
