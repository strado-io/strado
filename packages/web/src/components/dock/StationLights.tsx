import type { StationDto } from '../../api';
import { lightOf, splitStations, statusText, type Light } from '../../lib/dock/stations';

const DOT: Record<Light, string> = {
  calling: 'bg-amber-400 animate-pulse',
  working: 'bg-emerald-400',
  idle: 'border border-zinc-500 bg-transparent',
  offline: 'bg-zinc-700',
};

/** The Dock's station lights: one per agent/shell tab in this worktree, and
 * "+N" for every other worktree. Clicks open a station card or the line;
 * nothing here opens by itself — a new call only changes a light. */
export function StationLights({ stations, worktreePath, onOpenStation, onOpenLine }: {
  stations: StationDto[];
  worktreePath: string | null;
  onOpenStation: (agentId: string) => void;
  onOpenLine: () => void;
}) {
  const { here, others, othersCalling } = splitStations(stations, worktreePath);
  const countLabel = `${others} station${others === 1 ? '' : 's'} in other worktrees${othersCalling > 0 ? `, ${othersCalling} calling you` : ''}`;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {here.map((s) => {
        const light = lightOf(s);
        const name = s.alias ?? s.name;
        return (
          <button
            key={s.agentId}
            type="button"
            aria-label={`${name} — ${statusText(light)}`}
            title={`${name} — ${statusText(light)}`}
            data-light={light}
            onClick={() => onOpenStation(s.agentId)}
            className="flex h-6 w-5 items-center justify-center rounded hover:bg-zinc-800"
          >
            <span className={`h-2 w-2 rounded-full ${DOT[light]}`} />
          </button>
        );
      })}
      {others > 0 && (
        <button
          type="button"
          aria-label={countLabel}
          title={countLabel}
          data-calling={othersCalling > 0 ? 'true' : 'false'}
          onClick={onOpenLine}
          className={`rounded px-1 text-[11px] tabular-nums hover:bg-zinc-800 ${othersCalling > 0 ? 'text-amber-300' : 'text-zinc-500'}`}
        >
          +{others}
        </button>
      )}
    </div>
  );
}
