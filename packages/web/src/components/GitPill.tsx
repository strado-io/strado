// The hub's top-bar Git control, so pulling, pushing and opening a PR never
// needs the Changes tab: `⑂ branch  +12 −3  ↑2 ↓1 ▾`.
// - the counts open Changes (⌘L);
// - ↑N pushes the N commits ahead to origin, ↓N pulls the N behind; each shows
//   only when it isn't 0;
// - ▾: Pull, Pull from… (any branch, into this one), Push, Create PR…, Git tree, Refresh.
// Ahead/behind come from refresh-git (against origin/<branch>), re-read on
// mount, on focus, and after anything here. A push or pull reports in a small
// note under the pill. The Changes view listens for GIT_REFRESH_EVENT to reload.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiClientError } from '../api';
import { useRendererOverlay } from '../contexts/RendererOverlay';
import { CreateMrDialog } from './CreateMrDialog';
import type { Worktree } from '../types';

/** window event, detail { path }: that worktree's git state changed (Changes reloads). */
export const GIT_REFRESH_EVENT = 'strado:git-refresh';
export const announceGitChange = (path: string) => window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT, { detail: { path } }));

export type GitStatusSnap = { branch: string; ahead: number; behind: number };

/** 1234 → 1.2k, 12345 → 12k: the pill stays narrow. */
export const shortCount = (n: number): string =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;

const errMessage = (e: unknown) => (e instanceof ApiClientError || e instanceof Error ? e.message : String(e));

