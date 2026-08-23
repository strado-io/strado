import { beforeEach, describe, expect, it } from 'vitest';
import { readShellNames, renameSession, renameShell, sessionNameKey, shellNameKey } from './shellNames';

describe('sessionNames (agent tabs)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the legacy path::id key for shells so saved names survive', () => {
    expect(sessionNameKey('/wt/a', 'shell', '2')).toBe(shellNameKey('/wt/a', '2'));
  });

  it('keys agent renames by path::mode::id, separate from shells', () => {
    renameSession('/wt/a', 'claude', '2', 'reviewer');
    renameSession('/wt/a', 'shell', '2', 'api server');
    expect(readShellNames()).toEqual({
      [sessionNameKey('/wt/a', 'claude', '2')]: 'reviewer',
      [shellNameKey('/wt/a', '2')]: 'api server',
    });
  });

  it('clears an agent rename when the name trims to empty', () => {
    renameSession('/wt/a', 'codex', '1', 'fixer');
    renameSession('/wt/a', 'codex', '1', '  ');
    expect(readShellNames()).toEqual({});
  });
});

const KEY = 'strado:shell-names';

beforeEach(() => localStorage.clear());

describe('shellNames', () => {
  it('stores a rename keyed by path::id and reads it back', () => {
    renameShell('/wt/a', '2', 'api server');
    expect(readShellNames()).toEqual({ [shellNameKey('/wt/a', '2')]: 'api server' });
  });

  it('trims the name and clears the entry when it trims to empty', () => {
    renameShell('/wt/a', '1', '  logs  ');
    expect(readShellNames()[shellNameKey('/wt/a', '1')]).toBe('logs');
    renameShell('/wt/a', '1', '   ');
    expect(readShellNames()).toEqual({});
  });

  it('keeps other entries intact when one is renamed', () => {
    renameShell('/wt/a', '1', 'build');
    renameShell('/wt/b', '1', 'deploy');
    renameShell('/wt/a', '1', 'watch');
    expect(readShellNames()).toEqual({
      [shellNameKey('/wt/a', '1')]: 'watch',
      [shellNameKey('/wt/b', '1')]: 'deploy',
    });
  });

  it('survives malformed storage', () => {
    localStorage.setItem(KEY, 'not json');
    expect(readShellNames()).toEqual({});
    localStorage.setItem(KEY, JSON.stringify({ good: 'name', bad: 42 }));
    expect(readShellNames()).toEqual({ good: 'name' });
  });
});
