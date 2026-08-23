import type { Worktree, WorkflowStatus, MergeRequest } from '../types';
import { useTickets, ticketRef, jiraIssueUrl } from '../hooks/tickets';
import { TicketStatusSelect } from './TicketStatusSelect';
import { TicketHover } from './TicketHoverCard';
import { WorkflowStatusSelect } from './WorkflowStatusSelect';

export type Density = 'comfy' | 'compact';

// The row is deliberately lean: everything actionable (start/stop, agents,
// VS Code, logs, env) lives in the hub the row click opens. Only glanceable
// state stays here — status, time, changes, run dot.
export type Props = {
  worktree: Worktree;
  gridTemplate: string;
  density?: Density;
  repoLabel?: string | null;
  reorderable?: boolean;
  /** MR/PR summary chip for this row's branch; undefined/null hides it. */
  mr?: MergeRequest | null;
  /** In-app review for a chip click; without it the chip links out to the provider. */
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  onOpenShellTerminal: (w: Worktree) => void;
  onSetWorkflowStatus: (w: Worktree, status: WorkflowStatus | null) => void;
  onOpenNote: (w: Worktree) => void;
  onOpenDiff: (w: Worktree) => void;
  onStart: (w: Worktree) => void;
  onStop: (w: Worktree) => void;
  onKillExternal: (w: Worktree) => void;
  onOpenSettings: (w: Worktree) => void;
};

// Active seconds → compact duration ("45m", "3h 10m"). Hours never roll into
// days: "26h" is honest hands-on time, "3d 2h" would read like calendar time.
export function formatActiveTime(seconds: number | undefined): string | null {
  if (!seconds || seconds < 60) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-zinc-600',
  starting: 'bg-amber-500',
  running: 'bg-emerald-500',
  stopped: 'bg-zinc-500',
  crashed: 'bg-red-500',
};

const MR_STATE_STYLE: Record<MergeRequest['state'], string> = {
  open: 'bg-sky-900/50 text-sky-300 hover:bg-sky-900',
  merged: 'bg-purple-900/40 text-purple-300 hover:bg-purple-900/70',
  closed: 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700',
};

const MR_CI_GLYPH: Record<NonNullable<MergeRequest['pipeline']>, { glyph: string; cls: string }> = {
  success: { glyph: '✓', cls: 'text-emerald-400' },
  failed: { glyph: '✗', cls: 'text-red-400' },
  running: { glyph: '●', cls: 'animate-pulse text-amber-400' },
  pending: { glyph: '●', cls: 'text-zinc-500' },
  canceled: { glyph: '⊘', cls: 'text-zinc-500' },
};

