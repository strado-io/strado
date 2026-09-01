import { useEffect, useRef, useState } from 'react';
import { api, TicketIssueDto, TicketProviderId } from '../api';
import type { RepoConfig, Worktree } from '../types';
import { useJobSteps } from '../hooks/jobSteps';
import { JobSteps } from './JobSteps';
import { TicketSourceBadge } from './TicketSourceBadge';
import { useTickets } from '../hooks/tickets';
import { SearchSelect } from './SearchSelect';


// Most common ticket prefix across the workspace ("FD-123" → "FD") — used to
// find the Jira project's boards without any configuration.
export function dominantProjectKey(worktrees: Pick<Worktree, 'meta'>[]): string | null {
  const counts = new Map<string, number>();
  for (const w of worktrees) {
    if ((w.meta?.ticketProvider ?? 'jira') !== 'jira') continue; // Linear keys never look like a Jira project prefix
    const m = /^([A-Za-z]+)-\d+$/.exec(w.meta?.ticketId ?? '');
    if (m) counts.set(m[1]!.toUpperCase(), (counts.get(m[1]!.toUpperCase()) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [k, n] of counts) if (best === null || n > counts.get(best)!) best = k;
  return best;
}

export type CreatePayload = {
  repoId: string;
  ticketId: string;
  ticketProvider?: TicketProviderId;
  title: string;
  sourceBranch: string;
  sourceWorktree: string;
  port?: number;
  env?: Record<string, string>;
  /**
   * Which machine builds and holds this worktree. Absent = this one.
   *
   * Named by runner rather than "cloud" deliberately: the user is choosing a
   * machine, and that choice decides which filesystem and which git
   * credentials the work gets. A remote worktree is created by the runner
   * cloning the repo itself — no credentials ever travel from here.
   */
  runnerId?: string;
};

export function NewWorktreeDialog({
  repos,
  worktrees,
  workspaceId,
  preselectRepoId,
  runners = [],
  onCancel,
  onSubmit,
  onDone,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  /** Used to load the selected repository's local and remote branches. */
  workspaceId?: string;
  preselectRepoId?: string;
  /** Runners that can host this worktree. Empty (the default) hides the choice entirely. */
  runners?: { runnerId: string; name: string; online: boolean }[];
  onCancel: () => void;
  /**
   * Enqueue the work. Returning a `jobId` lets the dialog show named steps;
   * returning nothing keeps the old spinner behaviour (other callers, tests).
   */
  onSubmit: (payload: CreatePayload) => void | Promise<void | { jobId?: string } | undefined>;
  /** Called once the job finishes; the caller closes the dialog. */
  onDone?: () => void;
}) {
  const initialRepo = repos.find((r) => r.id === preselectRepoId) ?? repos[0];
  // Opened from a repo row's + button: the repo is already decided — no picker.
  const lockedRepo = repos.find((r) => r.id === preselectRepoId);
  // The repo's real default branch = the branch its main worktree is on
  // (main/master/anything). Guessing 'master' broke repos on 'main'.
  const mainBranchOf = (r?: RepoConfig): string | null | undefined =>
    worktrees.find((w) => !!r && w.path === r.path)?.branch;
  const [repoId, setRepoId] = useState(initialRepo?.id ?? '');
  const [ticketId, setTicketId] = useState('');
  const [title, setTitle] = useState('');
  const [sourceBranch, setSourceBranch] = useState(mainBranchOf(initialRepo) ?? 'main');
  const [branchOptions, setBranchOptions] = useState<string[]>([mainBranchOf(initialRepo) ?? 'main']);

  // Switching repos re-points the source branch at the newly-selected repo's
  // main worktree. The main worktree remains the internal linking default; it
  // no longer needs to be a creation-time choice in the UI.
  function changeRepo(id: string) {
    setRepoId(id);
    const r = repos.find((x) => x.id === id);
    const nextBranch = mainBranchOf(r) ?? 'main';
    setSourceBranch(nextBranch);
    setBranchOptions([nextBranch]);
  }
  // '' = this machine. Only online runners are selectable: creating on an
  // offline box would queue nothing and fail at the first request.
  const [runnerId, setRunnerId] = useState('');
  const selectedRepo = repos.find((r) => r.id === repoId);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const progress = useJobSteps(jobId);
  // The job owns the outcome now: it finishing is what closes the dialog, and
  // its failure is shown on the step that failed rather than as a generic
  // "failed to create worktree".
  useEffect(() => {
    if (progress.done) onDone?.();
  }, [progress.done]);
  useEffect(() => {
    if (progress.error) setCreating(false);
  }, [progress.error]);
  const { configured } = useTickets();
  const [ticketProvider, setTicketProvider] = useState<TicketProviderId | undefined>(undefined);
  const [myIssues, setMyIssues] = useState<TicketIssueDto[]>([]);
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const ticketPickerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    const localBranches = worktrees
      .filter((worktree) => worktree.repoId === repoId && worktree.branch)
      .map((worktree) => worktree.branch!);
    const fallback = Array.from(new Set([sourceBranch, ...localBranches]));
    setBranchOptions(fallback);
    if (!workspaceId || !selectedRepo?.path) return;

    let current = true;
    api.worktrees.git.branches(workspaceId, selectedRepo.path)
      .then(({ branches }) => {
        if (current) setBranchOptions(Array.from(new Set([sourceBranch, ...branches])));
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [workspaceId, repoId, selectedRepo?.path, worktrees]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ticketPickerOpen) setTicketPickerOpen(false);
      else onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, ticketPickerOpen]);

  // Keep ticket discovery completely on demand. Opening this dialog should be
  // instant and should not contact Jira/Linear until the user asks for tickets.
  // One provider being down still doesn't kill results from the others.
  useEffect(() => {
    if (!ticketPickerOpen || ticketsLoaded || ticketsLoading || configured.length === 0) return;
    setTicketsLoading(true);
    Promise.all(configured.map((p) => api.tickets.myIssues(p).catch(() => [])))
      .then((lists) => {
        if (!mountedRef.current) return;
        setMyIssues(lists.flat());
        setTicketsLoaded(true);
      })
      .finally(() => { if (mountedRef.current) setTicketsLoading(false); });
  }, [configured, ticketPickerOpen, ticketsLoaded]);

  useEffect(() => {
    if (!ticketPickerOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (ticketPickerRef.current && !ticketPickerRef.current.contains(event.target as Node)) {
        setTicketPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [ticketPickerOpen]);

  const repoOptions = repos.map((r) => ({ id: r.id, name: r.name }));
  const sourceWorktree = selectedRepo?.path ?? '';
  const runnerChoices = [
    { label: 'This Mac', id: '', disabled: false },
    ...runners.map((runner) => ({
      label: `${runner.name}${runner.online ? '' : ' (offline)'}`,
      id: runner.runnerId,
      disabled: !runner.online,
    })),
  ];
  const selectedRunnerLabel = runnerChoices.find((choice) => choice.id === runnerId)?.label ?? 'This Mac';
  const normalizedTicketQuery = ticketId.trim().toLowerCase();
  const visibleIssues = normalizedTicketQuery
    ? myIssues.filter((issue) =>
        issue.key.toLowerCase().includes(normalizedTicketQuery)
        || issue.summary.toLowerCase().includes(normalizedTicketQuery))
    : myIssues;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('title required');
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const started = await onSubmit({
        repoId,
        ticketId,
        ticketProvider,
        title: title.trim(),
        sourceBranch,
        sourceWorktree,
        runnerId: runnerId || undefined,
      });
      const id = started && typeof started === 'object' ? started.jobId : undefined;
      // No job id (a caller that does its own awaiting): keep the old
      // spinner-until-resolved behaviour.
      if (!id) {
        onDone?.();
        return;
      }
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree');
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={creating ? undefined : onCancel}>
      <form
        aria-labelledby="new-worktree-title"
        className="w-full max-w-3xl rounded-xl border border-zinc-700/80 bg-zinc-950 text-sm shadow-2xl"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="new-worktree-title" className="sr-only">New worktree</h2>

        <div className="flex min-h-16 items-center justify-between gap-4 border-b border-zinc-800 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-900 font-mono text-xs font-semibold text-zinc-500" aria-hidden>
              {selectedRepo?.name?.charAt(0).toUpperCase() || 'R'}
            </span>
            {lockedRepo ? (
              <span className="truncate text-sm font-medium text-zinc-200">{lockedRepo.name}</span>
            ) : (
              <label className="relative min-w-0">
                <span className="sr-only">Repo</span>
                <select
                  className="max-w-64 appearance-none truncate bg-transparent py-1 pl-0 pr-6 text-sm font-medium text-zinc-200 outline-none"
                  value={repoId}
                  onChange={(e) => changeRepo(e.target.value)}
                >
                  {repoOptions.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                <svg className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-zinc-500" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path d="m3.5 5.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </label>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
            <svg className="shrink-0" width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="3" r="1.5" />
              <circle cx="4" cy="13" r="1.5" />
              <circle cx="12" cy="5" r="1.5" />
              <path d="M4 4.5v7M5.5 11.5c0-3 1.2-5 5-5" />
            </svg>
            <span className="shrink-0">Create from</span>
            <SearchSelect
              value={sourceBranch}
              options={branchOptions}
              onSelect={setSourceBranch}
              ariaLabel="Source branch"
              placeholder="Search branches…"
              align="right"
            />
          </div>
        </div>

        <div className="px-5 pb-3 pt-5">
          <label className="block">
            <span className="sr-only">Title</span>
            <textarea
              autoFocus
              className="h-40 w-full resize-none bg-transparent text-lg leading-7 text-zinc-100 outline-none placeholder:text-zinc-600"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error === 'title required') setError(null);
              }}
              placeholder="What do you want to work on?"
            />
          </label>

          {runnerId && (
            <p className="mb-2 text-[11px] text-zinc-500">
              {selectedRepo?.cloneUrl
                ? `${runners.find((r) => r.runnerId === runnerId)?.name} will clone this repository using its own credentials.`
                : 'This repository has no git remote, so a runner cannot clone it. Add an origin remote first.'}
            </p>
          )}

          {error && <div className="mb-3 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

          {jobId && (
            <JobSteps
              progress={progress}
              where={runnerId ? runners.find((r) => r.runnerId === runnerId)?.name ?? runnerId : null}
            />
          )}

          <div className="flex items-end justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <div ref={ticketPickerRef} className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={ticketPickerOpen}
                  aria-label={ticketId ? `Ticket: ${ticketId}` : 'Add ticket'}
                  onClick={() => setTicketPickerOpen((open) => !open)}
                  className={`flex h-8 max-w-52 items-center gap-2 rounded-md px-2.5 text-xs transition-colors ${ticketId ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                >
                  <svg className="shrink-0" width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 4.5v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2Z" />
                    <path d="M5.5 6h5M5.5 9h3" />
                  </svg>
                  <span className="truncate">{ticketId || 'Add ticket'}</span>
                </button>

                {ticketPickerOpen && (
                  <div className="absolute bottom-full left-0 z-10 mb-2 w-96 max-w-[calc(100vw-3rem)] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl">
                    <div className="border-b border-zinc-800 p-2.5">
                      <label>
                        <span className="sr-only">Ticket (optional)</span>
                        <input
                          autoFocus
                          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
                          value={ticketId}
                          onChange={(e) => {
                            setTicketId(e.target.value);
                            setTicketProvider(undefined);
                          }}
                          placeholder="Enter a ticket ID or find a ticket…"
                        />
                      </label>
                    </div>
                    <div className="max-h-52 overflow-y-auto p-1" role="listbox" aria-label="My open tickets">
                      {ticketsLoading && <div className="px-3 py-3 text-xs text-zinc-500">Loading your open tickets…</div>}
                      {!ticketsLoading && configured.length === 0 && (
                        <div className="px-3 py-3 text-xs text-zinc-500">No ticket provider is connected. You can still enter an ID above.</div>
                      )}
                      {!ticketsLoading && ticketsLoaded && visibleIssues.length === 0 && (
                        <div className="px-3 py-3 text-xs text-zinc-500">
                          {myIssues.length === 0 ? 'No open tickets found. You can still enter an ID above.' : 'No matching tickets.'}
                        </div>
                      )}
                      {visibleIssues.map((issue) => (
                        <button
                          type="button"
                          key={`${issue.provider}:${issue.key}`}
                          role="option"
                          aria-selected={ticketId === issue.key && ticketProvider === issue.provider}
                          onClick={() => {
                            setTicketId(issue.key);
                            setTitle(issue.summary);
                            setTicketProvider(issue.provider);
                            setTicketPickerOpen(false);
                            setError(null);
                          }}
                          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-zinc-900 ${
                            ticketId === issue.key && ticketProvider === issue.provider ? 'bg-zinc-900' : ''
                          }`}
                        >
                          <TicketSourceBadge provider={issue.provider} />
                          <span className="shrink-0 font-mono text-sky-300">{issue.key}</span>
                          <span className="min-w-0 flex-1 truncate text-zinc-300">{issue.summary}</span>
                          <span className="shrink-0 text-[10px] uppercase text-zinc-600">{issue.status}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {runners.length > 0 && (
                <div className="flex h-8 items-center gap-1.5 text-zinc-500">
                  <svg className="shrink-0" width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.5" y="3" width="11" height="4" rx="1" /><rect x="2.5" y="9" width="11" height="4" rx="1" /><path d="M5 5h.01M5 11h.01" />
                  </svg>
                  <SearchSelect
                    value={selectedRunnerLabel}
                    options={runnerChoices.map((choice) => choice.label)}
                    disabledOptions={runnerChoices.filter((choice) => choice.disabled).map((choice) => choice.label)}
                    onSelect={(label) => setRunnerId(runnerChoices.find((choice) => choice.label === label)?.id ?? '')}
                    ariaLabel="Where"
                    searchable={false}
                    side="top"
                  />
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button type="button" disabled={creating} className="h-9 rounded-md px-3 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-50" onClick={onCancel}>Cancel</button>
              <button type="submit" disabled={creating || !title.trim()} className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-4 text-xs font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
                {creating && (
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                    <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
