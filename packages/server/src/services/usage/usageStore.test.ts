import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUsageStore } from './usageStore.js';
import { encodeProjectDir } from './claudeLogs.js';

let home = '';
let stateDir = '';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const claudeLine = (over: { ts?: string; model?: string; cwd?: string; id?: string; usage?: Record<string, number> } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: over.ts ?? iso(DAY),
    requestId: `req_${over.id ?? '1'}`,
    cwd: over.cwd ?? '/repo/wt-a',
    message: {
      id: `msg_${over.id ?? '1'}`,
      model: over.model ?? 'claude-opus-5',
      usage: { input_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 2_000, ...over.usage },
    },
  });

const codexLines = (over: { ts?: string; cwd?: string; output?: number } = {}) => [
  JSON.stringify({
    type: 'session_meta',
    timestamp: over.ts ?? iso(DAY),
    payload: { id: 's1', cwd: over.cwd ?? '/repo/wt-b', model: 'gpt-5.6' },
  }),
  JSON.stringify({
    type: 'event_msg',
    timestamp: over.ts ?? iso(DAY),
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 5_000, cached_input_tokens: 4_000, output_tokens: over.output ?? 500 } },
      rate_limits: {
        primary: { used_percent: 36, window_minutes: 300, resets_at: 1_788_266_796 },
        secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_788_773_664 },
      },
    },
  }),
];

const writeClaude = async (cwd: string, lines: string[], file = 'session.jsonl') => {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  await fsp.mkdir(dir, { recursive: true });
  const full = path.join(dir, file);
  await fsp.writeFile(full, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return full;
};

const writeCodex = async (lines: string[], file = 'rollout-a.jsonl') => {
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '31');
  await fsp.mkdir(dir, { recursive: true });
  const full = path.join(dir, file);
  await fsp.writeFile(full, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return full;
};

const labels = () => [
  { path: '/repo/wt-a', label: 'wt-a' },
  { path: '/repo/wt-b', label: 'wt-b' },
];

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-home-'));
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-state-'));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rm(stateDir, { recursive: true, force: true });
});

