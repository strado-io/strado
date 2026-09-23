import { describe, expect, it } from 'vitest';
import { agentIdFor, isValidAlias, slugOf } from './agentId.js';
import { claudeKey, codexKey, opencodeKey, piKey, shellKey } from './terminalManager.js';

describe('slugOf', () => {
  it('is the basename', () => {
    expect(slugOf('/home/u/.strado/worktrees/app/str-13-linux-runner')).toBe('str-13-linux-runner');
  });
  it('replaces characters outside [A-Za-z0-9_.-] with -', () => {
    expect(slugOf('/tmp/my repo (copy)')).toBe('my-repo--copy-');
  });
});

describe('agentIdFor', () => {
  const wt = '/home/u/wt/str-13';
  it('formats <mode>-<tab>@<slug> for every mode, tab 1', () => {
    expect(agentIdFor(claudeKey(wt, '1'), 'str-13')).toBe('claude-1@str-13');
    expect(agentIdFor(codexKey(wt, '1'), 'str-13')).toBe('codex-1@str-13');
    expect(agentIdFor(opencodeKey(wt, '1'), 'str-13')).toBe('opencode-1@str-13');
    expect(agentIdFor(piKey(wt, '1'), 'str-13')).toBe('pi-1@str-13');
    expect(agentIdFor(shellKey(wt, '1'), 'str-13')).toBe('shell-1@str-13');
  });
  it('carries tab N', () => {
    expect(agentIdFor(claudeKey(wt, '2'), 'str-13')).toBe('claude-2@str-13');
    expect(agentIdFor(shellKey(wt, '3'), 'str-13')).toBe('shell-3@str-13');
  });
  it('uses the slug it is given, not the path basename', () => {
    expect(agentIdFor(claudeKey(wt, '1'), 'str-13~2')).toBe('claude-1@str-13~2');
  });
});

describe('isValidAlias', () => {
  it('accepts simple names', () => {
    for (const a of ['reviewer', 'Backend', 'fe.v2', 'a_b-c', 'x'.repeat(64)]) expect(isValidAlias(a)).toBe(true);
  });
  it('rejects empty, leading punctuation, spaces, too long', () => {
    for (const a of ['', '-lead', '.dot', 'has space', 'x'.repeat(65), 'a@b']) expect(isValidAlias(a)).toBe(false);
  });
});
