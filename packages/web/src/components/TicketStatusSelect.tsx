import { useState } from 'react';
import { api, JiraTransitionDto } from '../api';
import { providerLabel, publishTickets, ticketRef, type TicketIssue } from '../hooks/tickets';

// Done is the quiet state — a board full of finished work should not glow.
// Filled chips are reserved for statuses that still need someone.
const CHIP: Record<TicketIssue['category'], string> = {
  new: 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
  indeterminate: 'bg-blue-950/70 text-blue-300 hover:bg-blue-900/60',
  done: 'bg-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300',
};

// Provider-backed replacement for the local workflow-status dropdown, used
// when the worktree's ticket resolves in Jira or Linear. The chip shows the
// provider's real status; clicking lazily fetches the transitions the
// provider allows from that state, so illegal moves never appear. Picking
// one is optimistic and confirmed by re-reading the issue server-side.
export function TicketStatusSelect({ issue }: { issue: TicketIssue }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [transitions, setTransitions] = useState<JiraTransitionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = providerLabel(issue.provider);
  const ref = ticketRef(issue.provider, issue.key);

  const close = () => {
    setAnchor(null);
    setTransitions(null);
    setError(null);
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Keep the (max-h-80) menu on screen when the row sits near the bottom.
    setAnchor({ x: r.left, y: Math.min(r.bottom + 4, Math.max(8, window.innerHeight - 336)) });
    setTransitions(null);
    setError(null);
    api.tickets.transitions(issue.provider, issue.key)
      .then(setTransitions)
      .catch((err) => setError((err as Error).message));
  };

  const pick = async (t: JiraTransitionDto) => {
    setBusy(true);
    setError(null);
    // Optimistic: show the target state now, reconcile with the provider's answer.
    publishTickets({ issues: { [ref]: { ...issue, status: t.toStatus, category: t.toCategory } } });
    try {
      const updated = await api.tickets.transition(issue.provider, issue.key, t.id);
      publishTickets({ issues: { [ticketRef(updated.provider, updated.key)]: updated } });
      close();
    } catch (err) {
      publishTickets({ issues: { [ref]: issue } }); // revert
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openMenu}
        aria-label="Ticket status"
        title={`${provider}: ${issue.status} — click to transition`}
        className={`flex h-6 w-full max-w-[120px] cursor-pointer items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide ${CHIP[issue.category]}`}
      >
        {issue.category === 'done' && (
          <span className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/80" aria-hidden />
        )}
        <span className="truncate">{issue.status}</span>
      </button>
      {anchor && (
        <div
          className="fixed inset-0 z-30"
          onClick={(e) => {
            // Don't let the backdrop click reach the row underneath — the row
            // opens a shell terminal on click.
            e.stopPropagation();
            close();
          }}
        >
          <div
            className="absolute max-h-80 w-56 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900 py-1 text-xs shadow-2xl"
            style={{ left: anchor.x, top: anchor.y }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Ticket transitions"
          >
            {transitions === null && !error && (
              <div className="px-3 py-2 text-zinc-500">Loading transitions…</div>
            )}
            {error && (
              <div className="px-3 py-2 text-red-300">
                {error}
                {issue.provider === 'jira' && (
                  <div className="mt-1 text-[10px] text-zinc-500">
                    Jira may need more info for this move — open the ticket.
                  </div>
                )}
              </div>
            )}
            {transitions?.length === 0 && (
              <div className="px-3 py-2 text-zinc-500">No transitions available</div>
            )}
            {transitions?.map((t) => (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => pick(t)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${t.toCategory === 'done' ? 'bg-emerald-400' : t.toCategory === 'indeterminate' ? 'bg-blue-400' : 'bg-zinc-500'}`} />
                <span className="truncate">{t.name}</span>
                {t.toStatus !== t.name && (
                  <span className="ml-auto truncate text-[10px] text-zinc-500">→ {t.toStatus}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
