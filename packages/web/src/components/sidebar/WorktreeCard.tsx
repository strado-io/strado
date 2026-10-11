// The worktree card: what a row in the sidebar's Focus looks like. Three
// lines — the repo it belongs to and when it was last opened, the most human
// name we have for the work, then the branch with whatever is live on it
// (PR state, changes, sessions). Behaviour (open, hover card, menus) is the
// caller's; this is only the shape.

/** Palette for repo avatars; a repo keeps its colour by a hash of its id. */
const AVATAR_COLORS = [
  'bg-violet-500/25 text-violet-200',
  'bg-sky-500/25 text-sky-200',
  'bg-emerald-500/25 text-emerald-200',
  'bg-amber-500/25 text-amber-200',
  'bg-rose-500/25 text-rose-200',
  'bg-teal-500/25 text-teal-200',
];

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

export function RepoAvatar({ id, name }: { id: string; name: string }) {
  const color = AVATAR_COLORS[hash(id) % AVATAR_COLORS.length]!;
  return (
    <span aria-hidden className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-semibold leading-none ${color}`}>
      {repoInitials(name)}
    </span>
  );
}

export function WorktreeCard({ repo, title, subtitle, time, active, muted = false, onOpen, label, titleLeading, leading, trailing, titleClassName = '' }: {
  repo?: { id: string; name: string } | null;
  title: string;
  subtitle: string;
  /** Already short: "5h". Empty hides the slot. */
  time: string;
  active: boolean;
  /** An unreachable runner's card: still here, but quiet. */
  muted?: boolean;
  onOpen: () => void;
  /** Accessible name of the whole card's button. */
  label: string;
  /** Before the title: the agent's state (working spinner, waiting flag). */
  titleLeading?: React.ReactNode;
  /** Before the subtitle: the PR state icon. */
  leading?: React.ReactNode;
  /** After the subtitle, right-aligned: changes, sessions, run dot, runner. */
  trailing?: React.ReactNode;
  titleClassName?: string;
}) {
  // A resting card reads quietly; the one you are in is the bright one.
  const titleColor = muted ? 'text-zinc-500' : active ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200';
  return (
    // The whole card opens the worktree; the title button carries the
    // accessible name and keyboard focus, and its click bubbles up here.
    <div onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer flex-col py-2 pl-2 pr-1.5">
      {repo && (
        <div data-card-repo className="mb-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
          <RepoAvatar id={repo.id} name={repo.name} />
          <span className="min-w-0 flex-1 truncate">{repo.name}</span>
          {time && <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{time}</span>}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        {titleLeading && <span className="flex h-4 w-3.5 shrink-0 items-center justify-center">{titleLeading}</span>}
        <button type="button" aria-label={label} title={label}
          className={`block min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-5 ${titleColor} ${titleClassName}`}>
          {title}
        </button>
      </div>
      <div className="mt-px flex min-h-4 items-center gap-1.5">
        {leading}
        {subtitle && (
          <span data-card-subtitle className={`min-w-0 flex-1 truncate font-mono text-[11px] ${muted ? 'text-zinc-600' : 'text-zinc-500'}`}>{subtitle}</span>
        )}
        {!subtitle && <span className="flex-1" />}
        {trailing && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
      </div>
    </div>
  );
}
