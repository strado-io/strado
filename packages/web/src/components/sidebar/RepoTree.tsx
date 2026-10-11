// The sidebar with Focus off: the whole space as a tree. A Repos heading with
// Add repo, then each repo as a collapsible row (+ for a new worktree there,
// ⋯ to remove the repo) over compact one-line worktree rows: label · title,
// uncommitted +/−, session avatars, run dot. Runner worktrees sit under the
// repo they belong to, after the local ones; ones tied to no local repo are
// grouped under their remote repo's name. Collapsed repos are remembered per
// device; a repo starts open.
import { useState } from 'react';
import type { RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { sessionChips } from '../../hooks/sessions';
import type { AddRepoAnchor } from '../Sidebar';
import { PlusIcon } from '../hub/icons';
import { SessionAvatarStack } from './sessionAvatars';
import { worktreeLabel, worktreeTitle } from './labels';
import { WorktreeRowItem, type OpenWorktree } from './WorktreeRowItem';
import {
  BrailleSpinner, BranchIcon, HoverActions, Menu, MergeRequestBadge, RepoIcon,
  agentWorking, diffBadge, isRunning, type MenuItem,
} from './rowBits';

const COLLAPSED_KEY = 'strado:collapsed-repos';
function readCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function useCollapsedRepos(): [Set<string>, (repoId: string) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (repoId: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(repoId) ? next.delete(repoId) : next.add(repoId);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* storage off */ }
    return next;
  });
  return [collapsed, toggle];
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const chevron = (open: boolean) => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke} className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 4l4 4-4 4" /></svg>
);

export type RepoTreeProps = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  activeWorktreePath: string | null;
  mrByPath: Map<string, MergeRequest | null>;
  vscodeTabs: Set<string>;
  browserTabs: Set<string>;
  onAddRepo: (anchor: AddRepoAnchor) => void;
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  onOpenWorktree: OpenWorktree;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  onOpenDiff?: (w: Worktree) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** Right-click on a row: its ⋯ menu at the cursor. */
  onContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  /** Runner loading/error notes, rendered after the tree. */
  children?: React.ReactNode;
};

