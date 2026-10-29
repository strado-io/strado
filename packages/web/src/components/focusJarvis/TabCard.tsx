import type React from 'react';
import type { TabCardRef } from '../../types';
import { KIND_ICON } from '../hub/TabTile';
import { ClaudeIcon, CodexIcon, GlobeIcon, OpencodeIcon, PiIcon, ShellIcon } from '../hub/icons';
import type { ResolvedCard } from './cards';

const ICON: Record<TabCardRef['kind'], (p: { className?: string }) => React.ReactElement> = {
  claude: ClaudeIcon, codex: CodexIcon, opencode: OpencodeIcon, pi: PiIcon, shell: ShellIcon, run: ShellIcon, browser: GlobeIcon,
};
const KIND_LABEL: Record<TabCardRef['kind'], string> = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', shell: 'Shell', run: 'Run', browser: 'Browser',
};

/** A tab Jarvis opened, as one line: its kind's icon, "Shell opened", the tab
 * and worktree, the command it ran. A click jumps to the tab. Once the tab is
 * gone the line stays in the log, greyed, "closed". */
export function TabCard({ card, resolved, onOpen, command, running = false }: {
  card: TabCardRef;
  resolved: ResolvedCard;
  onOpen: (r: Extract<ResolvedCard, { open: true }>) => void;
  /** What Jarvis ran in it, if anything. */
  command?: string;
  /** The step is still going. */
  running?: boolean;
}) {
  const Icon = ICON[card.kind];
  const tileMode = card.kind === 'run' ? 'shell' : card.kind;
  const closed = !resolved.open;
  const kind = KIND_LABEL[card.kind];
  const name = card.label || card.url || card.tab;
  const status = resolved.open ? resolved.status : '';
  const line = (
    <>
      <Icon className={`shrink-0 ${closed ? 'text-zinc-500' : KIND_ICON[tileMode]}`} />
      <span className="min-w-0 truncate">
        <span className={`font-medium ${running ? 'jarvis-shimmer' : 'text-zinc-300'}`}>{running ? `Opening ${kind.toLowerCase()}` : `${kind} opened`}</span>
        <span className="text-zinc-500"> {name} · {card.worktree}</span>
        {command && <span className="text-zinc-500"> · ran <code className="font-mono text-[11.5px] text-zinc-400">{command}</code></span>}
        {status && status !== 'idle' && (
          <span className={status === 'working' || status === 'needs you' ? 'text-amber-300' : 'text-zinc-500'}> · {status}</span>
        )}
      </span>
      {closed && <span className="shrink-0 text-[11px] text-zinc-600">closed</span>}
    </>
  );
  const row = 'flex w-fit min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px]';
  return (
    <div data-testid="tab-card" data-closed={closed} className={`-mx-1.5 ${closed ? 'opacity-60' : ''}`}>
      {resolved.open
        ? <button type="button" onClick={() => onOpen(resolved)} aria-label={`Open ${kind} ${name}`} title={`Open ${name}`}
            className={`${row} hover:bg-[rgb(var(--pane-edge)/0.05)]`}>{line}</button>
        : <div className={row}>{line}</div>}
    </div>
  );
}
