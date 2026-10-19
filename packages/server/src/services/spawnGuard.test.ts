import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpawnGuard, SPAWN_IDEMPOTENCY_TTL_MS, SPAWN_RATE_PER_MIN } from './spawnGuard';

function guard(opts: { live?: Set<string>; max?: number; file?: string } = {}) {
  let t = 0;
  const live = opts.live ?? new Set<string>();
  const g = createSpawnGuard({ now: () => t, isLive: async (_s, e) => live.has(e), liveMax: () => opts.max ?? 8, file: opts.file });
  return { g, live, tick: (ms: number) => { t += ms; } };
}

describe('spawnGuard', () => {
  it('rate-limits per caller per minute, then recovers', async () => {
    const { g, tick } = guard();
    for (let i = 0; i < SPAWN_RATE_PER_MIN; i += 1) (await g.admit('s', 'a')).release();
    await expect(g.admit('s', 'a')).rejects.toMatchObject({ code: 'BACKPRESSURE', details: { reason: 'spawn_rate' } });
    (await g.admit('s', 'b')).release(); // another caller is unaffected
    tick(60_001);
    (await g.admit('s', 'a')).release();
  });

  it('parallel admits cannot overshoot the rate or the cap', async () => {
    const r1 = guard();
    const rate = await Promise.allSettled(Array.from({ length: 20 }, () => r1.g.admit('s', 'a')));
    expect(rate.filter((x) => x.status === 'fulfilled')).toHaveLength(SPAWN_RATE_PER_MIN);

    const r2 = guard({ max: 3 });
    const capped = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((c) => r2.g.admit('s', c)));
    expect(capped.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
    expect(capped.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason.details.reason)).toEqual(['spawn_cap', 'spawn_cap']);
  });

  it('caps live agent-spawned tabs per scope, counting only live ones; release frees a slot', async () => {
    const { g, live } = guard({ max: 2 });
    (await g.admit('s', 'p1')).commit('c1'); live.add('c1');
    const held = await g.admit('s', 'p2');
    await expect(g.admit('s', 'p3')).rejects.toMatchObject({ details: { reason: 'spawn_cap' } });
    held.release();
    (await g.admit('s', 'p4')).commit('c2'); live.add('c2');
    await expect(g.admit('s', 'p5')).rejects.toMatchObject({ details: { reason: 'spawn_cap' } });
    live.delete('c1');
    (await g.admit('s', 'p6')).release();
    (await g.admit('other', 'a')).release(); // other scope has none
  });

  it('a spawned execution cannot spawn (depth 1); markers are per execution and survive a restart', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spawnguard-')), 'spawn-markers.json');
    const first = guard({ file });
    (await first.g.admit('s', 'a')).commit('child-exec');
    expect(first.g.isSpawned('child-exec')).toBe(true);
    expect(first.g.isSpawned('a')).toBe(false);
    const after = guard({ file, live: new Set(['child-exec']) });
    expect(after.g.isSpawned('child-exec')).toBe(true);
    await expect(after.g.admit('s', 'child-exec')).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'spawn_depth' } });
  });

  it('idempotency: replays a finished response, waits for an in-flight one, refuses a different body', async () => {
    const { g, tick } = guard();
    expect(await g.begin('s', 'a', 'k', 'h1')).toBeNull();
    const waiting = g.begin('s', 'a', 'k', 'h1');
    await expect(g.begin('s', 'a', 'k', 'h2')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'idempotency_mismatch' } });
    g.complete('s', 'a', 'k', { agent: 'c' });
    expect(await waiting).toEqual({ response: { agent: 'c' } });
    expect(await g.begin('s', 'a', 'k', 'h1')).toEqual({ response: { agent: 'c' } });
    expect(await g.begin('s', 'b', 'k', 'h1')).toBeNull(); // per caller
    expect(await g.begin('s', 'a', null, 'h1')).toBeNull();
    tick(SPAWN_IDEMPOTENCY_TTL_MS + 1);
    expect(await g.begin('s', 'a', 'k', 'h1')).toBeNull();
  });

  it('idempotency: an abandoned key fails its waiters and can be reused', async () => {
    const { g } = guard();
    await g.begin('s', 'a', 'k', 'h');
    const waiting = g.begin('s', 'a', 'k', 'h');
    g.abandon('s', 'a', 'k');
    await expect(waiting).rejects.toMatchObject({ details: { reason: 'idempotency_failed' } });
    expect(await g.begin('s', 'a', 'k', 'h')).toBeNull();
  });
});
