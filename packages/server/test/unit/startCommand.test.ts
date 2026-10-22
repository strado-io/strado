import { describe, expect, it } from 'vitest';
import { resolveRunCommand } from '../../src/services/startCommand.js';
import type { RepoConfig } from '../../src/repoConfig.js';

const repo = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  id: 'r', name: 'R', path: '/r', projectSubdir: null, startCommand: 'npm run dev',
  defaultPort: 3000, editor: 'code',
  runCommands: [{ id: 'web', name: 'web', command: 'npm run dev', envFile: '.env' }, { id: 'api', name: 'api', command: 'node api.js' }],
  ...over,
} as RepoConfig);

describe('resolveRunCommand', () => {
  it('no runId: the first, the default', () => {
    expect(resolveRunCommand(repo(), null)).toEqual({ id: 'web', name: 'web', command: 'npm run dev', envFile: '.env', isDefault: true });
  });
  it('by id: that one, not the default', () => {
    expect(resolveRunCommand(repo(), 'api')).toEqual({ id: 'api', name: 'api', command: 'node api.js', envFile: null, isDefault: false });
  });
  it('by name too, any case (the command box says "run API")', () => {
    expect(resolveRunCommand(repo(), 'API')).toMatchObject({ id: 'api', isDefault: false });
    expect(resolveRunCommand(repo(), ' Web ')).toMatchObject({ id: 'web', isDefault: true });
  });
  it('an unknown id is NOT_FOUND', () => {
    expect(() => resolveRunCommand(repo(), 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
  it('a worktree override replaces the default command only; {ENV_FILE} in it takes the default\'s file', () => {
    expect(resolveRunCommand(repo(), null, 'next dev --env {ENV_FILE}')).toMatchObject({ command: 'next dev --env .env', envFile: null });
    expect(resolveRunCommand(repo(), null, 'pnpm dev')).toMatchObject({ command: 'pnpm dev', envFile: '.env' });
    expect(resolveRunCommand(repo(), 'api', 'pnpm dev')).toMatchObject({ command: 'node api.js' });
  });
  it('a repo with no run commands but a worktree override: that is the default', () => {
    expect(resolveRunCommand(repo({ runCommands: [], startCommand: '' }), null, 'make run')).toEqual({ id: 'dev', name: 'dev', command: 'make run', envFile: null, isDefault: true });
  });
  it('nothing to run: VALIDATION "empty startCommand" (as before)', () => {
    expect(() => resolveRunCommand(repo({ runCommands: [], startCommand: '' }), null)).toThrow(expect.objectContaining({ code: 'VALIDATION', message: 'empty startCommand' }));
  });
  it('an old repo (no runCommands yet) is migrated on the fly', () => {
    expect(resolveRunCommand(repo({ runCommands: undefined, envProfiles: [{ name: 'local', envFile: '.env' }] }), null)).toMatchObject({ id: 'local', envFile: '.env', isDefault: true });
  });
});
