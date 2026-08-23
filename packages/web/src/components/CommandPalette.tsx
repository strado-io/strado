import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { RepoConfig, Workspace, Worktree } from '../types';
import { ShellIcon, ClaudeIcon, CodexIcon, VsCodeIcon, GlobeIcon, BookIcon } from './hub/icons';
import { hasSession } from '../hooks/sessions';
import { readVscodeTabs } from '../hooks/vscodeTabs';
import { readBrowserTabs } from '../hooks/browserTabs';
import { readKbTabs } from '../hooks/kbTabs';
import { readWorktreeLru, compareByActivityThenRecency, type RankableWorktree } from '../lib/worktreeLru';

type Result =
  | { kind: 'worktree'; id: string; label: string; detail: string; worktree: Worktree; wsId?: string }
  | { kind: 'repo'; id: string; label: string; detail: string; repoId: string }
  | { kind: 'workspace'; id: string; label: string; detail: string; wsId: string };

const GROUP_LABEL: Record<Result['kind'], string> = {
  worktree: 'Worktrees',
  repo: 'Repos',
  workspace: 'Workspaces',
};

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// ⌘K global search: one box over everything navigable — worktrees (opens the
// hub), repos (switches the view), workspaces (switches context).
export function CommandPalette({
  repos,
  worktrees,
  workspaces,
  activeWorkspaceId,
  onOpenWorktree,
  onGoRepo,
  onSwitchWorkspace,
  onClose,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  // wsId set when the worktree lives in another workspace (switch first)
  onOpenWorktree: (w: Worktree, wsId?: string) => void;
  onGoRepo: (repoId: string) => void;
  onSwitchWorkspace: (wsId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);
  // Client-only embed tabs (VS Code / Browser / Knowledge Base) live in
  // localStorage, not on the Worktree — read once per palette open so rows
  // can badge them too.
  const vscodeTabs = useMemo(() => readVscodeTabs(), []);
  const browserTabs = useMemo(() => readBrowserTabs(), []);
  const kbTabs = useMemo(() => readKbTabs(), []);

  // Worktrees from the OTHER workspaces, loaded once per palette open so
  // any worktree is reachable without switching workspace first.
  const [remote, setRemote] = useState<{ ws: Workspace; items: Worktree[] }[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      workspaces
        .filter((ws) => ws.id !== activeWorkspaceId)
        .map(async (ws) => ({ ws, items: await api.worktrees.list(ws.id).catch(() => [] as Worktree[]) })),
    ).then((loaded) => {
      if (alive) setRemote(loaded);
    });
    return () => {
      alive = false;
    };
  }, [workspaces, activeWorkspaceId]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const lru = readWorktreeLru();
    const out: Result[] = [];

    // Collect every matching worktree (local + remote) into one list, then rank
    // by activity + recency so the ones the user is working in float to the top.
    const isActive = (w: Worktree) => hasSession(w) || w.process?.status === 'running';
    const wts: (RankableWorktree & { result: Extract<Result, { kind: 'worktree' }> })[] = [];
    let index = 0;
    for (const w of worktrees) {
      const ticket = w.meta?.ticketId ?? '';
      const title = w.meta?.title ?? '';
      const repo = (w.repoId && repoName.get(w.repoId)) || '';
      if (q && !matches(q, ticket, title, w.branch, repo)) continue;
      wts.push({
        path: w.path,
        active: isActive(w),
        index: index++,
        result: {
          kind: 'worktree',
          id: w.path,
          label: ticket || w.branch || w.path.split('/').pop() || w.path,
          detail: [title, repo].filter(Boolean).join(' · '),
          worktree: w,
        },
      });
    }
    for (const { ws, items } of remote) {
      for (const w of items) {
        const ticket = w.meta?.ticketId ?? '';
        const title = w.meta?.title ?? '';
        if (q && !matches(q, ticket, title, w.branch, ws.name)) continue;
        wts.push({
          path: w.path,
          active: isActive(w),
          index: index++,
          result: {
            kind: 'worktree',
            id: `${ws.id}:${w.path}`,
            label: ticket || w.branch || w.path.split('/').pop() || w.path,
            detail: [title, `${ws.name} · switch & open`].filter(Boolean).join(' · '),
            worktree: w,
            wsId: ws.id,
          },
        });
      }
    }
    wts.sort((a, b) => compareByActivityThenRecency(a, b, lru));
    for (const { result } of wts) out.push(result);

    for (const r of repos) {
      if (q && !matches(q, r.name, r.path)) continue;
      out.push({ kind: 'repo', id: r.id, label: r.name, detail: r.path, repoId: r.id });
    }
    for (const ws of workspaces) {
      if (ws.id === activeWorkspaceId) continue;
      if (q && !matches(q, ws.name)) continue;
      out.push({ kind: 'workspace', id: ws.id, label: ws.name, detail: 'switch workspace', wsId: ws.id });
    }
    return out.slice(0, 15);
  }, [query, worktrees, remote, repos, workspaces, activeWorkspaceId, repoName]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  const pick = (r: Result) => {
    onClose();
    if (r.kind === 'worktree') onOpenWorktree(r.worktree, r.wsId);
    else if (r.kind === 'repo') onGoRepo(r.repoId);
    else onSwitchWorkspace(r.wsId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[sel];
      if (r) pick(r);
    }
  };

  let lastKind: Result['kind'] | null = null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[18vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-900 px-3">
          <svg aria-hidden width="15" height="15" viewBox="0 0 16 16" className="shrink-0 text-zinc-500">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search worktrees, repos, workspaces…"
            aria-label="Global search"
            className="h-11 w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <kbd className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-500">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 && <div className="px-3 py-6 text-center text-xs text-zinc-600">No matches</div>}
          {results.map((r, i) => {
            const header = r.kind !== lastKind ? GROUP_LABEL[r.kind] : null;
            lastKind = r.kind;
            return (
              <div key={`${r.kind}:${r.id}`}>
                {header && (
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                    {header}
                  </div>
                )}
                <button
                  data-idx={i}
                  onClick={() => pick(r)}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    i === sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  {r.kind === 'worktree' && <ShellIcon className="shrink-0 text-zinc-600" />}
                  <span className={`shrink-0 ${r.kind === 'worktree' ? 'font-mono text-xs' : ''}`}>{r.label}</span>
                  {r.detail && <span className="min-w-0 truncate text-xs text-zinc-600">{r.detail}</span>}
                  {r.kind === 'worktree' && (() => {
                    const w = r.worktree;
                    const running = w.process?.status === 'running';
                    const badges: React.ReactNode[] = [];
                    if (w.hasClaudeSession) badges.push(<span key="c" title="Claude"><ClaudeIcon size={12} /></span>);
                    if (w.hasCodexSession) badges.push(<span key="x" title="Codex"><CodexIcon size={12} /></span>);
                    if (w.hasShellSession) badges.push(<span key="s" title="Shell"><ShellIcon size={12} /></span>);
                    if (vscodeTabs.has(w.path)) badges.push(<span key="v" title="VS Code"><VsCodeIcon size={12} /></span>);
                    if (browserTabs.has(w.path)) badges.push(<span key="b" title="Browser"><GlobeIcon /></span>);
                    if (kbTabs.has(w.path)) badges.push(<span key="k" title="Knowledge Base"><BookIcon size={12} /></span>);
                    if (!running && badges.length === 0) return null;
                    return (
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-zinc-500">
                        {badges}
                        {running && (
                          <span title="dev server running" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        )}
                      </span>
                    );
                  })()}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
