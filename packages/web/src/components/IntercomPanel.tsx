import { useEffect, useRef, useState } from 'react';
import type { EscalationDto, ForkDto, IntercomTaskDto, PeerDto } from '../api';
import { useIntercom } from '../contexts/IntercomContext';
import { activeForks, forkLabel, forkTargetLabel, openEscalations, peerOf, settledForks, type IntercomState } from '../hooks/intercom';
import { relativeTime } from '../lib/relativeTime';

export type IntercomPanelProps = {
  initialTab: 'escalations' | 'tasks' | 'forks';
  worktreePath?: string;
  focusId?: string;
  onClose: () => void;
  onOpenTab?: (path: string, mode: PeerDto['mode'], sessionId: string) => void;
};

const BTN = 'rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40';
const PRIMARY = 'rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40';
const BADGE = 'shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400';

const when = (ms: number) => relativeTime(new Date(ms).toISOString());

/** Agent identity for a row: alias when the peer is known, agent id otherwise. */
function AgentLabel({ s, agentId, onOpenTab }: { s: IntercomState; agentId: string; onOpenTab?: IntercomPanelProps['onOpenTab'] }) {
  const peer = peerOf(s, agentId);
  const name = peer?.alias ?? agentId;
  const body = (
    <>
      <span className="truncate text-zinc-300">{name}</span>
      {peer && <span className={BADGE}>{peer.mode}</span>}
    </>
  );
  // Only clickable when the caller can actually focus the tab and the peer is
  // still around to focus — a dead agent's row stays plain text.
  if (!onOpenTab || !peer) return <span className="flex min-w-0 items-center gap-1.5">{body}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenTab(peer.worktreePath, peer.mode, peer.sessionId)}
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-zinc-900"
    >
      {body}
    </button>
  );
}

