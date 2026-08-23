import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateStore, WorktreeMeta } from '../../src/state';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'state-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function sampleMeta(): WorktreeMeta {
  return {
    repoId: 'acme-react-app',
    ticketId: 'FD-1',
    title: 'thing',
    linkedFrom: null,
    linkedAt: null,
    port: 8080,
    env: {},
    lastStartedAt: null,
  };
}

describe('state store', () => {
  it('returns empty state when file missing', async () => {
    const store = createStateStore(path.join(tmp, 'state.json'));
    expect(await store.list()).toEqual([]);
  });

  it('writes and reads a worktree entry', async () => {
    const store = createStateStore(path.join(tmp, 'state.json'));
    await store.upsert('/repos/app/.worktrees/FD-1_thing', sampleMeta());
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('/repos/app/.worktrees/FD-1_thing');
    expect(entries[0].meta.ticketId).toBe('FD-1');
  });

  it('removes an entry', async () => {
    const store = createStateStore(path.join(tmp, 'state.json'));
    await store.upsert('/repos/app/.worktrees/FD-1_thing', sampleMeta());
    await store.remove('/repos/app/.worktrees/FD-1_thing');
    expect(await store.list()).toEqual([]);
  });

  it('writes file atomically via tmp+rename', async () => {
    const file = path.join(tmp, 'state.json');
    const store = createStateStore(file);
    await store.upsert('/x', sampleMeta());
    const raw = await fs.readFile(file, 'utf8');
    expect(JSON.parse(raw).worktrees['/x'].ticketId).toBe('FD-1');
  });

  it('round-trips ticketProvider: linear', async () => {
    const store = createStateStore(path.join(tmp, 'state.json'));
    const meta = { ...sampleMeta(), ticketProvider: 'linear' as const };
    await store.upsert('/repos/app/.worktrees/LIN-1_thing', meta);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].meta.ticketProvider).toBe('linear');
  });

  it('omits ticketProvider field defaults to null', async () => {
    const store = createStateStore(path.join(tmp, 'state.json'));
    await store.upsert('/repos/app/.worktrees/FD-1_thing', sampleMeta());
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].meta.ticketProvider).toBeUndefined();
  });
});
