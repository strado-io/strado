// Jarvis speaks up: when a coding agent Jarvis started in a Focus finishes
// its turn (working → idle) or exits mid-turn, the Focus's chat gets an
// `event` entry ("claude-1 finished: <its last answer>") and, unless the
// person turned wakes off, Jarvis gets a short wake turn about it. An answer
// to one of Jarvis's asks does the same.
//
// Only agents whose tab Jarvis opened count: an `action` entry in that Focus's
// log carries the tab's card. Wakes are batched per Focus: at most one per
// wakeGapMs, the events in between go into the next one together. The runner
// itself queues a wake behind a running turn.
import path from 'node:path';
import type { EventBus } from '../../events/bus.js';
import type { AgentControl } from '../agentControl.js';
import type { AgentLifecycle, AgentRegistry } from '../agentRegistry.js';
import { HUMAN_AGENT_ID } from '../intercomSchema.js';
import { INTERCOM_CHANNEL, type IntercomStore } from '../intercomStore.js';
import type { JarvisRunner } from './runner.js';
import type { JarvisChatStore } from './store.js';
import { JARVIS_LIMITS, type ChatEntry, type TabCardRef } from './types.js';

/** One agent as the wakes see it (agentRegistry's summary + its last result). */
export type WakeAgent = {
  agentId: string;
  /** What the person calls it: alias, else the id's name ("claude-1"). */
  name: string;
  mode: string;
  worktreePath: string;
  sessionId: string;
  lifecycle: AgentLifecycle;
  lastResult: string | null;
};

export type JarvisWakesDeps = {
  /** Calls back when an agent may have changed: its station changed or it
   *  came or went (by id), or its worktree's agent status moved (by path). */
  subscribe(cb: (ev: { scopeId: string; agentId: string } | { path: string }) => void): () => void;
  /** An agent's reply to the human (kind reply), with the id it answers. */
  replies?(cb: (r: { scopeId: string; replyTo: string; from: string; body: string }) => void): () => void;
  /** null: the agent is gone. */
  agent(scopeId: string, agentId: string): Promise<WakeAgent | null>;
  focuses(ws: string): Promise<Array<{ id: string }>>;
  chat(ws: string): Promise<JarvisChatStore>;
  /** The person's "Jarvis speaks up when agents finish" setting. */
  wakesOn(): Promise<boolean>;
  runner: Pick<JarvisRunner, 'wake'>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  log?: (message: string) => void;
};

export type JarvisWakes = {
  start(): void;
  stop(): void;
  /** Jarvis asked an agent (agent.ask, run in the window): the ask's intercom
   *  message id. The agent's reply to it lands in that Focus's chat. */
  asked(ws: string, focusId: string, askId: string): void;
  /** An agent answered Jarvis's ask. */
  answered(ws: string, focusId: string, from: string, text: string): Promise<void>;
  /** Resolves once every change seen so far is handled (tests). */
  idle(): Promise<void>;
};

const RESULT_MAX = 300;
/** Pending asks remembered (in memory; a restart forgets them and the answer
 *  then only shows in the box, as any ask's does). */
const ASKS_MAX = 500;
const trim = (s: string) => (s.length <= RESULT_MAX ? s : `${s.slice(0, RESULT_MAX - 1)}…`);

/** The tab a card points at is this agent's. */
function isCardOf(card: TabCardRef | undefined, a: WakeAgent): boolean {
  if (!card || card.worktree !== path.basename(a.worktreePath)) return false;
  return card.tab === a.name || card.tab === `${a.mode}-${a.sessionId}`;
}

