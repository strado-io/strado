import { chipStatus, displayLabel, type SessionChip } from '../hooks/sessions';
import { ClaudeIcon, CodexIcon, OpencodeIcon, GlobeIcon, ShellIcon, VsCodeIcon } from './hub/icons';

// Icons inherit the chip's text colour (fill/stroke = currentColor) so they
// brighten with the chip on hover — no fixed colour class here. A shell that
// is hosting a hand-launched agent wears that agent's icon.
function icon(chip: SessionChip) {
  const mode = chip.mode === 'shell' ? (chip.hostedAgent ?? 'shell') : chip.mode;
  if (mode === 'claude') return <ClaudeIcon />;
  if (mode === 'codex') return <CodexIcon />;
  if (mode === 'opencode') return <OpencodeIcon />;
  if (mode === 'vscode') return <VsCodeIcon />;
  if (mode === 'browser') return <GlobeIcon />;
  return <ShellIcon />;
}

const STATUS_DOT: Record<string, string> = {
  working: 'bg-amber-400 animate-pulse',
  waiting: 'bg-blue-400',
};

// One session as a compact icon chip. Click opens it; a corner dot shows a
// live status (working/waiting); a ✕ on hover closes it. The label lives in the
// tooltip and the accessible name so the strip stays to a single icon.
export function SessionChipButton({
  chip, worktreeLabel, onOpen, onClose, active = false,
}: {
  chip: SessionChip;
  worktreeLabel: string;
  onOpen: (path: string, mode: SessionChip['mode'], id?: string) => void;
  onClose?: (path: string, mode: SessionChip['mode'], id?: string) => void;
  /** This session is the one open on screen — highlight its chip. */
  active?: boolean;
}) {
  const status = chipStatus(chip);
  const label = displayLabel(chip);
  const busy = status && status !== 'idle' ? status : null;
  const dot = busy ? STATUS_DOT[busy] : null;
  const fullLabel = busy ? `${label} (${busy})` : label;
  return (
    <div className="group relative">
      <button
        onClick={() => onOpen(chip.path, chip.mode, chip.sessionId)}
        aria-label={`${worktreeLabel} ${fullLabel}`}
        aria-current={active ? 'true' : undefined}
        title={`${worktreeLabel} — ${fullLabel}`}
        className={`flex h-7 w-7 items-center justify-center rounded-md ${
          active
            ? 'bg-zinc-800 text-zinc-50 ring-1 ring-sky-500'
            : 'bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
        }`}
      >
        {icon(chip)}
      </button>
      {dot && (
        <span className={`pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-zinc-950 ${dot}`} />
      )}
      {onClose && (
        <button
          onClick={() => onClose(chip.path, chip.mode, chip.sessionId)}
          aria-label={`Close ${worktreeLabel} ${label}`}
          className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-zinc-700 text-[9px] leading-none text-zinc-100 ring-2 ring-zinc-950 hover:bg-red-500 hover:text-white group-hover:flex"
        >
          ✕
        </button>
      )}
    </div>
  );
}
