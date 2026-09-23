import type { EscalationDto } from '../api';

export type EscalationBannerProps = {
  escalation: EscalationDto;
  onAnswer: (escalationId: string) => void;
};

/**
 * The focused tab's open question, sitting right above the hub's tab strip.
 * A blocked agent is invisible in a terminal that has scrolled on, so the hub
 * itself says who is waiting — the Answer button opens the intercom panel
 * focused on this escalation instead of making the user hunt for it.
 */
export function EscalationBanner({ escalation, onAnswer }: EscalationBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-900/50 bg-amber-950/40 px-3 py-1 text-xs text-amber-200"
    >
      <span className="min-w-0 truncate">
        Waiting on you: <b className="font-semibold">{escalation.title}</b>
      </span>
      <button
        type="button"
        onClick={() => onAnswer(escalation.id)}
        className="ml-auto shrink-0 rounded border border-amber-800/70 px-2 py-0.5 text-amber-100 hover:bg-amber-900/50"
      >
        Answer
      </button>
    </div>
  );
}
