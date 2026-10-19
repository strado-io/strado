import { describe, expect, it } from 'vitest';
import type { ParseContext } from '../jarvis/types';
import { contextualNames } from './contextual';

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [{ worktreePath: '/w', mode: 'shell', sessionId: '1', label: 'Shell', busy: false }, { worktreePath: '/w', mode: 'claude', sessionId: '1', label: 'Claude', busy: false }],
  focused: null, lastActedOn: null, currentWorktree: '/w',
  worktrees: [{ path: '/w', name: 'FD-9', branch: 'fd-9-login' }, { path: '/m', name: 'master', branch: 'master' }],
  focuses: [{ id: 'f', name: 'Billing' }],
  repos: [{ path: '/r', name: 'Fleetx Dashboard' }],
  packageScripts: { dev: 'vite', test: 'vitest' },
  peers: [{ agentId: 'claude-1@w', alias: 'reviewer', mode: 'claude', worktreePath: '/w' }],
  ...over,
});

describe('contextualNames (what speech recognition is primed with)', () => {
  it('tab labels, agent names and aliases, worktree names and branches, Focuses, repos, scripts; no duplicates', () => {
    expect(contextualNames(ctx())).toEqual(['Shell', 'Claude', 'claude-1', 'reviewer', 'FD-9', 'fd-9-login', 'master', 'Billing', 'Fleetx Dashboard', 'dev', 'test']);
  });
  it('capped, so a huge workspace does not flood the recogniser', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `/w${i}`, name: `wt-${i}` }));
    expect(contextualNames(ctx({ worktrees: many })).length).toBeLessThanOrEqual(100);
  });
});
