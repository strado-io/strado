// The Worktrees page: everything in the space, for managing it. One section
// per repo (add, remove, start a worktree there) over compact rows for every
// worktree: label · title, which Focuses hold it, uncommitted +/−, sessions,
// run dot, last opened. A row opens the worktree (which also adds it to the
// active Focus); its button toggles it in the active Focus without opening.
// Runner worktrees sit under their local repo, or under their remote repo's
// name when they have none. Never filtered by Focus: the sidebar is that view.
import type { ReactNode } from 'react';
import type { RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { sessionChips } from '../../hooks/sessions';
import { useVscodeTabs } from '../../hooks/vscodeTabs';
import { useBrowserTabs } from '../../hooks/browserTabs';
import { ticketRef, useTickets } from '../../hooks/tickets';
import { useFocuses } from '../../hooks/useFocuses';
import { readWorktreeLru } from '../../lib/worktreeLru';
import { shortRelativeTime } from '../../lib/relativeTime';
import { OpenSidebarButton } from '../SidebarToggle';
import { PlusIcon } from '../hub/icons';
import { SessionAvatarStack } from '../sidebar/sessionAvatars';
import { cardLines, worktreeLabel } from '../sidebar/labels';
import { localPinId, remotePinId } from '../sidebar/pinIds';
import { FocusIcon } from '../sidebar/FocusSwitcher';
import {
  BrailleSpinner, BranchIcon, Menu, MergeRequestBadge, RepoIcon,
  agentWorking, diffBadge, isRunning, type MenuItem,
} from '../sidebar/rowBits';

export type WorktreesPageProps = {
  wsId: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  activeWorktreePath: string | null;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  runningServers?: ReactNode;
  onAddRepo: () => void;
  /** New worktree; with a repo id, in that repo. */
  onNewWorktree: (repoId?: string) => void;
  onRemoveRepo: (repo: RepoConfig) => void;
  onOpenWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  onError?: (message: string) => void;
};

const rowClass = (active: boolean) =>
  `group flex items-center gap-2 rounded-md py-1.5 pl-2 pr-1 ${active ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`;

export function WorktreesPage({
  wsId, repos, worktrees, remoteWorktrees, runnerStatuses, activeWorktreePath,
  sidebarCollapsed, onExpandSidebar, runningServers,
  onAddRepo, onNewWorktree, onRemoveRepo, onOpenWorktree, onOpenRemoteWorktree, onOpenMr,
  onWorktreeSettings, onDeleteWorktree, onDeleteRemoteWorktree, onError,
}: WorktreesPageProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const { focuses, active, setMembership } = useFocuses(wsId);
  const vscodeTabs = useVscodeTabs();
  const browserTabs = useBrowserTabs();
  const tickets = useTickets();
  const lru = readWorktreeLru();
  const runnerOnline = (runnerId: string) => runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;
  const total = worktrees.length + remoteWorktrees.length;

  // Which Focuses hold a worktree; the active one first.
  const focusesOf = (pinId: string) =>
    focuses.filter((f) => f.members.includes(pinId)).sort((a, b) => (a.id === active?.id ? -1 : b.id === active?.id ? 1 : 0));
  const toggleInActive = (pinId: string) => {
    if (!active) return;
    const member = active.members.includes(pinId);
    void setMembership(active.id, pinId, !member).catch((err) => onError?.(`Could not update ${active.name}: ${(err as Error).message}`));
  };
  const focusCell = (pinId: string, label: string) => {
    const held = focusesOf(pinId);
    const inActive = !!active && active.members.includes(pinId);
    return (
      <span className="flex min-w-0 shrink-0 items-center gap-1">
        {held.map((f) => (
          <span key={f.id} title={`In ${f.name}`}
            className={`max-w-28 truncate rounded px-1 text-[10px] ${f.id === active?.id ? 'bg-sky-950/60 text-sky-300' : 'bg-zinc-800 text-zinc-500'}`}>
            {f.name}
          </span>
        ))}
        {active && (
          <button type="button" onClick={(e) => { e.stopPropagation(); toggleInActive(pinId); }}
            aria-label={`${inActive ? 'Remove' : 'Add'} ${label} ${inActive ? 'from' : 'to'} ${active.name}`}
            title={inActive ? `Remove from ${active.name}` : `Add to ${active.name}`}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
              inActive ? 'text-sky-400 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100'}`}>
            <FocusIcon size={13} />
          </button>
        )}
      </span>
    );
  };

  const localRow = (w: Worktree, repoName: string) => {
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const mr = mrByPath.get(w.path);
    const pinId = localPinId(w);
    const ticketId = w.meta?.ticketId?.trim();
    const issue = ticketId ? tickets.issues[ticketRef(w.meta?.ticketProvider, ticketId)] : undefined;
    const { title, subtitle } = cardLines(w, repoName, { ticketSummary: issue?.summary, prTitle: mr?.title });
    const label = worktreeLabel(w);
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
    return (
      <div key={w.path} className={rowClass(activeRow)}>
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {mr ? <MergeRequestBadge worktree={w} mr={mr} onOpen={onOpenMr} />
            : agentWorking(w) ? <BrailleSpinner small />
            : <BranchIcon className={activeRow ? 'text-sky-400' : 'text-zinc-600'} />}
        </span>
        <button type="button" onClick={() => onOpenWorktree(w)} aria-label={label}
          className={`flex min-w-0 flex-1 items-baseline gap-2 text-left ${activeRow ? 'text-zinc-100' : 'text-zinc-300'}`}>
          <span className="min-w-0 truncate text-[13px]">{title}</span>
          {subtitle !== title && <span className="min-w-0 truncate font-mono text-[11px] text-zinc-600">{subtitle}</span>}
        </button>
        {focusCell(pinId, label)}
        {diffBadge(w)}
        <SessionAvatarStack chips={chips} testId={`session-stack-${w.path}`} />
        {isRunning(w) && (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <span data-testid={`run-dot-${w.path}`} className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        )}
        <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(lru[w.path])}</span>
        <Menu label={`${label} actions`} items={menuItems} />
      </div>
    );
  };

  const remoteRow = (w: RemoteWorktree) => {
    const reachable = runnerOnline(w.runnerId);
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w as unknown as Worktree]);
    const label = w.branch ?? w.name;
    const pinId = remotePinId(w);
    const menuItems: MenuItem[] = !w.isRepoRoot && onDeleteRemoteWorktree
      ? [{ text: 'Delete worktree', danger: true, onClick: () => onDeleteRemoteWorktree(w) }]
      : [];
    return (
      <div key={pinId} className={rowClass(activeRow)}>
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <BranchIcon className={activeRow ? 'text-sky-400' : reachable ? 'text-zinc-600' : 'text-zinc-700'} />
        </span>
        <button type="button" onClick={() => onOpenRemoteWorktree?.(w)} aria-label={`${label} on ${w.runnerName}`}
          title={`${w.path} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
          className={`flex min-w-0 flex-1 items-baseline gap-2 text-left ${activeRow ? 'text-zinc-100' : reachable ? 'text-zinc-300' : 'text-zinc-600'}`}>
          <span className="min-w-0 truncate text-[13px]">{label}</span>
          <span className={`shrink-0 text-[11px] ${reachable ? 'text-zinc-600' : 'text-red-400/70'}`}>{w.runnerName}{reachable ? '' : ' · offline'}</span>
        </button>
        {focusCell(pinId, `${label} on ${w.runnerName}`)}
        <SessionAvatarStack chips={chips} testId={`session-stack-${w.runnerId}:${w.path}`} />
        <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(lru[w.path])}</span>
        {menuItems.length > 0 ? <Menu label={`${label} on ${w.runnerName} actions`} items={menuItems} /> : <span className="w-5 shrink-0" />}
      </div>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="app-drag sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-900 bg-zinc-950 px-3 py-2">
        {sidebarCollapsed && <OpenSidebarButton onClick={() => onExpandSidebar?.()} />}
        <h1 className="text-sm font-medium text-zinc-200">Worktrees</h1>
        <span className="font-mono text-[11px] tabular-nums text-zinc-600">{total}</span>
        <div className="ml-auto flex items-center gap-2">
          {runningServers}
          <button type="button" onClick={onAddRepo}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100">
            Add repo
          </button>
          <button type="button" onClick={() => onNewWorktree()}
            className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950 hover:bg-white">
            New worktree
          </button>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        {repos.length === 0 && orphanGroups.length === 0 && (
          <p className="px-2 py-6 text-sm text-zinc-500">No repos yet. Add one to start a worktree.</p>
        )}
        <div className="flex flex-col gap-5">
          {repos.map((repo) => {
            const repoWts = worktrees.filter((w) => w.repoId === repo.id);
            const repoRemote = remoteWorktrees.filter((w) => w.localRepoId === repo.id);
            return (
              <section key={repo.id} aria-label={repo.name}>
                <div className="group flex items-center gap-2 px-2 pb-1">
                  <span className="text-zinc-500"><RepoIcon /></span>
                  <span className="truncate text-sm font-medium text-zinc-200">{repo.name}</span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-zinc-600">{repo.path}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button type="button" aria-label={`New worktree in ${repo.name}`} title="New worktree here"
                      onClick={() => onNewWorktree(repo.id)}
                      className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                      <PlusIcon size={14} />
                    </button>
                    <Menu alwaysVisible label={`${repo.name} actions`} items={[
                      { text: 'New worktree', onClick: () => onNewWorktree(repo.id) },
                      { text: 'Remove repo', danger: true, onClick: () => onRemoveRepo(repo) },
                    ]} />
                  </span>
                </div>
                <div className="flex flex-col gap-px">
                  {repoWts.length === 0 && repoRemote.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-zinc-600">No worktrees</div>
                  )}
                  {repoWts.map((w) => localRow(w, repo.name))}
                  {repoRemote.map(remoteRow)}
                </div>
              </section>
            );
          })}
          {orphanGroups.map(([key, g]) => (
            <section key={key} aria-label={g.name}>
              <div className="flex items-center gap-2 px-2 pb-1">
                <span className="text-zinc-500"><RepoIcon /></span>
                <span className="truncate text-sm font-medium text-zinc-200">{g.name}</span>
                <span className="font-mono text-[11px] tabular-nums text-zinc-600">{g.rows.length}</span>
              </div>
              <div className="flex flex-col gap-px">{g.rows.map(remoteRow)}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