export function IntercomPanel({ initialTab, worktreePath, focusId, onClose, onOpenTab }: IntercomPanelProps) {
  const s = useIntercom();
  const [tab, setTab] = useState(initialTab);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Per-row in-flight ids, so two rows can be busy at once without one row's
  // action unblocking another's (a plain scalar `busy` would do that).
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [taskBusy, setTaskBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Settled forks stay unmounted while collapsed — jsdom (and browsers) only
  // hide a closed <details>' children visually, they remain queryable, so a
  // "settled rows are collapsed" test needs them actually absent from the DOM.
  // Seeded open when the drawer is opened focused on a fork that has already
  // settled (often a failed one), so the highlighted row isn't hidden behind
  // a click.
  const [forksSettledOpen, setForksSettledOpen] = useState(() => !!focusId && settledForks(s).some((f) => f.id === focusId));
  const [title, setTitle] = useState('');
  const [ticketKey, setTicketKey] = useState('');
  const focusRef = useRef<HTMLDivElement | null>(null);
  // Which focusId we have already scrolled to, so coming back to the
  // Escalations tab doesn't yank the list to an old row again.
  const scrolledTo = useRef<string | null>(null);
  // Initial-focus targets: the first open escalation's answer box, or the
  // new-task title input, whichever tab the drawer opened on.
  const firstEscalationRef = useRef<HTMLTextAreaElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const switchTab = (next: typeof tab) => {
    setTab(next);
    // A failed action on one tab shouldn't keep shouting on the other.
    setError(null);
  };

  useEffect(() => {
    // Mirrors HandoffDialog: Escape must not drop a resolve/dismiss/task
    // action mid-flight, losing its error or the row's draft.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && busyIds.size === 0 && !taskBusy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busyIds, taskBusy]);

  useEffect(() => {
    const el = focusRef.current;
    if (!focusId || focusId === scrolledTo.current || !el) return;
    // jsdom (and older browsers) may not implement scrollIntoView.
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    scrolledTo.current = focusId;
  }, [focusId, tab]);

  // If focusId changes (or arrives) naming a fork that has already settled,
  // reveal it rather than leaving it collapsed behind the Settled toggle.
  useEffect(() => {
    if (focusId && settledForks(s).some((f) => f.id === focusId)) setForksSettledOpen(true);
  }, [focusId, s.forks]);

  // Autofocus on mount only, like HandoffDialog's textarea — `?.focus?.()`
  // guards jsdom (and an empty list, where the ref never attaches).
  useEffect(() => {
    if (initialTab === 'tasks') titleInputRef.current?.focus?.();
    else if (initialTab === 'escalations') firstEscalationRef.current?.focus?.();
    // 'forks' has nothing to autofocus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (id: string, action: () => Promise<void>, after?: () => void) => {
    setBusyIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      await action();
      after?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const runTask = async (action: () => Promise<void>, after?: () => void) => {
    setTaskBusy(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTaskBusy(false);
    }
  };

  const allOpen = openEscalations(s);
  // Opened from a worktree row, the drawer starts scoped to that worktree;
  // "Show all" lifts the filter rather than hiding work silently.
  const scoped = worktreePath && !showAll ? allOpen.filter((e) => peerOf(s, e.from.agentId)?.worktreePath === worktreePath) : allOpen;
  const hidden = allOpen.length - scoped.length;
  // Same audience filter as `openEscalations`: agent-to-agent asks are not
  // the human's history, so a resolved peer ask never shows up here.
  const settled = s.escalations.filter((e) => e.to === 'human' && e.status !== 'open');
  const openTasks = s.tasks.filter((t) => t.status === 'open');
  const claimedTasks = s.tasks.filter((t) => t.status === 'claimed');
  const doneTasks = s.tasks.filter((t) => t.status === 'done' || t.status === 'cancelled');
  const livePeers = s.peers.filter((p) => p.live);
  const forksActive = activeForks(s);
  const forksSettled = settledForks(s);
  const shown = error ?? s.error;

  const tabClass = (which: typeof tab) =>
    `rounded-md px-2.5 py-1 text-xs font-medium ${tab === which ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`;

  const renderEscalation = (e: EscalationDto) => {
    const answer = answers[e.id] ?? '';
    const isBusy = busyIds.has(e.id);
    const isFirstScoped = scoped[0]?.id === e.id;
    return (
      <div
        key={e.id}
        data-testid={`escalation-${e.id}`}
        ref={focusId === e.id ? focusRef : undefined}
        className={`rounded-lg border bg-zinc-900/40 p-3 ${focusId === e.id ? 'border-zinc-800 ring-1 ring-amber-500/60' : 'border-zinc-800'}`}
      >
        <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
          <AgentLabel s={s} agentId={e.from.agentId} onOpenTab={onOpenTab} />
          <span className="shrink-0">{when(e.createdAt)}</span>
        </div>
        <div className="mt-1.5 break-words text-sm font-semibold text-zinc-100">{e.title}</div>
        {e.body && <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">{e.body}</div>}
        {e.context.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            {e.context.map((c, i) =>
              c.kind === 'url' ? (
                <a key={i} href={c.value} target="_blank" rel="noreferrer" className="break-all text-sky-400 underline underline-offset-2 hover:text-sky-300">
                  {c.label ?? c.value}
                </a>
              ) : c.kind === 'file' ? (
                <code key={i} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{c.label ?? c.value}</code>
              ) : (
                <span key={i} className="text-zinc-400">{c.label ?? c.value}</span>
              ),
            )}
          </div>
        )}
        {e.taskId && (
          <button type="button" onClick={() => switchTab('tasks')} className="mt-2 block text-[11px] text-sky-400 underline underline-offset-2 hover:text-sky-300">
            task {e.taskId}
          </button>
        )}
        <textarea
          aria-label="Your answer"
          ref={isFirstScoped ? firstEscalationRef : undefined}
          value={answer}
          disabled={isBusy}
          onChange={(event) => setAnswers((prev) => ({ ...prev, [e.id]: event.target.value }))}
          placeholder="Answer the agent…"
          className="mt-2 h-16 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" disabled={isBusy} onClick={() => void run(e.id, () => s.dismiss(e.id), () => setAnswers((prev) => ({ ...prev, [e.id]: '' })))} className={BTN}>Dismiss</button>
          <button
            type="button"
            disabled={isBusy || !answer.trim()}
            onClick={() => void run(e.id, () => s.resolve(e.id, answer.trim()), () => setAnswers((prev) => ({ ...prev, [e.id]: '' })))}
            className={PRIMARY}
          >
            Resolve
          </button>
        </div>
      </div>
    );
  };

  const renderTask = (t: IntercomTaskDto) => {
    const claimer = t.claimedBy ? peerOf(s, t.claimedBy.agentId) : undefined;
    const isBusy = busyIds.has(t.id);
    return (
      <div key={t.id} data-testid={`task-${t.id}`} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-sm text-zinc-100">{t.title}</span>
          {/* No provider on a task's ticket key, so no URL to link to. */}
          {t.ticketKey && <span className={BADGE}>{t.ticketKey}</span>}
        </div>
        {t.body && <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-zinc-400">{t.body}</div>}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
          {t.claimedBy ? (
            <>
              <span className="truncate text-zinc-300">{claimer?.alias ?? t.claimedBy.agentId}</span>
              {claimer && <span className={BADGE}>{claimer.mode}</span>}
            </>
          ) : (
            <span>{when(t.createdAt)}</span>
          )}
        </div>
        {t.status === 'open' && (
          <div className="mt-2 flex items-center justify-end gap-2">
            <select
              aria-label="Assign to"
              value=""
              disabled={isBusy}
              onChange={(event) => {
                const agent = event.target.value;
                if (agent) void run(t.id, () => s.assignTask(t.id, agent));
              }}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-600 disabled:opacity-40"
            >
              <option value="">Assign to…</option>
              {livePeers.map((p) => (
                <option key={p.agentId} value={p.agentId}>{`${p.alias ?? p.agentId} (${p.mode})`}</option>
              ))}
            </select>
            <button type="button" disabled={isBusy} onClick={() => void run(t.id, () => s.cancelTask(t.id))} className={BTN}>Cancel task</button>
          </div>
        )}
        {t.status === 'claimed' && (
          <div className="mt-2 flex items-center justify-end gap-2">
            <button type="button" disabled={isBusy} onClick={() => void run(t.id, () => s.doneTask(t.id))} className={BTN}>Mark done</button>
            <button type="button" disabled={isBusy} onClick={() => void run(t.id, () => s.releaseTask(t.id))} className={BTN}>Release</button>
            <button type="button" disabled={isBusy} onClick={() => void run(t.id, () => s.cancelTask(t.id))} className={BTN}>Cancel task</button>
          </div>
        )}
      </div>
    );
  };

  const renderFork = (f: ForkDto) => {
    const isBusy = busyIds.has(f.id);
    const targetPeer = f.target.kind === 'peer' ? peerOf(s, f.target.agentId) : f.target.agentId ? peerOf(s, f.target.agentId) : undefined;
    return (
      <div
        key={f.id}
        data-testid={`fork-${f.id}`}
        ref={focusId === f.id ? focusRef : undefined}
        className={`rounded-lg border bg-zinc-900/40 p-3 ${focusId === f.id ? 'border-zinc-800 ring-1 ring-sky-700' : 'border-zinc-800'}`}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
          <span className={BADGE}>{f.status}</span>
          <AgentLabel s={s} agentId={f.source.agentId} onOpenTab={onOpenTab} />
          <span className="shrink-0">→</span>
          {targetPeer ? (
            <AgentLabel s={s} agentId={targetPeer.agentId} onOpenTab={onOpenTab} />
          ) : (
            <span className="truncate text-zinc-300">{forkTargetLabel(s, f.target)}</span>
          )}
          <span className="truncate text-zinc-300">{forkLabel(f)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>{when(f.createdAt)}</span>
          {f.summarySource && <span className={BADGE}>{`summary: ${f.summarySource}`}</span>}
          {f.status === 'failed' && f.error && <span className="text-red-300 break-words">{f.error}</span>}
        </div>
        {(f.status === 'summarising' || f.status === 'queued' || (onOpenTab && targetPeer)) && (
          <div className="mt-2 flex items-center justify-end gap-2">
            {(f.status === 'summarising' || f.status === 'queued') && (
              <button type="button" disabled={isBusy} onClick={() => void run(f.id, () => s.cancelFork(f.id))} className={BTN}>Cancel fork</button>
            )}
            {onOpenTab && targetPeer && (
              <button type="button" onClick={() => onOpenTab(targetPeer.worktreePath, targetPeer.mode, targetPeer.sessionId)} className={BTN}>Open</button>
            )}
          </div>
        )}
      </div>
    );
  };

  const group = (label: string, list: IntercomTaskDto[]) =>
    list.length === 0 ? null : (
      <section key={label} className="mt-4 first:mt-0">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</h3>
        <div className="space-y-2">{list.map(renderTask)}</div>
      </section>
    );

  const addTask = () => {
    const name = title.trim();
    if (!name) return;
    const key = ticketKey.trim();
    void runTask(() => s.createTask({ title: name, ...(key ? { ticketKey: key } : {}) }), () => { setTitle(''); setTicketKey(''); });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Intercom"
        onClick={(event) => event.stopPropagation()}
        className="h-full w-[28rem] max-w-full overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-zinc-100">Intercom</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
            Close
          </button>
        </div>
        <div className="mt-3 flex gap-1">
          <button type="button" aria-pressed={tab === 'escalations'} onClick={() => switchTab('escalations')} className={tabClass('escalations')}>
            {`Escalations (${allOpen.length})`}
          </button>
          <button type="button" aria-pressed={tab === 'tasks'} onClick={() => switchTab('tasks')} className={tabClass('tasks')}>
            {`Tasks (${openTasks.length + claimedTasks.length})`}
          </button>
          <button type="button" aria-pressed={tab === 'forks'} onClick={() => switchTab('forks')} className={tabClass('forks')}>
            {`Forks (${forksActive.length})`}
          </button>
        </div>
        {shown && <div role="alert" className="mt-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">{shown}</div>}

        {tab === 'escalations' ? (
          <div className="mt-4">
            {scoped.length === 0 ? (
              <p className="text-xs text-zinc-500">No open escalations</p>
            ) : (
              <div className="space-y-3">{scoped.map(renderEscalation)}</div>
            )}
            {hidden > 0 && (
              <button type="button" onClick={() => setShowAll(true)} className="mt-3 text-[11px] text-sky-400 underline underline-offset-2 hover:text-sky-300">
                {`Show all (${hidden} in other worktrees)`}
              </button>
            )}
            {settled.length > 0 && (
              <details className="mt-4 border-t border-zinc-900 pt-3">
                <summary className="cursor-pointer text-xs text-zinc-500">{`Resolved (${settled.length})`}</summary>
                <ul className="mt-2 space-y-2">
                  {settled.map((e) => (
                    <li key={e.id} data-testid={`escalation-${e.id}`} className="text-xs text-zinc-400">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-zinc-300">{e.title}</span>
                        <span className={BADGE}>{e.status === 'dismissed' ? 'Dismissed' : 'Answered'}</span>
                      </div>
                      {e.resolution && <div className="mt-0.5 whitespace-pre-wrap break-words text-zinc-500">{e.resolution}</div>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : tab === 'forks' ? (
          <div className="mt-4">
            {forksActive.length === 0 ? (
              <p className="text-xs text-zinc-500">No forks in flight</p>
            ) : (
              <div className="space-y-2">{forksActive.map(renderFork)}</div>
            )}
            {forksSettled.length > 0 && (
              <details className="mt-4 border-t border-zinc-900 pt-3" open={forksSettledOpen}>
                <summary
                  className="cursor-pointer text-xs text-zinc-500"
                  onClick={(event) => { event.preventDefault(); setForksSettledOpen((v) => !v); }}
                >
                  {`Settled (${forksSettled.length})`}
                </summary>
                {forksSettledOpen && <div className="mt-2 space-y-2">{forksSettled.map(renderFork)}</div>}
              </details>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <form
              onSubmit={(event) => { event.preventDefault(); addTask(); }}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2"
            >
              <input
                aria-label="New task title"
                ref={titleInputRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs doing?"
                className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <input
                aria-label="Ticket key"
                value={ticketKey}
                onChange={(event) => setTicketKey(event.target.value)}
                placeholder="FLT-123"
                className="w-24 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <button type="submit" disabled={!title.trim() || taskBusy} className={PRIMARY}>Add task</button>
            </form>
            {s.tasks.length === 0 ? (
              <p className="mt-4 text-xs text-zinc-500">No tasks yet</p>
            ) : (
              <div className="mt-4">
                {group('Open', openTasks)}
                {group('Claimed', claimedTasks)}
                {group('Done', doneTasks)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
