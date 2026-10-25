import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary } from './agentRegistry.js';
import { claudeTrustAsked, trustAttention } from './claudeTrust.js';
import { createTabOps, PROMPT_DELIVERY_RETRY_MS, PROMPT_DELIVERY_WINDOW_MS } from './tabOps.js';

const SCREEN = fs.readFileSync(path.join(__dirname, '../../test/fixtures/claude-trust-screen.txt'), 'utf8');
const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId: 'claude-1@web', alias: 'claude-1', scopeId: 'default', mode: 'claude', worktreePath: '/w/web', sessionId: '1',
  lifecycle: 'starting', executionId: 'e1', live: true, ...over,
});

describe('claudeTrustAsked (Claude Code 2.1.310\'s trust screen)', () => {
  it('matches the captured screen, with colours and wrapped lines', () => {
    expect(claudeTrustAsked(SCREEN)).toBe(true);
    expect(claudeTrustAsked(`\x1b[1m${SCREEN.replace(/ /g, '\n')}\x1b[0m`)).toBe(true);
  });

  it('is narrow: one of the two lines alone, or a prompt mentioning trust, is not it', () => {
    expect(claudeTrustAsked('Quick safety check: Is this a project you created or one you trust?')).toBe(false);
    expect(claudeTrustAsked('❯ Yes, I trust this folder')).toBe(false);
    expect(claudeTrustAsked('> do you trust this code? explain the folder')).toBe(false);
  });
});

describe('trustAttention', () => {
  const snap = (screen: string) => () => screen;
  it('only a live, not-yet-started Claude tab showing the question', () => {
    expect(trustAttention(agent(), snap(SCREEN))).toBe('trust');
    expect(trustAttention(agent({ lifecycle: 'idle' }), snap(SCREEN))).toBeUndefined();
    expect(trustAttention(agent({ live: false }), snap(SCREEN))).toBeUndefined();
    expect(trustAttention(agent({ mode: 'codex' }), snap(SCREEN))).toBeUndefined();
    expect(trustAttention(agent(), snap('Claude Code v2.1.310\n❯ '))).toBeUndefined();
    expect(trustAttention(agent(), () => { throw new Error('no such session'); })).toBeUndefined();
  });
});

describe('the first prompt to a tab on the trust question', () => {
  afterEach(() => { vi.useRealTimers(); });

  function harness(state: { me: AgentSummary | null; screen: string }) {
    const nudges: string[] = [];
    const logs: string[] = [];
    const app = { deps: {
      agents: { list: async () => (state.me ? [state.me] : []) },
      terminal: { snapshot: () => state.screen, write: () => undefined },
      intercomPush: { nudge: async (_k: string, t: string) => { nudges.push(t); return 'sent'; } },
      ptyActivity: { quiet: () => ({ input: 1e9, output: 1e9 }) },
      debugLog: { log: (_c: string, m: string) => logs.push(m) },
    } } as unknown as FastifyInstance;
    return { ops: createTabOps(app), nudges, logs };
  }
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

  it('keeps waiting past 45 s while the question is up, then delivers once it is answered', async () => {
    vi.useFakeTimers();
    const state = { me: agent() as AgentSummary | null, screen: SCREEN };
    const h = harness(state);
    h.ops.deliverPrompt('default', 'claude-1@web', 'claude:/w/web:1', 'claude', 'fix it');
    await tick(PROMPT_DELIVERY_WINDOW_MS + 10_000);
    expect(h.logs.join('\n')).not.toMatch(/gave up/);
    state.me = agent({ lifecycle: 'idle' });
    state.screen = '❯ ';
    await tick(PROMPT_DELIVERY_RETRY_MS * 2);
    expect(h.nudges).toEqual(['fix it']);
  });

  it('without the question it still gives up after 45 s; a closed tab ends it at once', async () => {
    vi.useFakeTimers();
    const state = { me: agent() as AgentSummary | null, screen: 'Claude Code\n' };
    const h = harness(state);
    h.ops.deliverPrompt('default', 'claude-1@web', 'k', 'claude', 'x');
    await tick(PROMPT_DELIVERY_WINDOW_MS + 5_000);
    expect(h.logs.join('\n')).toMatch(/gave up after 45000 ms/);

    const s2 = { me: agent() as AgentSummary | null, screen: SCREEN };
    const h2 = harness(s2);
    h2.ops.deliverPrompt('default', 'claude-1@web', 'k', 'claude', 'x');
    await tick(PROMPT_DELIVERY_RETRY_MS * 3);
    s2.me = null;
    await tick(PROMPT_DELIVERY_RETRY_MS * 3);
    s2.me = agent({ lifecycle: 'idle' });
    s2.screen = '❯ ';
    await tick(PROMPT_DELIVERY_RETRY_MS * 3);
    expect(h2.nudges).toEqual([]);
  });
});
