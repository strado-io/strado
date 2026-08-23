import { describe, expect, it } from 'vitest';
import { sortByOrder, computeReorderPatches, dropPlace } from './rowOrder';
import type { Worktree } from '../types';

// Apply patches to the (unsorted) state list and return the resulting display order.
function applyAndSort(state: Worktree[], patches: { path: string; order: number }[]): string[] {
  const next = state.map((w) => {
    const p = patches.find((x) => x.path === w.path);
    return p ? ({ ...w, meta: { ...w.meta!, order: p.order } } as Worktree) : w;
  });
  return sortByOrder(next).map((w) => w.path);
}

function wt(path: string, order?: number | null): Worktree {
  return {
    path, repoId: 'r', branch: 'b', head: 'h', prunable: false, tracked: true,
    meta: { repoId: 'r', ticketId: path, title: path, linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null, order: order ?? null },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  } as Worktree;
}

describe('sortByOrder', () => {
  it('orders by meta.order ascending; unordered fall back to original index', () => {
    const list = [wt('/a'), wt('/b', 0.5), wt('/c')]; // a(idx0), b(0.5), c(idx2)
    // effective: a=0, b=0.5, c=2 -> a, b, c
    expect(sortByOrder(list).map((w) => w.path)).toEqual(['/a', '/b', '/c']);
  });

  it('moves a low-order row to the top', () => {
    const list = [wt('/a'), wt('/b'), wt('/c', -1)];
    // effective: a=0, b=1, c=-1 -> c, a, b
    expect(sortByOrder(list).map((w) => w.path)).toEqual(['/c', '/a', '/b']);
  });

  it('is stable for equal effective orders', () => {
    const list = [wt('/a'), wt('/b')]; // a=0, b=1
    expect(sortByOrder(list).map((w) => w.path)).toEqual(['/a', '/b']);
  });
});

describe('computeReorderPatches', () => {
  it('drop after a row produces the exact dropped sequence', () => {
    const state = [wt('/a', 0), wt('/b', 1), wt('/c', 2)];
    const patches = computeReorderPatches(state, '/c', '/a', 'after');
    expect(applyAndSort(state, patches)).toEqual(['/a', '/c', '/b']);
  });

  it('drop before the first row moves the dragged row to the top', () => {
    const state = [wt('/a', 0), wt('/b', 1), wt('/c', 2)];
    const patches = computeReorderPatches(state, '/c', '/a', 'before');
    expect(applyAndSort(state, patches)).toEqual(['/c', '/a', '/b']);
  });

  it('lands exactly where dropped even when earlier drags left mixed implicit/explicit orders', () => {
    // a,b,c created without explicit orders; d was previously dragged
    // before b (fractional order). Display: a, d, b, c.
    const state = [wt('/a'), wt('/b'), wt('/c'), wt('/d', 0.5)];
    const display = sortByOrder(state);
    expect(display.map((w) => w.path)).toEqual(['/a', '/d', '/b', '/c']);

    // Now drag c and drop it BEFORE b — it must land between d and b.
    const patches = computeReorderPatches(display, '/c', '/b', 'before');
    expect(applyAndSort(state, patches)).toEqual(['/a', '/d', '/c', '/b']);
  });

  it('emits no patches for unknown targets or self-drops', () => {
    const state = [wt('/a', 0), wt('/b', 1)];
    expect(computeReorderPatches(state, '/a', '/missing', 'before')).toEqual([]);
    expect(computeReorderPatches(state, '/a', '/a', 'before')).toEqual([]);
  });

  it('skips rows whose order already matches', () => {
    const state = [wt('/a', 0), wt('/b', 1), wt('/c', 2)];
    // dropping c after b changes nothing
    expect(computeReorderPatches(state, '/c', '/b', 'after')).toEqual([]);
  });

  it('includes untracked rows so a mixed backlog reorders as a whole', () => {
    const untracked = (path: string): Worktree => ({ ...wt(path), meta: null } as Worktree);
    const display = [untracked('/u1'), wt('/t1'), untracked('/u2')];
    const patches = computeReorderPatches(display, '/u2', '/u1', 'before');
    expect(patches).toEqual([
      { path: '/u2', order: 0 },
      { path: '/u1', order: 1 },
      { path: '/t1', order: 2 },
    ]);
  });
});

describe('dropPlace', () => {
  it('returns before in the top half and after in the bottom half', () => {
    const rect = { top: 100, height: 40 }; // mid = 120
    expect(dropPlace(110, rect)).toBe('before');
    expect(dropPlace(130, rect)).toBe('after');
  });
});
