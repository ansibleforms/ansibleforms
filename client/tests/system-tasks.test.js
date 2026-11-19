// Jobs > System : the app's own maintenance tasks (the job retention, the nightly backup, the
// expired tokens ...), under Future after Scheduled and Stored, for an admin only (the route's
// showSettings, the api's guard). The list is the scheduled jobs' table, a row opening the task's
// page : Details, Schedule then Runs, every task's cron changed on its Schedule tab as a
// schedule's (its editor and Save, no Revert as the other record pages), the config seed reload's too, whose cron may still come
// from its deprecated seconds (CONFIG_SEED_RELOAD_SECONDS). The runner hub's own loops are listed
// too, read only : every so many seconds, one line saying why. Run now runs a task once, as a
// schedule's page, and a loop's pass. Read from the sources and the config, as the other page tests do.
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
// the runner hub's loops among them (HUB_LOOPS), declared after the tasks
const LOOP_KEYS = ['runnerDispatch', 'runnerDial', 'runnerPrune'];
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

  it('when it runs : its cron in words, a runner hub loop every so many seconds, or off', () => {
    expect(taskTiming(t, { cron: '0 * * * *', enabled: true }, 'en')).toBe('Every hour');
    expect(taskTiming(t, { cron: null, interval_seconds: 2, enabled: true })).toBe('jobs.system.everySeconds {"n":2}');
    expect(taskTiming(i18n.global.t, { cron: null, interval_seconds: 10, enabled: true })).toBe('Every 10 seconds');
    expect(taskTiming(t, { cron: '* * * * *', enabled: false })).toBe('jobs.system.off');
    expect(taskTimingCell(t, { cron: null, interval_seconds: 2, enabled: true })).not.toMatch(/popover/);
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
    expect(order).toEqual(['name', 'description', 'lastLaunch', 'result', 'lastRun', 'nextRun', 'node', 'setting']);
    expect((details.match(/class="form-label fw-bold"/g) || []).length).toBe(6);
  });

  it("shows on its Schedule tab the editor, or a runner hub loop's seconds read only with one line", () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'schedule\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));
    expect([...tab.matchAll(/fieldShown\('(\w+)'\)/g)].map((m) => m[1])).toEqual(['timing', 'cron']);
    expect(page).toMatch(/const isLoop = computed\(\(\) => !!task\.value && !task\.value\.schedule_env\);/);
    const loop = tab.slice(tab.indexOf('<div v-if="isLoop"'), tab.indexOf('<div v-else'));
    expect(loop).toMatch(/<div class="form-text">\{\{ t\('jobs\.system\.hubLoopHint'\) \}\}<\/div>/);
    expect(loop).not.toMatch(/<input|<select|v-model|BsCron/);
    expect(page).not.toMatch(/scheduleOwned|nextRunsLabel/);
  });

  it("names the node whose memory a runner hub loop's last run comes from", () => {
    expect(page).toMatch(/<div v-if="isLoop" v-show="fieldShown\('node'\)" class="mb-3">/);
    expect(page).toMatch(/\{\{ task\.loop\?\.node \|\| '–' \}\}/);
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

  it("has no Delete, and edits nothing but the task's cron", () => {
    expect(page).not.toMatch(/icon="trash"/);
    expect(page).not.toMatch(/axios\.delete/);
    // its one post : Run now
    expect([...page.matchAll(/axios\.post\(`([^`]+)`/g)].map((m) => m[1])).toEqual([
      '/api/v2/system/tasks/${encodeURIComponent(taskKey.value)}/run',
    ]);
    expect([...page.matchAll(/v-model="(\w+)"/g)].map((m) => m[1]).sort()).toEqual(['cronEdit', 'search']);
  });

  it('lists the runs in the linked table of the other Runs tabs, a row opening nothing', () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'runs\')"'));
    expect(tab).toMatch(/<AppLinkedTable/);
    expect(tab).not.toMatch(/:to=/);
    expect(tab).toMatch(/<template #cell-outcome="\{ row \}"><AppStatusPill :status="row\.outcome" \/><\/template>/);
  });
});

describe("a task's Schedule tab", () => {
  const tab = page.slice(page.indexOf('v-if="tabShown(\'schedule\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));
  // each task's declaration on the server, by its key ; each has a schedule setting
  const declared = serverTasks
    .split(/^ {4}key: '/m)
    .slice(1)
    .map((chunk) => ({ key: chunk.slice(0, chunk.indexOf("'")), schedule: /schedule: scheduleSetting\(/.test(chunk) }));

  it("every task has a cron setting ; the runner hub's loops none, the one exception", () => {
    expect(declared.filter((d) => d.schedule).map((d) => d.key)).toEqual(
      TASK_KEYS.filter((k) => !LOOP_KEYS.includes(k)),
    );
    expect(declared.filter((d) => !d.schedule).map((d) => d.key)).toEqual(LOOP_KEYS);
  });

  it("shows the task's cron in a schedule's editor, no line under it while it may be changed", () => {
    expect(tab).toMatch(/<div v-else v-show="fieldShown\('cron'\)" class="af-system-cron mb-0">/);
    expect(tab).toMatch(
      /<BsCron v-model="cronEdit" icon="stopwatch" :hasError="!!cronError" :disabled="!scheduleEditable" \/>/,
    );
    // a line only for its error, or when the environment sets it
    expect(tab).toMatch(/<div v-if="cronError" class="invalid-feedback d-block">/);
    expect(tab).toMatch(/<div v-else-if="deprecated" class="form-text af-schedule-deprecated">/);
    expect(tab).toMatch(/<div v-else-if="!scheduleEditable" class="form-text">/);
    // a schedule's own editor, the same width
    const schedule = withoutComments(read('src/pages/schedule.vue'));
    expect(schedule).toMatch(/<BsCron\s+v-model="edit\.cron"\s+icon="stopwatch"/);
    expect(page).toMatch(/\.af-system-cron \{\s*max-width: 40rem;/);
  });

  it('pinned by the environment : the editor read only, one line naming the variable', () => {
    expect(page).toMatch(
      /const scheduleEditable = computed\(\(\) => !!task\.value\?\.schedule_env && !!task\.value\?\.editable_schedule\);/,
    );
    expect(tab).toMatch(/t\('jobs\.system\.scheduleEnv', \{ env: task\.schedule_env \}\)/);
    // no Save then, Run now still
    expect(page).toMatch(/<template v-if="task" #actions>/);
    expect(page).toMatch(/<BsButton v-if="scheduleEditable" icon="save" :disabled="!canSave" @click="save\(\)">/);
  });

  it('BsCron greys out every preset, field and the expression when disabled', () => {
    const cron = read('src/components/BsCron.vue');
    expect(cron).toMatch(/disabled: \{ type: Boolean, default: false \}/);
    expect(cron).toMatch(/<fieldset :disabled="disabled">/);
  });

  it('saves with Save, orange while changed, no Revert as the other record pages, and asks before leaving', () => {
    const actions = page.slice(page.indexOf('#actions>'), page.indexOf('</AppSettings>'));
    expect(actions).not.toMatch(/revert|clock-rotate-left/);
    expect(page).not.toMatch(/function revert\(/);
    // the save icon : orange while enabled (BsButton), grey while nothing changed
    expect(actions).toMatch(/icon="save" :disabled="!canSave" @click="save\(\)">/);
    expect(page).toMatch(/useUnsavedGuard\(\s*dirty,/);
    expect(page).toMatch(
      /axios\.put\(`\/api\/v2\/system\/tasks\/\$\{encodeURIComponent\(taskKey\.value\)\}\/schedule`, \{\s*cron: cronEdit\.value\.trim\(\),/,
    );
  });

  it('reads the task again after a save : its last run, next run and next runs follow', () => {
    const save = page.slice(page.indexOf('async function save()'), page.indexOf('const runAsked'));
    expect(save).toMatch(/await axios\.put[\s\S]*await load\(\);/);
    expect(page).toMatch(/cronEdit\.value = task\.value\?\.cron \|\| '';\s*loaded\.value = true;/);
  });

  it('refuses a cron of other than 5 fields before sending it, as the server does', () => {
    expect(page).toMatch(/\.length !== 5\) return t\('jobs\.system\.cronFiveFields'\)/);
    const save = page.slice(page.indexOf('async function save()'), page.indexOf('const runAsked'));
    expect(save).toMatch(/if \(cronProblem\.value\) \{\s*toast\.warning\(cronProblem\.value\);\s*return false;/);
  });
});

describe("the config seed reload's Schedule tab, its cron from the deprecated seconds", () => {
  const tab = page.slice(page.indexOf('v-if="tabShown(\'schedule\')"'), page.indexOf('v-if="tabShown(\'runs\')"'));

  it('is editable as the others : its cron setting is CONFIG_SEED_RELOAD_CRON, every minute by default', () => {
    const seed = serverTasks.slice(serverTasks.indexOf("key: 'configSeedReload'"));
    expect(seed).toMatch(/cron: '\* \* \* \* \*',/);
    expect(seed).toMatch(/schedule: scheduleSetting\('CONFIG_SEED_RELOAD_CRON', 'configSeedReloadCron', \{/);
    expect(seed).toMatch(/env: 'CONFIG_SEED_RELOAD_SECONDS',/);
  });

  it('shows the cron the deprecated variable reads as, one line naming it', () => {
    expect(page).toMatch(/const deprecated = computed\(\(\) => task\.value\?\.schedule_deprecated \|\| null\);/);
    expect(tab).toMatch(/t\('jobs\.system\.scheduleDeprecated', \{ env: deprecated\.env \}\)/);
    // the editor holds the cron in force (6 fields for seconds) : no error until it is changed
    expect(page).toMatch(/const cronError = computed\(\(\) => \(dirty\.value \? cronProblem\.value : ''\)\);/);
  });

  it('Save writes it as the new variable : enabled for its cron unchanged when it has 5 fields', () => {
    expect(page).toMatch(
      /const canSave = computed\(\(\) => dirty\.value \|\| \(scheduleEditable\.value && !!deprecated\.value && !cronProblem\.value\)\);/,
    );
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
      // the line of a cron read from a deprecated variable, its name in it, on one line : the CJK
      // characters twice as wide as the variable's
      const old = texts.jobs.system.scheduleDeprecated;
      expect(old, lang).toMatch(/\{env\}/);
      const shown = old.replace('{env}', 'CONFIG_SEED_RELOAD_SECONDS');
      const width = [...shown].reduce((w, c) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
      expect(width, lang).toBeLessThanOrEqual(90);
      // a runner hub loop's timing, and the line of its Schedule tab, on one line
      expect(texts.jobs.system.everySeconds, lang).toMatch(/\{n\}/);
      const hint = texts.jobs.system.hubLoopHint;
      const hintWidth = [...hint].reduce((w, c) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
      expect(hintWidth, lang).toBeLessThanOrEqual(90);
      // Revert is gone, as from the other record pages
      expect(texts.jobs.system.revert, lang).toBeUndefined();
      // Run now's toasts, on one line : a task's name and a short result in them
      for (const key of ['runDone', 'runFailed', 'runStarted', 'runSucceeded']) {
        const text = texts.jobs.system[key];
        expect(text, `${lang} ${key}`).toMatch(/\{name\}/);
        if (key === 'runDone' || key === 'runFailed') expect(text, `${lang} ${key}`).toMatch(/\{result\}/);
        const shown = text.replace('{name}', 'Stored jobs cleanup').replace('{result}', 'Removed 2 jobs');
        expect(shown.length * wide, `${lang} ${key}`).toBeLessThanOrEqual(90);
      }
      // the button : the schedules' Run now, a word or two
      expect(texts.settings.schedules.runSchedule.length * wide, lang).toBeLessThanOrEqual(20);
      // the audit labels of a run
      expect(texts.audit.actionLabels.system_task_run, lang).toBeTruthy();
      expect(texts.audit.actionLabels.system_tasks_run_create, lang).toBeTruthy();
    }
  });
});

describe('Run now', () => {
  const actions = page.slice(page.indexOf('#actions>'), page.indexOf('</AppSettings>'));
  const schedule = withoutComments(read('src/pages/schedule.vue'));

  it("sits top right before Save, as a schedule's page, its icon and words", () => {
    expect(actions).toMatch(
      /<BsButton icon="play" cssClass="text-nowrap" :disabled="!canRun" @click="runNow\(\)">\{\{\s*t\('settings\.schedules\.runSchedule'\)/,
    );
    expect(schedule).toMatch(/<BsButton icon="play" cssClass="text-nowrap" :disabled="running" @click="runNow\(\)">/);
    expect(actions.indexOf('runNow()')).toBeLessThan(actions.indexOf('save()'));
  });

  it('shows for the tasks and the runner hub loops alike, a loop without Save', () => {
    expect(page).toMatch(/<template v-if="task" #actions>/);
    expect(actions).not.toMatch(/isLoop/);
    // a loop has no schedule setting : scheduleEditable is false, no Save
    expect(page).toMatch(
      /const scheduleEditable = computed\(\(\) => !!task\.value\?\.schedule_env && !!task\.value\?\.editable_schedule\);/,
    );
  });

  it("says a loop's pass by its outcome, a pass having no result", () => {
    const say = page.slice(page.indexOf('function sayRun(run)'), page.indexOf('function followRun('));
    expect(say).toMatch(
      /else if \(!run\?\.result\) toast\.success\(t\('jobs\.system\.runSucceeded', \{ name: name\.value \}\)\)/,
    );
  });

  it('is disabled while the task runs, and for a task that is off', () => {
    expect(page).toMatch(/const running = computed\(\(\) => runAsked\.value \|\| !!task\.value\?\.running\);/);
    expect(page).toMatch(
      /const canRun = computed\(\(\) => !!task\.value && task\.value\.enabled !== false && !running\.value\);/,
    );
  });

  it('posts the run, reads the task again, and says how it went ; a run still going is followed', () => {
    const run = page.slice(page.indexOf('async function runNow()'), page.indexOf('onBeforeUnmount(() =>'));
    expect(run).toMatch(/axios\.post\(`\/api\/v2\/system\/tasks\/\$\{encodeURIComponent\(taskKey\.value\)\}\/run`/);
    expect(run).toMatch(/await load\(true\);/);
    expect(run).toMatch(/res\.status === 202[\s\S]*t\('jobs\.system\.runStarted'[\s\S]*followRun\(/);
    expect(run).toMatch(/sayRun\(task\.value\?\.last_run\)/);
    expect(run).toMatch(/toast\.error\(Helpers\.parseAxiosResponseError\(err\)\)/);
    expect(page).toMatch(/t\('jobs\.system\.runFailed'/);
    expect(page).toMatch(/t\('jobs\.system\.runDone'/);
    // a changed cron is kept when the task is read again after a run
    expect(page).toMatch(/const keep = keepEdit && dirty\.value;/);
    expect(page).toMatch(/onBeforeUnmount\(\(\) => clearTimeout\(followTimer\)\);/);
  });
});
