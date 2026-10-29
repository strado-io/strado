import type { ChatEntry, TabCardRef } from '../../types';
import { AnswerText } from '../jarvis/AnswerText';
import { ApprovalCard } from './ApprovalCard';
import { TabCard } from './TabCard';
import { useState } from 'react';
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

/** One line of the chat: the person's bubble on the right, Jarvis's reply as
 * plain text, each step it took as one line with an icon (and the tab it
 * opened), an approval, or a note. */
export function ChatEntryView({ entry, live = false, resolve, onOpenCard, onApprove }: ViewProps) {
  switch (entry.type) {
    case 'user':
      return <UserBubble text={entry.text} />;
    case 'jarvis':
      return (
        <div className="text-[14px] leading-relaxed text-zinc-200" aria-busy={!entry.done}>
          <AnswerText text={entry.text} />
        </div>
      );
    case 'action':
      return (
        <div className="flex flex-col gap-1">
          <ToolLine entry={entry} live={live} />
          {entry.card && <div className="ml-[22px]"><TabCard card={entry.card} resolved={resolve(entry.card)} onOpen={onOpenCard} /></div>}
        </div>
      );
    case 'approval':
      return <ApprovalCard entry={entry} onApprove={onApprove} />;
    case 'event':
      return <EventLine text={entry.text} />;
    case 'agent':
      // Not shown: the model button below already says which agent runs Jarvis.
      return null;
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

/** A long message folds to its first lines; "Show more" opens it, "Show less" folds it again. */
const LONG_CHARS = 600;
const LONG_LINES = 10;

/** Your message: a roomy bubble on the right. */
function UserBubble({ text }: { text: string }) {
  const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col rounded-[20px] bg-white/[0.08] px-5 py-3.5">
        <div data-testid="jarvis-user"
          className={`whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-100 ${folded ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}`}>
          {text}
        </div>
        {long && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 self-end text-[12px] text-zinc-500 hover:text-zinc-300">
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}
