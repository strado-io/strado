import { useEffect, useMemo, useState } from 'react';
import { api, TicketIssueDto, TicketProviderId, TicketSprintDto } from '../api';
import type { RepoConfig, Worktree } from '../types';
import { dominantProjectKey } from './NewWorktreeDialog';
import { TicketSourceBadge } from './TicketSourceBadge';
import { useTickets, ticketRef } from '../hooks/tickets';
import { useWorkspace } from '../hooks/useWorkspace';

type Row = {
  issue: TicketIssueDto;
  existing?: Worktree; // already on the board — nothing to do
  create: boolean; // scaffold a worktree for it
};

// "Scaffold my week": pick a sprint/cycle as the ticket source, see which of
// its tickets already live on the board and which are new (optionally
// scaffolded as worktrees in one click).
export function ImportTicketsDialog({
  repos,
  worktrees,
  onDone,
  onCancel,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const { configured } = useTickets();
  const [provider, setProvider] = useState<TicketProviderId>(configured.includes('jira') ? 'jira' : 'linear');
  const [sprints, setSprints] = useState<TicketSprintDto[]>([]);
  const [sprintsLoading, setSprintsLoading] = useState(true);
  const [sprintId, setSprintId] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(true);
  const [issues, setIssues] = useState<TicketIssueDto[] | null>(null);
  // Tickets the user unticked — kept separate so live worktree updates
  // (SSE/poll) can't wipe the choices or retrigger the fetch.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [sourceBranch, setSourceBranch] = useState('master');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const heading = provider === 'linear' ? 'Cycle' : 'Sprint';

  // Keyed by (provider, key) — a Jira ticket and a Linear issue that happen
  // to share the same bare id (e.g. both "ENG-45") must not collide.
  const byTicket = useMemo(() => {
    const m = new Map<string, Worktree>();
    for (const w of worktrees) {
      const t = w.meta?.ticketId;
      if (!t) continue;
      const ref = ticketRef(w.meta?.ticketProvider, t);
      if (!m.has(ref)) m.set(ref, w);
    }
    return m;
  }, [worktrees]);

  // Sprints/cycles depend on the provider — switching providers restarts the
  // whole flow (sprint list, selection, issues).
  useEffect(() => {
    let alive = true;
    setSprintsLoading(true);
    setSprints([]);
    setSprintId(null);
    setError(null);
    const project = provider === 'jira' ? dominantProjectKey(worktrees) : undefined;
    if (provider === 'jira' && !project) {
      setSprintsLoading(false);
      setError('no Jira project detectable from the board tickets');
      return;
    }
    const fetchSprints = provider === 'jira' ? api.tickets.sprints('jira', project!) : api.tickets.sprints('linear');
    fetchSprints
      .then((s) => {
        if (!alive) return;
        setSprintsLoading(false);
        setSprints(s);
        if (s.length > 0) setSprintId(s[0]!.id);
        else setError(`no active or upcoming ${heading.toLowerCase()} found`);
      })
      .catch((err) => {
        if (!alive) return;
        setSprintsLoading(false);
        setError((err as Error).message);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Fetch depends ONLY on the sprint selection — the dashboard mutates the
  // worktree list every few seconds (SSE + poll), and refetching on that made
  // the list flicker back to "Loading…" endlessly.
  useEffect(() => {
    if (sprintId === null) return;
    let alive = true;
    setIssues(null);
    setUnchecked(new Set());
    api.tickets.sprintIssues(provider, sprintId, onlyMine)
      .then((list) => { if (alive) setIssues(list); })
      .catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [provider, sprintId, onlyMine]);

  const rows: Row[] | null = useMemo(() => {
    if (issues === null) return null;
    return issues.map((issue) => {
      const existing = byTicket.get(ticketRef(provider, issue.key));
      return { issue, existing, create: !existing && !unchecked.has(issue.key) };
    });
  }, [issues, byTicket, unchecked]);

  async function importTickets() {
    const sprint = sprints.find((s) => s.id === sprintId);
    if (!sprint || !rows) return;
    setBusy(true);
    setError(null);
    try {
      // New tickets get scaffolded (create jobs run in the background).
      const repo = repos.find((r) => r.id === repoId);
      const creates = rows.filter((r) => !r.existing && r.create);
      for (const r of creates) {
        await api.worktrees.create(wsId, {
          repoId,
          ticketId: r.issue.key,
          title: r.issue.summary,
          sourceBranch,
          sourceWorktree: repo?.path ?? '',
          ticketProvider: provider,
        });
      }

      setSummary(
        `${sprint.name}: ${creates.length} worktree${creates.length === 1 ? '' : 's'} being created.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const createCount = rows?.filter((r) => !r.existing && r.create).length ?? 0;
  const creatable = rows?.filter((r) => !r.existing) ?? [];
  const toggleAll = () =>
    setUnchecked(createCount > 0 ? new Set(creatable.map((r) => r.issue.key)) : new Set());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="flex max-h-[85vh] w-[560px] flex-col rounded-lg bg-zinc-900 p-6 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">Import tickets</h2>

        {summary ? (
          <>
            <div className="rounded bg-emerald-900/30 px-3 py-2 text-emerald-200">{summary}</div>
            <div className="mt-4 flex justify-end">
              <button className="rounded bg-sky-700 px-3 py-1.5 text-white hover:bg-sky-600" onClick={onDone}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {configured.length > 1 && (
              <label className="mb-3 block">
                <span className="block text-zinc-400">Tracker</span>
                <select
                  className="mt-1 w-full rounded bg-zinc-800 p-2"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as TicketProviderId)}
                >
                  {configured.map((p) => (
                    <option key={p} value={p}>{p === 'jira' ? 'Jira' : 'Linear'}</option>
                  ))}
                </select>
              </label>
            )}

            <div className="mb-3 flex items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="block text-zinc-400">{heading}</span>
                <select
                  className="mt-1 w-full rounded bg-zinc-800 p-2 disabled:text-zinc-500"
                  value={sprintId ?? ''}
                  disabled={sprintsLoading}
                  onChange={(e) => setSprintId(e.target.value)}
                >
                  {sprintsLoading ? (
                    <option value="">Loading {heading.toLowerCase()}s…</option>
                  ) : (
                    sprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.state === 'future' ? ' (upcoming)' : ''}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="mb-2 flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-zinc-500">
                <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
                only mine
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800">
              {creatable.length > 0 && (
                <div className="flex items-center gap-2 border-b border-zinc-800/60 px-3 py-2">
                  <input
                    type="checkbox"
                    className="w-4 shrink-0"
                    aria-label="Select all tickets"
                    checked={createCount === creatable.length}
                    // half-selected shows the native indeterminate dash
                    ref={(el) => { if (el) el.indeterminate = createCount > 0 && createCount < creatable.length; }}
                    onChange={toggleAll}
                  />
                  <span className="text-xs text-zinc-500">
                    {createCount > 0 ? `${createCount} of ${creatable.length} selected` : 'Select all'}
                  </span>
                </div>
              )}
              {rows === null && <div className="px-3 py-4 text-zinc-500">Loading {heading.toLowerCase()} tickets…</div>}
              {rows?.length === 0 && <div className="px-3 py-4 text-zinc-500">No open tickets in this {heading.toLowerCase()}.</div>}
              {rows?.map((r) => (
                <div
                  key={r.issue.key}
                  className="flex items-center gap-2 border-b border-zinc-800/60 px-3 py-2 last:border-b-0"
                >
                  {r.existing ? (
                    <span
                      className="w-4 shrink-0 text-center text-emerald-400"
                      title="Already on the board"
                    >
                      ✓
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      className="w-4 shrink-0"
                      checked={r.create}
                      aria-label={`Create worktree for ${r.issue.key}`}
                      onChange={(e) =>
                        setUnchecked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(r.issue.key);
                          else next.add(r.issue.key);
                          return next;
                        })
                      }
                    />
                  )}
                  <TicketSourceBadge provider={r.issue.provider} />
                  <span className="shrink-0 font-mono text-xs text-sky-300">{r.issue.key}</span>
                  <span className="shrink-0 text-[10px] uppercase text-zinc-500">{r.issue.status}</span>
                  <span className="min-w-0 truncate text-zinc-300" title={r.issue.summary}>
                    {r.issue.summary}
                  </span>
                  {r.existing && <span className="ml-auto shrink-0 text-[10px] text-zinc-500">on board</span>}
                </div>
              ))}
            </div>

            {createCount > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-zinc-400">Repo for new worktrees</span>
                  <select
                    className="mt-1 w-full rounded bg-zinc-800 p-2"
                    value={repoId}
                    onChange={(e) => setRepoId(e.target.value)}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-zinc-400">Source branch</span>
                  <input
                    className="mt-1 w-full rounded bg-zinc-800 p-2"
                    value={sourceBranch}
                    onChange={(e) => setSourceBranch(e.target.value)}
                  />
                </label>
              </div>
            )}

            {error && <div className="mt-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700" onClick={onCancel}>
                Cancel
              </button>
              <button
                className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                onClick={importTickets}
                disabled={busy || !rows || sprintId === null || createCount === 0}
              >
                {busy
                  ? 'Importing…'
                  : `Import${createCount > 0 ? ` (+${createCount} worktree${createCount === 1 ? '' : 's'})` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
