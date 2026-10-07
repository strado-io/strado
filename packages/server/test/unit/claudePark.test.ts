import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { claudeProjectDir, hasBackgroundJobs, jobsUnder, noTranscriptSince, parkMinutesFromEnv, processStartMs, startClaudeParkSweep, type ParkedSession } from '../../src/services/claudePark';
import { claudeKey, type LiveSession } from '../../src/services/terminalManager';

const HOUR = 60 * 60_000;
const stops: Array<() => void> = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

function sweep(opts: {
  live?: LiveSession[];
  last?: Record<string, number | null>;
  status?: string;
  convo?: { providerSessionId: string; transcriptPath?: string; updatedAt?: string } | null;
  started?: number | null;
  unused?: boolean;
  jobs?: boolean;
  now: () => number;
}) {
  const started = opts.started === undefined ? 0 : opts.started;
  const parked: Array<{ key: string; entry: ParkedSession }> = [];
  const s = startClaudeParkSweep({
    liveSessions: () => opts.live ?? [{ path: '/wt', mode: 'claude', id: '1' }],
    lastActivity: (key) => opts.last?.[key] ?? null,
    status: () => opts.status,
    backgroundJobs: async () => opts.jobs ?? false,
    processStart: async () => started,
    conversation: async () => {
      const c = opts.convo === undefined ? { providerSessionId: 'c1' } : opts.convo;
      // recorded after the process started unless the test says otherwise
      return c ? { updatedAt: new Date((started ?? 0) + 60_000).toISOString(), ...c } : null;
    },
    unusedSince: async () => opts.unused ?? false,
    park: (key, entry) => parked.push({ key, entry }),
    idleMs: 2 * HOUR,
    intervalMs: 1e9,
    now: opts.now,
  });
  stops.push(s.stop);
  return { tick: s.tick, parked };
}

describe('claude park sweep', () => {
  it('parks a Claude tab idle past the threshold, remembering its conversation', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 0 }, now: () => 3 * HOUR });
    await tick();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.key).toBe(claudeKey('/wt', '1'));
    expect(parked[0]!.entry).toMatchObject({ path: '/wt', sessionId: '1', providerSessionId: 'c1' });
  });

  it('leaves a recently active tab alone', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 2 * HOUR }, now: () => 3 * HOUR });
    await tick();
    expect(parked).toEqual([]);
  });

  it('never parks while Claude is working', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 0 }, status: 'working', now: () => 3 * HOUR });
    await tick();
    expect(parked).toEqual([]);
  });

  it('parks an empty tab (no conversation, nothing written since start) with no id to resume', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 0 }, convo: null, unused: true, now: () => 3 * HOUR });
    await tick();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.entry.providerSessionId).toBeUndefined();
  });

  it('ignores a conversation id recorded before this process started (an earlier Claude in the tab)', async () => {
    const old = { providerSessionId: 'old', updatedAt: new Date(0).toISOString() };
    const used = sweep({ last: { '/wt': 0 }, convo: old, started: HOUR, unused: false, now: () => 4 * HOUR });
    await used.tick();
    expect(used.parked).toEqual([]); // used since start, conversation unknown: leave it
    const empty = sweep({ last: { '/wt': 0 }, convo: old, started: HOUR, unused: true, now: () => 4 * HOUR });
    await empty.tick();
    expect(empty.parked).toHaveLength(1);
    expect(empty.parked[0]!.entry.providerSessionId).toBeUndefined(); // fresh, never the old one
  });

  it('never parks a tab with a background job Claude started', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 0 }, jobs: true, now: () => 3 * HOUR });
    await tick();
    expect(parked).toEqual([]);
  });

  it('never parks when the process start time is unknown', async () => {
    const { tick, parked } = sweep({ last: { '/wt': 0 }, started: null, unused: true, now: () => 3 * HOUR });
    await tick();
    expect(parked).toEqual([]);
  });

  it('keeps a tab whose conversation is unknown or whose transcript is gone', async () => {
    const a = sweep({ last: { '/wt': 0 }, convo: null, now: () => 3 * HOUR });
    await a.tick();
    expect(a.parked).toEqual([]);
    const b = sweep({
      last: { '/wt': 0 },
      convo: { providerSessionId: 'c1', transcriptPath: path.join(os.tmpdir(), 'no-such-transcript.jsonl') },
      now: () => 3 * HOUR,
    });
    await b.tick();
    expect(b.parked).toEqual([]);
  });

  it('parks when the transcript exists', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'park-')), 't.jsonl');
    fs.writeFileSync(file, '{}');
    const { tick, parked } = sweep({
      last: { '/wt': 0 }, convo: { providerSessionId: 'c1', transcriptPath: file }, now: () => 3 * HOUR,
    });
    await tick();
    expect(parked[0]!.entry.transcriptPath).toBe(file);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('only parks Claude tabs, never shells or other agents', async () => {
    const { tick, parked } = sweep({
      live: [{ path: '/wt', mode: 'shell', id: '1' }, { path: '/wt', mode: 'codex', id: '1' }],
      now: () => 3 * HOUR,
    });
    await tick();
    await tick();
    expect(parked).toEqual([]);
  });

  it('counts first sight as activity for sessions with no recorded clock (after a restart)', async () => {
    let t = 10 * HOUR;
    const { tick, parked } = sweep({ last: {}, now: () => t });
    await tick();
    expect(parked).toEqual([]);
    t += HOUR;
    await tick();
    expect(parked).toEqual([]);
    t += 2 * HOUR;
    await tick();
    expect(parked).toHaveLength(1);
  });

  it('reads the idle threshold from STRADO_PARK_IDLE_MINUTES', () => {
    expect(parkMinutesFromEnv({})).toBe(15);
    expect(parkMinutesFromEnv({ STRADO_PARK_IDLE_MINUTES: '0' })).toBe(0);
    expect(parkMinutesFromEnv({ STRADO_PARK_IDLE_MINUTES: '30' })).toBe(30);
    expect(parkMinutesFromEnv({ STRADO_PARK_IDLE_MINUTES: 'junk' })).toBe(15);
  });
});


