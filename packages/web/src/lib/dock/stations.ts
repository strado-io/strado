// What the Dock shows for intercom stations: one light per tab in this
// worktree (calling you / working / idle / offline), a count for the rest.
import type { StationDto } from '../../api';

export type Light = 'calling' | 'working' | 'idle' | 'offline';

export function lightOf(s: StationDto): Light {
  if (s.needsYou || s.calls.length > 0) return 'calling';
  if (!s.live) return 'offline';
  if (s.lifecycle === 'working') return 'working';
  return 'idle';
}

const STATUS: Record<Light, string> = { calling: 'calling you', working: 'working', idle: 'idle', offline: 'offline' };
export const statusText = (l: Light): string => STATUS[l];

const MODE_ORDER = ['claude', 'codex', 'opencode', 'pi', 'shell'];
const tabOrder = (a: StationDto, b: StationDto) =>
  (MODE_ORDER.indexOf(a.mode) + 1 || 99) - (MODE_ORDER.indexOf(b.mode) + 1 || 99) || Number(a.sessionId) - Number(b.sessionId) || a.sessionId.localeCompare(b.sessionId);

/** This worktree's stations (callers first, then tab order) and a count of the rest. */
export function splitStations(stations: StationDto[], worktreePath: string | null): { here: StationDto[]; others: number; othersCalling: number } {
  const here = stations.filter((s) => worktreePath !== null && s.worktreePath === worktreePath);
  const away = stations.filter((s) => !(worktreePath !== null && s.worktreePath === worktreePath));
  const calling = (s: StationDto) => lightOf(s) === 'calling';
  here.sort((a, b) => Number(calling(b)) - Number(calling(a)) || tabOrder(a, b));
  return { here, others: away.length, othersCalling: away.filter(calling).length };
}
