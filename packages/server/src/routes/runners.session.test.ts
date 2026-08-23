import { describe, expect, it } from 'vitest';
import { pickSessionFields } from './runners.js';
import { runnerSessionPath } from './runners.js';

describe('pickSessionFields', () => {
  it('carries the session/status fields a runner reports', () => {
    const w: Parameters<typeof pickSessionFields>[0] = {
      hasClaudeSession: true, claudeStatus: 'working',
      claudeStatusById: { '1': 'working' }, claudeSessions: ['1'],
      hasShellSession: true, shellSessions: ['1', '2'],
    };
    expect(pickSessionFields(w)).toEqual({
      hasClaudeSession: true, claudeStatus: 'working',
      claudeStatusById: { '1': 'working' }, claudeSessions: ['1'],
      hasCodexSession: undefined, codexStatus: undefined,
      codexStatusById: undefined, codexSessions: undefined,
      hasOpencodeSession: undefined, opencodeStatus: undefined,
      opencodeStatusById: undefined, opencodeSessions: undefined,
      hasShellSession: true, shellSessions: ['1', '2'],
    });
  });
});

describe('runnerSessionPath', () => {
  it('omits the id query when the id is the default session', () => {
    expect(runnerSessionPath({ remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude' }))
      .toBe('/api/w/ws1/worktrees/%2Fw%2FFD-1/sessions/claude');
    expect(runnerSessionPath({ remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude', id: '1' }))
      .toBe('/api/w/ws1/worktrees/%2Fw%2FFD-1/sessions/claude');
  });
  it('adds the id query for a non-default session', () => {
    expect(runnerSessionPath({ remoteWsId: 'ws1', path: '/w/FD-1', mode: 'shell', id: '2' }))
      .toBe('/api/w/ws1/worktrees/%2Fw%2FFD-1/sessions/shell?id=2');
  });
});
