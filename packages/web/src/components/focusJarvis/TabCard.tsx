import type React from 'react';
import type { TabCardRef } from '../../types';
import { KIND_ICON, TabTile } from '../hub/TabTile';
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
    <div data-testid="tab-card" data-closed={closed}
      className={`glass pane-card flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 ${closed ? 'opacity-50' : ''}`}>
      <TabTile mode={tileMode} icon={<Icon className={closed ? 'text-zinc-500' : KIND_ICON[tileMode]} />} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-zinc-200">{title}</div>
        <div className="truncate text-[11px] text-zinc-500">
          {card.worktree}
          {resolved.open && resolved.status && (
            <span className={resolved.status === 'working' || resolved.status === 'needs you' ? 'text-amber-300' : ''}> · {resolved.status}</span>
          )}
        </div>
      </div>
      {resolved.open
        ? <button type="button" onClick={() => onOpen(resolved)} aria-label={`Open ${title}`}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-zinc-300 hover:bg-white/10 hover:text-zinc-100">Open</button>
        : <span className="shrink-0 text-[11px] text-zinc-500">closed</span>}
    </div>
  );
}
