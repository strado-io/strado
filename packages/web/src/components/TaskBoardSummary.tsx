import { ATTENTION_LABEL, type Attention } from '../hooks/attention';

/** The tiles worth a glance. Idle is the absence of attention — no tile. */
export const SUMMARY_TILES: readonly Attention[] = ['needs-you', 'working', 'running', 'review'];

const TONE: Record<Attention, string> = {
  'needs-you': 'text-amber-300',
  review: 'text-red-300',
  working: 'text-sky-300',
  running: 'text-emerald-300',
  idle: 'text-zinc-400',
};

export function TaskBoardSummary({
  counts, active, onToggle,
}: {
  counts: Record<Attention, number>;
  active: Attention | null;
  onToggle: (a: Attention) => void;
}) {
  // An empty workspace has nothing to summarise; the onboarding card speaks there.
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  if (total === 0 && !active) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3" role="group" aria-label="Attention summary">
      {SUMMARY_TILES.map((a) => {
        const n = counts[a];
        const pressed = active === a;
        return (
          <button
            key={a}
            type="button"
            data-testid={`tile-${a}`}
            data-empty={n === 0 ? 'true' : 'false'}
            aria-pressed={pressed}
            onClick={() => onToggle(a)}
            className={`flex min-w-[7.5rem] items-baseline justify-between gap-3 rounded-md border px-3 py-2 text-left transition ${
              pressed
                ? 'border-zinc-600 bg-zinc-900'
                : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700 hover:bg-zinc-900/60'
            } ${n === 0 && !pressed ? 'opacity-60' : ''}`}
          >
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">{ATTENTION_LABEL[a]}</span>
            <span className={`font-mono text-base tabular-nums ${n === 0 ? 'text-zinc-600' : TONE[a]}`}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}
