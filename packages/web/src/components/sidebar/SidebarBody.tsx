import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { chipStatus, displayLabel, sessionChips, type SessionChip } from '../../hooks/sessions';
import { useVscodeTabs } from '../../hooks/vscodeTabs';
import { useBrowserTabs } from '../../hooks/browserTabs';
import type { SidebarView } from '../Sidebar';
import { PlusIcon } from '../hub/icons';
import { SESSION_COLOR, SessionAvatarIcon } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { worktreeLabel, worktreeTitle } from './labels';
import { WorktreeRowItem, type OpenWorktree } from './WorktreeRowItem';

export type SidebarBodyProps = {
  wsId: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
  taskCount: number;
  reviewCount?: number;
  /** True until the first workspace-wide code-review fetch settles. */
  reviewLoading?: boolean;
  onAddRepo: () => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  expandedRepos: Set<string>;
  onToggleRepo: (repoId: string) => void;
  onOpenWorktree: OpenWorktree;
  /** Opens the diff & commit modal for a worktree (hover-card quick action). */
  onOpenDiff?: (w: Worktree) => void;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  activeWorktreePath: string | null;
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
};

function isRunning(w: Worktree): boolean {
  return w.process.status === 'running' || w.process.status === 'starting' || !!w.process.external;
}
function agentWorking(w: Worktree): boolean {
  return w.claudeStatus === 'working' || w.codexStatus === 'working'
    || w.opencodeStatus === 'working' || w.piStatus === 'working';
}

// Terminal-style loader shown while an agent is working (frames via CSS).
function BrailleSpinner({ small = false }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="agent working"
      className={`braille-spinner shrink-0 font-mono leading-none text-amber-400 ${small ? 'text-[13px]' : 'text-sm'}`}
    />
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

// branch glyph (hand-tuned SVG, ships pre-flipped upside down) — marks
// each worktree row as a branch hanging off its repo.
function BranchIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 48 48" aria-hidden data-worktree-icon="branch"
      className={`-scale-y-100 ${className}`}
      fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4"
    >
      <path clipRule="evenodd" d="M36 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm-22 0a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm0 32a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z" />
      <path d="M14 12v24v-3c0-8 22-9 22-17v-4" />
    </svg>
  );
}

// The row's leading glyph when a branch has an open/merged/closed PR. The
// detail (title, checks, branches) belongs to the row's hover card — the icon
// is the state at a glance and a click into the review.
function MergeRequestBadge({ worktree, mr, onOpen }: {
  worktree: Worktree;
  mr: MergeRequest;
  onOpen?: (w: Worktree, mr: MergeRequest) => void;
}) {
  const pipeline = mr.pipeline ? PIPELINE_DETAIL[mr.pipeline] : null;
  const { kind } = prKind(mr);
  return (
    <button
      type="button"
      data-testid={`pr-status-${worktree.path}`}
      aria-label={`Open ${kind} ${mr.number}, ${mr.state}${pipeline ? `, ${pipeline.label.toLowerCase()}` : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(worktree, mr);
      }}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm outline-none ring-offset-zinc-950 focus-visible:ring-1 focus-visible:ring-sky-400"
      style={{ color: MR_STATE_COLOR[mr.state] }}
    >
      <PrStateIcon state={mr.state} />
    </button>
  );
}

// Who is open in this worktree, as overlapping faces. Names and live status
// are the hover card's job.
// Three is what a narrow rail can carry without crowding out the name; the
// rest become a count, and the hover card still lists every session.
const MAX_AVATARS = 3;

function SessionAvatarStack({ chips, testId }: { chips: SessionChip[]; testId: string }) {
  if (chips.length === 0) return null;
  const visible = chips.slice(0, MAX_AVATARS);
  const overflow = chips.length - visible.length;
  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={`${chips.length} open session${chips.length === 1 ? '' : 's'}: ${chips.map(displayLabel).join(', ')}`}
      className="flex shrink-0 items-center"
    >
      {visible.map((chip, index) => (
        <span
          key={`${chip.mode}:${chip.sessionId}`}
          data-session-avatar
          aria-hidden
          className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 ring-1 ring-zinc-950 ${SESSION_COLOR[chip.mode]} ${
            index > 0 ? '-ml-1' : ''
          }`}
          style={{ zIndex: index + 1 }}
        >
          <SessionAvatarIcon chip={chip} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          data-session-overflow
          aria-hidden
          className="relative -ml-1 flex h-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 px-1 font-mono text-[9px] leading-none text-zinc-400 ring-1 ring-zinc-950"
          style={{ zIndex: visible.length + 1 }}
        >+{overflow}</span>
      )}
    </span>
  );
}

