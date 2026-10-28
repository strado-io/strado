import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatEntry, JarvisMeta, JarvisSettings } from '../../types';
import { ChatEntryView, type EntryHandlers } from './ChatEntryView';
import { ThinkingLine } from './ToolLine';
import { JarvisComposer, type AgentChip, type WorktreeChip } from './JarvisComposer';
import type { RecentWorktree } from '../../lib/home/recent';
import type { Worktree } from '../../types';
import { shortRelativeTime } from '../../lib/relativeTime';

/** What the empty chat offers: the Focus's recent worktrees, or, for a blank Focus, ways to fill it. */
export type JarvisStart = {
  recent: RecentWorktree[];
  onOpenRecent: (w: Worktree) => void;
  onAddWorktrees: () => void;
  onNewWorktree: () => void;
};

/** The log as read, as agents show it: within each run of one turn's
 * entries, the steps Jarvis took first (in their order), then its answer, then
 * anything left to settle (an approval, how the turn ended). Runs stay where
 * they are, so a later message never moves above a turn. */
export function displayOrder(entries: ChatEntry[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  const turnOf = (e: ChatEntry) => ('turnId' in e ? e.turnId : null);
  for (let i = 0; i < entries.length;) {
    const t = turnOf(entries[i]!);
    let j = i + 1;
    if (t !== null) while (j < entries.length && turnOf(entries[j]!) === t) j++;
    const run = entries.slice(i, j);
    out.push(
      ...run.filter((e) => e.type === 'action'),
      ...run.filter((e) => e.type === 'jarvis'),
      ...run.filter((e) => e.type !== 'action' && e.type !== 'jarvis'),
    );
    i = j;
  }
  return out;
}

/** A Focus's Jarvis in the main area, T3 Code style: one centred column, the
 * chat scrolling above, the composer pinned below. */
export function FocusJarvisView({ focusName, entries, meta, hasOlder, error = null, onSend, onStop, onSettings, onLoadOlder, agents, worktrees, start, ...handlers }: {
  focusName: string;
  /** The empty chat's starting points (none in tests that don't need them). */
  start?: JarvisStart;
  entries: ChatEntry[];
  meta: JarvisMeta | null;
  hasOlder: boolean;
  /** The last send/approve/stop that failed, said above the composer. */
  error?: string | null;
  /** Resolves once the server has the message; rejects to keep the draft. */
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  /** A model or effort picked in the composer's menu. */
  onSettings: (settings: JarvisSettings) => void;
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

  const running = Boolean(meta?.running);
  // Only the newest turn's steps can still be running; an older one left
  // "running" was cut off.
  const lastTurn = [...entries].reverse().find((e) => 'turnId' in e);
  const lastTurnId = lastTurn && 'turnId' in lastTurn ? lastTurn.turnId : null;
  const live = (e: ChatEntry) => running && 'turnId' in e && e.turnId === lastTurnId;
  // "Thinking…" while the turn runs and nothing else shows it: no step is
  // spinning and no answer is streaming in.
  const thinking = running && !entries.some((e) => live(e) && (
    (e.type === 'action' && e.state === 'running') || (e.type === 'jarvis' && !e.done)
  ));

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
              {start && <JarvisStartList start={start} />}
            </div>
          )}
          {groupSteps(displayOrder(entries)).map((g) => g.length === 1
            ? <ChatEntryView key={g[0]!.id} entry={g[0]!} live={live(g[0]!)} {...handlers} />
            : (
              // A turn's steps sit together, a line each, like any agent's tool calls.
              <div key={g[0]!.id} data-testid="jarvis-steps" className="-my-1 flex flex-col gap-0.5">
                {g.map((e) => <ChatEntryView key={e.id} entry={e} live={live(e)} {...handlers} />)}
              </div>
            ))}
          {thinking && <ThinkingLine />}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[640px] px-4 pb-4">
        {error && <div role="alert" className="mb-2 text-[12px] text-red-300">{error}</div>}
        <JarvisComposer running={Boolean(meta?.running)} agent={meta?.agent ?? 'claude'}
          model={meta?.model ?? null} effort={meta?.effort ?? null} onSettings={onSettings} onSend={onSend} onStop={onStop} agents={agents} worktrees={worktrees} />
      </div>
    </section>
  );
}

/** Entries drawn as one-line steps: actions, decided approvals, agents' reports. */
const isStep = (e: ChatEntry) => e.type === 'action' || e.type === 'event' || (e.type === 'approval' && e.state !== 'pending');

/** Consecutive steps as one group; everything else on its own. */
function groupSteps(list: ChatEntry[]): ChatEntry[][] {
  const out: ChatEntry[][] = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    if (isStep(e) && prev && isStep(prev[0]!)) prev.push(e);
    else out.push([e]);
  }
  return out;
}

// The home screen's Recent rows, for this Focus only.
const START_ACTION = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-[rgb(var(--pane-edge)/0.05)]';
function JarvisStartList({ start }: { start: JarvisStart }) {
  return (
    <div className="mt-8 text-left">
      {start.recent.length > 0 ? (
        <>
          <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Recent in this Focus</div>
          <ul aria-label="Recent in this Focus">
            {start.recent.map((r) => (
              <li key={r.worktree.path}>
                <button type="button" onClick={() => start.onOpenRecent(r.worktree)} className={START_ACTION}>
                  <span className="truncate text-zinc-200">{r.name}</span>
                  {r.repo && <span className="truncate text-xs text-zinc-500">· {r.repo}</span>}
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(r.openedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-col">
          <button type="button" onClick={start.onAddWorktrees} className={START_ACTION}>Add worktrees</button>
          <button type="button" onClick={start.onNewWorktree} className={START_ACTION}>New worktree here</button>
        </div>
      )}
    </div>
  );
}
