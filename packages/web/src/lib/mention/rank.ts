// The `@` picker's order (spec: 2026-10-17-strado-dock-intercom-design.md).
// Who is calling you first, then the tab you are in, then the rest of this
// worktree, and other worktrees last below a divider — so a same-named
// claude-1 elsewhere is never the one you pick by accident.

export type StationStatus = 'calling' | 'working' | 'idle' | 'offline';

export type Station = {
  agentId: string;
  name: string;
  alias?: string | null;
  worktreeName: string;
  inThisWorktree: boolean;
  focused: boolean;
  status: StationStatus;
  /** ms epoch of the last terminal activity; 0 when unknown. */
  lastActivityAt: number;
};

export type RankedStations = {
  rows: Station[];
  /** Index of the first "other worktrees" row, or null when there is none. */
  dividerBefore: number | null;
};

/** 0 = prefix match, 1 = substring match, null = no match. */
function matchRank(s: Station, q: string): 0 | 1 | null {
  if (!q) return 0;
  const names = [s.name, s.alias ?? ''].map((n) => n.toLowerCase()).filter(Boolean);
  if (names.some((n) => n.startsWith(q))) return 0;
  if (names.some((n) => n.includes(q))) return 1;
  return null;
}

/** 0 calling · 1 focused · 2 this worktree · 3 other worktrees. */
function group(s: Station): number {
  if (s.status === 'calling') return 0;
  if (s.focused) return 1;
  return s.inThisWorktree ? 2 : 3;
}

export function rankStations(stations: Station[], query: string, limit = 6): RankedStations {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  const scored = stations
    .map((s) => ({ s, m: matchRank(s, q), g: group(s) }))
    .filter((x): x is { s: Station; m: 0 | 1; g: number } => x.m !== null);
  scored.sort((a, b) =>
    a.g - b.g
    || a.m - b.m
    || Number(a.s.status === 'offline') - Number(b.s.status === 'offline')
    || b.s.lastActivityAt - a.s.lastActivityAt
    || a.s.name.localeCompare(b.s.name));
  const rows = scored.slice(0, Math.max(0, limit)).map((x) => x.s);
  const first = scored.slice(0, rows.length).findIndex((x) => x.g === 3);
  return { rows, dividerBefore: first === -1 ? null : first };
}
