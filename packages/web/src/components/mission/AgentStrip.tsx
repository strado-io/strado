import { useState, type ReactNode } from 'react';
import { ClaudeIcon, CodexIcon, OpencodeIcon, PiIcon, ShellIcon } from '../hub/icons';
import type { AgentStateName } from './tone';

export type StripAgent = {
  agentId: string;
  name: string;
  /** Which harness (claude, codex, opencode, pi, shell): its own icon on the pill. */
  mode?: string;
  state: AgentStateName;
  /** The state as a word ("needs you"): in the pill's name and title, so the dot is never colour alone. */
  word: string;
  activity: string | null;
  /** The worktree it is in, when it is shown from outside the Focus. */
  outside?: string | null;
  /** Where it is, when another shown agent has the same name. */
  place?: string | null;
  /** Its project, when the shown agents span several: a label heads each project's pills. */
  project?: string | null;
};
const SHOWN = 5;
// The pill's surface is its state: quiet when idle, tinted when it wants a look.
const PILL: Record<StripAgent['state'], string> = {
  idle: 'border-white/[0.07] bg-white/[0.03] text-zinc-300 hover:border-white/15 hover:bg-white/[0.06]',
  working: 'border-sky-400/25 bg-sky-400/[0.07] text-zinc-200 hover:border-sky-400/40',
  needs_you: 'border-amber-400/40 bg-amber-400/10 text-amber-100 hover:border-amber-400/60',
  offline: 'border-white/[0.05] bg-transparent text-zinc-500 hover:border-white/10',
  failed: 'border-red-400/35 bg-red-400/10 text-red-100 hover:border-red-400/55',
  limited: 'border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:border-white/15',
};
// A slow breathing glow (index.css) while it works or waits on you; still under reduced motion.
const BREATHE: Partial<Record<StripAgent['state'], string>> = { working: 'pill-breathe-working', needs_you: 'pill-breathe-needs' };
/** The harness's own mark, in its colour (Claude's orange; the rest quiet). */
function AgentMark({ mode }: { mode?: string }) {
  switch (mode) {
    case 'claude': return <ClaudeIcon size={12} className="text-[#d97757]" />;
    case 'codex': return <CodexIcon size={12} className="text-zinc-200" />;
    case 'opencode': return <OpencodeIcon size={11} className="text-zinc-200" />;
    case 'pi': return <PiIcon size={12} className="text-zinc-200" />;
    default: return <ShellIcon size={12} className="text-zinc-400" />;
  }
}
const label = (a: StripAgent) => [a.name, a.project, a.place, a.word, ...(a.outside ? ['outside this Focus', a.outside] : [a.activity])].filter(Boolean).join(' · ');

/** Mission Control's always-visible row: one labelled pill per agent of the
 * open Focus, in the order given (a fixed place each), the first few shown and
 * "+N" for the rest; agents outside it only when they need you. */
export function AgentStrip({ agents, onSelect, onOpen, selectedId = null, selectedLine = null }: {
  agents: StripAgent[];
  onSelect: (agentId: string) => void;
  onOpen: (agentId: string) => void;
  selectedId?: string | null;
  /** The selected agent's line (AgentLine), shown where the hint is. */
  selectedLine?: ReactNode;
}) {
  const [more, setMore] = useState(false);
  const pill = (a: StripAgent, extra = '') => (
    <button
      key={a.agentId}
      type="button"
      aria-label={label(a)}
      title={label(a)}
      aria-pressed={selectedId === a.agentId}
      data-state={a.state}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) onOpen(a.agentId);
        else onSelect(a.agentId);
        setMore(false);
      }}
      className={`flex h-6 min-w-0 max-w-[16rem] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border pl-1 pr-2 text-[11px] transition-colors ${
        selectedId === a.agentId ? 'border-sky-400/60 bg-sky-400/15 text-zinc-50 ring-1 ring-sky-400/20' : PILL[a.state]} ${BREATHE[a.state] ?? ''} ${extra}`}
    >
      {/* The harness icon on a small tile. */}
      <span aria-hidden="true" data-testid="agent-mark" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-black/40">
        <AgentMark mode={a.mode} />
      </span>
      <span className="shrink-0 font-medium">{a.name}</span>
      {a.place && <span className="min-w-0 truncate opacity-60">{a.place}</span>}
      {/* Only live work in the pill; the last reply is on the agent's line when selected. */}
      {a.outside
        ? <><span aria-hidden className="shrink-0">·</span><span className="min-w-0 truncate opacity-80">{a.outside}</span></>
        : a.state === 'working' && a.activity && <><span aria-hidden className="shrink-0">·</span><span className="min-w-0 truncate opacity-80">{a.activity}</span></>}
    </button>
  );
  // Outside the Focus (they broke through: they need you): their own group, always shown.
  const inside = agents.filter((a) => !a.outside);
  const outside = agents.filter((a) => a.outside);
  const rest = inside.slice(SHOWN);
  // A project's label before its first pill (agents come grouped; only set when 2+ projects).
  const withLabels = (list: StripAgent[], extra?: string) => list.map((a, i) => (
    a.project && a.project !== list[i - 1]?.project
      ? <span key={a.agentId} className="contents">
          {/* A thin rule between project groups. */}
          {i > 0 && <span aria-hidden data-testid="project-divider" className="mx-1.5 h-4 w-px shrink-0 bg-white/10" />}
          <span data-testid="project-label" title={`Repository: ${a.project}`} className={`flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500 ${i > 0 ? '' : 'ml-0.5'}`}>
            {a.project}
          </span>
          {pill(a, extra)}
        </span>
      : pill(a, extra)
  ));
  return (
    <div data-testid="agent-strip" className="relative flex min-w-0 items-center gap-1.5 px-2 py-1">
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden px-px py-0.5">
        {withLabels(inside.slice(0, SHOWN))}
        {rest.length > 0 && (
          <button type="button" aria-label={`+${rest.length} more agents`} aria-expanded={more} onClick={() => setMore((m) => !m)}
            className="flex h-6 shrink-0 items-center rounded-md border border-white/[0.07] bg-white/[0.03] px-2 text-[11px] text-zinc-400 hover:border-white/15 hover:bg-white/[0.06]">+{rest.length}</button>
        )}
        {outside.length > 0 && (
          <div role="group" aria-label="Outside this Focus" className="ml-1 flex min-w-0 shrink-0 items-center gap-1 border-l border-zinc-800 pl-2">
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-600">Outside this Focus</span>
            {outside.map((a) => pill(a))}
          </div>
        )}
      </div>
      {selectedId !== null && selectedLine && (
        <div data-testid="agent-strip-selected" className="ml-auto min-w-0 shrink pl-2">{selectedLine}</div>
      )}
      {more && rest.length > 0 && (
        <ul aria-label="More agents" className="surface-pop absolute bottom-full right-2 z-20 mb-1 flex max-h-64 flex-col gap-1 overflow-auto rounded-md p-1.5">
          {rest.map((a, i) => (
            <li key={a.agentId} className="flex flex-col gap-0.5">
              {a.project && a.project !== (rest[i - 1] ?? inside[SHOWN - 1])?.project && <span data-testid="project-label" title={`Repository: ${a.project}`} className="flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-zinc-500">{a.project}</span>}
              {pill(a, 'w-full')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
