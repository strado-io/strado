import { describe, it, expect } from 'vitest';
import { planFromModel } from '../../lib/jarvis/model';
import { buildParseContext } from '../jarvis/jarvisContext';
import type { Worktree } from '../../types';

// The ref Jarvis is told to use for a tab: `<worktree>/<mode>-<id>`. It must
// resolve to exactly that tab from any window, whatever is on screen.
const wt = (path: string, branch: string): Worktree => ({ path, branch } as Worktree);
const peer = (agentId: string, mode: string, worktreePath: string, sessionId: string, alias: string | null = null) =>
  ({ agentId, alias, mode, worktreePath, sessionId, executionId: `x-${agentId}`, lifecycle: 'idle', live: true }) as never;
const ctxShowing = (hubPath: string | null) => buildParseContext({
  hub: hubPath ? { path: hubPath, context: { tabs: hubPath === '/w/api'
    ? [{ worktreePath: '/w/api', mode: 'shell', sessionId: '1', label: 'Shell', busy: false }, { worktreePath: '/w/api', mode: 'claude', sessionId: '1', label: 'Claude', busy: false }]
    : [{ worktreePath: '/w/web', mode: 'shell', sessionId: '1', label: 'Shell', busy: false }], focused: null } } : null,
  lastActedOn: null, focuses: [], workspaces: [], repos: [], scripts: null,
  worktrees: [wt('/w/api', 'master'), wt('/w/web', 'web')],
  peers: [peer('shell-1@api', 'shell', '/w/api', '1'), peer('claude-1@api', 'claude', '/w/api', '1', 'reviewer'), peer('shell-1@web', 'shell', '/w/web', '1')],
  storedBrowsers: [{ worktreePath: '/w/api', sessionId: '2', label: 'Google' }],
});
const targetOf = (name: string, hub: string | null) => {
  const plan = planFromModel([{ action: 'tab.focus', args: { tab: name } }], ctxShowing(hub));
  const t = plan.steps[0]?.target;
  return t?.kind === 'tab' ? `${t.ref.worktreePath}:${t.ref.mode}-${t.ref.sessionId}` : `unresolved: ${plan.summary}`;
};

describe('<worktree>/<mode>-<id> refs', () => {
  for (const hub of [null, '/w/api', '/w/web']) {
    it(`resolve exactly with ${hub ?? 'nothing'} on screen`, () => {
      expect(targetOf('master/shell-1', hub)).toBe('/w/api:shell-1');
      expect(targetOf('web/shell-1', hub)).toBe('/w/web:shell-1');
      expect(targetOf('master/claude-1', hub)).toBe('/w/api:claude-1'); // has an alias ("reviewer")
      if (hub !== '/w/api') expect(targetOf('master/browser-2', hub)).toBe('/w/api:browser-2');
    });
  }
});