export function createJarvisWakes(deps: JarvisWakesDeps): JarvisWakes {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  const log = deps.log ?? (() => undefined);
  const last = new Map<string, WakeAgent>();
  const batches = new Map<string, { lastWakeAt: number; pending: string[]; timer: boolean }>();
  let queue: Promise<void> = Promise.resolve();
  const asks = new Map<string, string>(); // `${ws}\0${askId}` → focusId
  let off: (() => void) | null = null;
  let offReplies: (() => void) | null = null;

  function run(fn: () => Promise<void>): Promise<void> {
    const next = queue.then(fn).catch((err) => log(`jarvis wake: ${(err as Error).message}`));
    queue = next;
    return next;
  }

  async function allEntries(chat: JarvisChatStore, focusId: string): Promise<ChatEntry[]> {
    const out: ChatEntry[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await chat.page(focusId, { before, limit: JARVIS_LIMITS.pageMax });
      if (page.length === 0) return out;
      out.unshift(...page);
      before = page[0]!.id;
    }
  }

  async function flush(ws: string, focusId: string): Promise<void> {
    const b = batches.get(`${ws}\0${focusId}`);
    if (!b || b.pending.length === 0) return;
    const text = b.pending.join('\n');
    b.pending = [];
    b.lastWakeAt = now();
    if (!(await deps.focuses(ws)).some((f) => f.id === focusId)) return; // deleted meanwhile
    deps.runner.wake(ws, focusId, text);
  }

  /** The event goes in the chat now; the wake now or when the gap ends. */
  async function post(ws: string, focusId: string, text: string): Promise<void> {
    await (await deps.chat(ws)).append(focusId, { type: 'event', text });
    if (!(await deps.wakesOn())) return;
    const k = `${ws}\0${focusId}`;
    const b = batches.get(k) ?? { lastWakeAt: -Infinity, pending: [], timer: false };
    batches.set(k, b);
    b.pending.push(text);
    if (b.timer) return;
    const wait = b.lastWakeAt + JARVIS_LIMITS.wakeGapMs - now();
    if (wait <= 0) return flush(ws, focusId);
    b.timer = true;
    setTimer(() => {
      b.timer = false;
      void run(() => flush(ws, focusId));
    }, wait);
  }

  async function changed(scopeId: string, agentId: string): Promise<void> {
    const k = `${scopeId}\0${agentId}`;
    const prev = last.get(k);
    const cur = await deps.agent(scopeId, agentId);
    if (cur) last.set(k, cur);
    else last.delete(k);
    if (prev?.lifecycle !== 'working') return;
    if (cur && cur.lifecycle !== 'idle' && cur.lifecycle !== 'offline') return;
    const who = cur ?? prev;
    const result = cur ? cur.lastResult : prev.lastResult;
    const verb = cur && cur.lifecycle === 'idle' ? 'finished' : 'exited';
    const text = result ? `${who.name} ${verb}: ${trim(result)}` : `${who.name} ${verb}`;
    const chat = await deps.chat(scopeId);
    for (const f of await deps.focuses(scopeId)) {
      const entries = await allEntries(chat, f.id);
      if (entries.some((e) => e.type === 'action' && isCardOf(e.card, who))) await post(scopeId, f.id, text);
    }
  }

  async function replied(r: { scopeId: string; replyTo: string; from: string; body: string }): Promise<void> {
    const k = `${r.scopeId}\0${r.replyTo}`;
    const focusId = asks.get(k);
    if (focusId === undefined) return; // the box's own ask, or not an ask
    asks.delete(k);
    const name = (await deps.agent(r.scopeId, r.from))?.name ?? r.from.split('@')[0]!;
    await post(r.scopeId, focusId, `${name} answered: ${trim(r.body)}`);
  }

  return {
    start() {
      offReplies ??= deps.replies?.((r) => void run(() => replied(r))) ?? null;
      off ??= deps.subscribe((ev) => {
        if ('agentId' in ev) return void run(() => changed(ev.scopeId, ev.agentId));
        // A path: every agent seen at that worktree.
        for (const a of [...last.entries()].filter(([, x]) => x.worktreePath === ev.path)) {
          const [scopeId] = a[0].split('\0');
          void run(() => changed(scopeId!, a[1].agentId));
        }
      });
    },
    stop() {
      off?.();
      off = null;
      offReplies?.();
      offReplies = null;
    },
    asked(ws, focusId, askId) {
      asks.set(`${ws}\0${askId}`, focusId);
      if (asks.size > ASKS_MAX) asks.delete(asks.keys().next().value!);
    },
    answered: (ws, focusId, from, text) => run(() => post(ws, focusId, `${from} answered: ${trim(text)}`)),
    idle: () => queue,
  };
}

/** The app's side of JarvisWakesDeps: the intercom channel's station and
 *  peer events (by id), the worktrees channel's agent-status updates (by path),
 *  and an agent read from the registry plus its last result. */
export function appWakeSource(d: {
  bus: Pick<EventBus, 'on'>;
  agents: Pick<AgentRegistry, 'list'>;
  agentControl: Pick<AgentControl, 'activityOf'>;
  intercom: Pick<IntercomStore, 'listScope'>;
}): Pick<JarvisWakesDeps, 'subscribe' | 'agent'> & Required<Pick<JarvisWakesDeps, 'replies'>> {
  return {
    subscribe(cb) {
      const offIntercom = d.bus.on(INTERCOM_CHANNEL, (evt) => {
        const data = evt.data as { scopeId?: unknown; agentId?: unknown } | undefined;
        if (!['station.changed', 'peer.registered', 'peer.dropped'].includes(String(evt.type))) return;
        if (typeof data?.scopeId === 'string' && typeof data.agentId === 'string') cb({ scopeId: data.scopeId, agentId: data.agentId });
      });
      const offWorktrees = d.bus.on('worktrees', (evt) => {
        const data = evt.data as Record<string, unknown> | undefined;
        // Only the agent-status stores' updates carry a per-session map.
        if (evt.type !== 'worktree.updated' || typeof data?.path !== 'string') return;
        if (!Object.keys(data).some((k) => k.endsWith('ById'))) return;
        cb({ path: data.path });
      });
      return () => {
        offIntercom();
        offWorktrees();
      };
    },
    replies(cb) {
      return d.bus.on(INTERCOM_CHANNEL, (evt) => {
        const m = evt.data as { id?: unknown; scopeId?: unknown; from?: unknown; to?: unknown; kind?: unknown; replyTo?: unknown } | undefined;
        if (evt.type !== 'message.queued' || m?.to !== HUMAN_AGENT_ID || m.kind !== 'reply') return;
        if (typeof m.id !== 'string' || typeof m.scopeId !== 'string' || typeof m.from !== 'string' || typeof m.replyTo !== 'string') return;
        // Read only: the box still pulls and shows the answer as it always has.
        const row = d.intercom.listScope(m.scopeId, { agent: m.from, limit: 50 }).find((x) => x.id === m.id);
        if (row) cb({ scopeId: m.scopeId, replyTo: m.replyTo, from: m.from, body: row.body });
      });
    },
    async agent(scopeId, agentId) {
      const a = (await d.agents.list(scopeId)).find((x) => x.agentId === agentId);
      if (!a || a.mode === 'shell') return null;
      return {
        agentId: a.agentId,
        name: a.alias ?? a.agentId.split('@')[0]!,
        mode: a.mode,
        worktreePath: a.worktreePath,
        sessionId: a.sessionId,
        lifecycle: a.lifecycle,
        lastResult: d.agentControl.activityOf(scopeId, a.agentId).lastResult?.text ?? null,
      };
    },
  };
}
