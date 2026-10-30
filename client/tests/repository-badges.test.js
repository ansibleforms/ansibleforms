// The repositories' Pull and Push badges (Settings > Repositories, and a repository's own page).
// status is the lock any git operation takes, so a repository being pushed has status 'running' :
// the Pull badge drawn from it said running while a push ran, and the Push badge did not. The
// Pull badge reads pull_status, the Push badge push_status, each 'running' only while its own
// operation runs (server/src/models/repository.model.js claim).
import { describe, it, expect } from 'vitest';
import { repositoryPullPill, repositoryPushPill } from '../src/config/settings.js';

const t = (key) => key;
const isRunning = (html) => html.includes('jobs.menu.running');
const isSuccess = (html) => html.includes('jobs.menu.success');
const isFailed = (html) => html.includes('jobs.menu.failed');

describe('a repository being pushed', () => {
  const pushing = { status: 'running', pull_status: 'success', push_status: 'running', unpushed: true };

  it('says running on the Push badge', () => {
    expect(isRunning(repositoryPushPill(t, pushing, false))).toBe(true);
  });

  it('keeps the last pull on the Pull badge', () => {
    const pull = repositoryPullPill(t, pushing, false);
    expect(isRunning(pull)).toBe(false);
    expect(isSuccess(pull)).toBe(true);
  });
});

describe('a repository being pulled', () => {
  const pulling = { status: 'running', pull_status: 'running', push_status: 'failed' };

  it('says running on the Pull badge', () => {
    expect(isRunning(repositoryPullPill(t, pulling, false))).toBe(true);
  });

  it('keeps the last push on the Push badge', () => {
    const push = repositoryPushPill(t, pulling, false);
    expect(isRunning(push)).toBe(false);
    expect(isFailed(push)).toBe(true);
  });
});

describe('a repository a designer save holds', () => {
  it('shows neither badge as running', () => {
    const saving = { status: 'running', pull_status: 'failed', push_status: 'success' };
    expect(isFailed(repositoryPullPill(t, saving, false))).toBe(true);
    expect(isSuccess(repositoryPushPill(t, saving, false))).toBe(true);
  });
});
