import type React from 'react';

// The tile under each tab's icon, tinted by kind (the icon keeps its status colour).
const TILE: Record<string, string> = {
  claude: 'bg-[#d97757]/15 ring-[#d97757]/25',
  codex: 'bg-white/[0.06] ring-white/10',
  opencode: 'bg-white/[0.06] ring-white/10',
  pi: 'bg-white/[0.06] ring-white/10',
  // One clear hue per kind, none shared: green, blue, purple, yellow, pink.
  shell: 'bg-emerald-400/15 ring-emerald-400/30',
  browser: 'bg-sky-400/15 ring-sky-400/30',
  kb: 'bg-violet-400/15 ring-violet-400/30',
  diff: 'bg-amber-400/15 ring-amber-400/30',
  files: 'bg-rose-400/15 ring-rose-400/30',
};
/** The icon colour of a non-agent kind at rest, matching its tile (agents keep their status colours). */
export const KIND_ICON: Record<'shell' | 'browser' | 'kb' | 'diff' | 'files', string> = {
  shell: 'text-emerald-300',
  browser: 'text-sky-300',
  kb: 'text-violet-300',
  diff: 'text-amber-300',
  files: 'text-rose-300',
};
/** A tab's icon on its small rounded tile, tinted by kind (the icon keeps its status colour). Shared with the pane cards. */
export function TabTile({ mode, icon }: { mode: string; icon: React.ReactNode }) {
  return (
    <span aria-hidden="true" data-testid="tab-tile" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] ring-1 ring-inset ${TILE[mode] ?? TILE.codex}`}>
      {icon}
    </span>
  );
}

// The edge a member behind the front tile shows: its kind's colour, solid.
const EDGE: Record<string, string> = {
  claude: '#b8644a', shell: '#2f8f6a', browser: '#2b7fb3', kb: '#7457c2', diff: '#a8782f', files: '#c2536a',
};

/** A group's members as a deck, like Rex: the first member's tile in front,
 * up to two more peeking out behind it as thin edges in their kind's colour. */
export function TileStack({ tiles }: { tiles: { key: string; mode: string; icon: React.ReactNode }[] }) {
  const deck = tiles.slice(0, 3);
  const front = deck[0];
  if (!front) return null;
  return (
    <span aria-hidden="true" data-testid="tile-stack" className="relative flex h-5 shrink-0" style={{ width: 20 + 4 * (deck.length - 1) }}>
      {deck.slice(1).map((t, i) => (
        <span key={t.key} data-testid="tile-layer"
          className="absolute top-[2px] h-4 w-5 rounded-[6px] ring-1 ring-black/60"
          style={{ left: 4 * (i + 1), zIndex: 2 - i, background: EDGE[t.mode] ?? '#52525b' }} />
      ))}
      <span data-testid="tile-layer" className="absolute left-0 top-0 z-10 rounded-[6px] bg-[rgb(14_15_18)] shadow-[2px_0_3px_rgba(0,0,0,0.5)]">
        <TabTile mode={front.mode} icon={front.icon} />
      </span>
    </span>
  );
}

/** A group's title: its name, else the first two members and how many more. */
export function groupTitle(name: string | null | undefined, members: string[]): string {
  if (name) return name;
  return members.length <= 2 ? members.join(' · ') : `${members.slice(0, 2).join(' · ')} +${members.length - 2}`;
}
