import { useMemo, useRef, useState } from 'react';
import { insertChip, mentionAt, pruneChips, toWire, type Chip, type Mention } from '../../lib/mention/chips';
import { JARVIS_MESSAGE_MAX, type JarvisAgent, type JarvisEffort, type JarvisSettings } from '../../types';
import { ClaudeIcon, CodexIcon, OpencodeIcon, PiIcon, StopIcon } from '../hub/icons';
import { KIND_ICON } from '../hub/TabTile';

export type AgentChip = { label: string; agentId: string };
export type WorktreeChip = { label: string; worktreePath: string };

type AgentId = 'claude' | 'codex' | 'opencode' | 'pi';
// Each with the icon and tint its terminal tab has.
const AGENTS: { id: AgentId; label: string; ready: boolean; Icon: typeof ClaudeIcon }[] = [
  { id: 'claude', label: 'Claude', ready: true, Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', ready: false, Icon: CodexIcon },
  { id: 'opencode', label: 'OpenCode', ready: false, Icon: OpencodeIcon },
  { id: 'pi', label: 'Pi', ready: false, Icon: PiIcon },
];
// The models each agent offers Jarvis; null is the agent's own default.
// Only Claude's are known yet; the others get theirs when they can run Jarvis.
const MODELS: Record<AgentId, { id: string | null; label: string }[]> = {
  claude: [
    { id: null, label: 'Default' },
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [],
  opencode: [],
  pi: [],
};
const EFFORTS: { id: JarvisEffort | null; label: string }[] = [
  { id: null, label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];
const MENTION_MAX = 8;
const SECTION = 'px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-zinc-500';

/** The chip's words: the agent, then its model and effort when they aren't the default. */
export function runsOnLabel(agent: JarvisAgent, model: string | null, effort: JarvisEffort | null): string {
  const a = AGENTS.find((x) => x.id === agent) ?? AGENTS[0]!;
  const parts = [a.label];
  // A full model id the list doesn't name is said as it is.
  if (model) parts.push(MODELS[a.id].find((m) => m.id === model)?.label ?? model);
  if (effort) parts.push(EFFORTS.find((e) => e.id === effort)?.label ?? effort);
  return parts.join(' · ');
}

/** Where the person talks to Jarvis. Enter sends, Shift-Enter is a newline;
 * `@` names an agent and `#` a worktree, sent exactly (`@{agentId}`); Stop
 * while a turn runs; the chip says which agent CLI runs Jarvis, and with
 * what model and effort, and its menu changes them (from the next turn). */
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
  const models = MODELS[current.id];
  const label = runsOnLabel(agent, model, effort);
  const set = (settings: JarvisSettings) => { setMenuOpen(false); onSettings(settings); };
  // The menus are solid (menu-solid), never glass: see index.css. The
  // mention list is the card's sibling; the runs-on menu opens right above
  // its chip. The wrapper is its own layer above the chat.
  const popup = 'menu-solid absolute bottom-full left-0 z-50 mb-2 rounded-xl p-1';
  const menuBox = 'menu-solid absolute bottom-full left-0 z-50 mb-1 rounded-xl p-1';
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
          <div className="relative">
            {menuOpen && (
              <div role="menu" aria-label="Jarvis runs on" className={`${menuBox} max-h-[70vh] w-56 overflow-auto text-[12.5px]`}>
                <div className={SECTION}>Jarvis runs on</div>
                {AGENTS.map((a) => (
                  <div key={a.id} role="menuitem" aria-disabled={!a.ready} tabIndex={a.ready ? 0 : -1}
                    onClick={() => { if (a.ready) setMenuOpen(false); }}
                    className={`flex h-8 items-center gap-2 rounded-lg px-2 ${a.ready ? 'cursor-pointer text-zinc-100 hover:bg-[rgb(var(--pane-edge)/0.07)]' : 'cursor-default text-zinc-500'}`}>
                    <a.Icon size={14} className={`${KIND_ICON[a.id]} ${a.ready ? '' : 'opacity-50'}`} />
                    <span className="flex-1">{a.label}</span>
                    {a.id === current.id
                      ? <span aria-hidden="true" className="text-[#e8906f]">✓</span>
                      : !a.ready && <span className="rounded-full border border-[rgb(var(--pane-edge)/0.1)] px-1.5 py-px text-[10px] text-zinc-500">Soon</span>}
                  </div>
                ))}
                {models.length > 0 && <>
                  <div role="presentation" className={`${SECTION} mt-1`}>Model</div>
                  {models.map((m) => (
                    <Choice key={m.id ?? ''} label={m.label} checked={m.id === model}
                      onPick={() => (m.id === model ? setMenuOpen(false) : set({ model: m.id }))} />
                  ))}
                </>}
                <div role="presentation" className={`${SECTION} mt-1`}>Effort</div>
                {EFFORTS.map((e) => (
                  <Choice key={e.id ?? ''} label={e.label} checked={e.id === effort}
                    onPick={() => (e.id === effort ? setMenuOpen(false) : set({ effort: e.id }))} />
                ))}
              </div>
            )}
            <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
              aria-label={`Agent: ${label}`}
              className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200">
              <current.Icon size={13} className={KIND_ICON[current.id]} />{label}
            </button>
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

/** A model or effort row: picked by click, Enter or Space; the chosen one ticked. */
function Choice({ label, checked, onPick }: { label: string; checked: boolean; onPick: () => void }) {
  return (
    <div role="menuitemradio" aria-checked={checked} tabIndex={0} onClick={onPick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-zinc-100 hover:bg-[rgb(var(--pane-edge)/0.07)]">
      <span className="flex-1">{label}</span>
      {checked && <span aria-hidden="true" className="text-[#e8906f]">✓</span>}
    </div>
  );
}
