import { useEffect, useRef } from 'react';
import type { IntercomTaskDto, StationDto } from '../../api';
import { lightOf, splitStations, statusText, type Light } from '../../lib/dock/stations';
import type { FeedItem } from './StationCard';

const DOT: Record<Light, string> = {
  calling: 'bg-amber-400 animate-pulse',
  working: 'bg-emerald-400',
  idle: 'border border-zinc-500',
  offline: 'bg-zinc-700',
};
const short = (id: string) => (id === 'human' ? 'you' : id.split('@')[0]!);

/** The Line: every station grouped by worktree (this one first), the live
 * feed between stations, and a small board of tasks. Opened by "+N" or by
 * typing "intercom". */
export function LineView({ stations, worktreePath, tasks, feed, onOpenStation, onOpenDetails, onClose }: {
  stations: StationDto[];
  worktreePath: string | null;
  tasks: IntercomTaskDto[];
  feed?: FeedItem[];
  onOpenStation: (agentId: string) => void;
  /** The full intercom panel (tasks and calls in detail). */
  onOpenDetails: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  // Groups: this worktree first, then the others by name.
  const { here } = splitStations(stations, worktreePath);
  const byPath = new Map<string, StationDto[]>();
  for (const s of stations) if (s.worktreePath !== worktreePath) byPath.set(s.worktreePath, [...(byPath.get(s.worktreePath) ?? []), s]);
  const groups = [
    ...(here.length > 0 ? [{ path: worktreePath!, name: here[0]!.worktreeName, list: here }] : []),
    ...[...byPath.entries()]
      .map(([path, list]) => ({ path, name: list[0]!.worktreeName, list: splitStations(list, path).here }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
  const board = tasks.filter((t) => t.status === 'open' || t.status === 'claimed');

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Line"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      className="absolute bottom-full right-0 z-[60] mb-1 max-h-[70vh] w-full overflow-y-auto border border-zinc-800 bg-zinc-950 text-sm shadow-2xl outline-none sm:right-4 sm:w-[32rem] sm:rounded-lg"
    >
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <span className="font-medium text-zinc-100">Line</span>
        <span className="text-xs text-zinc-500">{stations.length} station{stations.length === 1 ? '' : 's'}</span>
        <button type="button" onClick={onOpenDetails} className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">Details</button>
      </div>
      <div className="space-y-2 px-3 py-2">
        {groups.map((g) => (
          <div key={g.path} role="group" aria-label={g.name}>
            <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-600">{g.name}</div>
            <ul className="mt-0.5">
              {g.list.map((s) => {
                const light = lightOf(s);
                const name = s.alias ?? s.name;
                return (
                  <li key={s.agentId}>
                    <button
                      type="button"
                      aria-label={`${name} — ${statusText(light)}`}
                      onClick={() => onOpenStation(s.agentId)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-900"
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[light]}`} />
                      <span className="text-zinc-200">{name}</span>
                      <span className={`text-xs ${light === 'calling' ? 'text-amber-300' : 'text-zinc-500'}`}>{statusText(light)}</span>
                      {s.calls[0] && <span className="min-w-0 truncate text-xs text-zinc-400">{s.calls[0].title}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {groups.length === 0 && <div className="text-xs text-zinc-500">No stations yet — open an agent or a shell tab.</div>}
      </div>
      {feed && feed.length > 0 && (
        <section aria-label="Live" className="border-t border-zinc-900 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Live</div>
          <ul className="space-y-0.5 text-xs text-zinc-400">
            {feed.slice(0, 12).map((m) => (
              <li key={m.id} className="truncate">{`${short(m.from)} → ${short(m.to)}: ${m.body}`}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Board" className="border-t border-zinc-900 px-3 py-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Board</div>
        {board.length === 0 ? (
          <div className="text-xs text-zinc-500">No open tasks.</div>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {board.slice(0, 8).map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <span className="min-w-0 truncate text-zinc-300">{t.title}</span>
                <span className="ml-auto shrink-0 text-zinc-500">{t.claimedBy ? short(t.claimedBy.agentId) : 'open'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
