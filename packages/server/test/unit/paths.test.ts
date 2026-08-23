import { describe, expect, it } from 'vitest';
import { assertPathUnder, encodePath, decodePath } from '../../src/paths';
import { AppError } from '../../src/errors';

describe('assertPathUnder', () => {
  it('accepts paths under an allowed root', () => {
    expect(() =>
      assertPathUnder('/repos/app/.worktrees/feature-x', [
        '/repos/app/.worktrees',
      ]),
    ).not.toThrow();
  });

  it('rejects paths that escape via ..', () => {
    expect(() =>
      assertPathUnder('/repos/app/.worktrees/../../etc/passwd', [
        '/repos/app/.worktrees',
      ]),
    ).toThrowError(AppError);
  });

  it('rejects paths outside any allowed root', () => {
    expect(() => assertPathUnder('/etc/passwd', ['/repos/app'])).toThrowError(
      AppError,
    );
  });

  it('accepts an exact match', () => {
    expect(() => assertPathUnder('/repos/app', ['/repos/app'])).not.toThrow();
  });

  it('rejects a sibling that merely shares a prefix with the root', () => {
    expect(() =>
      assertPathUnder('/repos/app-evil', ['/repos/app']),
    ).toThrowError(AppError);
  });

  it('throws PATH_FORBIDDEN without leaking the target path in the message', () => {
    const target = '/Users/kb/Desktop/strado/strado-fe.worktree-evil';
    try {
      assertPathUnder(target, ['/Users/kb/Desktop/strado/strado-fe']);
      throw new Error('expected assertPathUnder to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('PATH_FORBIDDEN');
      expect(appErr.message).not.toContain(target);
    }
  });

  it('still attaches target and allowedRoots in details for server-side logging', () => {
    const target = '/etc/passwd';
    const allowedRoots = ['/repos/app'];
    try {
      assertPathUnder(target, allowedRoots);
      throw new Error('expected assertPathUnder to throw');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.details).toEqual({ target, allowedRoots });
    }
  });
});

describe('encodePath/decodePath', () => {
  it('round trips an absolute path', () => {
    const p = '/Users/dev/code/repo.worktrees/FD-123_thing';
    expect(decodePath(encodePath(p))).toBe(p);
  });
});
