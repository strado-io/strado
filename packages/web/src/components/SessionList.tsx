import { useState } from 'react';
import type { Worktree } from '../types';
import { sessionChips, displayLabel, type SessionChip } from '../hooks/sessions';
import { useVscodeTabs } from '../hooks/vscodeTabs';
import { useBrowserTabs } from '../hooks/browserTabs';
import { Chevron } from './Chevron';
import { SessionChipButton } from './SessionChipButton';
import { ProcessCard } from './ProcessCard';

type Mode = SessionChip['mode'];

export function SessionList({
  worktrees, onOpen, onClose, emptyText, machineLabel, wsId, filter = '', repoName, activeTab,
}: {
  worktrees: Worktree[];
  onOpen: (path: string, mode: Mode, id?: string) => void;
  onClose?: (path: string, mode: Mode, id?: string) => void;
  emptyText?: string;
  machineLabel?: (path: string) => string | null;
  wsId: string;
  filter?: string;
  /** repoId → display name; drives the repo-level grouping. Omit for a flat list. */
  repoName?: Map<string, string>;
  /** The open hub's active tab — its chip and worktree card are highlighted. */
  activeTab?: { path: string; mode: string; id: string } | null;
}) {
  const vscodeTabs = useVscodeTabs();
  const browserTabs = useBrowserTabs();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [expandedProc, setExpandedProc] = useState<Set<string>>(new Set());
  const wtByPath = new Map(worktrees.map((w) => [w.path, w] as const));

  const q = filter.trim().toLowerCase();
  const matches = (c: SessionChip) =>
    !q || c.label.toLowerCase().includes(q) || (c.title ?? '').toLowerCase().includes(q) || displayLabel(c).toLowerCase().includes(q);

  const chips = sessionChips(worktrees, vscodeTabs, browserTabs).filter(matches);
  if (chips.length === 0) {
    return emptyText ? <div className="px-2 py-3 text-xs text-zinc-600">{q ? 'No matching sessions' : emptyText}</div> : null;
  }

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    setSet(next);
  };

  // One group per worktree path, in first-appearance order.
  const groups = new Map<string, SessionChip[]>();
  for (const c of chips) groups.set(c.path, [...(groups.get(c.path) ?? []), c]);

  // Bucket the worktree groups by repo, preserving order. A worktree whose repo
  // can't be resolved (repoId null, or a remote repo not in this workspace's
  // list) gets its own singleton bucket so it still renders flat — no repo
  // header, exactly as before repo grouping existed.
  type RepoBucket = { key: string; label: string | null; paths: string[] };
  const buckets: RepoBucket[] = [];
  const bucketByKey = new Map<string, RepoBucket>();
  for (const path of groups.keys()) {
    const repoId = wtByPath.get(path)?.repoId ?? null;
    const label = repoId ? (repoName?.get(repoId) ?? null) : null;
    const key = label ? `repo:${repoId}` : `wt:${path}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) { bucket = { key, label, paths: [] }; bucketByKey.set(key, bucket); buckets.push(bucket); }
    bucket.paths.push(path);
  }

  // The process dot lives to the right of a worktree header and opens its
  // ProcessCard. Hidden for remote worktrees and never-started local ones.
  const procDot = (path: string, ariaLabel: string) => {
    const wt = wtByPath.get(path);
    if (!wt || wt.remote || !wt.process || wt.process.status === 'idle') return null;
    const cls =
      wt.process.status === 'running' || wt.process.status === 'starting'
        ? 'bg-emerald-500'
        : wt.process.status === 'crashed' ? 'bg-red-500' : 'bg-zinc-500';
    return (
      <button
        data-testid={`proc-dot-${path}`}
        onClick={() => toggle(expandedProc, setExpandedProc, path)}
        aria-label={ariaLabel}
        className="shrink-0 rounded p-0.5 hover:bg-zinc-800"
      >
        <span className={`block h-2 w-2 rounded-full ${cls}`} />
      </button>
    );
  };

  const countBadge = (n: number) => (
    <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[10px] tabular-nums text-zinc-400">{n}</span>
  );

  const procCard = (path: string) => {
    const wt = wtByPath.get(path);
    if (!expandedProc.has(path) || !wt || wt.remote || !wt.process) return null;
    return <ProcessCard wsId={wsId} path={path} process={wt.process} />;
  };

  const isActiveChip = (c: SessionChip) =>
    !!activeTab && activeTab.path === c.path && activeTab.mode === c.mode && activeTab.id === c.sessionId;
  const sessionChipStrip = (path: string, headLabel: string) => (
    <div className="flex flex-wrap gap-1 px-1 pt-1">
      {groups.get(path)!.map((c) => (
        <SessionChipButton
          key={`${c.mode}:${c.sessionId}`}
          chip={c}
          worktreeLabel={headLabel}
          active={isActiveChip(c)}
          onOpen={onOpen}
          onClose={onClose}
        />
      ))}
    </div>
  );
  // A worktree card gets a subtle ring when the open hub is on this worktree.
  // ring-INSET: the card is full-width inside the dock's overflow-auto column,
  // so an outset ring's right edge would be clipped by the scroll boundary.
  const cardClass = (path: string) =>
    `rounded-lg p-2 ${activeTab?.path === path ? 'bg-zinc-900/60 ring-1 ring-inset ring-sky-500/40' : 'bg-zinc-900/40'}`;

  // A worktree group: its own header (branch/ticket label), process dot, count,
  // and session rows. Used standalone (unresolved repo) and nested inside a repo
  // that has more than one worktree.
  const renderWorktree = (path: string) => {
    const group = groups.get(path)!;
    const head = group[0]!;
    const isCollapsed = collapsed.has(path);
    return (
      <div key={path} className={cardClass(path)}>
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <button
            onClick={() => toggle(collapsed, setCollapsed, path)}
            aria-expanded={!isCollapsed}
            aria-label={`${head.label} sessions`}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={head.title ? `${head.label} — ${head.title}` : head.label}
          >
            <Chevron open={!isCollapsed} size={12} className="text-zinc-600" />
            <span className="shrink-0 truncate text-[11px] font-semibold uppercase tracking-wide text-zinc-300">{head.label}</span>
            {head.title && <span className="min-w-0 truncate text-[11px] text-zinc-600">{head.title}</span>}
            {machineLabel?.(path) && (
              <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{machineLabel(path)}</span>
            )}
          </button>
          {procDot(path, `${head.label} process`)}
          {countBadge(group.length)}
        </div>
        {procCard(path)}
        {!isCollapsed && sessionChipStrip(path, head.label)}
      </div>
    );
  };

  // A repo with a single worktree: collapse the two headers into one line — the
  // repo name is the header, the branch/ticket rides along as a subtitle only
  // when it differs from the repo name (a repo's main checkout just repeats it).
  const renderRepoLeaf = (bucket: RepoBucket) => {
    const path = bucket.paths[0]!;
    const group = groups.get(path)!;
    const head = group[0]!;
    const isCollapsed = collapsed.has(path);
    const branch = head.label.toLowerCase() === bucket.label!.toLowerCase() ? null : head.label;
    return (
      <div key={bucket.key} className={cardClass(path)}>
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <button
            onClick={() => toggle(collapsed, setCollapsed, path)}
            aria-expanded={!isCollapsed}
            aria-label={`${bucket.label} sessions`}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={branch ? `${bucket.label} — ${branch}` : bucket.label!}
          >
            <Chevron open={!isCollapsed} size={12} className="text-zinc-500" />
            <span className="shrink-0 truncate text-xs font-semibold text-zinc-100">{bucket.label}</span>
            {branch && <span className="min-w-0 truncate text-[11px] text-zinc-600">{branch}</span>}
            {machineLabel?.(path) && (
              <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{machineLabel(path)}</span>
            )}
          </button>
          {procDot(path, `${bucket.label} process`)}
          {countBadge(group.length)}
        </div>
        {procCard(path)}
        {!isCollapsed && sessionChipStrip(path, bucket.label!)}
      </div>
    );
  };

  // A repo with multiple worktrees: repo header, then each worktree nested and
  // indented beneath it.
  const renderRepoGroup = (bucket: RepoBucket) => {
    const repoCollapsed = collapsedRepos.has(bucket.key);
    const repoCount = bucket.paths.reduce((n, p) => n + (groups.get(p)?.length ?? 0), 0);
    return (
      <div key={bucket.key} className="flex flex-col gap-2">
        <button
          onClick={() => toggle(collapsedRepos, setCollapsedRepos, bucket.key)}
          aria-expanded={!repoCollapsed}
          aria-label={`${bucket.label} repository`}
          className="flex w-full items-center gap-1.5 px-1 text-left"
          title={bucket.label!}
        >
          <Chevron open={!repoCollapsed} size={12} className="text-zinc-500" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-100">{bucket.label}</span>
          {countBadge(repoCount)}
        </button>
        {!repoCollapsed && (
          <div className="flex flex-col gap-1.5">
            {bucket.paths.map((p) => renderWorktree(p))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {buckets.map((bucket) => {
        if (!bucket.label) return renderWorktree(bucket.paths[0]!); // unresolved repo → flat
        if (bucket.paths.length === 1) return renderRepoLeaf(bucket); // one worktree → merged line
        return renderRepoGroup(bucket); // many worktrees → repo header + nested
      })}
    </div>
  );
}
