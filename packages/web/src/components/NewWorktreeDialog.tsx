import { useEffect, useState } from 'react';
import { api, TicketIssueDto, TicketProviderId } from '../api';
import type { RepoConfig, Worktree } from '../types';
import { useJobSteps } from '../hooks/jobSteps';
import { JobSteps } from './JobSteps';
import { TicketSourceBadge } from './TicketSourceBadge';
import { useTickets } from '../hooks/tickets';


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
  preselectRepoId,
  runners = [],
  onCancel,
  onSubmit,
  onDone,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
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
  const [sourceWorktree, setSourceWorktree] = useState(initialRepo?.path ?? '');

  // Switching repos re-points the source branch + node_modules source at the
  // newly-selected repo's main worktree.
  function changeRepo(id: string) {
    setRepoId(id);
    const r = repos.find((x) => x.id === id);
    setSourceWorktree(r?.path ?? '');
    setSourceBranch(mainBranchOf(r) ?? 'main');
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Merged picker: my open issues from every connected tracker. One provider
  // being down doesn't kill the picker for the rest.
  useEffect(() => {
    if (configured.length === 0) return;
    let alive = true;
    Promise.all(configured.map((p) => api.tickets.myIssues(p).catch(() => [])))
      .then((lists) => { if (alive) setMyIssues(lists.flat()); });
    return () => { alive = false; };
  }, [configured]);


  const repoOptions = repos.map((r) => ({ id: r.id, name: r.name }));
  const sourceOptions = [
    ...repos.filter((r) => r.id === repoId).map((r) => ({ path: r.path, label: `${r.name} (main)` })),
    ...worktrees
      .filter((w) => w.repoId === repoId)
      .map((w) => ({ path: w.path, label: w.meta?.ticketId ?? w.branch ?? w.path })),
  ];

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

  const FIELD = 'mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500';
  const LABEL = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={creating ? undefined : onCancel}>
      <form
        className="w-[480px] rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm shadow-2xl"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold text-zinc-100">
          New worktree
          {lockedRepo && <span className="font-normal text-zinc-500"> — {lockedRepo.name}</span>}
        </h2>

        {!lockedRepo && (
          <label className="mb-3 block">
            <span className={LABEL}>Repo</span>
            <select className={FIELD} value={repoId} onChange={(e) => changeRepo(e.target.value)}>
              {repoOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        )}

        {myIssues.length > 0 && (
          <div className="mb-3 block">
            <span className={LABEL}>My open tickets</span>
            <div
              className="mt-1 max-h-40 overflow-y-auto rounded border border-zinc-700 bg-zinc-900"
              role="listbox"
              aria-label="My open tickets"
            >
              {myIssues.map((i) => (
                <button
                  type="button"
                  key={`${i.provider}:${i.key}`}
                  role="option"
                  aria-selected={ticketId === i.key && ticketProvider === i.provider}
                  onClick={() => {
                    setTicketId(i.key);
                    setTitle(i.summary);
                    setTicketProvider(i.provider);
                    setError(null);
                  }}
                  className={`flex w-full items-center gap-2 border-b border-zinc-800/60 px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-zinc-800 ${
                    ticketId === i.key && ticketProvider === i.provider ? 'bg-zinc-800' : ''
                  }`}
                >
                  <TicketSourceBadge provider={i.provider} />
                  <span className="shrink-0 font-mono text-sky-300">{i.key}</span>
                  <span className="shrink-0 text-[10px] uppercase text-zinc-500">{i.status}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{i.summary}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="mb-3 block">
          <span className={LABEL}>Ticket <span className="text-zinc-600 normal-case">(optional)</span></span>
          <input
            className={FIELD}
            value={ticketId}
            onChange={(e) => {
              setTicketId(e.target.value);
              setTicketProvider(undefined);
            }}
            placeholder="e.g. FD-12345 — optional"
          />
        </label>

        <label className="mb-3 block">
          <span className={LABEL}>Title</span>
          <input className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label className="mb-3 block">
          <span className={LABEL}>Source branch</span>
          <input className={FIELD} value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
        </label>

        {runners.length > 0 && (
          <label className="mb-3 block">
            <span className={LABEL}>Where</span>
            <select className={FIELD} value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
              <option value="">This Mac</option>
              {runners.map((r) => (
                <option key={r.runnerId} value={r.runnerId} disabled={!r.online}>
                  {r.name}{r.online ? '' : ' (offline)'}
                </option>
              ))}
            </select>
            {runnerId && (
              <span className="mt-1 block text-[11px] text-zinc-500">
                {selectedRepo?.cloneUrl
                  ? `${runners.find((r) => r.runnerId === runnerId)?.name} clones ${selectedRepo.cloneUrl} itself, with its own credentials. The first worktree in a repo waits for that clone.`
                  : 'This repo has no git remote, so a runner has no way to get it. Add an origin remote first.'}
              </span>
            )}
          </label>
        )}

        <label className="mb-3 block">
          <span className={LABEL}>Link node_modules from</span>
          <select className={FIELD} value={sourceWorktree} onChange={(e) => setSourceWorktree(e.target.value)}>
            {sourceOptions.map((o) => (
              <option key={o.path} value={o.path}>{o.label}</option>
            ))}
          </select>
        </label>

        {error && <div className="mb-3 rounded bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

        {jobId && (
          <JobSteps
            progress={progress}
            where={runnerId ? runners.find((r) => r.runnerId === runnerId)?.name ?? runnerId : null}
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={creating} className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={creating} className="flex items-center gap-2 rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-70">
            {creating && (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
