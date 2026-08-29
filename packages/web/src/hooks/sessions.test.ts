import { describe, expect, it } from 'vitest';
import { hasSession, sessionChips, bySessionPriority, chipStatus, displayLabel } from './sessions';
import type { Worktree } from '../types';

function wt(path: string, opts: Partial<Worktree> = {}): Worktree {
  return { path, meta: { ticketId: path.split('/').pop() } as any, ...opts } as unknown as Worktree;
}

describe('session helpers', () => {
  it('hasSession is true when any flag is set', () => {
    expect(hasSession(wt('/a', { hasClaudeSession: true }))).toBe(true);
    expect(hasSession(wt('/b', { hasCodexSession: true }))).toBe(true);
    expect(hasSession(wt('/c', { hasShellSession: true }))).toBe(true);
    expect(hasSession(wt('/e', { hasPiSession: true }))).toBe(true);
    expect(hasSession(wt('/d'))).toBe(false);
  });

  it('sessionChips emits one chip per live session, claude then codex then opencode then pi then shells, one per shell id', () => {
    const chips = sessionChips([
      wt('/a', { hasClaudeSession: true, hasCodexSession: true, hasOpencodeSession: true, hasPiSession: true, hasShellSession: true, shellSessions: ['1', '3'], claudeStatus: 'working' }),
      wt('/b', { hasShellSession: true }),
      wt('/c'),
    ]);
    expect(chips).toEqual([
      { path: '/a', mode: 'claude', sessionId: '1', modeLabel: 'claude', label: 'a', title: null, claudeStatus: 'working' },
      { path: '/a', mode: 'codex', sessionId: '1', modeLabel: 'codex', label: 'a', title: null, codexStatus: undefined },
      { path: '/a', mode: 'opencode', sessionId: '1', modeLabel: 'opencode', label: 'a', title: null, opencodeStatus: undefined },
      { path: '/a', mode: 'pi', sessionId: '1', modeLabel: 'pi', label: 'a', title: null, piStatus: undefined },
      { path: '/a', mode: 'shell', sessionId: '1', modeLabel: 'shell', label: 'a', title: null, hostedAgent: undefined },
      { path: '/a', mode: 'shell', sessionId: '3', modeLabel: 'shell 3', label: 'a', title: null, hostedAgent: undefined },
      { path: '/b', mode: 'shell', sessionId: '1', modeLabel: 'shell', label: 'b', title: null, hostedAgent: undefined },
    ]);
  });

  it('emits one claude chip per session, coloured by that session\'s own by-id status', () => {
    const chips = sessionChips([
      wt('/a', {
        hasClaudeSession: true,
        claudeSessions: ['1', '2'],
        claudeStatus: 'idle',
        claudeStatusById: { '1': 'idle', '2': 'working' },
      }),
    ]);
    expect(chips).toEqual([
      { path: '/a', mode: 'claude', sessionId: '1', modeLabel: 'claude', label: 'a', title: null, claudeStatus: 'idle' },
      { path: '/a', mode: 'claude', sessionId: '2', modeLabel: 'claude 2', label: 'a', title: null, claudeStatus: 'working' },
    ]);
  });

  it('still emits one chip when hasClaudeSession is set but the ids array is empty', () => {
    const chips = sessionChips([wt('/a', { hasClaudeSession: true, claudeSessions: [], claudeStatus: 'working' })]);
    expect(chips).toEqual([
      { path: '/a', mode: 'claude', sessionId: '1', modeLabel: 'claude', label: 'a', title: null, claudeStatus: 'working' },
    ]);
  });

  it('vscode tabs count as sessions and get a chip', () => {
    const tabs = new Set(['/v']);
    expect(hasSession(wt('/v'), tabs)).toBe(true);
    expect(hasSession(wt('/w'), tabs)).toBe(false);
    const chips = sessionChips([wt('/v'), wt('/w', { hasShellSession: true })], tabs);
    expect(chips).toEqual([
      { path: '/v', mode: 'vscode', sessionId: '1', modeLabel: 'vs code', label: 'v', title: null },
      { path: '/w', mode: 'shell', sessionId: '1', modeLabel: 'shell', label: 'w', title: null, hostedAgent: undefined },
    ]);
  });

  it('scopes a Shell-hosted agent to its own tab', () => {
    const chips = sessionChips([
      wt('/a', {
        hasClaudeSession: true,
        claudeSessions: ['1'],
        hasShellSession: true,
        shellSessions: ['1', '2'],
        // Claude launched by hand inside Shell 2 — the worktree aggregate is
        // 'working', but only that shell may show it
        claudeStatus: 'working',
        claudeStatusById: { 'shell:2': 'working' },
      }),
    ]);
    expect(chips).toEqual([
      { path: '/a', mode: 'claude', sessionId: '1', modeLabel: 'claude', label: 'a', title: null, claudeStatus: undefined },
      { path: '/a', mode: 'shell', sessionId: '1', modeLabel: 'shell', label: 'a', title: null, hostedAgent: undefined },
      {
        path: '/a', mode: 'shell', sessionId: '2', modeLabel: 'shell 2', label: 'a', title: null,
        hostedAgent: 'claude', claudeStatus: 'working',
      },
    ]);
    expect(chipStatus(chips[0]!)).toBeUndefined();
    expect(chipStatus(chips[2]!)).toBe('working');
  });

  it('bySessionPriority orders waiting before working before others', () => {
    const list = [wt('/x', { claudeStatus: 'idle' }), wt('/y', { claudeStatus: 'waiting' }), wt('/z', { claudeStatus: 'working' })];
    const sorted = [...list].sort(bySessionPriority).map((w) => w.path);
    expect(sorted).toEqual(['/y', '/z', '/x']);
  });
});

describe('chipStatus', () => {
  it('returns the per-mode status, undefined for non-agent modes', () => {
    const base = { path: '/a', sessionId: '1', modeLabel: '', label: 'a', title: null } as const;
    expect(chipStatus({ ...base, mode: 'claude', claudeStatus: 'working' })).toBe('working');
    expect(chipStatus({ ...base, mode: 'codex', codexStatus: 'waiting' })).toBe('waiting');
    expect(chipStatus({ ...base, mode: 'opencode', opencodeStatus: 'idle' })).toBe('idle');
    expect(chipStatus({ ...base, mode: 'pi', piStatus: 'working' })).toBe('working');
    expect(chipStatus({ ...base, mode: 'shell' })).toBeUndefined();
    expect(chipStatus({ ...base, mode: 'vscode' })).toBeUndefined();
  });
});

describe('displayLabel', () => {
  const base = { path: '/a', modeLabel: '', label: 'a', title: null } as const;
  it('proper-cases each mode and never double-numbers', () => {
    expect(displayLabel({ ...base, mode: 'claude', sessionId: '1' })).toBe('Claude');
    expect(displayLabel({ ...base, mode: 'claude', sessionId: '2' })).toBe('Claude 2');
    expect(displayLabel({ ...base, mode: 'shell', sessionId: '2' })).toBe('Shell 2');
    expect(displayLabel({ ...base, mode: 'opencode', sessionId: '1' })).toBe('OpenCode');
    expect(displayLabel({ ...base, mode: 'vscode', sessionId: '1' })).toBe('VS Code');
    expect(displayLabel({ ...base, mode: 'browser', sessionId: '1' })).toBe('Browser');
  });
});
