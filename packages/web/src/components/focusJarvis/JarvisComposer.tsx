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
  /** Resolves once sent; a rejection keeps the draft in the box. */
  onSend: (text: string) => Promise<void>;
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

  // W7: the draft stays until the server has it; a failed send leaves it as typed.
  const [sending, setSending] = useState(false);
  const send = () => {
    const wire = toWire(text, chips).trim();
    if (!wire || sending) return;
    setSending(true);
    setMention(null);
    onSend(wire).then(() => {
      setText((now) => (now === text ? '' : now));
      setChips([]);
    }, () => { /* kept: the error line says so */ }).finally(() => setSending(false));
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
          className="surface-pop absolute bottom-full left-0 z-50 mb-2 max-h-60 w-64 overflow-auto rounded-xl p-1 text-[13px]">
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
          <div>
            <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
              aria-label={`Agent: ${current.label}`}
              className="rounded-md px-2 py-0.5 text-[12px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200">
              ✦ {current.label}
            </button>
            {menuOpen && (
              // Above the whole composer, never over its text; solid, like every menu.
              <div role="menu" aria-label="Jarvis runs on" className="surface-pop absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl p-1 text-[12.5px]">
                <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">Jarvis runs on</div>
                {AGENTS.map((a) => (
                  <div key={a.id} role="menuitem" aria-disabled={!a.ready} tabIndex={a.ready ? 0 : -1}
                    onClick={() => { if (a.ready) setMenuOpen(false); }}
                    className={`flex h-8 items-center gap-2 rounded-lg px-2 ${a.ready ? 'cursor-pointer text-zinc-100 hover:bg-white/[0.07]' : 'cursor-default text-zinc-500'}`}>
                    <span className="flex-1">{a.label}</span>
                    {a.id === current.id
                      ? <span aria-hidden="true" className="text-[#e8906f]">✓</span>
                      : !a.ready && <span className="rounded-full border border-white/10 px-1.5 py-px text-[10px] text-zinc-500">Soon</span>}
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
