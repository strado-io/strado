// Retry a failed sandbox build on a runner worktree.
//
// The worktree itself is fine and stays usable throughout; only the container
// is rebuilt. Named steps rather than a spinner: a first build on a runner
// pulls a base image and installs four agent CLIs, which is minutes.
import { useEffect, useState } from 'react';
import type { RemoteWorktree } from '../api';
import { useJobSteps } from '../hooks/jobSteps';
import { JobSteps } from './JobSteps';

export function RebuildSandboxDialog({
  remote,
  onCancel,
  onConfirm,
  onDone,
}: {
  remote: RemoteWorktree;
  onCancel: () => void;
  onConfirm: () => Promise<{ jobId: string }>;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useJobSteps(jobId);
  useEffect(() => {
    if (progress.done) onDone?.();
  }, [progress.done, onDone]);
  useEffect(() => {
    if (progress.error) setBusy(false);
  }, [progress.error]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { jobId: id } = await onConfirm();
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the rebuild');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Rebuild sandbox">
      <div className="w-[460px] rounded-lg bg-zinc-900 p-6 text-sm">
        <h2 className="mb-2 text-lg font-semibold">Rebuild sandbox</h2>
        <p className="mb-3 text-zinc-400">
          {remote.path}<br />
          on <span className="text-zinc-200">{remote.runnerName}</span>
        </p>
        <p className="mb-3 text-xs text-zinc-500">
          This worktree runs directly on the runner because its sandbox build failed. Rebuilding
          creates the container again; the worktree and its files are untouched.
        </p>
        {jobId && <JobSteps progress={progress} where={remote.runnerName} />}
        {error && <div className="mb-2 rounded border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-200">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="rounded bg-sky-700 px-3 py-1 text-white disabled:opacity-70"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Rebuilding…' : 'Rebuild'}
          </button>
        </div>
      </div>
    </div>
  );
}
