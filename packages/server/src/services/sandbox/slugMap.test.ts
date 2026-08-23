import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxSlugMap, hydrateSandboxSlugs } from './slugMap.js';
import { createStateStore } from '../../state.js';
import type { WorktreeMeta } from '../../state.js';

const meta = (over: Partial<WorktreeMeta> = {}): WorktreeMeta => ({
  repoId: 'r1',
  ticketId: 'T-1',
  title: 'x',
  linkedFrom: null,
  linkedAt: null,
  port: null,
  env: {},
  lastStartedAt: null,
  ...over,
});

describe('sandbox slug map', () => {
  it('returns null for an unknown path', () => {
    expect(createSandboxSlugMap().slugOf('/w')).toBeNull();
  });

  it('resolves an exact worktree path', () => {
    const m = createSandboxSlugMap();
    m.set('/w/feat', 'feat-abc');
    expect(m.slugOf('/w/feat')).toBe('feat-abc');
  });

  it('resolves a subdirectory of a sandboxed worktree (projectSubdir sessions)', () => {
    const m = createSandboxSlugMap();
    m.set('/w/feat', 'feat-abc');
    expect(m.slugOf('/w/feat/apps/web')).toBe('feat-abc');
  });

  it('does not match a sibling whose path merely shares a prefix', () => {
    const m = createSandboxSlugMap();
    m.set('/w/feat', 'feat-abc');
    expect(m.slugOf('/w/feature-two')).toBeNull();
  });

  it('prefers the longest matching prefix when worktrees nest', () => {
    const m = createSandboxSlugMap();
    m.set('/w', 'outer');
    m.set('/w/inner', 'inner');
    expect(m.slugOf('/w/inner/src')).toBe('inner');
    expect(m.slugOf('/w/other/src')).toBe('outer');
  });

  it('tolerates a trailing slash on both sides', () => {
    const m = createSandboxSlugMap();
    m.set('/w/feat/', 'feat-abc');
    expect(m.slugOf('/w/feat')).toBe('feat-abc');
    expect(m.slugOf('/w/feat/')).toBe('feat-abc');
  });

  it('forgets a deleted worktree', () => {
    const m = createSandboxSlugMap();
    m.set('/w/feat', 'feat-abc');
    m.delete('/w/feat');
    expect(m.slugOf('/w/feat/src')).toBeNull();
  });

  it('hydrates from every workspace state store, sandboxed rows only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-slugs-'));
    const a = createStateStore(path.join(dir, 'a.json'));
    const b = createStateStore(path.join(dir, 'b.json'));
    await a.upsert('/w/one', meta({ sandbox: { slug: 'one-111' } }));
    await a.upsert('/w/plain', meta());
    await b.upsert('/w/two', meta({ sandbox: { slug: 'two-222' } }));
    await b.upsert('/w/cleared', meta({ sandbox: null }));

    const m = createSandboxSlugMap();
    await hydrateSandboxSlugs(m, {
      workspaces: { list: async () => [{ id: 'a' }, { id: 'b' }] },
      stores: async (id) => ({ state: id === 'a' ? a : b }),
    });

    expect(m.slugOf('/w/one/src')).toBe('one-111');
    expect(m.slugOf('/w/two')).toBe('two-222');
    expect(m.slugOf('/w/plain')).toBeNull();
    expect(m.slugOf('/w/cleared')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a broken workspace does not cost the others their sandboxes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-slugs-'));
    const good = createStateStore(path.join(dir, 'good.json'));
    await good.upsert('/w/one', meta({ sandbox: { slug: 'one-111' } }));

    const errors: string[] = [];
    const m = createSandboxSlugMap();
    await hydrateSandboxSlugs(m, {
      workspaces: { list: async () => [{ id: 'broken' }, { id: 'good' }] },
      stores: async (id) => {
        if (id === 'broken') throw new Error('state file is corrupt');
        return { state: good };
      },
      onError: (id, err) => errors.push(`${id}: ${err.message}`),
    });

    expect(m.slugOf('/w/one')).toBe('one-111');
    expect(errors).toEqual(['broken: state file is corrupt']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