/** The worktree's branch and how far it is from origin, kept fresh. */
export function useGitStatus(wsId: string, path: string, enabled = true): [GitStatusSnap | null, () => void] {
  const [status, setStatus] = useState<GitStatusSnap | null>(null);
  const read = useCallback(() => {
    if (!enabled) return;
    Promise.resolve().then(() => api.worktrees.refreshGit(wsId, path))
      .then((s) => setStatus({ branch: s.branch, ahead: s.ahead, behind: s.behind }))
      .catch(() => { /* not a repo, or git failed: keep what we had */ });
  }, [wsId, path, enabled]);
  useEffect(() => {
    setStatus(null);
    read();
    const onFocus = () => read();
    const onChange = (e: Event) => { if ((e as CustomEvent<{ path: string }>).detail?.path === path) read(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener(GIT_REFRESH_EVENT, onChange);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener(GIT_REFRESH_EVENT, onChange); };
  }, [read, path]);
  return [status, read];
}

type Op = 'push' | 'pull' | null;

export function GitPill({ wsId, worktree, status, additions, deletions, active, onOpenChanges, onOpenTree }: {
  wsId: string;
  worktree: Worktree;
  status: GitStatusSnap | null;
  additions: number;
  deletions: number;
  /** The Changes tab is the one on screen. */
  active: boolean;
  onOpenChanges: () => void;
  onOpenTree: () => void;
}) {
  const [menu, setMenu] = useState<'main' | 'mr' | 'pull' | null>(null);
  const [op, setOp] = useState<Op>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [targets, setTargets] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');
  const [mrTarget, setMrTarget] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useRendererOverlay(menu !== null);
  const branch = status?.branch ?? null;

  useEffect(() => {
    if (!note) return;
    // A note can come without the menu ever opening (↑ / ↓): place it under the pill.
    setAnchor(root.current?.getBoundingClientRect() ?? null);
    const t = setTimeout(() => setNote(null), note.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [note]);

  const open = (which: 'main' | 'mr' | 'pull') => {
    setAnchor(root.current?.getBoundingClientRect() ?? null);
    setMenu(which);
  };
  const close = () => { setMenu(null); setFilter(''); };

  /** `source` for a pull: a branch to bring in ("origin/main", or a local one); default origin/<this branch>. */
  const run = async (kind: 'push' | 'pull', source?: string) => {
    close();
    if (op || !branch) return;
    setOp(kind);
    setNote(null);
    try {
      if (kind === 'push') {
        const { remotes } = await api.worktrees.git.remotes(wsId, worktree.path);
        const remote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (!remote) throw new Error('This repository has no remote to push to');
        await api.worktrees.git.push(wsId, worktree.path, remote);
        setNote({ text: `Pushed ${branch} to ${remote}`, error: false });
      } else {
        const from = source ?? `origin/${branch}`;
        await api.worktrees.git.pull(wsId, worktree.path, from);
        setNote({ text: `Pulled ${from} into ${branch}`, error: false });
      }
    } catch (e) {
      setNote({ text: errMessage(e), error: true });
    } finally {
      setOp(null);
      announceGitChange(worktree.path);
    }
  };

  // Create PR… targets: branches on origin. Pull from…: every other branch, local or remote.
  const openPicker = (which: 'mr' | 'pull') => {
    open(which);
    setTargets(null);
    api.worktrees.git.branches(wsId, worktree.path)
      .then((r) => {
        const cur = r.current ?? branch;
        setTargets(which === 'mr'
          ? [...new Set(r.branches.filter((b) => b.startsWith('origin/')).map((b) => b.slice('origin/'.length)))].filter((b) => b !== cur)
          : r.branches.filter((b) => b !== cur));
      })
      .catch((e) => { setTargets([]); setNote({ text: errMessage(e), error: true }); });
  };

  const pick = (t: string) => {
    if (menu === 'pull') void run('pull', t);
    else { setMrTarget(t); close(); }
  };
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40';
  const shown = (targets ?? []).filter((t) => t.toLowerCase().includes(filter.toLowerCase()));
  const below = anchor ? { top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) } : null;

  return (
    <div ref={root} className="relative flex shrink-0 self-center">
      <div className={`flex h-7 items-center rounded-md border transition ${
        active ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'}`}>
        <button
          type="button"
          onClick={onOpenChanges}
          title={`Changes (⌘L): +${additions} −${deletions} lines${branch ? ` on ${branch}` : ''}`}
          aria-label="Changes"
          aria-pressed={active}
          className="flex h-full items-center gap-1.5 rounded-l-[5px] pl-2 pr-1.5 hover:bg-white/5 hover:text-zinc-100"
        >
          {branch && (
            <span className="flex max-w-[9rem] items-center gap-1 text-[11px] text-zinc-300">
              <BranchIcon />
              <span className="truncate">{branch}</span>
            </span>
          )}
          <span className="flex gap-1 font-mono text-[11px] tabular-nums leading-none">
            <span className="text-emerald-400">+{shortCount(additions)}</span>
            <span className="text-red-300">−{shortCount(deletions)}</span>
          </span>
        </button>
        {(op === 'push' || (status?.ahead ?? 0) > 0) && (
          <button type="button" onClick={() => void run('push')} disabled={!!op} aria-label={`Push ${status?.ahead ?? 0} commits`}
            title={`Push ${status?.ahead ?? 0} commit${status?.ahead === 1 ? '' : 's'} to origin`}
            className="flex h-full items-center gap-0.5 px-1.5 font-mono text-[11px] tabular-nums text-sky-300 hover:bg-white/5 disabled:opacity-60">
            <span aria-hidden className={op === 'push' ? 'animate-pulse' : ''}>↑</span>{status?.ahead ?? 0}
          </button>
        )}
        {(op === 'pull' || (status?.behind ?? 0) > 0) && (
          <button type="button" onClick={() => void run('pull')} disabled={!!op} aria-label={`Pull ${status?.behind ?? 0} commits`}
            title={`Pull ${status?.behind ?? 0} commit${status?.behind === 1 ? '' : 's'} from origin`}
            className="flex h-full items-center gap-0.5 px-1.5 font-mono text-[11px] tabular-nums text-amber-300 hover:bg-white/5 disabled:opacity-60">
            <span aria-hidden className={op === 'pull' ? 'animate-pulse' : ''}>↓</span>{status?.behind ?? 0}
          </button>
        )}
        <span aria-hidden className="h-4 w-px bg-zinc-800" />
        <button type="button" onClick={() => (menu ? close() : open('main'))} aria-label="Git actions" aria-expanded={menu !== null}
          title="Git: pull, push, create PR, git tree"
          className="flex h-full items-center rounded-r-[5px] px-1 hover:bg-white/5 hover:text-zinc-100">
          <ChevronIcon />
        </button>
      </div>

      {note && below && createPortal(
        <div role="status" style={{ top: below.top, right: below.right }}
          className={`menu-solid fixed z-[95] max-w-sm rounded-lg border px-2.5 py-1.5 text-[11px] ${note.error ? 'text-red-300' : 'text-zinc-200'}`}>
          {note.text}
        </div>,
        document.body,
      )}

      {menu && below && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onMouseDown={close} />
          <div role="menu" aria-label={menu === 'mr' ? 'Create PR into' : menu === 'pull' ? 'Pull from' : 'Git'} style={{ top: below.top, right: below.right }}
            className="menu-solid fixed z-[91] w-60 rounded-xl border p-1"
            onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
            {menu === 'main' ? (
              <>
                <button role="menuitem" className={item} disabled={!!op || !branch} onClick={() => void run('pull')}>
                  <span className="w-4 text-center text-amber-300">↓</span>Pull{status?.behind ? <span className="ml-auto font-mono text-[11px] text-zinc-500">{status.behind}</span> : null}
                </button>
                <button role="menuitem" className={item} disabled={!!op || !branch} onClick={() => openPicker('pull')}>
                  <span className="w-4 text-center text-amber-300">↓</span>Pull from…
                </button>
                <button role="menuitem" className={item} disabled={!!op || !branch} onClick={() => void run('push')}>
                  <span className="w-4 text-center text-sky-300">↑</span>Push{status?.ahead ? <span className="ml-auto font-mono text-[11px] text-zinc-500">{status.ahead}</span> : null}
                </button>
                <button role="menuitem" className={item} disabled={!branch} onClick={() => openPicker('mr')}>
                  <span className="flex w-4 justify-center"><PrIcon /></span>Create PR…
                </button>
                <div className="my-1 h-px bg-zinc-800" />
                <button role="menuitem" className={item} onClick={() => { close(); onOpenTree(); }}>
                  <span className="flex w-4 justify-center"><BranchIcon /></span>Git tree
                </button>
                <button role="menuitem" className={item} onClick={() => { close(); announceGitChange(worktree.path); }}>
                  <span className="flex w-4 justify-center"><RefreshIcon /></span>Refresh
                </button>
              </>
            ) : (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] text-zinc-500">{menu === 'mr' ? `Create PR from ${branch} into` : `Pull into ${branch} from`}</div>
                <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search branches…" aria-label="Target branch"
                  onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) pick(shown[0]); }}
                  className="mb-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600" />
                <div className="max-h-64 overflow-y-auto">
                  {targets === null ? <div className="px-2 py-1.5 text-[11px] text-zinc-500">Loading branches…</div>
                    : shown.length === 0 ? <div className="px-2 py-1.5 text-[11px] text-zinc-500">{menu === 'mr' ? 'No branches on origin' : 'No other branches'}</div>
                    : shown.map((t) => (
                      <button key={t} role="menuitem" className={`${item} font-mono text-[11px]`} onClick={() => pick(t)}>{t}</button>
                    ))}
                </div>
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {mrTarget && (
        <CreateMrDialog
          wsId={wsId}
          worktreePath={worktree.path}
          branch={branch}
          target={mrTarget}
          initialTitle={worktree.meta?.ticketId && worktree.meta?.title ? `${worktree.meta.ticketId}: ${worktree.meta.title}` : (branch ?? '')}
          onClose={() => setMrTarget(null)}
          onCreated={(mr) => setNote({ text: `Created ${mr.provider === 'github' ? '#' : '!'}${mr.number} → ${mrTarget}`, error: false })}
        />
      )}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M6 9v6M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function PrIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v6M13 6h3a2 2 0 0 1 2 2v7" />
    </svg>
  );
}

// Lucide "rotate-cw", the same size and stroke as the menu's other icons.
function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
