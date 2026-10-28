import type { ChatEntry, TabCardRef } from '../../types';
import { AnswerText } from '../jarvis/AnswerText';
import { ApprovalCard } from './ApprovalCard';
import { TabCard } from './TabCard';
import { EventLine, ToolLine } from './ToolLine';
import type { ResolvedCard } from './cards';

export type EntryHandlers = {
  resolve: (card: TabCardRef) => ResolvedCard;
  onOpenCard: (r: Extract<ResolvedCard, { open: true }>) => void;
  /** Resolves once the server has the answer; the card waits for it (W4). */
  onApprove: (entryId: string, approve: boolean) => Promise<void>;
};

/** `live`: the turn is still running (a step marked running really is). */
type ViewProps = { entry: ChatEntry; live?: boolean } & EntryHandlers;

const quiet = 'text-[12px] text-zinc-500';
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };

/** One line of the chat: the person's bubble on the right, Jarvis's reply as
 * plain text, each step it took as one line with an icon (and the tab it
 * opened), an approval, or a note. */
export function ChatEntryView({ entry, live = false, resolve, onOpenCard, onApprove }: ViewProps) {
  switch (entry.type) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div data-testid="jarvis-user" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-white/10 px-3.5 py-2 text-[13px] text-zinc-100">{entry.text}</div>
        </div>
      );
    case 'jarvis':
      return (
        <div className="text-[13px] leading-relaxed text-zinc-200" aria-busy={!entry.done}>
          <AnswerText text={entry.text} />
        </div>
      );
    case 'action':
      return (
        <div className="flex flex-col gap-1">
          <ToolLine entry={entry} live={live} />
          {entry.card && <div className="ml-7"><TabCard card={entry.card} resolved={resolve(entry.card)} onOpen={onOpenCard} /></div>}
        </div>
      );
    case 'approval':
      return <ApprovalCard entry={entry} onApprove={onApprove} />;
    case 'event':
      return <EventLine text={entry.text} />;
    case 'agent':
      return <div className={`text-center ${quiet}`}>Jarvis now runs on {AGENT_NAMES[entry.agent] ?? entry.agent}</div>;
    case 'turn':
      if (entry.state === 'failed') {
        return (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
            {entry.error ?? 'Jarvis stopped with an error'}
            {entry.fix && <div className="mt-0.5 text-zinc-300">{entry.fix}</div>}
          </div>
        );
      }
      if (entry.state === 'stopped' || entry.state === 'interrupted') {
        return <div className={quiet}>{entry.state === 'stopped' ? 'Stopped' : 'Interrupted'}</div>;
      }
      return null;
  }
}
