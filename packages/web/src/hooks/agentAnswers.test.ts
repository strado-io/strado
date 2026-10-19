import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (evt: { type: string; data: Record<string, unknown> }) => void;
const sse = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), subs: 0, unsubs: 0 }));
vi.mock('../eventStream', () => ({
  subscribeIntercom: (ws: string, h: Handler) => { sse.handlers.set(ws, h); sse.subs += 1; return () => { sse.handlers.delete(ws); sse.unsubs += 1; }; },
}));
const feed = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: { intercom: { feed: (...a: unknown[]) => feed(...a) } } }));

import { __resetAgentAnswers, expectAnswer, onAgentAnswer, type AgentAnswer } from './agentAnswers';

const flush = () => new Promise((r) => setTimeout(r, 0));
const reply = (over: Record<string, unknown> = {}) => ({ type: 'message.queued', data: { scopeId: 's', id: 'r1', from: 'claude-1@app', to: 'human', kind: 'reply', replyTo: 'q1', ...over } });

beforeEach(() => {
  __resetAgentAnswers();
  sse.handlers.clear(); sse.subs = 0; sse.unsubs = 0;
  feed.mockReset().mockResolvedValue([
    { id: 'r0', from: { agentId: 'claude-1@app' }, to: 'human', kind: 'reply', body: 'old', createdAt: 1 },
    { id: 'r1', from: { agentId: 'claude-1@app' }, to: 'human', kind: 'reply', body: 'Yes, all 40 pass.', createdAt: 2 },
  ]);
});
afterEach(() => { __resetAgentAnswers(); });

describe('agent answers', () => {
  it('listens only while a question waits; the reply to it comes back with its text, then it stops listening', async () => {
    const got: AgentAnswer[] = [];
    const off = onAgentAnswer((a) => got.push(a));
    expect(sse.subs).toBe(0);
    expectAnswer('default', { id: 'q1', agentId: 'claude-1@app', name: 'claude-1', spoken: true });
    expect(sse.subs).toBe(1);
    sse.handlers.get('default')!(reply());
    await flush();
    expect(feed).toHaveBeenCalledWith('default', expect.objectContaining({ agent: 'claude-1@app' }));
    expect(got).toEqual([{ questionId: 'q1', agentId: 'claude-1@app', name: 'claude-1', text: 'Yes, all 40 pass.', spoken: true }]);
    expect(sse.unsubs).toBe(1);
    off();
  });

  it('ignores what is not the reply to a waiting question: other kinds, other recipients, other questions, a reply fetched twice', async () => {
    const got: AgentAnswer[] = [];
    onAgentAnswer((a) => got.push(a));
    expectAnswer('default', { id: 'q1', agentId: 'claude-1@app', name: 'claude-1', spoken: false });
    const h = sse.handlers.get('default')!;
    h({ type: 'feed.changed', data: { scopeId: 's', id: 'x' } });
    h(reply({ kind: 'message' }));
    h(reply({ to: 'claude-2@app' }));
    h(reply({ replyTo: 'q-other' }));
    await flush();
    expect(feed).not.toHaveBeenCalled();
    h(reply());
    h(reply());
    await flush();
    expect(got).toHaveLength(1);
  });

  it('one stream per workspace, for several questions; it closes once the last is answered', async () => {
    onAgentAnswer(() => {});
    expectAnswer('default', { id: 'q1', agentId: 'claude-1@app', name: 'claude-1', spoken: false });
    expectAnswer('default', { id: 'q2', agentId: 'claude-1@app', name: 'claude-1', spoken: false });
    expect(sse.subs).toBe(1);
    sse.handlers.get('default')!(reply());
    await flush();
    expect(sse.unsubs).toBe(0);
    feed.mockResolvedValue([{ id: 'r2', from: { agentId: 'claude-1@app' }, to: 'human', kind: 'reply', body: 'done', createdAt: 3 }]);
    sse.handlers.get('default')!(reply({ id: 'r2', replyTo: 'q2' }));
    await flush();
    expect(sse.unsubs).toBe(1);
  });

  it('a failed fetch keeps waiting (the next signal for it tries again)', async () => {
    const got: AgentAnswer[] = [];
    onAgentAnswer((a) => got.push(a));
    expectAnswer('default', { id: 'q1', agentId: 'claude-1@app', name: 'claude-1', spoken: false });
    feed.mockRejectedValueOnce(new Error('offline'));
    sse.handlers.get('default')!(reply());
    await flush();
    expect(got).toHaveLength(0);
    sse.handlers.get('default')!(reply());
    await flush();
    expect(got).toHaveLength(1);
  });
});
