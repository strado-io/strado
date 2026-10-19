import { api } from '../api';
import { subscribeIntercom } from '../eventStream';

// Answers to questions asked from the command box ("ask claude-1 if the tests
// pass"). A question waits here until its agent replies on the intercom; the
// stream is open only while one waits, and the reply's text is fetched once.
// Module-level, so an answer still lands when the box that asked has been
// replaced (home → Dock, Settings) or closed.

export type AgentAnswer = { questionId: string; agentId: string; name: string; text: string; spoken: boolean };
type Question = { id: string; agentId: string; name: string; spoken: boolean };

const waiting = new Map<string, Map<string, Question>>(); // wsId → question id → question
const streams = new Map<string, () => void>();
const fetching = new Set<string>();
const listeners = new Set<(a: AgentAnswer) => void>();

export function __resetAgentAnswers() {
  for (const off of streams.values()) off();
  streams.clear();
  waiting.clear();
  fetching.clear();
  listeners.clear();
}

/** Every answer, as it arrives (the command box shows it, or a toast does). */
export function onAgentAnswer(cb: (a: AgentAnswer) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Wait for the reply to a question the box just sent (`id` = its message id). */
export function expectAnswer(wsId: string, q: Question): void {
  const qs = waiting.get(wsId) ?? new Map<string, Question>();
  qs.set(q.id, q);
  waiting.set(wsId, qs);
  if (streams.has(wsId)) return;
  streams.set(wsId, subscribeIntercom(wsId, (evt) => {
    if (evt.type !== 'message.queued') return;
    const d = evt.data as { id: string; from?: unknown; to?: unknown; kind?: unknown; replyTo?: unknown };
    if (d.to !== 'human' || d.kind !== 'reply' || typeof d.replyTo !== 'string' || typeof d.from !== 'string') return;
    const question = waiting.get(wsId)?.get(d.replyTo);
    if (!question || fetching.has(d.replyTo)) return;
    void land(wsId, question, d.id, d.from);
  }));
}

async function land(wsId: string, q: Question, replyId: string, from: string) {
  fetching.add(q.id);
  try {
    const messages = await api.intercom.feed(wsId, { agent: from, limit: 50 });
    const m = messages.find((x) => x.id === replyId);
    if (!m) return; // not in the feed yet: the next signal tries again
    const qs = waiting.get(wsId);
    if (!qs?.delete(q.id)) return;
    if (qs.size === 0) { waiting.delete(wsId); streams.get(wsId)?.(); streams.delete(wsId); }
    const answer: AgentAnswer = { questionId: q.id, agentId: q.agentId, name: q.name, text: (m.body ?? '').trim(), spoken: q.spoken };
    for (const l of listeners) l(answer);
  } catch {
    // Offline or the server restarted: keep waiting.
  } finally {
    fetching.delete(q.id);
  }
}