export function WorktreeRow({
  worktree,
  gridTemplate,
  density = 'comfy',
  repoLabel = null,
  reorderable = false,
  mr, // no default: undefined = feature off (no chip column), null = empty slot
  onOpenMr,
  onOpenShellTerminal,
  onSetWorkflowStatus,
  onOpenNote,
  onOpenDiff,
  onStart,
  onStop,
  onKillExternal,
  onOpenSettings,
}: Props) {
  const compact = density === 'compact';
  const rowPad = compact ? 'px-3 py-1' : 'px-3 py-2';
  const rowText = compact ? 'text-xs' : 'text-sm';
  const { meta, branch, process, nodeModules } = worktree;
  const isRunning = process.status === 'running' || process.status === 'starting';

  // node_modules present (linked or installed) is the NORMAL state — only
  // "unlinked" (missing deps) earns a visible warning, inline with the branch.
  const unlinked = !(nodeModules?.status === 'symlink' || nodeModules?.status === 'directory');
  const ticketId = meta?.ticketId?.trim() || '—';
  const hasTicket = ticketId !== '—' && ticketId.trim().length > 0;
  const tickets = useTickets();
  const ticketProvider = meta?.ticketProvider ?? 'jira';
  const ref = hasTicket ? ticketRef(ticketProvider, ticketId) : null;
  const issue = ref ? tickets.issues[ref] : undefined;
  // Confirmed-missing tickets (worktrees not tracked in the provider) get a
  // plain badge instead of a link to a 404 page.
  const confirmedMissing = !!ref && tickets.missing.has(ref);
  const ticketUrl = hasTicket && !confirmedMissing
    ? (issue?.url
      ?? (ticketProvider === 'jira'
        ? jiraIssueUrl(tickets.jiraBaseUrl ?? 'https://your-domain.atlassian.net', ticketId.trim())
        : null)) // unresolved Linear ticket: no guessable URL, render plain text
    : null;
  const title = meta?.title ?? worktree.path.split('/').pop() ?? worktree.path;
  // Original estimate rides along with time spent when the ticket has one.
  const estimate = issue?.estimate && !/^0[mhd]$/.test(issue.estimate) ? issue.estimate : null;
  // Settled rows (verified/done) render dimmed — the board reads
  // "what still needs me" at a glance; hover restores full contrast.
  const settled = issue
    ? issue.category === 'done'
    : meta?.workflowStatus === 'verified' || meta?.workflowStatus === 'done';
  // The ticket ID already has its own column; the branch shows only its
  // descriptive tail ("FD-33033_safety_enha…" → "safety_enha…").
  const branchLabel = (() => {
    if (!branch || !hasTicket) return branch;
    const esc = ticketId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = branch.replace(new RegExp(`^${esc}[-_ ]*`, 'i'), '');
    return stripped || branch;
  })();
  const note = meta?.note?.trim() ?? '';
  const hasNote = note.length > 0;
  const noteTitle = hasNote ? note.split('\n')[0]!.slice(0, 80) : 'Add note';
  const diff = worktree.diffStats;
  const hasDiff = !!diff && (diff.additions > 0 || diff.deletions > 0);

  // Idle affordances stay hidden until the row is hovered; anything carrying
  // live state is always visible.
  const hoverOnly = 'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100';

  return (
    <div
      className={`group grid cursor-pointer items-center gap-3 border-b border-zinc-900 ${rowPad} ${rowText} transition-[background-color,opacity] hover:bg-zinc-800/60 ${settled ? 'opacity-50 hover:opacity-100' : ''}`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={(e) => {
        // The row itself opens the shell terminal; clicks on any interactive
        // child (buttons, links, selects, the drag grip) keep their own job.
        const el = e.target as HTMLElement;
        if (el.closest('button, a, select, input, textarea, span[draggable="true"]')) return;
        onOpenShellTerminal(worktree);
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-zinc-500">
        {reorderable && (
          <span
            aria-label="Drag to reorder"
            title="Drag to reorder"
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData('text/reorder-path', worktree.path);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className={`shrink-0 cursor-grab text-zinc-600 hover:text-zinc-300 ${hoverOnly}`}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" className="fill-current">
              <circle cx="3" cy="3" r="1" /><circle cx="7" cy="3" r="1" />
              <circle cx="3" cy="7" r="1" /><circle cx="7" cy="7" r="1" />
              <circle cx="3" cy="11" r="1" /><circle cx="7" cy="11" r="1" />
            </svg>
          </span>
        )}
        <button
          type="button"
          aria-label={hasNote ? 'Edit note' : 'Add note'}
          title={noteTitle}
          onClick={() => onOpenNote(worktree)}
          className={`shrink-0 ${hasNote ? 'text-amber-300 hover:text-amber-200' : `text-zinc-600 hover:text-zinc-300 ${hoverOnly}`}`}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 1.5h5.5L13 5v9.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5Z"
              fill={hasNote ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
        {ticketUrl ? (() => {
          // Status color lives in the STATUS chip alone; the badge is an
          // identifier/link — neutral, hoverable for the details card.
          const tone = 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100';
          const badge = (
            <a
              href={ticketUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={issue ? undefined : `Open ${ticketId} in Jira`}
              className={`shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
            >
              {ticketId}
            </a>
          );
          return issue ? <TicketHover issue={issue}>{badge}</TicketHover> : badge;
        })() : confirmedMissing ? (
          <span
            title={ticketProvider === 'jira' ? 'Not tracked in Jira' : 'Not tracked'}
            className="shrink-0 truncate rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400"
          >
            {ticketId}
          </span>
        ) : (
          <span className="truncate">{ticketId}</span>
        )}
      </div>
      <div className="min-w-0 truncate font-mono text-[11px]">
        {(() => {
          const spent = formatActiveTime(worktree.activitySeconds);
          if (!spent && !estimate) return <span className="text-zinc-700">—</span>;
          return (
            <>
              {spent && (
                <span className="text-zinc-300" title="Active time in this worktree (terminal + agent activity)">
                  {spent}
                </span>
              )}
              {estimate && (
                <span className="text-zinc-600" title="Original estimate">
                  {spent ? ' / ' : 'est '}
                  {estimate}
                </span>
              )}
            </>
          );
        })()}
      </div>
      <div className="min-w-0">
        {issue ? (
          <TicketStatusSelect issue={issue} />
        ) : (
          <WorkflowStatusSelect
            value={meta?.workflowStatus ?? null}
            onChange={(s) => onSetWorkflowStatus(worktree, s)}
          />
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-xs text-zinc-300">
        {/* Fixed-width slot next to the status column so chips line up as
            their own pseudo-column and branch names stay aligned whether or
            not a row has an MR. undefined = feature off (no slot at all),
            null = feature on but no MR (empty slot). */}
        {mr !== undefined && (
          <span className="flex min-w-[4rem] shrink-0 justify-start">
            {mr && (
              <a
                href={mr.webUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="mr-chip"
                aria-label="Open merge request"
                onClick={(e) => {
                  e.stopPropagation();
                  // in-app review when the board provides it; href stays for
                  // middle-click / copy-link either way
                  if (onOpenMr) {
                    e.preventDefault();
                    onOpenMr(worktree, mr);
                  }
                }}
                title={`${mr.title} — ${mr.state}${mr.pipeline ? `, CI ${mr.pipeline}` : ''}`}
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${MR_STATE_STYLE[mr.state]}`}
              >
                {mr.provider === 'github' ? '#' : '!'}{mr.number}
                {mr.pipeline && (
                  <span className={`ml-1 ${MR_CI_GLYPH[mr.pipeline].cls}`} aria-hidden>
                    {MR_CI_GLYPH[mr.pipeline].glyph}
                  </span>
                )}
              </a>
            )}
          </span>
        )}
        {repoLabel && (
          <span
            className="shrink-0 rounded bg-zinc-900 px-1.5 py-0.5 font-sans text-[10px] font-medium uppercase tracking-wide text-zinc-400"
            title={`Repo: ${repoLabel}`}
          >
            {repoLabel}
          </span>
        )}
        <span className="min-w-0 truncate" title={branch ?? title}>
          {branchLabel ?? '—'}
        </span>
        {!worktree.tracked && (
          <span className="shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-amber-300">
            untracked
          </span>
        )}
        {unlinked && (
          <span
            className="shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-amber-300"
            title="node_modules missing — link or install deps"
          >
            unlinked
          </span>
        )}
        {branch && (
          <button
            title="Copy branch name"
            aria-label="Copy branch name"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(branch).catch(() => undefined);
            }}
            className={`shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${hoverOnly}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="4" width="9" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 4V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {/* Changes doubles as the git entry point: the count opens the diff &
          commit modal; with a clean tree the affordance reveals on hover. */}
      <div className="min-w-0 font-mono text-[11px]">
        {hasDiff ? (
          <button
            title="Open diff & commit"
            aria-label="Open diff & commit"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDiff(worktree);
            }}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
              <path
                d="M4 1.5h5.5L13 5v9.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span>{diff!.files}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-emerald-400">+{diff!.additions}</span>
            <span className="text-red-300">-{diff!.deletions}</span>
          </button>
        ) : (
          <button
            title="Diff & commit"
            aria-label="Diff & commit"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDiff(worktree);
            }}
            className={`rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 ${hoverOnly}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              className="fill-current"
              aria-hidden="true"
            >
              <path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 justify-self-center">
        <div
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            process.external ? 'bg-sky-500' : STATUS_COLOR[process.status] ?? 'bg-zinc-600'
          }`}
          aria-label={`status ${process.status}${process.external ? ' (external)' : ''}`}
          title={
            (process.external ? 'running (external)' : process.status) +
            (process.port ? ` :${process.port}` : '') +
            (process.detectedUrl ? ` — ${process.detectedUrl}` : '') +
            (process.exitCode !== null ? ` (exit ${process.exitCode})` : '') +
            (process.pid ? ` · pid ${process.pid}` : '')
          }
        />
        {process.external ? (
          <button
            title={`Kill external process (pid ${process.pid ?? '?'})`}
            aria-label="Kill external process"
            onClick={(e) => {
              e.stopPropagation();
              onKillExternal(worktree);
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-red-300 hover:bg-zinc-800 hover:text-red-200"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : isRunning ? (
          <button
            title="Stop"
            aria-label="Stop"
            onClick={(e) => {
              e.stopPropagation();
              onStop(worktree);
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-red-300 hover:bg-zinc-800 hover:text-red-200"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            title="Start"
            aria-label="Start"
            onClick={(e) => {
              e.stopPropagation();
              onStart(worktree);
            }}
            className={`inline-flex h-6 w-6 items-center justify-center rounded text-emerald-300 hover:bg-zinc-800 hover:text-emerald-200 ${hoverOnly}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          title="Worktree settings"
          aria-label="Worktree settings"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings(worktree);
          }}
          className={`inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${hoverOnly}`}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5Zm5.6 2.5c0-.4 0-.8-.1-1.1l1.3-1-1.2-2.1-1.6.5a5 5 0 0 0-1.8-1L10 1.6H6l-.3 1.7a5 5 0 0 0-1.8 1l-1.6-.5L1.2 5.9l1.3 1a5.6 5.6 0 0 0 0 2.2l-1.3 1 1.2 2.1 1.6-.5a5 5 0 0 0 1.8 1l.3 1.7h2.4l.3-1.7a5 5 0 0 0 1.8-1l1.6.5 1.2-2.1-1.3-1c.1-.3.1-.7.1-1.1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
