import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRolloutFiles, readCodexEvents } from './codexLogs.js';

let dir = '';

const meta = JSON.stringify({
  type: 'session_meta',
  timestamp: '2026-08-31T20:08:14.000Z',
  payload: { id: 'sess-1', cwd: '/repo/wt', originator: 'codex_cli_rs', model: 'gpt-5.6' },
});

const tokenCount = (
  last: Record<string, number>,
  rateLimits?: unknown,
  timestamp = '2026-08-31T20:10:00.000Z',
) => JSON.stringify({
  type: 'event_msg',
  timestamp,
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 0, output_tokens: 0 },
      last_token_usage: {
        input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, ...last,
      },
      model_context_window: 258_400,
    },
    ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
  },
});

const write = async (name: string, lines: string[]) => {
  const file = path.join(dir, name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return file;
};

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-codex-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('readCodexEvents', () => {
  it('turns each token_count into an event with cwd and model from the meta line', async () => {
    const file = await write('rollout-a.jsonl', [
      meta,
      tokenCount({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 5 }),
    ]);
    const { events, cwd } = await readCodexEvents(file, 0);
    expect(cwd).toBe('/repo/wt');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6',
      cwd: '/repo/wt',
      // Codex reports total input including the cached share; the priced
      // uncached input is the remainder.
      tokens: { input: 40, cacheRead: 60, cacheWrite: 10, output: 5 },
    });
  });

  it('counts reasoning tokens as output', async () => {
    const file = await write('rollout-a.jsonl', [
      meta,
      tokenCount({ input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 3 }),
    ]);
    const { events } = await readCodexEvents(file, 0);
    expect(events[0]!.tokens.output).toBe(11);
  });

  it('skips token_count events with no tokens at all', async () => {
    const file = await write('rollout-a.jsonl', [meta, tokenCount({})]);
    const { events } = await readCodexEvents(file, 0);
    expect(events).toHaveLength(0);
  });

  it('keeps the newest rate limit snapshot and labels its windows', async () => {
    const file = await write('rollout-a.jsonl', [
      meta,
      tokenCount({ output_tokens: 1 }, {
        primary: { used_percent: 10, window_minutes: 300, resets_at: 111 },
        secondary: { used_percent: 20, window_minutes: 10_080, resets_at: 222 },
      }),
      tokenCount({ output_tokens: 1 }, {
        primary: { used_percent: 43, window_minutes: 300, resets_at: 333 },
        secondary: { used_percent: 41, window_minutes: 10_080, resets_at: 444 },
      }, '2026-08-31T20:20:00.000Z'),
    ]);
    const { rateLimits } = await readCodexEvents(file, 0);
    expect(rateLimits).toEqual({
      capturedAt: Date.parse('2026-08-31T20:20:00.000Z'),
      windows: [
        { label: 'Session (5h)', usedPercent: 43, resetsAt: 333_000 },
        { label: 'Weekly', usedPercent: 41, resetsAt: 444_000 },
      ],
    });
  });

  it('labels an unrecognised window by its length', async () => {
    const file = await write('rollout-a.jsonl', [
      meta,
      tokenCount({ output_tokens: 1 }, { primary: { used_percent: 5, window_minutes: 60, resets_at: 9 } }),
    ]);
    const { rateLimits } = await readCodexEvents(file, 0);
    expect(rateLimits!.windows).toEqual([{ label: '1h', usedPercent: 5, resetsAt: 9_000 }]);
  });

  it('reports no rate limits when the rollout carries none', async () => {
    const file = await write('rollout-a.jsonl', [meta, tokenCount({ output_tokens: 1 })]);
    const { rateLimits } = await readCodexEvents(file, 0);
    expect(rateLimits).toBeNull();
  });

  it('counts malformed lines as skipped', async () => {
    const file = await write('rollout-a.jsonl', ['{oops', meta, tokenCount({ output_tokens: 2 })]);
    const { events, skipped } = await readCodexEvents(file, 0);
    expect(events).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('takes the model from turn_context and follows a mid-session switch', async () => {
    const turn = (model: string) => JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-08-31T20:09:00.000Z',
      payload: { turn_id: 't1', cwd: '/repo/wt', model },
    });
    const file = await write('rollout-a.jsonl', [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-31T20:08:14.000Z',
        payload: {
          id: 'sess-1',
          cwd: '/repo/wt',
          base_instructions: { provenance: { type: 'model', model: 'gpt-5.6-sol' } },
        },
      }),
      tokenCount({ output_tokens: 1 }),
      turn('gpt-5-codex'),
      tokenCount({ output_tokens: 1 }),
    ]);
    const { events } = await readCodexEvents(file, 0);
    expect(events.map((e) => e.model)).toEqual(['gpt-5.6-sol', 'gpt-5-codex']);
  });

  it('resumes from an offset, remembering the session model and cwd', async () => {
    const file = await write('rollout-a.jsonl', [meta, tokenCount({ output_tokens: 2 })]);
    const first = await readCodexEvents(file, 0);
    await fsp.appendFile(file, `${tokenCount({ output_tokens: 3 })}\n`);
    const second = await readCodexEvents(file, first.offset, { cwd: first.cwd, model: 'gpt-5.6' });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ cwd: '/repo/wt', model: 'gpt-5.6' });
  });
});

describe('codexRolloutFiles', () => {
  it('finds rollouts nested under year/month/day', async () => {
    await write(path.join('2026', '08', '31', 'rollout-a.jsonl'), [meta]);
    await write(path.join('2026', '09', '01', 'rollout-b.jsonl'), [meta]);
    await write(path.join('2026', '09', '01', 'notes.txt'), ['x']);
    const files = await codexRolloutFiles(dir);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl']);
  });

  it('returns nothing when the root is missing', async () => {
    expect(await codexRolloutFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});
