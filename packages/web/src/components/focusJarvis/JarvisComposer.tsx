import { useMemo, useRef, useState } from 'react';
import { insertChip, mentionAt, pruneChips, toWire, type Chip, type Mention } from '../../lib/mention/chips';
import { JARVIS_MESSAGE_MAX, type JarvisAgent } from '../../types';
import { StopIcon } from '../hub/icons';

export type AgentChip = { label: string; agentId: string };
export type WorktreeChip = { label: string; worktreePath: string };

const AGENTS: { id: string; label: string; ready: boolean }[] = [
  { id: 'claude', label: 'Claude', ready: true },
  { id: 'codex', label: 'Codex', ready: false },
  { id: 'opencode', label: 'OpenCode', ready: false },
  { id: 'pi', label: 'Pi', ready: false },
];
const MENTION_MAX = 8;

/** Where the person talks to Jarvis. Enter sends, Shift-Enter is a newline;
 * `@` names an agent and `#` a worktree, sent exactly (`@{agentId}`); Stop
 * while a turn runs; the chip says which agent CLI runs Jarvis. */
export function JarvisComposer({ running, agent, onSend, onStop, agents, worktrees, placeholder }: {
  running: boolean;
  agent: JarvisAgent;
  onSend: (text: string) => void;
  onStop: () => void;
  agents: AgentChip[];
  worktrees: WorktreeChip[];
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [mention, setMention] = useState<Mention | null>(null);
  const [pick, setPick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const options: Chip[] = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const pool: Chip[] = mention.sigil === '@' ? agents : worktrees;
    return pool.filter((c) => c.label.toLowerCase().includes(q)).slice(0, MENTION_MAX);
  }, [mention, agents, worktrees]);

  const change = (value: string, caret: number) => {
    setText(value);
    setChips((cur) => pruneChips(value, cur));
    setMention(mentionAt(value, caret));
    setPick(0);
  };

  const choose = (c: Chip) => {
    if (!mention) return;
    const next = insertChip(text, mention, c.label);
    setText(next.text);
    setChips((cur) => [...cur.filter((x) => x.label !== c.label), c]);
    setMention(null);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(next.caret, next.caret); });
  };

  const send = () => {
    const wire = toWire(text, chips).trim();
    if (!wire) return;
    onSend(wire);
    setText('');
    setChips([]);
    setMention(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[pick]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const current = AGENTS.find((a) => a.id === agent) ?? AGENTS[0]!;
  return (
    <div className="relative">
      {options.length > 0 && (
        <ul role="listbox" aria-label={mention?.sigil === '@' ? 'Agents' : 'Worktrees'}
          className="glass-pill absolute bottom-full left-0 mb-1 max-h-60 w-64 overflow-auto rounded-lg border p-1 text-[13px]">
          {options.map((c, i) => (
            <li key={'agentId' in c ? c.agentId : c.worktreePath} role="option" aria-selected={i === pick}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c)}
              className={`cursor-pointer truncate rounded-md px-2 py-1 ${i === pick ? 'bg-white/10 text-zinc-100' : 'text-zinc-300'}`}>
              {mention?.sigil}{c.label}
            </li>
          ))}
        </ul>
      )}
      <div className="glass pane-card rounded-2xl border px-3 pb-2 pt-2.5">
        <textarea ref={box} aria-label="Message Jarvis" rows={2} value={text} maxLength={JARVIS_MESSAGE_MAX}
          placeholder={placeholder ?? 'Ask Jarvis… @ an agent, # a worktree'}
          onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          className="block max-h-48 min-h-[2.5rem] w-full resize-none bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500" />
        <div className="mt-1 flex items-center gap-2">
          <div className="relative">
            <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
              aria-label={`Agent: ${current.label}`}
              className="rounded-md px-2 py-0.5 text-[12px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200">
              ✦ {current.label}
            </button>
            {menuOpen && (
              <div role="menu" className="glass-pill absolute bottom-full left-0 mb-1 w-48 rounded-lg border p-1 text-[12px]">
                {AGENTS.map((a) => (
                  <div key={a.id} role="menuitem" aria-disabled={!a.ready} tabIndex={a.ready ? 0 : -1}
                    onClick={() => { if (a.ready) setMenuOpen(false); }}
                    className={`flex justify-between rounded-md px-2 py-1 ${a.ready ? 'cursor-pointer text-zinc-200 hover:bg-white/10' : 'text-zinc-600'}`}>
                    <span>{a.label}</span>{!a.ready && <span>coming soon</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className="flex-1" />
          {running
            ? <button type="button" onClick={onStop} aria-label="Stop Jarvis" title="Stop"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white"><StopIcon size={12} /></button>
            : <button type="button" onClick={send} disabled={!text.trim()} aria-label="Send"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-30">↑</button>}
        </div>
      </div>
    </div>
  );
}
