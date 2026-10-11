// Routes

// Composables
import { createRouter, createWebHistory } from 'vue-router';
import { JOBS_STATUS_SLUGS, ALL_JOBS } from '@/lib/jobsPath';
import BaseUrl from '@/lib/BaseUrl';

// Pages load on first visit rather than up front: each becomes its own chunk, so the first
// page view downloads the app shell and that page instead of the whole application.
const designer = () => import('@/pages/designer.vue');
const index = () => import('@/pages/index.vue');
const form = () => import('@/pages/form.vue');
const login = () => import('@/pages/login.vue');
const logout = () => import('@/pages/logout.vue');
const logs = () => import('@/pages/logs.vue');
const jobs = () => import('@/pages/jobs.vue');
const apidocs = () => import('@/pages/api-docs.vue');
const unknown = () => import('@/pages/unknown.vue');
const changePassword = () => import('@/pages/change-password.vue');
const profile = () => import('@/pages/profile.vue');
const schema = () => import('@/pages/schema.vue');
const error = () => import('@/pages/error.vue');

// admin
const credentials = () => import('@/pages/admin/credentials.vue');
const credential = () => import('@/pages/admin/credential.vue');
const sso = () => import('@/pages/admin/sso.vue');
const ssoProvider = () => import('@/pages/admin/sso-provider.vue');
const groups = () => import('@/pages/admin/groups.vue');
const group = () => import('@/pages/admin/group.vue');
const knownHosts = () => import('@/pages/admin/knownHosts.vue');
const ldap = () => import('@/pages/admin/ldap.vue');
const chatSettings = () => import('@/pages/admin/chat.vue');
const mcpSettings = () => import('@/pages/admin/mcp.vue');
const mailSettings = () => import('@/pages/admin/mailSettings.vue');
const mailServer = () => import('@/pages/admin/mail-server.vue');
const logo = () => import('@/pages/admin/logo.vue');
const repositories = () => import('@/pages/admin/repositories.vue');
const repository = () => import('@/pages/admin/repository.vue');
const schedules = () => import('@/pages/admin/schedules.vue');
const schedule = () => import('@/pages/schedule.vue');
const storedJobs = () => import('@/pages/admin/stored-jobs.vue');
const storedJob = () => import('@/pages/stored-job.vue');
const settings = () => import('@/pages/admin/settings.vue');
const status = () => import('@/pages/admin/status.vue');
const secretStores = () => import('@/pages/admin/secretStores.vue');
const secretStore = () => import('@/pages/admin/secret-store.vue');
const runners = () => import('@/pages/admin/runners.vue');
const runner = () => import('@/pages/admin/runner.vue');
const audit = () => import('@/pages/admin/audit.vue');
const roles = () => import('@/pages/admin/roles.vue');
const role = () => import('@/pages/admin/role.vue');
const ssh = () => import('@/pages/admin/ssh.vue');
const users = () => import('@/pages/admin/users.vue');
const user = () => import('@/pages/admin/user.vue');
const backups = () => import('@/pages/admin/backups.vue');

import TokenStorage from '@/lib/TokenStorage.js';

