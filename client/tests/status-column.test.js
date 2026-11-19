// Every job table puts Status after the times (decided 2026-11-19) : the jobs list, a schedule's
// and a stored job's Runs tab, a system task's Runs tab, and the Scheduled and System lists.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings from '@/config/settings';

const read = (p) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const keysOf = (src, from, to) =>
  [...src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from))).matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
const all = getSettings((key) => key);
const shown = (list) => list.fields.filter((f) => !f.hidden && !f.noTable).map((f) => f.key);

describe('the Status column of every job table', () => {
  it('follows the start, end and duration of a run', () => {
    expect(keysOf(read('src/pages/jobs.vue'), 'const columnDefs', ']);')).toEqual([
      'id',
      'form',
      'job_type',
      'start',
      'end',
      'duration',
      'status',
      'user',
    ]);
    for (const page of ['src/pages/schedule.vue', 'src/pages/stored-job.vue']) {
      expect(keysOf(read(page), 'const runColumns', ']);'), page).toEqual([
        'id',
        'user',
        'start',
        'end',
        'duration',
        'status',
      ]);
    }
    expect(keysOf(read('src/pages/admin/runner.vue'), 'const jobColumns', ']);')).toEqual([
      'id',
      'form',
      'start',
      'end',
      'duration',
      'status',
    ]);
    const system = keysOf(read('src/pages/system-task.vue'), 'const runColumns', ']);');
    expect(system.slice(0, 4)).toEqual(['started_at', 'ended_at', 'duration', 'outcome']);
  });

  it('follows the last and next run in the Scheduled and System lists', () => {
    for (const name of ['schedules', 'system_tasks']) {
      const keys = shown(all[name]);
      expect(keys.slice(keys.indexOf('last_run')), name).toEqual(['last_run', 'next_run', 'status']);
    }
  });
});
