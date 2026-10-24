// The worktree card: what a row in the sidebar's Focus looks like. Two lines,
// nothing said twice — the most human name for the work with when it was last
// opened (and who is open in it), then where it lives (repo · branch) with
// whatever is live on it (PR, changes, run, runner). The surface (glass card,
// accent bar, waiting edge) is the row's; behaviour (open, hover card, menus)
// is the caller's; this is only the shape.

/** Palette for repo avatars (tinted like the tab tiles); a repo keeps its colour by a hash of its id. */
const AVATAR_COLORS = [
  'bg-violet-400/10 ring-violet-400/20 text-violet-200',
  'bg-sky-400/10 ring-sky-400/20 text-sky-200',
  'bg-emerald-400/10 ring-emerald-400/20 text-emerald-200',
  'bg-amber-400/10 ring-amber-400/20 text-amber-200',
  'bg-rose-400/10 ring-rose-400/20 text-rose-200',
  'bg-teal-400/10 ring-teal-400/20 text-teal-200',
];

/** The same hues as a solid bar: the open card's left accent, in its repo's colour. */
const ACCENT_COLORS = ['bg-violet-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-rose-400', 'bg-teal-400'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Two letters: the initials of the first two words, else the first two letters. */
export function repoInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '??').slice(0, 2);
  return letters.toUpperCase();
}

/** A repo's accent colour (a bg-* class), stable by its id like its avatar. */
export function repoAccent(id: string): string {
  return ACCENT_COLORS[hash(id) % ACCENT_COLORS.length]!;
}

export function RepoAvatar({ id, name }: { id: string; name: string }) {
  const color = AVATAR_COLORS[hash(id) % AVATAR_COLORS.length]!;
  return (
    // The same 20px tinted tile the tab bar puts under a tab's icon (hub/TabTile).
    <span aria-hidden data-testid="repo-tile" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-[9px] font-semibold leading-none ring-1 ring-inset ${color}`}>
      {repoInitials(name)}
    </span>
  );
}

export function WorktreeCard({ repo, title, subtitle, time, active, muted = false, onOpen, label, agents, agentState = null, meta, titleClassName = '' }: {
  repo?: { id: string; name: string } | null;
  title: string;
  /** The branch: shown (mono) only when it says something the title does not. */
  subtitle: string;
  /** Already short: "5h". Empty hides the slot. */
  time: string;
  active: boolean;
  /** An unreachable runner's card: still here, but quiet. */
  muted?: boolean;
  onOpen: () => void;
  /** Accessible name of the whole card's button. */
  label: string;
  /** Beside the time: who is open here (the session avatars, tinted by state). */
  agents?: React.ReactNode;
  /** Said to assistive tech (the avatars' tint says it to the eye). */
  agentState?: 'working' | 'waiting' | null;
  /** After repo · branch, right-aligned: PR, changes, run dot, runner. */
  meta?: React.ReactNode;
  titleClassName?: string;
}) {
  const titleColor = muted ? 'text-zinc-500' : active ? 'text-zinc-100' : 'text-zinc-200';
  // The mono branch only when it adds something ("main" under "main" says nothing).
  const branch = subtitle.trim().toLowerCase() === title.trim().toLowerCase() ? '' : subtitle;
  return (
    // The whole card opens the worktree; the title button carries the
    // accessible name and keyboard focus, and its click bubbles up here.
    <div onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 py-2 pl-3 pr-2">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" aria-label={label} title={label}
          className={`block min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-5 ${titleColor} ${titleClassName}`}>
          {title}
        </button>
        {agentState && <span role="status" aria-label={`agent ${agentState}`} className="sr-only">{agentState === 'waiting' ? 'Waiting on you' : 'Working'}</span>}
        {agents}
        {time && <span data-card-time className="shrink-0 text-[11px] tabular-nums text-zinc-500">{time}</span>}
      </div>
      <div className={`flex min-h-4 min-w-0 items-center gap-1.5 text-[11px] ${muted ? 'text-zinc-600' : 'text-zinc-500'}`}>
        {repo && <span data-card-repo className="min-w-0 shrink truncate">{repo.name}</span>}
        {repo && branch && <span aria-hidden>·</span>}
        {branch && <span data-card-subtitle className="min-w-0 flex-1 truncate font-mono">{branch}</span>}
        {!branch && <span className="flex-1" />}
        {meta && <span className="flex shrink-0 items-center gap-1.5">{meta}</span>}
      </div>
    </div>
  );
}
