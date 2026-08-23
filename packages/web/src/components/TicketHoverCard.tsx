import { useState } from 'react';
import { providerLabel, type TicketIssue } from '../hooks/tickets';

const STATUS_TONE: Record<TicketIssue['category'], string> = {
  new: 'text-zinc-300',
  indeterminate: 'text-blue-300',
  done: 'text-emerald-300',
};

// Wraps any element (the ticket badge) with a styled hover card: key,
// status, summary, assignee, priority, and — for Jira — logged effort.
export function TicketHover({ issue, children }: { issue: TicketIssue; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const provider = providerLabel(issue.provider);
  // Jira's time-tracking block (progress bar of spent vs remaining) only
  // makes sense for Jira; Linear's estimate is a plain point value with no
  // logged/remaining breakdown, so it gets its own row in the dl instead.
  const showTimeTracking =
    issue.timeSpentSeconds !== null || issue.remainingSeconds !== null || (issue.provider === 'jira' && !!issue.estimate);
  const showLinearEstimate = issue.provider === 'linear' && !!issue.estimate;

  return (
    <span
      className="flex min-w-0 items-center"
      aria-label={`${provider}: ${issue.status}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ x: r.left, y: r.bottom + 6 });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-40 w-72 rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs shadow-2xl"
          style={{ left: Math.min(pos.x, window.innerWidth - 300), top: pos.y }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono font-semibold text-sky-300">{issue.key}</span>
            <span className={`text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[issue.category]}`}>
              {issue.status}
            </span>
          </div>
          <div className="mt-1.5 text-zinc-200">{issue.summary}</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
            <dt>assignee</dt>
            <dd className="text-zinc-300">{issue.assignee ?? 'Unassigned'}</dd>
            <dt>priority</dt>
            <dd className="text-zinc-300">{issue.priority ?? '—'}</dd>
            {showLinearEstimate && (
              <>
                <dt>estimate</dt>
                <dd className="text-zinc-300">{issue.estimate} pts</dd>
              </>
            )}
          </dl>
          {showTimeTracking && (() => {
            // Jira-style time tracking: progress bar of spent vs spent+remaining,
            // labels underneath, original estimate as a chip.
            const spent = issue.timeSpentSeconds ?? 0;
            const remaining = issue.remainingSeconds ?? 0;
            const total = spent + remaining;
            const pct = total > 0 ? Math.round((spent / total) * 100) : 0;
            return (
              <div className="mt-3 border-t border-zinc-800 pt-2">
                <div className="text-[11px] text-zinc-500">time tracking</div>
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-700">
                  <div className="h-full rounded bg-sky-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-300">
                    {issue.timeSpent ? `${issue.timeSpent} logged` : 'No time logged'}
                  </span>
                  {issue.remaining && <span className="text-zinc-400">{issue.remaining} remaining</span>}
                </div>
                {issue.estimate && (
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
                    original estimate
                    <span className="rounded bg-zinc-700 px-1.5 py-0.5 font-medium text-zinc-200">
                      {issue.estimate}
                    </span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </span>
  );
}
