import type { Worktree } from '../types';

export type Props = {
  worktree: Worktree;
  onStart: (w: Worktree) => void;
  onStop: (w: Worktree) => void;
  onOpenEditor: (w: Worktree) => void;
  onMenu: (w: Worktree) => void;
  onShowLogs: (w: Worktree) => void;
};

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-zinc-500',
  starting: 'bg-amber-500',
  running: 'bg-emerald-500',
  stopped: 'bg-zinc-500',
  crashed: 'bg-red-500',
};

export function WorktreeCard({ worktree, onStart, onStop, onOpenEditor, onMenu, onShowLogs }: Props) {
  const { meta, branch, process } = worktree;
  const isRunning = process.status === 'running' || process.status === 'starting';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-400">{meta?.ticketId?.trim() || 'No ticket'}</div>
          <div className="text-base font-medium text-zinc-100">{meta?.title ?? worktree.path.split('/').pop()}</div>
        </div>
        <span className={`mt-1 inline-block h-2 w-2 rounded-full ${STATUS_COLOR[process.status] ?? 'bg-zinc-500'}`} aria-label={`status ${process.status}`} />
      </div>

      <div className="mt-2 text-zinc-400">{branch ?? '(no branch)'}</div>

      <div className="mt-1 text-xs text-zinc-500">
        {meta?.linkedFrom ? `linked ← ${meta.linkedFrom.split('/').pop()}` : 'unlinked'}
        {meta?.port ? ` · :${meta.port}` : null}
      </div>

      {!worktree.tracked && (
        <div className="mt-2 inline-block rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">untracked</div>
      )}

      {process.detectedUrl && (
        <a className="mt-2 block text-xs text-sky-400 underline" href={process.detectedUrl} target="_blank" rel="noreferrer">
          {process.detectedUrl}
        </a>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {isRunning ? (
          <button className="rounded bg-red-700 px-3 py-1 text-white" onClick={() => onStop(worktree)}>Stop</button>
        ) : (
          <button className="rounded bg-emerald-700 px-3 py-1 text-white" onClick={() => onStart(worktree)}>Start</button>
        )}
        <button className="rounded bg-zinc-800 px-3 py-1 text-zinc-100" onClick={() => onOpenEditor(worktree)}>Editor</button>
        <button className="rounded bg-zinc-800 px-3 py-1 text-zinc-100" onClick={() => onShowLogs(worktree)}>Logs</button>
        <button className="rounded bg-zinc-800 px-3 py-1 text-zinc-100" onClick={() => onMenu(worktree)} aria-label="more actions">⋯</button>
      </div>
    </div>
  );
}
