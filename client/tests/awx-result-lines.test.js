// A job run on AWX, AAP or Ascender : its output is ansible's, its events (read from AWX's job
// events, server/src/runners/awx/events.js) the shape an RTE's are, so its host result lines pair
// with them as a playbook's on an RTE do and open their details. The fixtures are one playbook's
// run as AWX stores it (server/tests/awx-job-events.test.mjs checks the events are what the
// server stores for it).
import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lineLevel, pairResultLines } from '@/lib/resultLines';
import { useJobEvents } from '@/composables/useJobEvents';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '../../server/tests/fixtures/awx-events');
const stdout = readFileSync(path.join(fixtures, 'awx-stdout.txt'), 'utf8');
const events = JSON.parse(readFileSync(path.join(fixtures, 'awx-stored-events.json'), 'utf8'));

// the job's output as the app stores it : its launch line, AWX's stdout, its end line
const text = ['ok: [Launched template deploy with jobid 77]', ...stdout.split(/\r?\n/), 'ok: [Successfully completed template deploy]'];
const lines = text.map((t) => ({ text: t.trim(), level: lineLevel(t.trim()) }));
const paired = pairResultLines(lines, events);
const eventOf = (index) => events.find((e) => e.order === paired.get(index));
const RESULT_LINE = /^(ok|changed|failed|fatal|skipping|unreachable):\s+\[([^\]]+)\]/;

/**
 * The task a line is under : the last TASK or RUNNING HANDLER line before it.
 */
function taskOf(index) {
  for (let i = index; i >= 0; i--) {
    if (lines[i].level === 3) return lines[i].text.replace(/^(TASK|RUNNING HANDLER) \[/, '').replace(/\]\s*\**\s*$/, '');
    if (lines[i].level) return null;
  }
  return null;
}

describe('an AWX job\'s output lines and its events', () => {
  it('pairs every result line under a task with its host\'s event of that task', () => {
    const results = lines.map((l, i) => [l, i]).filter(([l, i]) => RESULT_LINE.test(l.text) && taskOf(i));
    expect(results.length).toBeGreaterThan(20);
    for (const [line, index] of results) {
      const event = eventOf(index);
      expect(event, line.text).toBeTruthy();
      expect(event.host).toBe(RESULT_LINE.exec(line.text)[2]);
      expect(event.task).toBe(taskOf(index));
      // a loop's item line with its item's event, a host's result with its result
      expect(event.type === 'item').toBe(/\(item=/.test(line.text));
    }
  });

  it('opens every event that has details and a line of its own', () => {
    const opened = new Set(paired.values());
    const detailed = events.filter((e) => e.detailed);
    expect(detailed.length).toBeGreaterThan(20);
    // ansible prints no line for a loop's whole result (its items have theirs) nor for an
    // include (included: web for h1, h2) : as on an RTE, those open from the Hosts and tasks panel
    const unopened = detailed.filter((e) => !opened.has(e.order));
    expect(unopened.map((e) => [e.task, e.host])).toEqual([
      ['Loop items', 'h1'],
      ['Loop items', 'h2'],
      ['Use role', 'h1'],
      ['Use role', 'h2'],
    ]);
  });

  it('pairs a role\'s task, a handler, an unreachable host, a failure and its error, a body', () => {
    const at = (re) => lines.findIndex((l) => re.test(l.text));
    expect(eventOf(at(/^ok: \[h1\] => \{$/))).toMatchObject({ type: 'ok', task: 'Say hello', host: 'h1' });
    // the body printed with the result : the same event
    expect(paired.get(at(/^"msg": "hello h1"$/))).toBe(paired.get(at(/^ok: \[h1\] => \{$/)));
    expect(eventOf(at(/^fatal: \[h3\]: UNREACHABLE!/))).toMatchObject({ type: 'unreachable', host: 'h3', task: 'Change something' });
    const role = lines.findIndex((l, i) => taskOf(i) === 'web : Role task' && RESULT_LINE.test(l.text));
    expect(eventOf(role)).toMatchObject({ task: 'web : Role task' });
    const handler = lines.findIndex((l, i) => taskOf(i) === 'Restart web' && RESULT_LINE.test(l.text));
    expect(eventOf(handler)).toMatchObject({ type: 'ok', host: 'h1', task: 'Restart web' });
    // the failure of h2 : its [ERROR]: lines before it open it too
    const fatal = lines.findIndex((l, i) => taskOf(i) === 'Fail on h2' && /^fatal: \[h2\]/.test(l.text));
    expect(eventOf(fatal)).toMatchObject({ type: 'failed', host: 'h2' });
    const error = lines.findIndex((l, i) => taskOf(i) === 'Fail on h2' && l.text.startsWith('[ERROR]:'));
    expect(paired.get(error)).toBe(paired.get(fatal));
  });

  it('leaves the app\'s own lines and the recap alone', () => {
    expect(paired.has(0)).toBe(false);
    expect(paired.has(lines.length - 1)).toBe(false);
    const recap = lines.findIndex((l) => /^PLAY RECAP/.test(l.text));
    for (let i = recap; i < lines.length; i++) expect(paired.has(i)).toBe(false);
  });
});

describe('the job page reads an AWX job\'s events', () => {
  it('reads them for an awx job (AWX, AAP, Ascender) as for a playbook, never for a workflow', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { records: events } });
    try {
      const { jobEvents, loadEvents } = useJobEvents();
      await loadEvents(77, 'awx');
      expect(get).toHaveBeenCalledWith('/api/v2/job/77/events');
      expect(jobEvents.value).toHaveLength(events.length);
      await loadEvents(78, 'ansible');
      expect(get).toHaveBeenCalledTimes(2);
      await loadEvents(79, 'workflow');
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      get.mockRestore();
    }
  });
});
