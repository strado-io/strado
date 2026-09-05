import { ATTENTION_LABEL, type Attention } from '../hooks/attention';

/** The counts worth a glance. Idle is the absence of attention — no chip. */
export const SUMMARY_TILES: readonly Attention[] = ['needs-you', 'working', 'running', 'review'];

// One accent per state, used only on a non-zero count: the label stays quiet
// so the line reads as a sentence, not a scoreboard.
const TONE: Record<Attention, string> = {
  'needs-you': 'text-amber-300',
  review: 'text-red-300',
  working: 'text-sky-300',
  running: 'text-emerald-300',
  idle: 'text-zinc-400',
};

/**
 * "Needs you 1 · Working 0 · Running 0 · Review 0" as text chips. Each chip
 * toggles a filter on the board; the active one is lit, zero counts fade.
 */
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
    <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Attention summary">
      {SUMMARY_TILES.map((a, i) => {
        const n = counts[a];
        const pressed = active === a;
        return (
          <span key={a} className="flex items-center">
            {i > 0 && <span className="mx-1 text-zinc-800" aria-hidden>·</span>}
            <button
              type="button"
              data-testid={`tile-${a}`}
              data-empty={n === 0 ? 'true' : 'false'}
              aria-pressed={pressed}
              onClick={() => onToggle(a)}
              className={`flex items-baseline gap-1.5 rounded px-1.5 py-0.5 transition hover:bg-zinc-900 ${
                pressed ? 'bg-zinc-900 text-zinc-100' : n === 0 ? 'text-zinc-600' : 'text-zinc-400'
              }`}
            >
              <span>{ATTENTION_LABEL[a]}</span>
              <span className={`font-mono tabular-nums ${n === 0 && !pressed ? 'text-zinc-700' : TONE[a]}`}>{n}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
