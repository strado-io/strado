import type { SessionChip } from '../../hooks/sessions';
import { chipStatus, displayLabel } from '../../hooks/sessions';
import { ClaudeIcon, CodexIcon, GlobeIcon, OpencodeIcon, PiIcon, ShellIcon, VsCodeIcon } from '../hub/icons';

// One colour per session kind, shared by the avatar stack on the row and the
// session list inside the hover card so the same session reads the same in
// both places.
export const SESSION_COLOR: Record<SessionChip['mode'], string> = {
  claude: 'text-amber-300',
  codex: 'text-sky-300',
  opencode: 'text-violet-300',
  pi: 'text-rose-300',
  shell: 'text-zinc-300',
  vscode: 'text-blue-400',
  browser: 'text-emerald-400',
};

export function SessionAvatarIcon({ chip }: { chip: SessionChip }) {
  // A shell someone launched an agent inside wears that agent's face.
  const mode = chip.mode === 'shell' && chip.hostedAgent ? chip.hostedAgent : chip.mode;
  if (mode === 'claude') return <ClaudeIcon size={12} />;
  if (mode === 'codex') return <CodexIcon size={12} />;
  if (mode === 'opencode') return <OpencodeIcon size={12} />;
  if (mode === 'pi') return <PiIcon size={12} />;
  if (mode === 'vscode') return <VsCodeIcon size={12} />;
  if (mode === 'browser') return <GlobeIcon className="h-3 w-3" />;
  return <ShellIcon size={12} />;
}

// Who is open in this worktree, as overlapping faces. Names and live status
// are the hover card's job. Three is what a narrow rail can carry without
// crowding out the name; the rest become a count.
const MAX_AVATARS = 3;

/** With `tinted`, each face's ring says what that agent is doing. */
const STATE_RING = {
  working: 'ring-sky-400/80',
  waiting: 'ring-amber-400',
  idle: 'ring-zinc-950',
} as const;
const STATE_WORD = { working: 'working', waiting: 'waiting on you', idle: 'idle' } as const;

export function SessionAvatarStack({ chips, testId, tinted = false }: {
  chips: SessionChip[];
  testId: string;
  /** Ring each face by its agent's state (working, waiting, idle). */
  tinted?: boolean;
}) {
  if (chips.length === 0) return null;
  const visible = chips.slice(0, MAX_AVATARS);
  const overflow = chips.length - visible.length;
  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={`${chips.length} open session${chips.length === 1 ? '' : 's'}: ${chips.map((c) => {
        const st = tinted ? chipStatus(c) : undefined;
        return st ? `${displayLabel(c)} (${STATE_WORD[st]})` : displayLabel(c);
      }).join(', ')}`}
      className="flex shrink-0 items-center"
    >
      {visible.map((chip, index) => {
        const st = tinted ? chipStatus(chip) : undefined;
        return (
          <span
            key={`${chip.mode}:${chip.sessionId}`}
            data-session-avatar
            data-state={st}
            aria-hidden
            className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 ring-1 ${STATE_RING[st ?? 'idle']} ${SESSION_COLOR[chip.mode]} ${index > 0 ? '-ml-1' : ''}`}
            style={{ zIndex: index + 1 }}
          >
            <SessionAvatarIcon chip={chip} />
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          data-session-overflow
          aria-hidden
          className="relative -ml-1 flex h-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 px-1 font-mono text-[11px] leading-none text-zinc-400 ring-1 ring-zinc-950"
          style={{ zIndex: visible.length + 1 }}
        >+{overflow}</span>
      )}
    </span>
  );
}
