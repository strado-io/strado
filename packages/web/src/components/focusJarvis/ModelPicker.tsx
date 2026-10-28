import { useEffect, useMemo, useRef, useState } from 'react';
import type { JarvisAgent, JarvisEffort, JarvisSettings } from '../../types';
import { ClaudeIcon, CodexIcon, OpencodeIcon, PiIcon } from '../hub/icons';
import { KIND_ICON } from '../hub/TabTile';

type AgentId = 'claude' | 'codex' | 'opencode' | 'pi';
// Each with the icon and tint its terminal tab has.
export const AGENTS: { id: AgentId; label: string; vendor: string; ready: boolean; Icon: typeof ClaudeIcon }[] = [
  { id: 'claude', label: 'Claude', vendor: 'Anthropic', ready: true, Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', vendor: 'OpenAI', ready: true, Icon: CodexIcon },
  { id: 'opencode', label: 'OpenCode', vendor: 'OpenCode', ready: true, Icon: OpencodeIcon },
  { id: 'pi', label: 'Pi', vendor: 'Pi', ready: true, Icon: PiIcon },
];
type Model = { agent: AgentId; id: string | null; label: string };
// The models each agent offers Jarvis; null is the agent's own default.
const MODELS: Model[] = [
  { agent: 'claude', id: null, label: 'Claude default' },
  { agent: 'claude', id: 'fable', label: 'Claude Fable' },
  { agent: 'claude', id: 'opus', label: 'Claude Opus' },
  { agent: 'claude', id: 'sonnet', label: 'Claude Sonnet' },
  { agent: 'claude', id: 'haiku', label: 'Claude Haiku' },
  // From `codex debug models` (OpenAI's catalog: it changes with Codex updates).
  { agent: 'codex', id: null, label: 'Codex default' },
  { agent: 'codex', id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { agent: 'codex', id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { agent: 'codex', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { agent: 'opencode', id: null, label: 'OpenCode default' },
  // From `pi --list-models`, through OpenRouter (how Pi is logged in here).
  { agent: 'pi', id: null, label: 'Pi default' },
  { agent: 'pi', id: 'openrouter/anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
  { agent: 'pi', id: 'openrouter/anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
  { agent: 'pi', id: 'openrouter/anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
  { agent: 'pi', id: 'openrouter/openai/gpt-5.5', label: 'GPT-5.5' },
  { agent: 'pi', id: 'openrouter/google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { agent: 'pi', id: 'openrouter/z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
  { agent: 'pi', id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3' },
  { agent: 'pi', id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];
export const EFFORTS: { id: JarvisEffort | null; label: string }[] = [
  { id: null, label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

const agentOf = (id: string) => AGENTS.find((a) => a.id === id) ?? AGENTS[0]!;
const keyOf = (m: Pick<Model, 'agent' | 'id'>) => `${m.agent}:${m.id ?? ''}`;

/** The model as the button says it: from the list, else the raw id, else the agent's default. */
export function modelLabel(agent: JarvisAgent, model: string | null): string {
  const a = agentOf(agent);
  return MODELS.find((m) => m.agent === a.id && m.id === model)?.label ?? (model ? `${a.label} ${model}` : `${a.label} default`);
}

// Starred models, this browser only: a convenience, never needed to work.
const FAVS_KEY = 'strado:jarvis-model-favs';
function readFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAVS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeFavs(favs: string[]) {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs)); } catch { /* private window: favourites just don't stick */ }
}

/** Closes `open` on a press outside `ref`. */
function useOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [ref, open, close]);
}

const BUTTON = 'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200';
const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
);

/** The model button and its picker: agents down the left (and starred models
 * on top), the chosen agent's models on the right, searchable, ⌘1–9 to pick. */
export function ModelPicker({ agent, model, onSettings }: {
  agent: JarvisAgent;
  model: string | null;
  onSettings: (settings: JarvisSettings) => void;
}) {
  const current = agentOf(agent);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AgentId | 'favs'>(current.id);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [favs, setFavs] = useState<string[]>(readFavs);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useOutside(wrap, open, () => setOpen(false));

  const toggle = () => {
    setOpen((o) => !o);
    setTab(current.id);
    setQuery('');
    setHi(0);
  };
  useEffect(() => { if (open) search.current?.focus(); }, [open, tab]);

  const tabAgent = tab === 'favs' ? null : AGENTS.find((a) => a.id === tab)!;
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = tab === 'favs' ? MODELS.filter((m) => favs.includes(keyOf(m))) : MODELS.filter((m) => m.agent === tab);
    return q ? pool.filter((m) => `${m.label} ${m.id ?? ''}`.toLowerCase().includes(q)) : pool;
  }, [tab, query, favs]);

  const choose = (m: Model) => {
    setOpen(false);
    if (m.agent === current.id && m.id === model) return;
    // Another agent's model switches Jarvis to that agent (a fresh session).
    onSettings(m.agent === current.id ? { model: m.id } : { agent: m.agent, model: m.id });
  };
  const star = (m: Model) => {
    const k = keyOf(m);
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
    setFavs(next);
    writeFavs(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.length) setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
      return;
    }
    if (e.key === 'Enter' && list[hi]) { e.preventDefault(); choose(list[hi]!); return; }
    // ⌘1–9 (Ctrl off a Mac): the nth row, as the badges say.
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const m = list[Number(e.key) - 1];
      if (m) { e.preventDefault(); e.stopPropagation(); choose(m); }
    }
  };

  const railBtn = (active: boolean) =>
    `relative flex h-9 w-9 items-center justify-center rounded-lg ${active ? 'bg-[rgb(var(--pane-edge)/0.08)]' : 'hover:bg-[rgb(var(--pane-edge)/0.05)]'}`;
  return (
    <div ref={wrap} className="relative">
      {open && (
        <div role="dialog" aria-label="Choose a model" onKeyDown={onKeyDown}
          className="menu-solid absolute bottom-full left-0 z-50 mb-1 flex h-80 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl">
          <div role="tablist" aria-label="Agents" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[rgb(var(--pane-edge)/0.08)] py-2">
            <button type="button" role="tab" aria-selected={tab === 'favs'} aria-label="Starred" title="Starred"
              onClick={() => { setTab('favs'); setHi(0); }} className={railBtn(tab === 'favs')}>
              <StarIcon filled className="text-zinc-200" />
            </button>
            <div className="my-0.5 h-px w-6 bg-[rgb(var(--pane-edge)/0.08)]" />
            {AGENTS.map((a) => (
              <button key={a.id} type="button" role="tab" aria-selected={tab === a.id} aria-label={a.label}
                title={a.ready ? a.label : `${a.label} (soon)`} onClick={() => { setTab(a.id); setHi(0); }} className={railBtn(tab === a.id)}>
                <a.Icon size={18} className={`${KIND_ICON[a.id]} ${a.ready ? '' : 'opacity-40'}`} />
                {tab === a.id && <span aria-hidden className="absolute -right-[7px] top-1.5 h-6 w-0.5 rounded-full bg-[#e8906f]" />}
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="mx-2 mt-2 flex items-center gap-2 border-b border-[rgb(var(--pane-edge)/0.12)] px-1 pb-2 focus-within:border-sky-500/70">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="shrink-0 text-zinc-500">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
              </svg>
              <input ref={search} value={query} onChange={(e) => { setQuery(e.target.value); setHi(0); }} placeholder="Search models…"
                aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500" />
            </div>
            <div role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {tabAgent && !tabAgent.ready ? (
                <div className="px-3 py-6 text-center text-[12px] text-zinc-500">{tabAgent.label} can't run Jarvis yet. Soon.</div>
              ) : list.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-zinc-500">{tab === 'favs' && !query ? 'Star a model to keep it here.' : 'No models match.'}</div>
              ) : list.map((m, i) => {
                const a = agentOf(m.agent);
                const selected = m.agent === current.id && m.id === model;
                const starred = favs.includes(keyOf(m));
                return (
                  <div key={keyOf(m)} role="option" aria-selected={selected} onClick={() => choose(m)} onMouseEnter={() => setHi(i)}
                    className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 ${i === hi ? 'bg-[rgb(var(--pane-edge)/0.07)]' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-zinc-100">{m.label}</div>
                      <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                        <a.Icon size={11} className={KIND_ICON[a.id]} />{a.label} · {m.id ?? 'its own pick'}
                      </div>
                    </div>
                    <button type="button" aria-label={starred ? `Unstar ${m.label}` : `Star ${m.label}`} aria-pressed={starred}
                      onClick={(e) => { e.stopPropagation(); star(m); }}
                      className={`shrink-0 rounded p-0.5 hover:text-zinc-200 ${starred ? 'text-zinc-300' : 'text-zinc-600 opacity-0 group-hover:opacity-100'}`}>
                      <StarIcon filled={starred} />
                    </button>
                    {i < 9 && <kbd className="shrink-0 rounded-md bg-[rgb(var(--pane-edge)/0.08)] px-1.5 py-0.5 font-sans text-[10.5px] text-zinc-400">⌘{i + 1}</kbd>}
                    <span aria-hidden className={`w-3 shrink-0 text-[12px] text-zinc-300 ${selected ? '' : 'invisible'}`}>✓</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}
        aria-label={`Model: ${modelLabel(agent, model)}`} className={BUTTON}>
        <current.Icon size={13} className={KIND_ICON[current.id]} />
        <span className="max-w-[12rem] truncate">{modelLabel(agent, model)}</span>
        <Chevron />
      </button>
    </div>
  );
}

/** The effort button: a gauge, the level when it isn't the default, and a short list. */
export function EffortPicker({ effort, onSettings }: { effort: JarvisEffort | null; onSettings: (settings: JarvisSettings) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useOutside(wrap, open, () => setOpen(false));
  const label = EFFORTS.find((e) => e.id === effort)?.label ?? effort ?? 'Default';
  return (
    <div ref={wrap} className="relative">
      {open && (
        <div role="menu" aria-label="Effort" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
          className="menu-solid absolute bottom-full left-0 z-50 mb-1 w-40 rounded-xl p-1 text-[12.5px]">
          <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">Effort</div>
          {EFFORTS.map((e) => (
            <div key={e.id ?? ''} role="menuitemradio" aria-checked={e.id === effort} tabIndex={0}
              onClick={() => { setOpen(false); if (e.id !== effort) onSettings({ effort: e.id }); }}
              onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); setOpen(false); if (e.id !== effort) onSettings({ effort: e.id }); } }}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-zinc-100 hover:bg-[rgb(var(--pane-edge)/0.07)]">
              <span className="flex-1">{e.label}</span>
              {e.id === effort && <span aria-hidden className="text-[#e8906f]">✓</span>}
            </div>
          ))}
        </div>
      )}
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        aria-label={`Effort: ${label}`} title={`Effort: ${label}`} className={BUTTON}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M12 14l4-4" /><path d="M3.3 19a10 10 0 1 1 17.4 0" />
        </svg>
        {effort && <span>{label}</span>}
        <Chevron />
      </button>
    </div>
  );
}

function StarIcon({ filled = false, className = '' }: { filled?: boolean; className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
      strokeLinejoin="round" aria-hidden className={className}>
      <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />
    </svg>
  );
}
