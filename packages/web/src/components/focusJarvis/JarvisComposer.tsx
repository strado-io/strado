import { useMemo, useRef, useState } from 'react';
import { insertChip, mentionAt, pruneChips, toWire, type Chip, type Mention } from '../../lib/mention/chips';
import { JARVIS_MESSAGE_MAX, type JarvisAgent, type JarvisEffort, type JarvisSettings } from '../../types';
import { StopIcon } from '../hub/icons';
import { EffortPicker, ModelPicker } from './ModelPicker';

export type AgentChip = { label: string; agentId: string };
export type WorktreeChip = { label: string; worktreePath: string };

const MENTION_MAX = 8;

/** Where the person talks to Jarvis. Enter sends, Shift-Enter is a newline;
 * `@` names an agent and `#` a worktree, sent exactly (`@{agentId}`); Stop
 * while a turn runs; below the box, the model (and the agent CLI it runs
 * on) and the effort, each with its own picker (from the next turn). */
export function JarvisComposer({ running, agent, model, effort, onSettings, onSend, onStop, agents, worktrees, placeholder }: {
  running: boolean;
  agent: JarvisAgent;
  model: string | null;
  effort: JarvisEffort | null;
  onSettings: (settings: JarvisSettings) => void;
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

  // The menus are solid (menu-solid), never glass: see index.css. The
  // mention list is the card's sibling; the model and effort pickers open
  // right above their buttons. The wrapper is its own layer above the chat.
  const popup = 'menu-solid absolute bottom-full left-0 z-50 mb-2 rounded-xl p-1';
  return (
    <div className="relative isolate z-10">
      {options.length > 0 && (
        <ul role="listbox" aria-label={mention?.sigil === '@' ? 'Agents' : 'Worktrees'}
          className={`${popup} max-h-60 w-64 overflow-auto text-[13px]`}>
          {options.map((c, i) => (
            <li key={'agentId' in c ? c.agentId : c.worktreePath} role="option" aria-selected={i === pick}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c)}
              className={`cursor-pointer truncate rounded-md px-2 py-1 ${i === pick ? 'bg-[rgb(var(--pane-edge)/0.08)] text-zinc-100' : 'text-zinc-300'}`}>
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
          <ModelPicker agent={agent} model={model} onSettings={onSettings} />
          <EffortPicker effort={effort} onSettings={onSettings} />
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
