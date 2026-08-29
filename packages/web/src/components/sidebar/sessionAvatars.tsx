import type { SessionChip } from '../../hooks/sessions';
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
