import type { ChatEntry, TabCardRef } from '../../types';
import { AnswerText } from '../jarvis/AnswerText';
import { ApprovalCard } from './ApprovalCard';
import { TabCard } from './TabCard';
import type { ResolvedCard } from './cards';

export type EntryHandlers = {
  resolve: (card: TabCardRef) => ResolvedCard;
  onOpenCard: (r: Extract<ResolvedCard, { open: true }>) => void;
  onApprove: (entryId: string, approve: boolean) => void;
};

const quiet = 'text-[12px] text-zinc-500';

/** One line of the chat: the person's bubble on the right, Jarvis's reply as
 * plain text, its work as a compact log line (with the tab it opened), an
 * approval, or a note. */
export function ChatEntryView({ entry, resolve, onOpenCard, onApprove }: { entry: ChatEntry } & EntryHandlers) {
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
        <div className="flex flex-col gap-1.5">
          <div className={`flex min-w-0 items-baseline gap-1.5 ${quiet}`} data-testid="jarvis-action">
            <span aria-hidden className={entry.ok ? 'text-emerald-400' : 'text-red-400'}>{entry.ok ? '✓' : '✗'}</span>
            <span className="truncate">{entry.summary}{entry.error ? ` — ${entry.error}` : ''}</span>
          </div>
          {entry.card && <TabCard card={entry.card} resolved={resolve(entry.card)} onOpen={onOpenCard} />}
        </div>
      );
    case 'approval':
      return <ApprovalCard entry={entry} onApprove={onApprove} />;
    case 'event':
      return <div className={`text-center ${quiet}`}>{entry.text}</div>;
    case 'agent':
      return <div className={`text-center ${quiet}`}>Jarvis now runs on {entry.agent === 'claude' ? 'Claude' : entry.agent}</div>;
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
