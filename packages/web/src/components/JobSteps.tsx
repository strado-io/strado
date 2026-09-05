// A job's named steps: done / in flight / pending, plus an elapsed clock.
//
// Replaces a spinner, which for a multi-minute step (cloning a repo on a runner)
// is indistinguishable from a hang. When something fails the list stays put and
// the failure is marked on the line it happened on — localising a failure to a
// step is the entire reason to show steps.
import type { JobProgress } from '../hooks/jobSteps';

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function JobSteps({ progress, where }: {
  progress: JobProgress;
  /** Machine the work is running on, when it isn't this one. */
  where?: string | null;
}) {
  const { steps, currentIndex, detail, elapsed, done, error } = progress;
  // Nothing declared yet: the caller shows its own pending state rather than an
  // empty box. An error is the exception: even a missed progress frame must not
  // turn a failed job into an infinite-looking spinner.
  if (steps.length === 0) {
    return error ? (
      <div className="mt-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
        {error}
      </div>
    ) : null;
  }

  return (
    <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
      {where && (
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          on {where}
        </div>
      )}
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, i) => {
          const isDone = done || i < currentIndex;
          const isActive = !done && i === currentIndex;
          const failed = !!error && i === currentIndex;
          return (
            <li key={step.id} className="flex items-start gap-2 text-xs">
              <span
                aria-hidden
                className={
                  failed ? 'mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full bg-red-500/20 text-center text-[9px] leading-[14px] text-red-300'
                  : isDone ? 'mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full bg-emerald-500/20 text-center text-[9px] leading-[14px] text-emerald-300'
                  : isActive ? 'mt-[3px] h-3.5 w-3.5 shrink-0 animate-pulse rounded-full border-2 border-sky-400'
                  : 'mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700'
                }
                style={isActive || isDone || failed ? undefined : { marginLeft: 4, marginRight: 4 }}
              >
                {failed ? '✕' : isDone ? '✓' : ''}
              </span>
              <span className="min-w-0 flex-1">
                <span className={failed ? 'text-red-300' : isDone ? 'text-zinc-400' : isActive ? 'text-zinc-100' : 'text-zinc-600'}>
                  {step.label}
                </span>
                {isActive && detail && (
                  <span className="block truncate font-mono text-[10px] text-zinc-500">{detail}</span>
                )}
                {failed && <span className="block text-[11px] text-red-300/80">{error}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 font-mono text-[10px] tabular-nums text-zinc-600">{clock(elapsed)}</div>
    </div>
  );
}
