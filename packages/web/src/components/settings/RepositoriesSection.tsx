// Settings → Repositories: the workspace's repos, now that the sidebar has no
// repo list. Add, remove, or start a worktree in one. Worktrees themselves are
// reached through ⌘K and the Focus.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { RepoConfig } from '../../types';
import { useWorkspace } from '../../hooks/useWorkspace';
import { AddRepoDialog } from '../AddRepoDialog';

export function RepositoriesSection({ onNewWorktree, onChanged, onModalChange }: {
  onNewWorktree?: (repoId: string) => void;
  onChanged?: () => void | Promise<void>;
  // Tells the host page a dialog is open, so its own Escape handling can stand down.
  onModalChange?: (open: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const [repos, setRepos] = useState<RepoConfig[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rs, wts] = await Promise.all([api.repos.list(workspace.id), api.worktrees.list(workspace.id)]);
      const m = new Map<string, number>();
      for (const w of wts) if (w.repoId) m.set(w.repoId, (m.get(w.repoId) ?? 0) + 1);
      setRepos(rs);
      setCounts(m);
    } catch (e) {
      setError((e as Error).message);
      // Keep what was listed; an empty list only so a first-load failure still
      // renders the section with its error.
      setRepos((prev) => prev ?? []);
    }
  }, [workspace.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    onModalChange?.(adding);
    return () => onModalChange?.(false);
  }, [adding, onModalChange]);

  async function remove(repo: RepoConfig) {
    if (!confirm(`Remove "${repo.name}" from this workspace? Worktrees on disk are left untouched.`)) return;
    setBusy(repo.id);
    setError(null);
    try {
      await api.repos.remove(workspace.id, repo.id);
      await refresh();
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!repos) return null;
  return (
    <section className="max-w-2xl">
      <header className="mb-6 flex items-center justify-between pr-10">
        <h1 className="text-lg font-semibold text-zinc-100">Repositories</h1>
        <button type="button" onClick={() => setAdding(true)}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white">
          Add repository
        </button>
      </header>
      {repos.length === 0 && !error && <p className="text-sm text-zinc-500">No repositories yet.</p>}
      <ul className="space-y-2">
        {repos.map((repo) => {
          const n = counts.get(repo.id) ?? 0;
          return (
            <li key={repo.id} className="flex items-center gap-3 rounded-lg bg-zinc-900/35 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-zinc-200">{repo.name}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-zinc-600">{repo.path}</div>
              </div>
              <span className="shrink-0 text-xs text-zinc-500">{n} worktree{n === 1 ? '' : 's'}</span>
              {onNewWorktree && (
                <button type="button" aria-label={`New worktree in ${repo.name}`} onClick={() => onNewWorktree(repo.id)}
                  className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                  New worktree
                </button>
              )}
              <button type="button" aria-label={`Remove ${repo.name}`} disabled={busy === repo.id} onClick={() => void remove(repo)}
                className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40">
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      {error && <div role="alert" className="mt-4 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}
      {adding && (
        <AddRepoDialog anchor={null}
          onAdded={async () => { await refresh(); await onChanged?.(); }}
          onClose={() => setAdding(false)} />
      )}
    </section>
  );
}
