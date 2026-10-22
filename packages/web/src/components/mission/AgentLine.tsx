import type { CardAgent } from './AgentCard';

/** What typing in the box does right now. */
function hint(a: CardAgent): string {
  if (a.mode === 'shell') return 'type a command, ↵ runs it';
  if (a.calls.length > 0) return '↵ sends your reply';
  if (a.state === 'working') return '↵ queues, ⌘↵ sends now';
  if (a.state === 'offline') return 'open its tab to start it';
  return 'type a message, ↵ sends it';
}

const Kbd = ({ children }: { children: string }) => <kbd className="font-sans text-[10px] text-zinc-600">{children}</kbd>;

/** The selected agent, as one muted line in the strip's row: what typing
 * does, the latest news (sent / queued / a recap / an error / its call), and
 * a few text buttons. Never a second row; the pill already shows its state. */
export function AgentLine({ agent, note, onInterrupt, onOpen, onRecap, onDismissCalls }: {
  agent: CardAgent;
  /** The last thing done from the box ("queued: …", an error, a recap); null for none. */
  note: string | null;
  onInterrupt: (agentId: string) => void;
  onOpen: (agentId: string) => void;
  onRecap: (agentId: string) => void;
  /** A human click: dismiss these open calls (the escalation route). */
  onDismissCalls?: (agentId: string, callIds: string[]) => void;
}) {
  // A shell takes commands, not messages: no Summarize.
  const shell = agent.mode === 'shell';
  // An open call is a question: typing answers it (the box sends a reply, not a message).
  const text = note ?? (agent.calls[0] ? `asks: ${agent.calls[0].title} — type to reply` : null);
  const btn = 'flex shrink-0 items-center gap-1 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200';
  return (
    <div data-testid="agent-line" className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-zinc-500">
      <span data-testid="agent-line-hint" className="shrink-0 text-zinc-600">{hint(agent)}</span>
      {text && <span data-testid="agent-line-note" title={text} className="min-w-0 truncate text-zinc-400">{text}</span>}
      <span className="flex shrink-0 items-center">
        <button type="button" className={btn} onClick={() => onOpen(agent.agentId)}>Open tab <Kbd>⌘O</Kbd></button>
        {agent.state === 'working' && (
          <button type="button" className={btn} title={`Stop what ${agent.name} is doing`} onClick={() => onInterrupt(agent.agentId)}>Stop <Kbd>⌃C</Kbd></button>
        )}
        {!shell && <button type="button" className={btn} title={`Ask what ${agent.name} has done so far`} onClick={() => onRecap(agent.agentId)}>Summarize</button>}
        {agent.state === 'needs_you' && agent.calls.length > 0 && onDismissCalls && (
          <button type="button" className={btn} title={agent.calls.map((c) => c.title).join('\n')} onClick={() => onDismissCalls(agent.agentId, agent.calls.map((c) => c.id))}>
            {agent.calls.length > 1 ? `Dismiss ${agent.calls.length} calls` : 'Dismiss call'}
          </button>
        )}
      </span>
    </div>
  );
}