// Every route that needs a role option says which, as `meta.permission` : the one guard below
// checks it, and the left menus and the header search read it from the route a link resolves to
// (lib/routePermission.js) - one declaration, where it used to be restated in three places.
// a page in tabs ends in /:tab? : its tab is the last part of its address
// (composables/useRouteTab.js), the first tab none
const routes = [
  // root routes
  // the forms list : every form at /forms/all, a category at /forms/<category> (lib/formsPath.js) ;
  // the app's start page is every form
  { path: '/', name: '/', redirect: '/forms/all' },
  { path: '/forms', redirect: '/forms/all' },
  { path: '/forms/:category(.*)', name: '/forms', component: index },
  // a view at /designer/<view>, the form edited at /designer/forms/<form>, then the editor shown
  // (/visual, /preview ; pages/designer.vue)
  {
    path: '/designer/:view?/:item?/:editor?',
    name: '/designer',
    component: designer,
    meta: { permission: 'showDesigner' },
  },
  // a form : /form/<its name>, whatever category it is opened from (lib/formsPath.js)
  { path: '/form/:slug', name: '/form', component: form },
  { path: '/login', name: '/login', component: login },
  { path: '/change-password', name: '/change-password', component: changePassword },
  // the profile : a view at /profile/<view> ; /profile alone opens the first of its menu
  { path: '/profile/:view?', name: '/profile', component: profile },
  { path: '/logout', name: '/logout', component: logout },
  // every job at /jobs/all (lib/jobsPath.js) ; /jobs leads there
  {
    path: '/jobs',
    name: '/jobs',
    redirect: (to) => ({ path: `/jobs/${ALL_JOBS}`, query: to.query }),
    meta: { permission: 'showJobs' },
  },
  // the scheduled and stored jobs live with the jobs (their menu is the jobs menu) ; a fixed
  // segment outranks /jobs/:id, whatever the order
  {
    path: '/jobs/schedules',
    name: '/jobs/schedules',
    component: schedules,
    meta: { permission: 'allowScheduledJobs' },
  },
  {
    path: '/jobs/schedules/:id(\\d+)/:tab?',
    name: '/jobs/schedules/:id',
    component: schedule,
    meta: { permission: 'allowScheduledJobs' },
  },
  { path: '/jobs/stored', name: '/jobs/stored', component: storedJobs, meta: { permission: 'allowStoredJobs' } },
  {
    path: '/jobs/stored/:id(\\d+)/:tab?',
    name: '/jobs/stored/:id',
    component: storedJob,
    meta: { permission: 'allowStoredJobs' },
  },
  // the jobs of a status (/jobs/running, /jobs/approval ...) ; a job's page by its number only,
  // so a status's name is never read as a job
  {
    path: `/jobs/:status(${[ALL_JOBS, ...JOBS_STATUS_SLUGS].join('|')})`,
    name: '/jobs/:status',
    component: jobs,
    meta: { permission: 'showJobs' },
  },
  { path: '/jobs/:id(\\d+)', name: '/jobs/:id', component: jobs, meta: { permission: 'showJobs' } },
  // the server log : a settings page, under /settings as the others
  {
    path: '/settings/server-log/:tab?',
    name: '/settings/server-log',
    component: logs,
    meta: { permission: 'showLogs' },
  },
  { path: '/schema', name: '/schema', component: schema },
  { path: '/error', name: '/error', component: error },
  { path: '/api-docs', name: '/api-docs', component: apidocs },
  { path: '/:pathMatch(.*)*', name: '/unknown', component: unknown },

  // admin routes
  {
    path: '/settings/credentials',
    name: '/settings/credentials',
    component: credentials,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/credentials/:id(\\d+)/:tab?',
    name: '/settings/credentials/:id',
    component: credential,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/sso/:tab?', name: '/settings/sso', component: sso, meta: { permission: 'showSettings' } },
  // an SSO provider's page : its Details, Sign-in and Groups tabs
  {
    path: '/settings/sso/:id(\\d+)/:tab?',
    name: '/settings/sso/:id',
    component: ssoProvider,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/groups', name: '/settings/groups', component: groups, meta: { permission: 'showSettings' } },
  // a group's page : its Details and Users tabs
  {
    path: '/settings/groups/:id(\\d+)/:tab?',
    name: '/settings/groups/:id',
    component: group,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/known-hosts/:tab?',
    name: '/settings/known-hosts',
    component: knownHosts,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/ldap/:tab?', name: '/settings/ldap', component: ldap, meta: { permission: 'showSettings' } },
  {
    path: '/settings/chat/:tab?',
    name: '/settings/chat',
    component: chatSettings,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/mcp/:tab?', name: '/settings/mcp', component: mcpSettings, meta: { permission: 'showSettings' } },
  {
    path: '/settings/mail',
    name: '/settings/mail',
    component: mailSettings,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/mail/:id(\\d+)/:tab?',
    name: '/settings/mail/:id',
    component: mailServer,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/logo/:tab?', name: '/settings/logo', component: logo, meta: { permission: 'showSettings' } },
  {
    path: '/settings/repositories',
    name: '/settings/repositories',
    component: repositories,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/repositories/:id(\\d+)/:tab?',
    name: '/settings/repositories/:id',
    component: repository,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/general/:tab?',
    name: '/settings/general',
    component: settings,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/roles', name: '/settings/roles', component: roles, meta: { permission: 'showSettings' } },
  // a role's page : its General, Users and Groups tabs
  {
    path: '/settings/roles/:name/:tab?',
    name: '/settings/roles/:name',
    component: role,
    meta: { permission: 'showSettings' },
  },
  { path: '/settings/ssh/:tab?', name: '/settings/ssh', component: ssh, meta: { permission: 'showSettings' } },
  { path: '/settings/users', name: '/settings/users', component: users, meta: { permission: 'showSettings' } },
  // a user's page : its Details and Groups tabs
  {
    path: '/settings/users/:id(\\d+)/:tab?',
    name: '/settings/users/:id',
    component: user,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/backups/:tab?',
    name: '/settings/backups',
    component: backups,
    meta: { permission: 'allowBackupOps' },
  },
  // GET /api/v2/health is mounted behind checkSettingsMiddleware, so the guard
  // matches the permission the endpoint actually requires. The endpoint keeps the
  // 'health' name (it is the conventional one for a monitor to poll); the PAGE is
  // called Status because it states facts as well as verdicts.
  { path: '/settings/status/:tab?', name: '/settings/status', component: status, meta: { permission: 'showSettings' } },
  // /api/v2/secretstore is behind checkSettingsMiddleware, so the guard matches
  {
    path: '/settings/secret-stores',
    name: '/settings/secret-stores',
    component: secretStores,
    meta: { permission: 'showSettings' },
  },
  {
    path: '/settings/secret-stores/:id(\\d+)/:tab?',
    name: '/settings/secret-stores/:id',
    component: secretStore,
    meta: { permission: 'showSettings' },
  },
  // /api/v2/runner is behind checkSettingsMiddleware, so the guard matches
  { path: '/settings/runners', name: '/settings/runners', component: runners, meta: { permission: 'showSettings' } },
  {
    path: '/settings/runners/:id(\\d+)/:tab?',
    name: '/settings/runners/:id',
    component: runner,
    meta: { permission: 'showSettings' },
  },
  // GET /api/v2/audit is mounted behind checkSettingsMiddleware, so the guard matches
  {
    path: '/settings/audit-log/:tab?',
    name: '/settings/audit-log',
    component: audit,
    meta: { permission: 'showSettings' },
  },
];

const router = createRouter({
  history: createWebHistory(`${BaseUrl}/`), // honor the subpath the app is hosted under
  routes,
});

// the one guard : a route's role option (meta.permission), from the signed-in user's token -
// without it, home. The server checks the same option on the api, this only spares the user a
// page whose every request would be refused.
export function permissionGuard(to) {
  const permission = to.meta?.permission;
  if (!permission) return true;
  return TokenStorage.getPayload()?.user?.options?.[permission] ? true : { name: '/' };
}
router.beforeEach(permissionGuard);

export default router;
