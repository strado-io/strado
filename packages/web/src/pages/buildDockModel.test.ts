import { describe, expect, it } from 'vitest';
import { buildDockModel } from './Dashboard';
import type { RemoteWorktree } from '../api';
import type { Worktree } from '../types';

function rw(over: Partial<RemoteWorktree> = {}): RemoteWorktree {
  return {
    runnerId: 'run1', runnerName: 'runner-dev', wsBase: 'wss://x', remoteWsId: 'ws1',
    path: '/w/FD-1', name: 'FD-1', branch: 'b', head: 'h',
    remoteRepoId: 'rr', isRepoRoot: false, cloneUrl: null, localRepoId: 'r',
    ...over,
  };
}

function localWorktree(over: Partial<Worktree> = {}): Worktree {
  return {
    path: '/home/dev/repo.worktrees/FD-2',
    remote: null,
    repoId: 'r',
    branch: 'b',
    head: 'h',
    prunable: false,
    tracked: true,
    meta: null,
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
    ...over,
  };
}

describe('buildDockModel', () => {
  it('gives two runners with the SAME real path distinct dock entries, machine labels, and lookups', () => {
    const remoteA = rw({ runnerId: 'run-a', runnerName: 'alpha', path: '/w/FD-1', hasClaudeSession: true });
    const remoteB = rw({ runnerId: 'run-b', runnerName: 'beta', path: '/w/FD-1', hasClaudeSession: true });

    const { dockWorktrees, machineLabel, remoteByKey } = buildDockModel([], [remoteA, remoteB]);

    // Two distinct dock entries, not one merged group — a path-only key would
    // have collapsed these into a single Worktree with path '/w/FD-1'.
    expect(dockWorktrees).toHaveLength(2);
    const paths = dockWorktrees.map((w) => w.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toEqual(['run-a /w/FD-1', 'run-b /w/FD-1']);

    // Each composite key still resolves to its OWN runner's label.
    expect(machineLabel('run-a /w/FD-1')).toBe('alpha');
    expect(machineLabel('run-b /w/FD-1')).toBe('beta');

    // ...and remoteByKey resolves each composite key to the correct runner,
    // with the ORIGINAL (real) RemoteWorktree fields intact.
    expect(remoteByKey.get('run-a /w/FD-1')).toBe(remoteA);
    expect(remoteByKey.get('run-b /w/FD-1')).toBe(remoteB);
    expect(remoteByKey.get('run-a /w/FD-1')?.path).toBe('/w/FD-1');
    expect(remoteByKey.get('run-b /w/FD-1')?.path).toBe('/w/FD-1');
  });

  it('derives the chip-visible basename correctly from the composite key', () => {
    const remote = rw({ runnerId: 'run-a', path: '/w/FD-1' });
    const { dockWorktrees } = buildDockModel([], [remote]);
    // The label helper in hooks/sessions.ts derives the chip label via
    // path.split('/').pop() — the composite key must still yield the real
    // basename/ticket, not the runnerId.
    expect(dockWorktrees[0]!.path.split('/').pop()).toBe('FD-1');
  });

  it('leaves local worktrees with their own real path and no machine label', () => {
    const local = localWorktree({ path: '/home/dev/repo.worktrees/FD-2' });
    const { dockWorktrees, machineLabel, remoteByKey } = buildDockModel([local], []);

    expect(dockWorktrees).toEqual([local]);
    expect(machineLabel('/home/dev/repo.worktrees/FD-2')).toBeNull();
    expect(remoteByKey.get('/home/dev/repo.worktrees/FD-2')).toBeUndefined();
  });

  it('carries remote session state onto the merged worktree so the rail can read it', () => {
    const remote = rw({ runnerId: 'run-a', path: '/w/FD-1', hasClaudeSession: true, claudeStatus: 'working' });
    const { dockWorktrees } = buildDockModel([], [remote]);
    expect(dockWorktrees[0]!.hasClaudeSession).toBe(true);
    expect(dockWorktrees[0]!.claudeStatus).toBe('working');
    expect(dockWorktrees[0]!.remote?.runnerName).toBe('runner-dev');
  });
});
