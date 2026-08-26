import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createActivityTracker, createAgentOutputBeats } from '../../src/services/activityTracker';

const dirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  dirs.push(dir);
  return path.join(dir, 'activity.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('activityTracker', () => {
  it('accrues elapsed time between beats inside the idle gap', () => {
    let t = 0;
    const tracker = createActivityTracker(tmpFile(), { now: () => t, idleGapMs: 15 * 60_000 });
    tracker.touch('/wt/a'); // first beat opens the session, accrues nothing
    t += 60_000;
    tracker.touch('/wt/a');
    t += 120_000;
    tracker.touch('/wt/a');
    expect(tracker.get('/wt/a')).toBe(180);
  });

  it('a beat after the idle gap accrues nothing', () => {
    let t = 0;
    const tracker = createActivityTracker(tmpFile(), { now: () => t, idleGapMs: 15 * 60_000 });
    tracker.touch('/wt/a');
    t += 3 * 60 * 60_000; // 3h lunch break
    tracker.touch('/wt/a');
    expect(tracker.get('/wt/a')).toBe(0);
    t += 30_000; // but typing resumes normally afterwards
    tracker.touch('/wt/a');
    expect(tracker.get('/wt/a')).toBe(30);
  });

  it('tracks worktrees independently', () => {
    let t = 0;
    const tracker = createActivityTracker(tmpFile(), { now: () => t, idleGapMs: 15 * 60_000 });
    tracker.touch('/wt/a');
    tracker.touch('/wt/b');
    t += 60_000;
    tracker.touch('/wt/a');
    expect(tracker.get('/wt/a')).toBe(60);
    expect(tracker.get('/wt/b')).toBe(0);
  });

  it('persists totals and reloads them on construction', async () => {
    const file = tmpFile();
    let t = 0;
    const tracker = createActivityTracker(file, { now: () => t, idleGapMs: 15 * 60_000 });
    tracker.touch('/wt/a');
    t += 90_000;
    tracker.touch('/wt/a');
    await tracker.flush();

    const reloaded = createActivityTracker(file, { now: () => t });
    expect(reloaded.get('/wt/a')).toBe(90);
  });

  it('remove drops a worktree from totals and the persisted file', async () => {
    const file = tmpFile();
    let t = 0;
    const tracker = createActivityTracker(file, { now: () => t, idleGapMs: 15 * 60_000 });
    tracker.touch('/wt/a');
    t += 60_000;
    tracker.touch('/wt/a');
    tracker.remove('/wt/a');
    await tracker.flush();
    expect(tracker.get('/wt/a')).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).worktrees).toEqual({});
  });

  it('starts from zero when the file is corrupt instead of crashing', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'not json');
    const tracker = createActivityTracker(file);
    expect(tracker.get('/wt/a')).toBe(0);
  });
});

describe('createAgentOutputBeats', () => {
  function setup(status: 'idle' | 'working' | 'waiting' | undefined) {
    let t = 0;
    const touched: string[] = [];
    const beat = createAgentOutputBeats({
      touch: (p) => touched.push(p),
      agentStatus: () => status,
      now: () => t,
      throttleMs: 30_000,
    });
    return { beat, touched, advance: (ms: number) => { t += ms; } };
  }

  it('beats for a working agent, throttled to one per interval', () => {
    const { beat, touched, advance } = setup('working');
    beat('/wt/a'); // claude key = bare path
    beat('/wt/a'); // streamed chunk inside the throttle window — ignored
    advance(10_000);
    beat('/wt/a');
    expect(touched).toEqual(['/wt/a']);
    advance(30_000);
    beat('/wt/a');
    expect(touched).toEqual(['/wt/a', '/wt/a']);
  });

  it('ignores output while the agent is not working (idle TUI repaints)', () => {
    const { beat, touched } = setup('waiting');
    beat('/wt/a');
    beat('/wt/a\0codex');
    expect(touched).toEqual([]);
  });

  it('ignores uninstrumented shell output (dev servers, tails)', () => {
    const { beat, touched } = setup('working');
    beat('/wt/a\0shell');
    beat('/wt/a\0shell:2');
    expect(touched).toEqual([]);
  });

  it('beats for output from a working agent hosted in Shell', () => {
    const touched: string[] = [];
    const beat = createAgentOutputBeats({
      touch: (p) => touched.push(p),
      agentStatus: () => undefined,
      shellAgentWorking: (_p, id) => id === '2',
    });
    beat('/wt/a\0shell');
    beat('/wt/a\0shell:2');
    expect(touched).toEqual(['/wt/a']);
  });

  it('beats for a working codex session', () => {
    const { beat, touched } = setup('working');
    beat('/wt/a\0codex');
    expect(touched).toEqual(['/wt/a']);
  });
});
