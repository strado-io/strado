import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { followRemoteJob } from './remoteJobs.js';

function streamResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('followRemoteJob', () => {
  it('preserves the remote error code, details, and Git stderr', async () => {
    const details = {
      command: 'git',
      args: ['worktree', 'remove'],
      stderr: "fatal: '/worktree' contains modified or untracked files, use --force to delete it\n",
      code: 128,
    };
    const fetchImpl = vi.fn(async () => streamResponse(
      `event: error\ndata: ${JSON.stringify({
        code: 'SHELL_FAILED',
        message: 'git exited 128',
        details,
        progress: { message: 'Removing worktree', data: { step: 'remove' } },
      })}\n\n`,
    )) as unknown as typeof fetch;
    const events: unknown[] = [];

    let failure: unknown;
    try {
      await followRemoteJob('https://runner.test/events/jobs/1', (event) => events.push(event), { fetchImpl });
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: 'SHELL_FAILED',
      details,
      message: expect.stringContaining('contains modified or untracked files'),
    });
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      code: 'SHELL_FAILED',
      details,
      step: 'remove',
      message: expect.stringContaining('contains modified or untracked files'),
    })]);
  });
});