function RepoIcon() {
  // book-with-bookmark repo glyph (hand-tuned SVG), always in the app's
  // primary orange (sky-* is remapped to Strado orange) — one color for every repo
  return (
    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-sky-400">
      {/* GitHub's repo Octicon — drawn on a 16px grid, stays crisp at icon sizes */}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
        <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
      </svg>
    </span>
  );
}

// small kebab (⋯) button + popover; closes on outside-click via a fixed backdrop
function Menu({ label, items, alwaysVisible = false }: {
  label: string;
  items: { text: string; danger?: boolean; onClick: () => void }[];
  alwaysVisible?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pos]);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right, y: r.bottom });
        }}
        className={`${alwaysVisible ? 'inline-flex' : 'invisible pointer-events-none inline-flex group-hover:visible group-hover:pointer-events-auto'} h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded p-[3px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="8" cy="3.5" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="8" cy="12.5" r="1.25" />
        </svg>
      </button>
      {/* portal: the space carousel's transformed track would otherwise become
          the containing block for these fixed elements, shoving the popover a
          pane-width off-screen on every space but the first */}
      {pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setPos(null); }} />
          <div
            className="fixed z-50 min-w-44 -translate-x-full rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
            style={{ left: pos.x, top: pos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((it) => (
              <button
                key={it.text}
                onClick={() => { setPos(null); it.onClick(); }}
                className={`block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${it.danger ? 'text-red-300' : 'text-zinc-200'}`}
              >
                {it.text}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/**
 * A worktree on a runner. Rendered in the same list as local ones because
 * that adjacency is the point — but always badged with the machine, because
 * where it runs decides what it can see.
 */
function RemoteRow({ w, reachable, activeRow, onOpenRemoteWorktree, onDeleteRemoteWorktree }: {
w: RemoteWorktree;
reachable: boolean;
activeRow: boolean;
onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
}) {
  const chips = sessionChips([w as unknown as Worktree]);
  const hasSessions = chips.length > 0;
  return (
    <WorktreeRowItem
      worktree={w as unknown as Worktree}
      chips={chips}
      mr={null}
      runnerName={w.runnerName}
      onOpen={() => onOpenRemoteWorktree?.(w)}
      className={`group relative flex items-center rounded-md pr-1 ${activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
    >
      {hasSessions && (
        <span
          aria-hidden
          data-testid={`session-mark-${w.runnerId}:${w.path}`}
          className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500"
        />
      )}
      <span className="ml-5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <BranchIcon className={activeRow ? 'text-sky-400' : reachable ? 'text-zinc-600' : 'text-zinc-700'} />
      </span>
      <button
        onClick={() => onOpenRemoteWorktree?.(w)}
        title={`${w.path} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left ${
          activeRow ? 'text-zinc-100' : reachable ? 'text-zinc-300' : 'text-zinc-600'
        }`}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {w.branch ?? w.name}
        </span>
      </button>
      <span className="mr-1 flex shrink-0 items-center gap-1.5">
        <SessionAvatarStack chips={chips} testId={`session-stack-${w.runnerId}:${w.path}`} />
        <span
          data-testid={`runner-icon-${w.runnerId}:${w.path}`}
          role="img"
          aria-label={`${w.runnerName}${reachable ? ' runner' : ' runner, offline'}`}
          title={`${w.runnerName}${reachable ? '' : ' · offline'}`}
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${
            reachable ? 'text-zinc-500' : 'text-red-400/70'
          }`}
        >
          <svg aria-hidden width="14" height="14" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19,2H5A3,3,0,0,0,2,5V15a3,3,0,0,0,3,3H7.64l-.58,1a2,2,0,0,0,0,2,2,2,0,0,0,1.75,1h6.46A2,2,0,0,0,17,21a2,2,0,0,0,0-2l-.59-1H19a3,3,0,0,0,3-3V5A3,3,0,0,0,19,2ZM8.77,20,10,18H14l1.2,2ZM20,15a1,1,0,0,1-1,1H5a1,1,0,0,1-1-1V14H20Zm0-3H4V5A1,1,0,0,1,5,4H19a1,1,0,0,1,1,1Z" />
          </svg>
        </span>
      </span>
      {/* A repo's main working tree is not removable as a worktree — the
          delete route refuses it — so no menu rather than a dead action. */}
      {!w.isRepoRoot && onDeleteRemoteWorktree ? (
        <Menu
          label={`${w.branch ?? w.name} on ${w.runnerName} actions`}
          items={[
            {
              text: 'Delete worktree',
              danger: true,
              onClick: () => onDeleteRemoteWorktree(w),
            },
          ]}
        />
      ) : (
        <span
          aria-hidden
          data-testid={`action-slot-${w.runnerId}:${w.path}`}
          className="h-5 w-5 shrink-0"
        />
      )}
    </WorktreeRowItem>
  );
}

export function SidebarBody({
  wsId, repos, worktrees, remoteWorktrees, runnerStatuses, selected, onSelect, taskCount, reviewCount = 0,
  onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo, onOpenWorktree, activeWorktreePath,
  onOpenMr, onOpenDiff, onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree,
  remoteLoading = false, reviewLoading = false,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const vscodeTabs = useVscodeTabs();
  const browserTabs = useBrowserTabs();
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;

  // Uncommitted work on a worktree row: +adds −dels, the same numbers the task
  // table shows. Silent when the tree is clean, so a quiet row stays quiet.
  const diffBadge = (w: Worktree) => {
    const d = w.diffStats;
    if (!d || (d.additions === 0 && d.deletions === 0)) return null;
    return (
      <span
        data-testid={`diff-${w.path}`}
        title={`${d.files} file${d.files === 1 ? '' : 's'} changed · +${d.additions} -${d.deletions}`}
        className="shrink-0 font-mono text-[10px] tabular-nums"
      >
        <span className="text-emerald-500/80">+{d.additions}</span>
        <span className="ml-1 text-red-400/80">-{d.deletions}</span>
      </span>
    );
  };
  const TopItem = ({ active, onClick, label, count, loading = false, icon }: {
    active: boolean; onClick: () => void; label: string; count: number; loading?: boolean; icon: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}
    >
      <span className={`shrink-0 ${active ? 'text-zinc-300' : 'text-zinc-600 group-hover:text-zinc-400'}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`flex h-4 min-w-4 shrink-0 items-center justify-center font-mono text-[11px] tabular-nums ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>
        {loading ? (
          <span role="status" aria-label={`Loading ${label.toLowerCase()}`} className="braille-spinner text-[12px] leading-none" />
        ) : count}
      </span>
    </button>
  );

  const tasksIcon = (<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden {...stroke}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /></svg>);
  const reviewsIcon = (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
    </svg>
  );
  const chevron = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke} className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 4l4 4-4 4" /></svg>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-0.5">
        <TopItem active={selected.kind === 'tasks'} onClick={() => onSelect({ kind: 'tasks' })}
          label="Tasks" count={taskCount} icon={tasksIcon} />
        <TopItem active={selected.kind === 'reviews'} onClick={() => onSelect({ kind: 'reviews' })}
          label="Code reviews" count={reviewCount} loading={reviewLoading} icon={reviewsIcon} />
      </div>

      <div className="mb-1 mt-4 flex items-center justify-between pl-2.5 pr-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Repos</span>
        <button
          onClick={onAddRepo}
          aria-label="Add repo"
          title="Add repo"
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
        >
          <PlusIcon size={12} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        {repos.map((repo) => {
          const repoWts = worktrees.filter((w) => w.repoId === repo.id);
          const repoRemote = remoteWorktrees.filter((w) => w.localRepoId === repo.id);
          const open = expandedRepos.has(repo.id);
          return (
            <div key={repo.id}>
              <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-zinc-900">
                <button onClick={() => onToggleRepo(repo.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
                  {/* avatar by default; the expand chevron takes the slot on
                      row hover. Agent-working shows on the specific worktree
                      row and the session tab, not rolled up to the repo. */}
                  <span className="relative h-5 w-5 shrink-0">
                    <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0">
                      <RepoIcon />
                    </span>
                    <span className="absolute inset-0 flex items-center justify-center text-zinc-400 opacity-0 group-hover:opacity-100">
                      {chevron(open)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`New worktree in ${repo.name}`}
                  title="New worktree"
                  onClick={(e) => { e.stopPropagation(); onNewWorktreeForRepo(repo); }}
                  className="inline-flex shrink-0 cursor-pointer rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <PlusIcon size={14} />
                </button>
                <Menu alwaysVisible label={`${repo.name} actions`} items={[
                  { text: 'New worktree', onClick: () => onNewWorktreeForRepo(repo) },
                  { text: 'Remove repo', danger: true, onClick: () => onDeleteRepo(repo) },
                ]} />
              </div>
              {open && (() => {
                return (
                // rows span the full sidebar width; indentation lives in padding
                // so the hover/active background has no dead gap on the left
                <div className="flex flex-col gap-0.5">
                  {repoWts.length === 0 && repoRemote.length === 0 && (
                    <div className="py-1.5 pl-9 pr-2 text-xs text-zinc-600">No worktrees</div>
                  )}
                  {repoWts.map((w) => {
                    const activeRow = w.path === activeWorktreePath;
                    const chips = sessionChips([w], vscodeTabs, browserTabs);
                    const hasSessions = chips.length > 0;
                    const mr = mrByPath.get(w.path);
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
                        className={`group relative flex items-center rounded-md pr-1 ${
                          activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
                      >
                        {hasSessions && (
                          <span
                            aria-hidden
                            data-testid={`session-mark-${w.path}`}
                            className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500"
                          />
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
                            {worktreeTitle(w, repo.name) && (
                              // mono spaces around the · are full-width — use margins instead
                              <span className={activeRow ? 'text-zinc-400' : 'text-zinc-600'}><span className="mx-[3px]">·</span>{worktreeTitle(w, repo.name)}</span>
                            )}
                          </span>
                        </button>
                        <span className="mr-1 flex shrink-0 items-center gap-1.5">
                          {diffBadge(w)}
                          <SessionAvatarStack chips={chips} testId={`session-stack-${w.path}`} />
                          {isRunning(w) && (
                            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              <span
                                data-testid={`run-dot-${w.path}`}
                                className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                              />
                            </span>
                          )}
                        </span>
                        <Menu label={`${worktreeLabel(w)} actions`} items={[
                          { text: 'Settings', onClick: () => onWorktreeSettings(w) },
                          { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
                        ]} />
                      </WorktreeRowItem>
                    );
                  })}
                  {/* Runner worktrees for this repo, after the local ones. An
                      offline runner's rows stay VISIBLE and grey — vanishing
                      rows read as data loss, and the worktree is fine. */}
                  {repoRemote.map((w) => (
                    <RemoteRow
                      key={`${w.runnerId}:${w.path}`}
                      w={w}
                      reachable={runnerOnline(w.runnerId)}
                      activeRow={w.path === activeWorktreePath}
                      onOpenRemoteWorktree={onOpenRemoteWorktree}
                      onDeleteRemoteWorktree={onDeleteRemoteWorktree}
                    />
                  ))}
                </div>
                );
              })()}
            </div>
          );
        })}
        {/* Runner worktrees we could not tie to a local repo IN ANY SPACE —
            the server already omits ones homed in another space. Rendered as
            repo folders in the same list (named for the remote repo), never a
            separate bottom bucket: rows that move around read as a glitch,
            but hiding work that exists reads as data loss. */}
        {(() => {
          const orphans = remoteWorktrees.filter((w) => !w.localRepoId);
          if (orphans.length === 0) return null;
          const groups = new Map<string, { name: string; rows: RemoteWorktree[] }>();
          for (const w of orphans) {
            const key = `${w.runnerId}:${w.remoteRepoId ?? w.remoteRepoName ?? 'unknown'}`;
            const g = groups.get(key) ?? { name: w.remoteRepoName ?? w.runnerName, rows: [] };
            g.rows.push(w);
            groups.set(key, g);
          }
          return [...groups.entries()].map(([key, g]) => (
            <div key={key}>
              <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
                <RepoIcon />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{g.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{g.rows.length}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {g.rows.map((w) => (
                  <RemoteRow
                    key={`${w.runnerId}:${w.path}`}
                    w={w}
                    reachable={runnerOnline(w.runnerId)}
                    activeRow={w.path === activeWorktreePath}
                    onOpenRemoteWorktree={onOpenRemoteWorktree}
                    onDeleteRemoteWorktree={onDeleteRemoteWorktree}
                  />
                ))}
              </div>
            </div>
          ));
        })()}
        {/* First runner fetch still in flight: say so, quietly. Runner rows
            appearing a beat after the local ones otherwise looks like a bug. */}
        {remoteLoading && (
          <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-zinc-600">
            <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-800 border-t-zinc-500" />
            <span className="animate-pulse">Checking runners…</span>
          </div>
        )}
        {runnerStatuses
          .filter((r) => r.error)
          .map((r) => (
            <div key={r.runnerId} className="px-2 py-1.5 text-[11px] text-amber-600/80">
              {r.name}: {r.error}
            </div>
          ))}
      </div>

    </div>
  );
}
