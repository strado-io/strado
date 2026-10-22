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

// Mission Control: one state per station (strip and box), its live line,
// the order to show them in, and which ones to show (this Focus or the workspace).
export type StationState = 'needs_you' | 'failed' | 'limited' | 'working' | 'idle' | 'offline';

/** failed / limited have no source yet; they keep their place in the order. */
export function stateOf(s: StationDto): StationState {
  if (s.needsYou || s.calls.length > 0 || (s.approvals?.length ?? 0) > 0) return 'needs_you';
  if (!s.live) return 'offline';
  if (s.lifecycle === 'working') return 'working';
  return 'idle';
}

const STATE_WORD: Record<StationState, string> = { needs_you: 'needs you', failed: 'failed', limited: 'limited', working: 'working', idle: 'idle', offline: 'offline' };
export const stateWord = (state: StationState): string => STATE_WORD[state];

const firstLine = (text: string): string => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** The tool line while working ("Bash: npm test"); after, "done: " and the last answer's first line. */
export function activityLine(s: StationDto): string {
  if (stateOf(s) === 'working') return s.activity?.text.trim() ?? '';
  const done = s.lastResult ? firstLine(s.lastResult.text) : '';
  return done ? `done: ${done}` : '';
}

/** Worktree, then tab order: a fixed place per agent, never moved by its state
 * (the pill's colour says that). A new array. */
export function sortStations<T extends StationDto>(stations: T[]): T[] {
  return [...stations].sort((a, b) => a.worktreeName.localeCompare(b.worktreeName) || tabOrder(a, b));
}

export type StationScope = 'focus' | 'workspace';
export type ScopedStation = StationDto & { outside?: true };

/** In a Focus: its worktrees' stations, plus anyone else in the workspace who
 * needs you (flagged `outside`, shown with its worktreeName). No Focus open: the workspace. */
export function scopeStations(stations: StationDto[], opts: { scope: StationScope; focusWorktrees: string[] | null }): ScopedStation[] {
  if (opts.scope === 'workspace' || !opts.focusWorktrees) return stations;
  const inFocus = new Set(opts.focusWorktrees);
  return stations.flatMap((s): ScopedStation[] => {
    if (inFocus.has(s.worktreePath)) return [s];
    return stateOf(s) === 'needs_you' ? [{ ...s, outside: true }] : [];
  });
}

const scopeKey = (wsId: string) => `strado:station-scope:${wsId}`;

export function readStationScope(wsId: string): StationScope {
  try {
    return localStorage.getItem(scopeKey(wsId)) === 'workspace' ? 'workspace' : 'focus';
  } catch {
    return 'focus';
  }
}

export function writeStationScope(wsId: string, scope: StationScope): void {
  try {
    localStorage.setItem(scopeKey(wsId), scope);
  } catch { /* private window: the choice lasts this page only */ }
}
