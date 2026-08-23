import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteWorktree, RunnerStatus, UnmanagedWorktree } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import type { SidebarView } from '../Sidebar';
import { PlusIcon } from '../hub/icons';

export type SidebarBodyProps = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
  taskCount: number;
  onAddRepo: () => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  expandedRepos: Set<string>;
  onToggleRepo: (repoId: string) => void;
  onOpenWorktree: (w: Worktree) => void;
  activeWorktreePath: string | null;
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** Worktrees git lists but Strado hides (outside the managed folder). Shown
   * dimmed under their repo, with one action: move into the managed folder. */
  unmanaged?: UnmanagedWorktree[];
  onMoveUnmanaged?: (w: UnmanagedWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
};

function isRunning(w: Worktree): boolean {
  return w.process.status === 'running' || w.process.status === 'starting' || !!w.process.external;
}
function worktreeLabel(w: Worktree): string {
  return w.meta?.ticketId?.trim() || w.branch || w.path.split('/').pop() || w.path;
}

function agentWorking(w: Worktree): boolean {
  return w.claudeStatus === 'working' || w.codexStatus === 'working' || w.opencodeStatus === 'working';
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

// The human title stored at create time is a slug (e.g.
// "update-role-permissions-for-vt"); show it readably.
function worktreeTitle(w: Worktree): string {
  const t = w.meta?.title?.trim();
  if (!t) return '';
  const pretty = t.replace(/[-_]+/g, ' ').trim();
  // Don't echo the ticket id back as the title (some worktrees store it there).
  return pretty && pretty !== w.meta?.ticketId?.trim() ? pretty : '';
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

// branch glyph (hand-tuned SVG, ships pre-flipped upside down) — marks
// each worktree row as a branch hanging off its repo.
function BranchIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 48 48" aria-hidden
      className={`-scale-y-100 ${className}`}
      fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4"
    >
      <path clipRule="evenodd" d="M36 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm-22 0a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm0 32a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z" />
      <path d="M14 12v24v-3c0-8 22-9 22-17v-4" />
    </svg>
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
function Menu({ label, items }: { label: string; items: { text: string; danger?: boolean; onClick: () => void }[] }) {
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
        className="hidden shrink-0 cursor-pointer rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 group-hover:inline-flex"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden {...stroke}>
          <circle cx="8" cy="4" r="0.9" /><circle cx="8" cy="8" r="0.9" /><circle cx="8" cy="12" r="0.9" />
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

export function SidebarBody({
  repos, worktrees, remoteWorktrees, runnerStatuses, selected, onSelect, taskCount,
  onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo, onOpenWorktree, activeWorktreePath,
  onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree, onOpenRemoteWorktree, onDeleteRemoteWorktree,
  unmanaged = [], onMoveUnmanaged, remoteLoading = false,
}: SidebarBodyProps) {
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;

  /**
   * A worktree on a runner. Rendered in the same list as local ones because
   * that adjacency is the point — but always badged with the machine, because
   * where it runs decides what it can see.
   */
  const RemoteRow = ({ w }: { w: RemoteWorktree }) => {
    const reachable = runnerOnline(w.runnerId);
    const activeRow = w.path === activeWorktreePath;
    return (
      <div
        className={`group flex items-center gap-1 rounded-md pr-1 ${activeRow ? 'bg-zinc-800 ring-1 ring-inset ring-sky-500/40' : 'hover:bg-zinc-900'}`}
      >
        <button
          onClick={() => onOpenRemoteWorktree?.(w)}
          title={`${w.path} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left ${
            activeRow ? 'text-zinc-100' : reachable ? 'text-zinc-300' : 'text-zinc-600'
          }`}
        >
          <span className="flex w-3 shrink-0 items-center justify-center">
            <BranchIcon className={activeRow ? 'text-sky-400' : reachable ? 'text-zinc-600' : 'text-zinc-700'} />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {w.branch ?? w.name}
          </span>
          <span
            className={`shrink-0 rounded px-1 font-mono text-[10px] ${
              reachable ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-900 text-zinc-600'
            }`}
          >
            {reachable ? w.runnerName : `${w.runnerName} · offline`}
          </span>
        </button>
        {/* A repo's main working tree is not removable as a worktree — the
            delete route refuses it — so no menu rather than a dead action. */}
        {!w.isRepoRoot && onDeleteRemoteWorktree && (
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
        )}
      </div>
    );
  };
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
  // One global worktree search at the top of the sidebar; while it has a
  // query, matching repos are force-expanded and non-matching ones hidden.
  // The per-repo "show all" toggle caps big repos at WORKTREE_CAP otherwise.
  const [query, setQuery] = useState('');
  const [showAllRepos, setShowAllRepos] = useState<Set<string>>(new Set());
  const WORKTREE_CAP = 7;
  const q = query.trim().toLowerCase();
  const matches = (w: Worktree) => `${worktreeLabel(w)} ${worktreeTitle(w)}`.toLowerCase().includes(q);

  const TopItem = ({ active, onClick, label, count, icon }: {
    active: boolean; onClick: () => void; label: string; count: number; icon: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}
    >
      <span className={`shrink-0 ${active ? 'text-zinc-300' : 'text-zinc-600 group-hover:text-zinc-400'}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>{count}</span>
    </button>
  );

  const tasksIcon = (<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden {...stroke}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /></svg>);
  const chevron = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke} className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 4l4 4-4 4" /></svg>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search worktrees…"
        aria-label="Search worktrees"
        className="mb-2 h-8 w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 text-xs text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
      />
      <div className="flex flex-col gap-0.5">
        <TopItem active={selected.kind === 'tasks'} onClick={() => onSelect({ kind: 'tasks' })}
          label="Tasks" count={taskCount} icon={tasksIcon} />
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
        {q && !worktrees.some(matches) && (
          <div className="py-1.5 pl-2.5 text-xs text-zinc-600">No matches</div>
        )}
        {repos.map((repo) => {
          const repoWts = worktrees.filter((w) => w.repoId === repo.id);
          const repoRemote = remoteWorktrees.filter((w) => w.localRepoId === repo.id);
          const filtered = q ? repoWts.filter(matches) : repoWts;
          if (q && filtered.length === 0) return null; // searching: hide non-matching repos
          const open = q ? true : expandedRepos.has(repo.id); // searching: force-expand matches
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
                  {/* count at rest; the hover controls take this space instead.
                      No rolled-up running dot — it only said "something in here
                      runs", and the worktree row says which one. */}
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600 group-hover:hidden">{q ? filtered.length : repoWts.length}</span>
                </button>
                <button
                  type="button"
                  aria-label={`New worktree in ${repo.name}`}
                  title="New worktree"
                  onClick={(e) => { e.stopPropagation(); onNewWorktreeForRepo(repo); }}
                  className="hidden shrink-0 cursor-pointer rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 group-hover:inline-flex"
                >
                  <PlusIcon size={14} />
                </button>
                <Menu label={`${repo.name} actions`} items={[
                  { text: 'New worktree', onClick: () => onNewWorktreeForRepo(repo) },
                  { text: 'Remove repo', danger: true, onClick: () => onDeleteRepo(repo) },
                ]} />
              </div>
              {open && (() => {
                const showAll = showAllRepos.has(repo.id);
                const visible = q || showAll ? filtered : filtered.slice(0, WORKTREE_CAP);
                const hiddenCount = filtered.length - visible.length;
                return (
                // rows span the full sidebar width; indentation lives in padding
                // so the hover/active background has no dead gap on the left
                <div className="flex flex-col gap-0.5">
                  {repoWts.length === 0 && repoRemote.length === 0 &&
                    !unmanaged.some((u) => u.repoId === repo.id) && (
                    <div className="py-1.5 pl-9 pr-2 text-xs text-zinc-600">No worktrees</div>
                  )}
                  {visible.map((w) => {
                    const activeRow = w.path === activeWorktreePath;
                    return (
                      <div key={w.path}
                        className={`group flex items-center gap-1 rounded-md pr-1 ${
                          activeRow ? 'bg-zinc-800 ring-1 ring-inset ring-sky-500/40' : 'hover:bg-zinc-900'}`}>
                        <button onClick={() => onOpenWorktree(w)}
                          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left ${activeRow ? 'text-zinc-100' : 'text-zinc-300'}`}>
                          {/* branch slot: loader while the agent works, an
                              upside-down branch glyph otherwise */}
                          <span className="flex w-3 shrink-0 items-center justify-center">
                            {agentWorking(w) ? (
                              <BrailleSpinner small />
                            ) : (
                              <BranchIcon className={activeRow ? 'text-sky-400' : 'text-zinc-600'} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {worktreeLabel(w)}
                            {worktreeTitle(w) && (
                              // mono spaces around the · are full-width — use margins instead
                              <span className={activeRow ? 'text-zinc-400' : 'text-zinc-600'}><span className="mx-[3px]">·</span>{worktreeTitle(w)}</span>
                            )}
                          </span>
                          {diffBadge(w)}
                          <span
                            {...(isRunning(w) ? { 'data-testid': `run-dot-${w.path}` } : {})}
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning(w) ? 'bg-emerald-500' : 'bg-transparent'}`}
                          />
                        </button>
                        <Menu label={`${worktreeLabel(w)} actions`} items={[
                          { text: 'Settings', onClick: () => onWorktreeSettings(w) },
                          { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
                        ]} />
                      </div>
                    );
                  })}
                  {!q && !showAll && hiddenCount > 0 && (
                    <button
                      onClick={() => setShowAllRepos((s) => new Set(s).add(repo.id))}
                      className="rounded-md py-1.5 pl-9 pr-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    >
                      Show {hiddenCount} more
                    </button>
                  )}
                  {!q && showAll && filtered.length > WORKTREE_CAP && (
                    <button
                      onClick={() => setShowAllRepos((s) => { const n = new Set(s); n.delete(repo.id); return n; })}
                      className="rounded-md py-1.5 pl-9 pr-2 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    >
                      Show less
                    </button>
                  )}
                  {/* Worktrees git lists for this repo OUTSIDE the managed
                      folder. Dimmed and not openable — Strado won't operate on
                      them where they are — with one action: pull them in. */}
                  {!q && (unmanaged.filter((u) => u.repoId === repo.id)).map((u) => (
                    <div key={u.path} className="group flex items-center gap-1 rounded-md pr-1 hover:bg-zinc-900">
                      <div
                        title={`${u.path}\nOutside the managed worktrees folder — move it in to open it here.`}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left text-zinc-500"
                      >
                        <span className="flex w-3 shrink-0 items-center justify-center">
                          <BranchIcon className="text-zinc-700" />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {u.branch ?? u.path.split('/').pop()}
                        </span>
                        <span className="shrink-0 rounded bg-zinc-900 px-1 font-mono text-[10px] text-zinc-600">
                          unmanaged
                        </span>
                      </div>
                      {onMoveUnmanaged && (
                        <Menu label={`${u.branch ?? u.path} actions`} items={[
                          { text: 'Move to managed folder', onClick: () => onMoveUnmanaged(u) },
                        ]} />
                      )}
                    </div>
                  ))}
                  {/* Runner worktrees for this repo, after the local ones. An
                      offline runner's rows stay VISIBLE and grey — vanishing
                      rows read as data loss, and the worktree is fine. */}
                  {(q ? repoRemote.filter((w) => `${w.branch ?? ''} ${w.name}`.toLowerCase().includes(q)) : repoRemote)
                    .map((w) => <RemoteRow key={`${w.runnerId}:${w.path}`} w={w} />)}
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
        {!q && (() => {
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
                {g.rows.map((w) => <RemoteRow key={`${w.runnerId}:${w.path}`} w={w} />)}
              </div>
            </div>
          ));
        })()}
        {/* First runner fetch still in flight: say so, quietly. Runner rows
            appearing a beat after the local ones otherwise looks like a bug. */}
        {remoteLoading && !q && (
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
