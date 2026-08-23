import { useEffect, useState } from 'react';
import type { Worktree } from '../types';
import { useJobSteps } from '../hooks/jobSteps';
import { JobSteps } from './JobSteps';

export function DeleteWorktreeDialog({
  worktree,
  onCancel,
  onConfirm,
  onDone,
}: {
  worktree: Worktree;
  onCancel: () => void;
  /** Returning a `jobId` shows named steps; returning nothing closes as before. */
  onConfirm: (opts: { force: boolean; deleteBranch: boolean }) => void | Promise<void | { jobId?: string } | undefined>;
  /** Called once the job finishes; the caller closes the dialog. */
  onDone?: () => void;
}) {
  const [force, setForce] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJobSteps(jobId);
  useEffect(() => {
    if (progress.done) onDone?.();
  }, [progress.done]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await onConfirm({ force, deleteBranch });
      const id = started && typeof started === 'object' ? started.jobId : undefined;
      if (!id) {
        onDone?.();
        return;
      }
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60">
      <div className="w-[460px] rounded-lg bg-zinc-900 p-6 text-sm">
        <h2 className="mb-2 text-lg font-semibold">Delete worktree</h2>
        <p className="mb-3 text-zinc-400">
          {worktree.path}<br />
          branch: <span className="text-zinc-200">{worktree.branch ?? '—'}</span>
        </p>
        <label className="mb-2 flex items-center gap-2">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Force (if worktree has uncommitted changes)
        </label>
        <label className="mb-4 flex items-center gap-2">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Also delete branch
        </label>
        {jobId && <JobSteps progress={progress} where={worktree.remote?.runnerName ?? null} />}
        {error && <div className="mb-2 rounded border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-200">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="rounded bg-red-700 px-3 py-1 text-white disabled:opacity-70"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
