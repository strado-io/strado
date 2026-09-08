import { createHash } from 'node:crypto';
import {
  loadTranscript, parseClaudeMessages, parseCodexMessages, parseOpenCodeMessages, parsePiMessages,
  type AgentConversationOptions, type ConversationMessage,
} from './agentConversation.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { AgentSessionRegistry } from './agentSessionRegistry.js';
import type { AgentMode } from './handoffStore.js';
import { cutUtf8 } from './intercomContext.js';
import { TURN_PROMPT_MAX, TURN_REPLY_MAX, TURN_SETTLE_MS, TURNS_PER_REFRESH_MAX } from './intercomSchema.js';
import type { IntercomStore, TurnInput } from './intercomStore.js';
import { sessionKeyFor } from './terminalManager.js';

/** The step 4 hook injects the inbox as this block inside the user turn; it is not something the user said. */
const INJECTED_BLOCK = /<strado-intercom>[\s\S]*?<\/strado-intercom>/g;

export function stripInjected(prompt: string): string {
  return prompt.replace(INJECTED_BLOCK, '').trim();
}

/** Group messages into turns: a real prompt plus every assistant text up to the
 * next prompt. The reply is the LAST assistant text — what the user saw as the
 * answer. A turn with no assistant text yet is not returned (the caller
 * refreshes again later); one whose prompt was only injected context is
 * skipped but still occupies its turnIndex. */
export function splitTurns(messages: ConversationMessage[], now: number): TurnInput[] {
  const out: TurnInput[] = [];
  let index = -1;
  let prompt: string | null = null;
  let startedAt = now;
  let reply: ConversationMessage | null = null;

  const flush = (): void => {
    if (prompt === null || reply === null) return;
    const p = cutUtf8(prompt, TURN_PROMPT_MAX);
    const r = cutUtf8(reply.content, TURN_REPLY_MAX);
    out.push({
      turnIndex: index,
      prompt: p,
      promptTruncated: p.length < prompt.length,
      reply: r,
      replyTruncated: r.length < reply.content.length,
      startedAt,
      endedAt: reply.timestamp ?? now,
    });
  };

  for (const m of messages) {
    if (m.meta) continue;
    if (m.role === 'user') {
      flush();
      index += 1;
      const text = stripInjected(m.content);
      prompt = text.length > 0 ? text : null;
      startedAt = m.timestamp ?? now;
      reply = null;
    } else if (prompt !== null) {
      reply = m;
    }
  }
  flush();
  return out;
}

export type RefreshTrigger = 'idle' | 'working' | 'waiting';

export type TurnDiaryDeps = {
  agents: Pick<AgentRegistry, 'byKey'>;
  agentSessions: Pick<AgentSessionRegistry, 'get'>;
  intercom: Pick<IntercomStore, 'recordTurns'>;
  /** Where the harnesses keep their transcripts (Deps.agentHomeDir). */
  homeDir: string;
  now?: () => number;
  runOpenCode?: AgentConversationOptions['runOpenCode'];
  /** Test seam for the post-Stop settle timer. Production: setTimeout + unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (message: string, err: unknown) => void;
};

export type TurnDiary = {
  /** Never rejects. Resolves the number of rows inserted or updated by this call (0 on any failure). */
  refresh(mode: AgentMode, cwd: string, sessionId: string, trigger: RefreshTrigger): Promise<number>;
  /** Resolves once no refresh is in flight and no trailing rerun is pending. Pending settle timers are not awaited. */
  settle(): Promise<void>;
};

const PARSE: Record<AgentMode, (raw: string) => ConversationMessage[]> = {
  claude: parseClaudeMessages, codex: parseCodexMessages, opencode: parseOpenCodeMessages, pi: parsePiMessages,
};

const defaultSchedule: NonNullable<TurnDiaryDeps['schedule']> = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

export function createTurnDiary(deps: TurnDiaryDeps): TurnDiary {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const log = deps.log ?? (() => {});
  const fingerprints = new Map<string, string>();
  const inflight = new Map<string, Promise<number>>();
  const dirty = new Set<string>();
  const timers = new Map<string, { cancel(): void }>();

  async function runOnce(mode: AgentMode, cwd: string, sessionId: string, key: string): Promise<number> {
    try {
      const ex = deps.agents.byKey(key);
      if (!ex) return 0;
      const reference = await deps.agentSessions.get(mode, cwd, sessionId);
      if (!reference?.providerSessionId) return 0;
      const raw = await loadTranscript(mode, cwd, reference, { homeDir: deps.homeDir, runOpenCode: deps.runOpenCode });
      if (raw === null) return 0;
      const fp = createHash('sha256').update(raw).digest('hex');
      if (fingerprints.get(key) === fp) return 0;
      // Only the newest 50 turns are ever considered: older turns never change
      // once written, and the store's sweep already keeps at most 50 per
      // agent — so recomputing on every refresh (not just the first) is what
      // keeps a later resurrected old turnIndex from ever being backfilled.
      const turns = splitTurns(PARSE[mode](raw), now()).slice(-TURNS_PER_REFRESH_MAX);
      const { inserted, updated } = deps.intercom.recordTurns(ex.scopeId, ex.agentId, reference.providerSessionId, turns);
      fingerprints.set(key, fp);
      return inserted.length + updated.length;
    } catch (err) {
      log(`turn diary: refresh failed for ${key}`, err);
      return 0;
    }
  }

  const refresh: TurnDiary['refresh'] = (mode, cwd, sessionId, trigger) => {
    const key = sessionKeyFor(mode, cwd, sessionId);
    if (trigger !== 'working') {
      // Stop/waiting can fire before the harness flushes the final message.
      // One extra look a little later catches it even when no further hook
      // event comes. 'working' means the agent is mid-turn, not awaiting the
      // user, so it never arms this: 'idle' and 'waiting' both mean the
      // agent is now awaiting the user.
      timers.get(key)?.cancel();
      timers.set(key, schedule(() => {
        timers.delete(key);
        void refresh(mode, cwd, sessionId, 'working');
      }, TURN_SETTLE_MS));
    }
    const running = inflight.get(key);
    if (running) {
      dirty.add(key);
      return running;
    }
    const run = (async () => {
      try {
        let n = await runOnce(mode, cwd, sessionId, key);
        // A call that arrived mid-run may point at text this run read past. Re-read once per flag.
        while (dirty.delete(key)) n += await runOnce(mode, cwd, sessionId, key);
        return n;
      } finally {
        // Cleared synchronously inside the async body, not via a `.finally`
        // chained onto the outer promise: that leaves a microtask window
        // between the last `dirty.delete` check and the delete below where a
        // call could coalesce onto this already-settled promise and set a
        // dirty flag nothing will ever consume.
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  };

  const settle: TurnDiary['settle'] = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
  };

  return { refresh, settle };
}