export function RepoTree({
  repos, worktrees, remoteWorktrees, runnerStatuses, activeWorktreePath, mrByPath, vscodeTabs, browserTabs,
  onAddRepo, onNewWorktreeForRepo, onDeleteRepo, onOpenWorktree, onOpenMr, onOpenDiff, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree, onContextMenu, children,
}: RepoTreeProps) {
  const [collapsed, toggleRepo] = useCollapsedRepos();
  const runnerOnline = (runnerId: string) => runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;

  const localRow = (w: Worktree, repoName: string) => {
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const mr = mrByPath.get(w.path) ?? null;
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
    const title = worktreeTitle(w, repoName);
    return (
      <WorktreeRowItem
        key={w.path}
        worktree={w}
        chips={chips}
        mr={mr}
        onOpen={onOpenWorktree}
        onOpenMr={onOpenMr}
        onOpenDiff={onOpenDiff}
        onSettings={onWorktreeSettings}
        onContextMenu={(e) => onContextMenu(e, menuItems)}
        className={`group relative flex items-center rounded-md pr-1 ${activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
      >
        {chips.length > 0 && (
          <span aria-hidden data-testid={`session-mark-${w.path}`} className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500" />
        )}
        <span className="ml-5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {mr ? (
            <MergeRequestBadge worktree={w} mr={mr} onOpen={onOpenMr} />
          ) : agentWorking(w) ? (
            <BrailleSpinner small />
          ) : (
            <BranchIcon className={activeRow ? 'text-sky-400' : 'text-zinc-600'} />
          )}
        </span>
        <button onClick={() => onOpenWorktree(w)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left ${activeRow ? 'text-zinc-100' : 'text-zinc-300'}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {worktreeLabel(w)}
            {title && (
              // mono spaces around the · are full-width — use margins instead
              <span className={activeRow ? 'text-zinc-400' : 'text-zinc-600'}><span className="mx-[3px]">·</span>{title}</span>
            )}
          </span>
        </button>
        <span className="mr-1 flex shrink-0 items-center gap-1.5">
          {diffBadge(w)}
          <SessionAvatarStack chips={chips} testId={`session-stack-${w.path}`} />
          {isRunning(w) && (
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <span data-testid={`run-dot-${w.path}`} className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
          )}
        </span>
        <HoverActions active={activeRow}>
          <Menu label={`${worktreeLabel(w)} actions`} items={menuItems} />
        </HoverActions>
      </WorktreeRowItem>
    );
  };

  // A worktree on a runner, in the same list as local ones but always badged
  // with the machine. An offline runner's rows stay visible and grey:
  // vanishing rows read as data loss, and the worktree is fine.
  const remoteRow = (w: RemoteWorktree) => {
    const reachable = runnerOnline(w.runnerId);
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w as unknown as Worktree]);
    const label = w.branch ?? w.name;
    const testIdSuffix = `${w.runnerId}:${w.path}`;
    // A repo's main working tree is not removable as a worktree — the delete
    // route refuses it — so no menu rather than a dead action.
    const menuItems: MenuItem[] = !w.isRepoRoot && onDeleteRemoteWorktree
      ? [{ text: 'Delete worktree', danger: true, onClick: () => onDeleteRemoteWorktree(w) }]
      : [];
    const open = () => onOpenRemoteWorktree?.(w);
    return (
      <WorktreeRowItem
        key={testIdSuffix}
        worktree={w as unknown as Worktree}
        chips={chips}
        mr={null}
        runnerName={w.runnerName}
        onOpen={open}
        onContextMenu={menuItems.length > 0 ? (e) => onContextMenu(e, menuItems) : undefined}
        className={`group relative flex items-center rounded-md pr-1 ${activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
      >
        {chips.length > 0 && (
          <span aria-hidden data-testid={`session-mark-${testIdSuffix}`} className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500" />
        )}
        <span className="ml-5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <BranchIcon className={activeRow ? 'text-sky-400' : reachable ? 'text-zinc-600' : 'text-zinc-700'} />
        </span>
        <button onClick={open}
          title={`${w.path} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left ${
            activeRow ? 'text-zinc-100' : reachable ? 'text-zinc-300' : 'text-zinc-600'}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
        </button>
        <span className="mr-1 flex shrink-0 items-center gap-1.5">
          <SessionAvatarStack chips={chips} testId={`session-stack-${testIdSuffix}`} />
          <span
            data-testid={`runner-icon-${testIdSuffix}`}
            role="img"
            aria-label={`${w.runnerName}${reachable ? ' runner' : ' runner, offline'}`}
            title={`${w.runnerName}${reachable ? '' : ' · offline'}`}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${reachable ? 'text-zinc-500' : 'text-red-400/70'}`}
          >
            <svg aria-hidden width="14" height="14" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19,2H5A3,3,0,0,0,2,5V15a3,3,0,0,0,3,3H7.64l-.58,1a2,2,0,0,0,0,2,2,2,0,0,0,1.75,1h6.46A2,2,0,0,0,17,21a2,2,0,0,0,0-2l-.59-1H19a3,3,0,0,0,3-3V5A3,3,0,0,0,19,2ZM8.77,20,10,18H14l1.2,2ZM20,15a1,1,0,0,1-1,1H5a1,1,0,0,1-1-1V14H20Zm0-3H4V5A1,1,0,0,1,5,4H19a1,1,0,0,1,1,1Z" />
            </svg>
          </span>
        </span>
        <HoverActions active={activeRow}>
          {menuItems.length > 0 && <Menu label={`${label} on ${w.runnerName} actions`} items={menuItems} />}
        </HoverActions>
      </WorktreeRowItem>
    );
  };

  // Runner worktrees tied to no local repo, grouped under their remote repo.
  const orphanGroups = (() => {
    const groups = new Map<string, { name: string; rows: RemoteWorktree[] }>();
    for (const w of remoteWorktrees.filter((w) => !w.localRepoId)) {
      const key = `${w.runnerId}:${w.remoteRepoId ?? w.remoteRepoName ?? 'unknown'}`;
      const g = groups.get(key) ?? { name: w.remoteRepoName ?? w.runnerName, rows: [] };
      g.rows.push(w);
      groups.set(key, g);
    }
    return [...groups.entries()];
  })();

  return (
    <section aria-label="Repos" className="mt-2">
      <div className="mb-1 flex items-center justify-between pl-2.5 pr-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Repos</span>
        <button type="button" aria-label="Add repo" title="Add repo"
          onClick={(e) => { const { left, right, bottom } = e.currentTarget.getBoundingClientRect(); onAddRepo({ left, right, bottom }); }}
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300">
          <PlusIcon size={12} />
        </button>
      </div>
      {repos.length === 0 && orphanGroups.length === 0 && (
        <p className="px-2.5 py-2 text-xs text-zinc-600">No repos yet. Add one to start a worktree.</p>
      )}
      <div className="flex flex-col gap-0.5">
        {repos.map((repo) => {
          const repoWts = worktrees.filter((w) => w.repoId === repo.id);
          const repoRemote = remoteWorktrees.filter((w) => w.localRepoId === repo.id);
          const open = !collapsed.has(repo.id);
          return (
            <div key={repo.id} role="group" aria-label={repo.name}>
              <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-zinc-900">
                <button onClick={() => toggleRepo(repo.id)} aria-expanded={open}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
                  {/* Avatar by default; the chevron takes the slot on row hover. */}
                  <span className="relative h-5 w-5 shrink-0">
                    <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0"><RepoIcon /></span>
                    <span className="absolute inset-0 flex items-center justify-center text-zinc-400 opacity-0 group-hover:opacity-100">{chevron(open)}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
                </button>
                <button type="button" aria-label={`New worktree in ${repo.name}`} title="New worktree"
                  onClick={(e) => { e.stopPropagation(); onNewWorktreeForRepo(repo); }}
                  className="inline-flex shrink-0 cursor-pointer rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200">
                  <PlusIcon size={14} />
                </button>
                <Menu alwaysVisible label={`${repo.name} actions`} items={[
                  { text: 'New worktree', onClick: () => onNewWorktreeForRepo(repo) },
                  { text: 'Remove repo', danger: true, onClick: () => onDeleteRepo(repo) },
                ]} />
              </div>
              {open && (
                // Rows span the full width; indentation lives in padding so
                // the hover/active background has no dead gap on the left.
                <div className="flex flex-col gap-0.5">
                  {repoWts.length === 0 && repoRemote.length === 0 && (
                    <div className="py-1.5 pl-9 pr-2 text-xs text-zinc-600">No worktrees</div>
                  )}
                  {repoWts.map((w) => localRow(w, repo.name))}
                  {repoRemote.map(remoteRow)}
                </div>
              )}
            </div>
          );
        })}
        {orphanGroups.map(([key, g]) => (
          <div key={key} role="group" aria-label={g.name}>
            <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
              <RepoIcon />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{g.name}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{g.rows.length}</span>
            </div>
            <div className="flex flex-col gap-0.5">{g.rows.map(remoteRow)}</div>
          </div>
        ))}
        {children}
      </div>
    </section>
  );
}
