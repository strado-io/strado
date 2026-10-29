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

/** A tab Jarvis opened, live: its kind's tile, name and worktree, and Open to
 * jump to it. Once the tab is gone the card stays in the log, greyed, "closed". */
export function TabCard({ card, resolved, onOpen }: { card: TabCardRef; resolved: ResolvedCard; onOpen: (r: Extract<ResolvedCard, { open: true }>) => void }) {
  const Icon = ICON[card.kind];
  const tileMode = card.kind === 'run' ? 'shell' : card.kind;
  const closed = !resolved.open;
  const title = card.label || card.url || `${KIND_LABEL[card.kind]} · ${card.tab}`;
  return (
    // One compact line: the step above it already says what happened.
    <div data-testid="tab-card" data-closed={closed}
      className={`flex h-9 min-w-0 items-center gap-2 rounded-lg border border-[rgb(var(--pane-edge)/0.08)] bg-[rgb(var(--pane-edge)/0.03)] pl-2.5 pr-1 ${closed ? 'opacity-50' : ''}`}>
      <Icon className={`shrink-0 ${closed ? 'text-zinc-500' : KIND_ICON[tileMode]}`} />
      <div className="min-w-0 flex-1 truncate text-[12.5px]">
        <span className="font-medium text-zinc-200">{title}</span>
        <span className="text-zinc-500"> · {card.worktree}</span>
        {resolved.open && resolved.status && (
          <span className={resolved.status === 'working' || resolved.status === 'needs you' ? 'text-amber-300' : 'text-zinc-500'}> · {resolved.status}</span>
        )}
      </div>
      {resolved.open
        ? <button type="button" onClick={() => onOpen(resolved)} aria-label={`Open ${title}`}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-zinc-300 hover:bg-white/10 hover:text-zinc-100">Open</button>
        : <span className="shrink-0 text-[11px] text-zinc-500">closed</span>}
    </div>
  );
}