describe('empty-tab detection helpers', () => {
  it('maps a folder to Claude\'s project directory', () => {
    expect(claudeProjectDir('/Users/me/.strado/worktrees/a_b', { CLAUDE_CONFIG_DIR: '/c' }))
      .toBe('/c/projects/-Users-me--strado-worktrees-a-b');
  });

  it('noTranscriptSince sees only conversation files written after the cutoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    expect(await noTranscriptSince(path.join(dir, 'missing'), 0)).toBe(true);
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), '{}');
    expect(await noTranscriptSince(dir, 0)).toBe(true);
    const f = path.join(dir, 'abc.jsonl');
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, 1000, 1000);
    expect(await noTranscriptSince(dir, 2_000_000)).toBe(true);
    expect(await noTranscriptSince(dir, 0)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a live process start time', async () => {
    const t = await processStartMs(process.pid);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThanOrEqual(Date.now());
  });
});

describe('background job detection', () => {
  const SNAP = '/Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh';
  const table = (rows: Array<[number, number, string]>) => rows.map(([p, pp, c]) => `${p} ${pp} ${c}`).join('\n');

  it('ignores MCP servers and Claude helpers', () => {
    expect(jobsUnder(10, table([
      [10, 1, 'claude'],
      [11, 10, 'node /Applications/Strado.app/Contents/Resources/server/hooks/strado-mcp.mjs'],
      [12, 10, 'caffeinate -i -t 300'],
      [13, 10, 'claude bg-spare --bg-spare /tmp/x.sock'],
      [14, 11, 'node child-of-mcp.js'],
    ]))).toBe(false);
  });

  it('finds a Bash-tool command left running, at any depth', () => {
    expect(jobsUnder(10, table([
      [10, 1, 'zsh -l -c claude'],
      [20, 10, 'claude'],
      [21, 20, `/bin/zsh -c source ${SNAP} 2>/dev/null || true && npm run dev`],
      [22, 21, 'node vite'],
    ]))).toBe(true);
  });

  it('only looks under the given session', () => {
    expect(jobsUnder(10, table([
      [10, 1, 'claude'],
      [30, 1, 'claude'],
      [31, 30, `/bin/zsh -c source ${SNAP} && sleep 100`],
    ]))).toBe(false);
  });

  it('sees a real process tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-snapshots-'));
    const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-test.sh');
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.writeFileSync(snap, '');
    // parent stands in for claude; its child looks like a Bash-tool command
    const parent = spawn('/bin/sh', ['-c', `/bin/sh -c "true ${snap}; sleep 30" & wait`], { stdio: 'ignore', detached: true });
    try {
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        found = await hasBackgroundJobs(parent.pid!);
        if (!found) await new Promise((r) => setTimeout(r, 50));
      }
      expect(found).toBe(true);
      // a session with only plain children has nothing to protect
      const plain = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
      try {
        expect(await hasBackgroundJobs(plain.pid!)).toBe(false);
      } finally {
        process.kill(-plain.pid!, 'SIGKILL'); // whole group, not just the parent
      }
    } finally {
      process.kill(-parent.pid!, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
