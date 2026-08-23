import { describe, expect, it } from 'vitest';
import { claudeKey, codexKey, opencodeKey, parseSessionKey, sessionEnv, sessionsPayload, shellKey } from '../../src/services/terminalManager';

describe('opencodeKey', () => {
  it('uses the legacy suffix-only key for opencode id 1', () => {
    expect(opencodeKey('/wt/a', '1')).toBe('/wt/a\0opencode');
  });

  it('round-trips through parseSessionKey for suffixed ids', () => {
    for (const id of ['1', '2', '7']) {
      expect(parseSessionKey(opencodeKey('/x', id))).toEqual({ path: '/x', mode: 'opencode', id });
    }
  });
});

describe('codexKey', () => {
  it('uses the legacy suffix-only key for codex id 1', () => {
    expect(codexKey('/wt/a', '1')).toBe('/wt/a\0codex');
  });

  it('suffixes the id for codex sessions beyond 1', () => {
    expect(codexKey('/wt/a', '2')).toBe('/wt/a\0codex:2');
  });

  it('round-trips through parseSessionKey', () => {
    for (const id of ['1', '2', '7']) {
      expect(parseSessionKey(codexKey('/x', id))).toEqual({ path: '/x', mode: 'codex', id });
    }
  });
});

describe('sessionsPayload', () => {
  it('reports id lists and has-flags for a worktree from its live sessions', () => {
    const live = [
      { path: '/wt/a', mode: 'claude' as const, id: '2' },
      { path: '/wt/a', mode: 'claude' as const, id: '1' },
      { path: '/wt/a', mode: 'shell' as const, id: '3' },
      { path: '/wt/a', mode: 'shell' as const, id: '1' },
      { path: '/wt/a', mode: 'codex' as const, id: '2' },
      { path: '/wt/a', mode: 'opencode' as const, id: '1' },
    ];
    expect(sessionsPayload(live)).toEqual({
      hasClaudeSession: true,
      hasCodexSession: true,
      hasOpencodeSession: true,
      hasShellSession: true,
      shellSessions: ['1', '3'],
      claudeSessions: ['1', '2'],
      codexSessions: ['2'],
      opencodeSessions: ['1'],
    });
  });

  it('is all-empty for no sessions', () => {
    expect(sessionsPayload([])).toEqual({
      hasClaudeSession: false,
      hasCodexSession: false,
      hasOpencodeSession: false,
      hasShellSession: false,
      shellSessions: [],
      claudeSessions: [],
      codexSessions: [],
      opencodeSessions: [],
    });
  });
});

describe('sessionEnv', () => {
  it('stamps the session id from the key so hooks can attribute status', () => {
    expect(sessionEnv('/wt/a', '/wt/a').STRADO_SESSION_ID).toBe('1');
    expect(sessionEnv('/wt/a\0claude:2', '/wt/a').STRADO_SESSION_ID).toBe('2');
    expect(sessionEnv('/wt/a\0shell:3', '/wt/a').STRADO_SESSION_ID).toBe('3');
  });

  it('keeps the worktree and status-port vars', () => {
    const env = sessionEnv('/wt/a\0claude:2', '/wt/a');
    expect(env.STRADO_WORKTREE).toBe('/wt/a');
    expect(env.STRADO_STATUS_PORT).toBeDefined();
  });
});

describe('claudeKey', () => {
  it('uses the bare path for claude id 1 so live sessions survive', () => {
    expect(claudeKey('/wt/a', '1')).toBe('/wt/a');
  });

  it('suffixes the id for claude sessions beyond 1', () => {
    expect(claudeKey('/wt/a', '2')).toBe('/wt/a\0claude:2');
    expect(claudeKey('/wt/a', '10')).toBe('/wt/a\0claude:10');
  });
});

describe('shellKey', () => {
  it('uses the legacy key form for shell id 1', () => {
    expect(shellKey('/wt/a', '1')).toBe('/wt/a\0shell');
  });

  it('suffixes the id for shells beyond 1', () => {
    expect(shellKey('/wt/a', '2')).toBe('/wt/a\0shell:2');
    expect(shellKey('/wt/a', '10')).toBe('/wt/a\0shell:10');
  });
});

describe('parseSessionKey', () => {
  it('parses a bare path as claude id 1', () => {
    expect(parseSessionKey('/wt/a')).toEqual({ path: '/wt/a', mode: 'claude', id: '1' });
  });

  it('parses the legacy shell key as shell id 1', () => {
    expect(parseSessionKey('/wt/a\0shell')).toEqual({ path: '/wt/a', mode: 'shell', id: '1' });
  });

  it('parses suffixed shell keys', () => {
    expect(parseSessionKey('/wt/a\0shell:3')).toEqual({ path: '/wt/a', mode: 'shell', id: '3' });
  });

  it('round-trips through shellKey', () => {
    for (const id of ['1', '2', '7']) {
      expect(parseSessionKey(shellKey('/x', id))).toEqual({ path: '/x', mode: 'shell', id });
    }
  });

  it('parses the codex key as codex id 1', () => {
    expect(parseSessionKey('/wt/a\0codex')).toEqual({ path: '/wt/a', mode: 'codex', id: '1' });
  });

  it('parses the opencode key as opencode id 1', () => {
    expect(parseSessionKey('/wt/a\0opencode')).toEqual({ path: '/wt/a', mode: 'opencode', id: '1' });
  });

  it('parses suffixed claude keys', () => {
    expect(parseSessionKey('/wt/a\0claude:2')).toEqual({ path: '/wt/a', mode: 'claude', id: '2' });
  });

  it('round-trips through claudeKey', () => {
    for (const id of ['1', '2', '7']) {
      expect(parseSessionKey(claudeKey('/x', id))).toEqual({ path: '/x', mode: 'claude', id });
    }
  });
});
