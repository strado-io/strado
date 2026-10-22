import type { OrphanCallDto, StationDto } from '../api';

/** A desktop notification for a call (an agent asking you); a click opens its
 * tab and selects it. All null for an orphan call (its asker's tab closed). */
export type CallNotification = { id: string; agentId: string | null; path: string | null; mode: string | null; sessionId: string | null; title: string; body: string };

// Pure step for the Dashboard's "new call" notifier: `prev` is the caller's
// last-seen call ids, or null on the first snapshot for a workspace (fresh
// mount, or right after a switch) — that call never fires, it only seeds.
// `seen` is exactly the calls open now, so an answered one drops out.
export function nextSeenCalls(prev: Set<string> | null, stations: StationDto[], repoLabel: (path: string) => string, orphans: OrphanCallDto[] = []): { seen: Set<string>; fire: CallNotification[] } {
  const seen = new Set<string>();
  const fire: CallNotification[] = [];
  for (const s of stations) {
    for (const c of s.calls) {
      seen.add(c.id);
      if (prev === null || prev.has(c.id)) continue;
      fire.push({ id: c.id, agentId: s.agentId, path: s.worktreePath, mode: s.mode, sessionId: s.sessionId, title: `${repoLabel(s.worktreePath)}: ${s.alias ?? s.name} needs a decision — ${c.title}`, body: c.body });
    }
  }
  for (const c of orphans) {
    seen.add(c.id);
    if (prev === null || prev.has(c.id)) continue;
    fire.push({ id: c.id, agentId: null, path: null, mode: null, sessionId: null, title: `${c.name} (tab closed) needs a decision — ${c.title}`, body: c.body });
  }
  return { seen, fire };
}
