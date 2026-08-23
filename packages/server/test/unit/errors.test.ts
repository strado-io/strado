import { describe, expect, it } from 'vitest';
import { AppError, toResponse, ErrorCode } from '../../src/errors';

describe('AppError', () => {
  it('round-trips through toResponse', () => {
    const err = new AppError(ErrorCode.GIT_DIRTY, 'tree has changes', { branch: 'x' });
    expect(toResponse(err)).toEqual({
      error: { code: 'GIT_DIRTY', message: 'tree has changes', details: { branch: 'x' } },
    });
  });

  it('wraps unknown errors as SHELL_FAILED with stderr in details', () => {
    const raw = new Error('boom');
    expect(toResponse(raw)).toEqual({
      error: { code: 'SHELL_FAILED', message: 'boom', details: undefined },
    });
  });

  it('exposes a typed httpStatus per code', () => {
    expect(new AppError(ErrorCode.VALIDATION, 'bad').httpStatus).toBe(400);
    expect(new AppError(ErrorCode.NOT_FOUND, 'missing').httpStatus).toBe(404);
    expect(new AppError(ErrorCode.SHELL_FAILED, 'oops').httpStatus).toBe(500);
  });

  it('WORKSPACE_HAS_RUNNING_PROCESSES maps to 409', () => {
    expect(new AppError(ErrorCode.WORKSPACE_HAS_RUNNING_PROCESSES, 'busy').httpStatus).toBe(409);
  });

  it('strips details from PATH_FORBIDDEN so host filesystem paths never reach the client', () => {
    const err = new AppError(ErrorCode.PATH_FORBIDDEN, 'path is not under an allowed root', {
      target: '/Users/kb/Desktop/strado/strado-fe.worktree-evil',
      allowedRoots: ['/Users/kb/Desktop/strado/strado-fe'],
    });
    expect(toResponse(err)).toEqual({
      error: {
        code: 'PATH_FORBIDDEN',
        message: 'path is not under an allowed root',
        details: undefined,
      },
    });
  });

  it('keeps details for other codes that carry client-relevant data', () => {
    const err = new AppError(ErrorCode.WORKSPACE_HAS_RUNNING_PROCESSES, 'busy', {
      runningPaths: ['/repos/app/.worktrees/feature-x'],
    });
    expect(toResponse(err)).toEqual({
      error: {
        code: 'WORKSPACE_HAS_RUNNING_PROCESSES',
        message: 'busy',
        details: { runningPaths: ['/repos/app/.worktrees/feature-x'] },
      },
    });
  });
});
