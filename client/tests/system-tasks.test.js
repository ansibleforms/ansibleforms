// Jobs > System : the app's own maintenance tasks (the job retention, the nightly backup, the
// expired tokens ...), under Future after Scheduled and Stored, for an admin only (the route's
// showSettings, the api's guard). The list is the scheduled jobs' table, a row opening the task's
// page ; the page is read only, Details then Runs. Read from the sources and the config, as the
// other page tests do.
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

  it('has Details then Runs, the runs counted on their tab', () => {
    const keys = [...page.slice(page.indexOf('const tabs = computed')).matchAll(/\{ key: '(\w+)', label:/g)]
      .slice(0, 2)
      .map((m) => m[1]);
    expect(keys).toEqual(['details', 'runs']);
    expect(page).toMatch(
      /key: 'runs', label: t\('jobs\.system\.tabRuns'\), icon: 'history', count: runs\.value\.length/,
    );
  });

  it('starts its Details with the name, then the description, then the facts, each label bold', () => {
    const details = page.slice(page.indexOf('v-if="tabShown(\'details\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));
    const order = [...details.matchAll(/fieldShown\('(\w+)'\)/g)].map((m) => m[1]);
    expect(order).toEqual(['name', 'description', 'timing', 'lastLaunch', 'result', 'lastRun', 'nextRun', 'setting']);
    expect((details.match(/class="form-label fw-bold"/g) || []).length).toBe(6);
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

  it('is read only : no Save, no Delete, no field to edit', () => {
    expect(page).not.toMatch(/#actions/);
    expect(page).not.toMatch(/axios\.(put|post|delete)/);
    expect(page).not.toMatch(/v-model="(?!search)/);
  });

  it('lists the runs in the linked table of the other Runs tabs, a row opening nothing', () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'runs\')"'));
    expect(tab).toMatch(/<AppLinkedTable/);
    expect(tab).not.toMatch(/:to=/);
    expect(tab).toMatch(/<template #cell-outcome="\{ row \}"><AppStatusPill :status="row\.outcome" \/><\/template>/);
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
      for (const key of ['description', 'timing', 'result', 'setting', 'settingChange', 'settingEnv', 'noRuns']) {
        expect(texts.jobs.system[key], `${lang} ${key}`).toBeTruthy();
        expect(texts.jobs.system[key].length * wide, `${lang} ${key}`).toBeLessThanOrEqual(90);
      }
    }
  });
});
