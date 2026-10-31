import { useMemo, useRef, useState } from 'react';
import { insertChip, mentionAt, pruneChips, toWire, type Chip, type Mention } from '../../lib/mention/chips';
import { JARVIS_MESSAGE_MAX, type JarvisAgent, type JarvisEffort, type JarvisSettings } from '../../types';
import { StopIcon } from '../hub/icons';
import { EffortPicker, ModelPicker } from './ModelPicker';
import { useVoice, voiceBridge } from '../../hooks/voice';

export type AgentChip = { label: string; agentId: string };
export type WorktreeChip = { label: string; worktreePath: string };

const MENTION_MAX = 8;
/** Space held this long in the box turns into hold-to-speak; a tap is far shorter (as in ⌘K). */
const SPACE_HOLD_MS = 350;
/** What was said goes after what was typed, so a message can be said in several goes. */
const withSaid = (before: string, said: string) => (!said.trim() ? before : before.trim() ? `${before.replace(/\s+$/, '')} ${said}` : said);

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

  // Hold to speak: the mic button, or Space held in the box. The words land in
  // the box as they come; nothing is sent until Enter.
  const beforeVoice = useRef('');
  const v = useVoice({
    bridge: voiceBridge(),
    contextual: () => [...agents.map((a) => a.label), ...worktrees.map((w) => w.label)],
    onPartial: (said) => setText(withSaid(beforeVoice.current, said)),
    onFinal: (said) => {
      const full = withSaid(beforeVoice.current, said);
      setText(full);
      setChips((cur) => pruneChips(full, cur));
      requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(full.length, full.length); });
    },
    onCancel: () => setText(beforeVoice.current),
  });
  const listening = v.phase === 'listening' || v.phase === 'finishing';
  const startVoice = (before: string) => {
    beforeVoice.current = before;
    setText(before);
    setMention(null);
    v.start();
  };
  const spaceHold = useRef<{ timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const endSpaceHold = () => {
    const h = spaceHold.current;
    if (!h) return;
    spaceHold.current = null;
    if (h.timer) clearTimeout(h.timer);
    else v.stop();
  };
  /** Space in the box: a tap types it; held, it turns into hold-to-speak and comes back out. True when handled. */
  const spaceKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== ' ' || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
      if (spaceHold.current?.timer) endSpaceHold(); // another key first: they're typing
      return false;
    }
    if (spaceHold.current) { e.preventDefault(); return true; }
    if (!v.available || listening || e.repeat) return false;
    const before = text;
    const h: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
    h.timer = setTimeout(() => {
      h.timer = null;
      if (spaceHold.current === h) startVoice(before);
    }, SPACE_HOLD_MS);
    spaceHold.current = h;
    return false;
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
    if (spaceKey(e)) return;
    if (listening && e.key === 'Escape') { e.preventDefault(); v.cancel(); return; }
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
          placeholder={listening ? 'Listening…' : placeholder ?? (v.available ? 'Ask Jarvis… @ an agent, # a worktree, hold Space to speak' : 'Ask Jarvis… @ an agent, # a worktree')}
          onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (e.key === ' ') endSpaceHold(); }}
          onBlur={endSpaceHold}
          className="block max-h-48 min-h-[2.5rem] w-full resize-none bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500" />
        <div className="mt-1 flex items-center gap-2">
          <ModelPicker agent={agent} model={model} onSettings={onSettings} />
          <EffortPicker effort={effort} onSettings={onSettings} />
          <span className="flex-1" />
          {v.error && (
            <button type="button" onClick={v.dismissError} className="truncate text-[11px] text-red-300" title="Dismiss">
              Mic: {v.error.message ?? v.error.code}
            </button>
          )}
          {v.available && (
            // Press and hold; release to stop. Escape (in the box) throws it away.
            <button type="button" aria-label={listening ? 'Listening… release to stop' : 'Hold to speak'} title="Hold to speak"
              aria-pressed={listening}
              onPointerDown={(e) => { e.preventDefault(); startVoice(text); }}
              onPointerUp={() => v.stop()}
              onPointerLeave={() => { if (v.phase === 'listening') v.stop(); }}
              className={`relative flex h-7 w-7 items-center justify-center rounded-full ${listening ? 'bg-red-500/90 text-white' : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>
              {listening && (
                <span aria-hidden className="absolute inset-0 rounded-full ring-2 ring-red-400/60"
                  style={{ transform: `scale(${1 + Math.min(1, v.level) * 0.45})`, transition: 'transform 75ms' }} />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
              </svg>
            </button>
          )}
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
