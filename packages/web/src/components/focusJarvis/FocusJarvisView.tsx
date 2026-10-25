import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatEntry, JarvisMeta } from '../../types';
import { ChatEntryView, type EntryHandlers } from './ChatEntryView';
import { JarvisComposer, type AgentChip, type WorktreeChip } from './JarvisComposer';

/** A Focus's Jarvis in the main area, T3 Code style: one centred column, the
 * chat scrolling above, the composer pinned below. */
export function FocusJarvisView({ focusName, entries, meta, hasOlder, error = null, onSend, onStop, onLoadOlder, agents, worktrees, ...handlers }: {
  focusName: string;
  entries: ChatEntry[];
  meta: JarvisMeta | null;
  hasOlder: boolean;
  /** The last send/approve/stop that failed, said above the composer. */
  error?: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onLoadOlder: () => void;
  agents: AgentChip[];
  worktrees: WorktreeChip[];
} & EntryHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  // Follow the newest line while the person is at the bottom; leave them be when they've scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  useEffect(() => { pinned.current = true; }, [focusName]);

  return (
    <section aria-label="Jarvis" className="flex h-full min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-6">
          {hasOlder && (
            <button type="button" onClick={onLoadOlder} className="self-center text-[12px] text-zinc-500 hover:text-zinc-300">Earlier messages</button>
          )}
          {entries.length === 0 && (
            <div className="mt-[20vh] text-center">
              <div aria-hidden className="text-2xl text-[#e8906f]">✦</div>
              <div className="mt-2 text-[15px] text-zinc-200">What should we do in {focusName}?</div>
              <div className="mt-1 text-[12px] text-zinc-500">Jarvis can open worktrees and tabs, run scripts and talk to your agents.</div>
            </div>
          )}
          {entries.map((e) => <ChatEntryView key={e.id} entry={e} {...handlers} />)}
          {meta?.running && <div aria-live="polite" className="text-[12px] text-zinc-500"><span className="animate-pulse">Working…</span></div>}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[640px] px-4 pb-4">
        {error && <div role="alert" className="mb-2 text-[12px] text-red-300">{error}</div>}
        <JarvisComposer running={Boolean(meta?.running)} agent={meta?.agent ?? 'claude'} onSend={onSend} onStop={onStop} agents={agents} worktrees={worktrees} />
      </div>
    </section>
  );
}
