import { useEffect, useState } from 'react';
import type { Worktree, MergeRequest } from '../types';
import { api } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { useResizableWidth } from '../hooks/resizableWidth';

export type ChangeFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  staged: 'none' | 'partial' | 'full';
  untracked: boolean;
  renamedFrom?: string;
};

const GLYPH: Record<ChangeFile['status'], string> = { A: 'A', M: 'M', D: 'D', R: 'R', U: 'U' };
const TONE: Record<ChangeFile['status'], string> = {
  A: 'text-emerald-400', M: 'text-amber-400', D: 'text-red-400', R: 'text-sky-400', U: 'text-zinc-400',
};

type MrProbe =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'needsAuth'; provider: 'gitlab' | 'github' }
  | { kind: 'list'; provider: 'gitlab' | 'github'; mergeRequests: MergeRequest[] };

const STATE_TONE: Record<MergeRequest['state'], string> = {
  open: 'text-emerald-400', merged: 'text-purple-400', closed: 'text-zinc-500',
};
const PIPE_GLYPH: Record<NonNullable<MergeRequest['pipeline']>, string> = {
  success: '✓', failed: '✗', running: '…', pending: '…', canceled: '⊘',
};

// Toggleable right rail inside the hub pane: the active worktree's git changes,
// plus (when the repo lives on GitLab or GitHub) its open merge requests. A launcher, not
// a diff implementation — clicking a file opens the full DiffView, clicking an
// MR opens the MrReview overlay.
export function ChangesRail({
  worktree, open, onToggle, onOpenFile, onOpenMr, refreshKey,
}: {
  worktree: Worktree;
  open: boolean;
  onToggle: () => void;
  onOpenFile: (file: string) => void;
  onOpenMr?: (mr: MergeRequest) => void;
  refreshKey?: number;
}) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [tab, setTab] = useState<'changes' | 'mrs'>('changes');
  const [files, setFiles] = useState<ChangeFile[] | null>(null);
  const [error, setError] = useState(false);
  const [mr, setMr] = useState<MrProbe>({ kind: 'loading' });
  const [mrRefresh, setMrRefresh] = useState(0);
  // Drag the left edge to resize; persisted width. 256 = the old fixed w-64.
  const { width, resizing, handleProps } = useResizableWidth({
    storageKey: 'strado.changesRailWidth', min: 200, max: 480, fallback: 256, edge: 'left',
  });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(false);
    api.worktrees.git.changes(wsId, worktree.path)
      .then((res) => { if (alive) setFiles(res.files as ChangeFile[]); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [open, wsId, worktree.path, refreshKey]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setMr({ kind: 'loading' });
    api.worktrees.mergeRequests(wsId, worktree.path)
      .then((r) => { if (alive) setMr(r); })
      .catch(() => { if (alive) setMr({ kind: 'absent' }); });
    return () => { alive = false; };
  }, [open, wsId, worktree.path, refreshKey, mrRefresh]);

  // GitlabSection/GithubSection fire this after a successful connect so the
  // rail doesn't keep showing "Connect …" until an unrelated refresh happens
  useEffect(() => {
    const onConnected = () => setMrRefresh((n) => n + 1);
    window.addEventListener('strado:git-provider-connected', onConnected);
    return () => window.removeEventListener('strado:git-provider-connected', onConnected);
  }, []);

  if (!open) return null;
  const showMrTab = mr.kind !== 'absent';
  const active = showMrTab ? tab : 'changes';
  const provider = mr.kind === 'needsAuth' || mr.kind === 'list' ? mr.provider : 'gitlab';
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab';
  const mrNoun = provider === 'github' ? 'Pull Requests' : 'Merge Requests';

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-zinc-800 bg-zinc-950" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes rail"
        className={`absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize ${resizing ? 'bg-sky-500/50' : 'hover:bg-sky-500/30'}`}
        {...handleProps}
      />
      <div className="flex items-center justify-between border-b border-zinc-800 pr-1 text-xs text-zinc-300">
        <div className="flex">
          <button
            className={`whitespace-nowrap px-3 py-2 uppercase tracking-wide ${active === 'changes' ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
            onClick={() => setTab('changes')}
          >
            Changes ({files?.length ?? 0})
          </button>
          {showMrTab && (
            // Short label: the rail is w-64 and the spelled-out noun plus a
            // count wraps onto a second line; the full noun lives in `title`.
            <button
              title={mrNoun}
              className={`whitespace-nowrap px-3 py-2 uppercase tracking-wide ${active === 'mrs' ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
              onClick={() => setTab('mrs')}
            >
              {provider === 'github' ? 'PRs' : 'MRs'}{mr.kind === 'list' ? ` (${mr.mergeRequests.length})` : ''}
            </button>
          )}
        </div>
        <button className="rounded px-1.5 text-zinc-500 hover:text-zinc-200" onClick={onToggle} aria-label="Collapse rail">✕</button>
      </div>

      <div className="flex-1 overflow-auto p-1">
        {active === 'changes' ? (
          error ? <div className="px-2 py-2 text-xs text-red-300">Couldn't load changes.</div>
          : files === null ? <div className="px-2 py-2 text-xs text-zinc-600">Loading…</div>
          : files.length === 0 ? <div className="px-2 py-2 text-xs text-zinc-600">No changes</div>
          : files.map((f) => (
              <button key={f.path} onClick={() => onOpenFile(f.path)} title={f.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-zinc-300 hover:bg-zinc-900">
                <span className={`w-3 shrink-0 font-mono ${TONE[f.status]}`}>{GLYPH[f.status]}</span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
              </button>
            ))
        ) : (
          mr.kind === 'loading' ? <div className="px-2 py-2 text-xs text-zinc-600">Loading…</div>
          : mr.kind === 'needsAuth' ? (
            <div className="px-2 py-3 text-xs text-zinc-400">
              <p className="mb-2">Connect {providerName} to see {provider === 'github' ? 'pull requests' : 'merge requests'} for this branch.</p>
              <button onClick={() => window.dispatchEvent(new CustomEvent('strado:open-settings', { detail: { section: provider } }))}
                className="rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700">Connect {providerName}</button>
            </div>
          )
          : mr.kind === 'absent' ? null
          : mr.mergeRequests.length === 0 ? <div className="px-2 py-2 text-xs text-zinc-600">No {provider === 'github' ? 'pull requests' : 'merge requests'} for this branch</div>
          : mr.mergeRequests.map((m) => (
              <button key={m.number} onClick={() => onOpenMr?.(m)} title={m.title}
                className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-zinc-900">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-zinc-500">{(m.provider ?? provider) === 'github' ? '#' : '!'}{m.number}</span>
                  <span className={`uppercase ${STATE_TONE[m.state]}`}>{m.state}</span>
                  {m.pipeline && <span className="text-zinc-400">{PIPE_GLYPH[m.pipeline]}</span>}
                  {m.approvals && <span className="text-zinc-500">{m.approvals.given}/{m.approvals.required}</span>}
                </span>
                <span className="min-w-0 truncate text-zinc-300">{m.title}</span>
              </button>
            ))
        )}
      </div>
    </aside>
  );
}
