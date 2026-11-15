// The job page's Relaunch (lib/relaunchMenu.js) : the split button's entries when the job offers
// a second choice (its failed hosts), none otherwise - the plain Relaunch button then.
import { describe, test, expect } from 'vitest';
import { relaunchActions, relaunchBody } from '@/lib/relaunchMenu';

// vue-i18n's t, as the English texts
const EN = {
  'jobs.relaunchFailedHosts': 'On failed hosts ({count})',
  'jobs.relaunchAllHosts': 'On all hosts',
  'jobs.relaunchFromFirstNode': 'From the first node',
  'jobs.relaunchFromFailedNode': 'From the failed node',
};
const t = (key, args = {}) => (EN[key] || key).replace(/\{(\w+)\}/g, (_, k) => String(args[k]));

describe('the Relaunch menu', () => {
  test('no second choice : no entries, the plain button', () => {
    expect(relaunchActions(null, t)).toEqual([]);
    expect(relaunchActions({ failedHosts: null }, t)).toEqual([]);
    expect(relaunchActions({ failedHosts: [] }, t)).toEqual([]);
  });

  test('failed hosts : All hosts, then the failed ones with their count, no names', () => {
    const actions = relaunchActions({ failedHosts: ['a', 'b', 'c', 'd'] }, t);
    expect(actions.map((a) => a.key)).toEqual(['all', 'failedHosts']);
    expect(actions[0].label).toBe('On all hosts');
    expect(actions[1]).toMatchObject({ label: 'On failed hosts (4)' });
    expect(actions[1].hint).toBeUndefined();
  });

  test('a failed workflow job : from its first node, or from its failed node, without a hint', () => {
    const actions = relaunchActions({ failedHosts: null, fromFailedNode: true }, t);
    expect(actions.map((a) => [a.key, a.label])).toEqual([
      ['all', 'From the first node'],
      ['failedNode', 'From the failed node'],
    ]);
    expect(actions[1].hint).toBeUndefined();
    // not applicable (not failed, the workflow changed, a multistep) : the plain button
    expect(relaunchActions({ failedHosts: null, fromFailedNode: false }, t)).toEqual([]);
  });

  test('the call : failedHostsOnly, fromFailedNode, nothing else for a full relaunch', () => {
    expect(relaunchBody('failedHosts')).toEqual({ failedHostsOnly: true });
    expect(relaunchBody('failedNode')).toEqual({ fromFailedNode: true });
    expect(relaunchBody('all')).toEqual({});
  });
});