describe('createUsageStore', () => {
  it('sums both agents into totals and per-agent series', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    await writeCodex(codexLines());
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const summary = await store.summary({ days: 7, worktrees: labels() });

    expect(summary.totals.cost).toBeGreaterThan(0);
    expect(summary.totals.tokens).toBe(1_000 + 100_000 + 2_000 + 5_000 + 500);
    expect(summary.byAgent.claude.tokens).toBe(103_000);
    expect(summary.byAgent.codex.tokens).toBe(5_500);
    expect(summary.series).toHaveLength(7);
    const day = summary.series.find((point) => point.claude.tokens > 0);
    expect(day?.codex.tokens).toBe(5_500);
  });

  it('zero-fills days with no activity', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const summary = await store.summary({ days: 30, worktrees: labels() });

    expect(summary.series).toHaveLength(30);
    expect(summary.series.filter((p) => p.claude.tokens === 0).length).toBe(29);
    expect(summary.range.from < summary.range.to).toBe(true);
  });

  it('drops turns older than the window', async () => {
    await writeClaude('/repo/wt-a', [claudeLine({ ts: iso(40 * DAY), id: 'old' }), claudeLine()]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const week = await store.summary({ days: 7, worktrees: labels() });
    const quarter = await store.summary({ days: 90, worktrees: labels() });

    expect(week.totals.tokens).toBe(103_000);
    expect(quarter.totals.tokens).toBe(206_000);
  });

  it('ranks models by cost with shares that add up', async () => {
    await writeClaude('/repo/wt-a', [
      claudeLine({ id: 'a', model: 'claude-opus-5' }),
      claudeLine({ id: 'b', model: 'claude-haiku-4-5' }),
    ]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const { models } = await store.summary({ days: 7, worktrees: labels() });

    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
    expect(models[0]!.cost).toBeGreaterThan(models[1]!.cost);
    expect(Math.round(models.reduce((sum, m) => sum + m.share, 0))).toBe(100);
  });

  it('labels known worktrees and pools the rest as unattributed', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    await writeClaude('/somewhere/else', [claudeLine({ cwd: '/somewhere/else', id: 'x' })], 'other.jsonl');
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const { worktrees, totals } = await store.summary({ days: 7, worktrees: labels() });

    expect(worktrees.map((w) => w.label).sort()).toEqual(['Unattributed', 'wt-a']);
    expect(worktrees.reduce((sum, w) => sum + w.tokens, 0)).toBe(totals.tokens);
  });

  it('reports cache savings as the gap against full-rate pricing', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const { totals } = await store.summary({ days: 7, worktrees: labels() });

    expect(totals.cachedInput).toBe(100_000);
    expect(totals.uncachedInput).toBe(1_000);
    expect(totals.cacheSavings).toBeGreaterThan(0);
  });

  it('re-reads no bytes on a second pass and returns the same numbers', async () => {
    const file = await writeClaude('/repo/wt-a', [claudeLine()]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const first = await store.summary({ days: 7, worktrees: labels() });
    const second = await store.summary({ days: 7, worktrees: labels() });

    expect(second.totals).toEqual(first.totals);
    expect(second.bytesRead).toBe(0);
    expect(first.bytesRead).toBe((await fsp.stat(file)).size);
  });

  it('picks up appended turns without recounting old ones', async () => {
    const file = await writeClaude('/repo/wt-a', [claudeLine()]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });
    await store.summary({ days: 7, worktrees: labels() });

    await fsp.appendFile(file, `${claudeLine({ id: '2' })}\n`);
    const after = await store.summary({ days: 7, worktrees: labels() });

    expect(after.totals.tokens).toBe(206_000);
  });

  it('rereads a file from scratch when it shrinks', async () => {
    const file = await writeClaude('/repo/wt-a', [claudeLine(), claudeLine({ id: '2' })]);
    const store = createUsageStore({ agentHomeDir: home, stateDir });
    await store.summary({ days: 7, worktrees: labels() });

    await fsp.writeFile(file, `${claudeLine({ id: '3' })}\n`, 'utf8');
    const after = await store.summary({ days: 7, worktrees: labels() });

    expect(after.totals.tokens).toBe(103_000);
  });

  it('survives a new store instance by reloading its cache', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    await (createUsageStore({ agentHomeDir: home, stateDir })).summary({ days: 7, worktrees: labels() });

    const reopened = createUsageStore({ agentHomeDir: home, stateDir });
    const summary = await reopened.summary({ days: 7, worktrees: labels() });

    expect(summary.totals.tokens).toBe(103_000);
    expect(summary.bytesRead).toBe(0);
  });

  it('counts subagent transcripts nested under a session', async () => {
    await writeClaude('/repo/wt-a', [claudeLine()]);
    const subagents = path.join(home, '.claude', 'projects', encodeProjectDir('/repo/wt-a'), 'session', 'subagents');
    await fsp.mkdir(subagents, { recursive: true });
    await fsp.writeFile(path.join(subagents, 'agent-a.jsonl'), `${claudeLine({ id: 'sub' })}\n`, 'utf8');
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const summary = await store.summary({ days: 7, worktrees: labels() });

    expect(summary.totals.tokens).toBe(206_000);
    expect(summary.worktrees).toEqual([
      { label: 'wt-a', path: '/repo/wt-a', cost: expect.any(Number), tokens: 206_000 },
    ]);
  });

  it('exposes the newest codex rate-limit snapshot', async () => {
    await writeCodex(codexLines());
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    await store.summary({ days: 7, worktrees: labels() });
    const snapshot = await store.codexRateLimits();

    expect(snapshot?.windows.map((w) => w.label)).toEqual(['Session (5h)', 'Weekly']);
    expect(snapshot?.windows[0]!.usedPercent).toBe(36);
  });

  it('returns an empty summary when no agent logs exist', async () => {
    const store = createUsageStore({ agentHomeDir: home, stateDir });

    const summary = await store.summary({ days: 7, worktrees: labels() });

    expect(summary.totals.tokens).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.worktrees).toEqual([]);
    expect(summary.series).toHaveLength(7);
  });
});
