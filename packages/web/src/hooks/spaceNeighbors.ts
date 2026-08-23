import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RepoConfig, Workspace, Worktree } from '../types';

export type SpaceSnapshot = { repos: RepoConfig[]; worktrees: Worktree[] } | null;
export type Neighbour = { space: Workspace; data: SpaceSnapshot } | null;

/**
 * Repos + worktrees for the spaces either side of the active one, so the
 * sidebar carousel has real content to slide in. Snapshots only: no SSE, no
 * polling — a neighbour pane is a picture of that space, and goes live the
 * moment you land on it.
 */
export function useSpaceNeighbors(allWorkspaces: Workspace[], activeId: string) {
  const idx = allWorkspaces.findIndex((w) => w.id === activeId);
  const prev = idx > 0 ? allWorkspaces[idx - 1]! : null;
  const next = idx >= 0 && idx < allWorkspaces.length - 1 ? allWorkspaces[idx + 1]! : null;
  const [snapshots, setSnapshots] = useState<Record<string, SpaceSnapshot>>({});

  useEffect(() => {
    let alive = true;
    const load = async (id: string) => {
      try {
        const [repos, worktrees] = await Promise.all([api.repos.list(id), api.worktrees.list(id)]);
        if (alive) setSnapshots((s) => ({ ...s, [id]: { repos, worktrees } }));
      } catch {
        // A neighbour that won't load stays an empty pane. It must never throw
        // into the sidebar or delay the active space's paint.
        if (alive) setSnapshots((s) => ({ ...s, [id]: null }));
      }
    };

    // Prune snapshots to only include current neighbours, preventing unbounded cache growth
    const currentNeighbourIds = new Set<string>();
    if (prev) currentNeighbourIds.add(prev.id);
    if (next) currentNeighbourIds.add(next.id);

    setSnapshots((s) => {
      const pruned: Record<string, SpaceSnapshot> = {};
      for (const id of currentNeighbourIds) {
        if (id in s) {
          pruned[id] = s[id]!;
        }
      }
      return pruned;
    });

    // Deferred, never issued straight from the effect. Child effects run
    // before their parent's, so a bare call here puts two spaces' worth of
    // `GET /worktrees` — a `git worktree list` per repo, plus diff stats —
    // in front of the active space's own load, on an origin with six
    // connections. The snapshots only have to exist before a swipe starts.
    const start = () => { for (const w of [prev, next]) if (w) void load(w.id); };
    let cancel: () => void;
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(start, { timeout: 2000 });
      cancel = () => window.cancelIdleCallback?.(handle);
    } else {
      const handle = window.setTimeout(start, 0);
      cancel = () => window.clearTimeout(handle);
    }

    return () => {
      alive = false;
      cancel();
    };
  }, [prev?.id, next?.id]);

  return {
    prev: prev ? { space: prev, data: snapshots[prev.id] ?? null } : null,
    next: next ? { space: next, data: snapshots[next.id] ?? null } : null,
  };
}
