// Who may see a page is declared once : the route's `meta.permission` (router/index.js). The
// router's one guard checks it, and the left menus and the header search read it from the route
// a link resolves to (lib/routePermission.js). This used to be restated in three places, and
// shipped wrong twice : a link shown to a user the route then bounced, or a page reachable by
// url that the menu hid.
import { describe, it, expect, vi } from 'vitest';
import TokenStorage from '@/lib/TokenStorage';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import router, { permissionGuard } from '@/router';
import { routePermission, mayOpen } from '@/lib/routePermission';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const menus = read('src/components/AppSidebar.vue') + read('src/components/AppJobsSidebar.vue');
const links = [...menus.matchAll(/link:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('the routes declare who may see a page', () => {
  it('the menus were read, so these assertions are not vacuous', () => {
    expect(links.length).toBeGreaterThan(15);
    expect(links).toContain('/jobs/schedules');
  });

  it('every menu link points at a route that exists', () => {
    const missing = links.filter((link) => router.resolve(link).matched.length === 0);
    expect(missing).toEqual([]);
  });

  it('no menu item restates a permission : it comes from the route', () => {
    expect(menus).not.toMatch(/permission:\s*'/);
  });

  it('each page has the role option its api needs', () => {
    expect(routePermission('/settings/users')).toBe('showSettings');
    expect(routePermission('/settings/backups')).toBe('allowBackupOps');
    expect(routePermission('/settings/logs')).toBe('showLogs');
    expect(routePermission('/jobs/schedules')).toBe('allowScheduledJobs');
    expect(routePermission('/jobs/stored')).toBe('allowStoredJobs');
    expect(routePermission('/designer')).toBe('showDesigner');
    expect(routePermission('/jobs')).toBe('showJobs');
    expect(routePermission('/profile')).toBe(null);
  });

  it('a link shows to a user with its option only', () => {
    expect(mayOpen('/settings/users', { showSettings: true })).toBe(true);
    expect(mayOpen('/settings/users', { showJobs: true })).toBe(false);
    expect(mayOpen('/settings/backups', { showSettings: true })).toBe(false);
    expect(mayOpen('/profile', {})).toBe(true);
  });
});

describe('the guard', () => {
  // the signed-in user's role options, as the guard reads them from the token
  const as = (options) => vi.spyOn(TokenStorage, 'getPayload').mockReturnValue({ user: { username: 'u', options } });

  it('a page needing an option the user lacks : home ; with it : the page', () => {
    const designer = router.resolve('/designer');
    as({ showJobs: true });
    expect(permissionGuard(designer)).toEqual({ name: '/' });
    as({ showDesigner: true });
    expect(permissionGuard(designer)).toBe(true);
  });

  it('a page needing nothing opens for anybody', () => {
    as({});
    expect(permissionGuard(router.resolve('/profile'))).toBe(true);
  });
});
