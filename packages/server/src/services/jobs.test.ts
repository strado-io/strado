import { describe, expect, it } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { createJobQueue } from './jobs.js';

describe('job progress snapshots', () => {
  it('retains the latest progress frame for a late event-stream subscriber', async () => {
    const jobs = createJobQueue(createEventBus());
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => { finish = resolve; });
    const job = jobs.start('fast-job', async (ctx) => {
      ctx.progress('Stopping processes', {
        step: 'stop',
        steps: [{ id: 'stop', label: 'Stopping processes' }],
      });
      await hold;
    });

    // start() schedules the job body as a microtask.
    await Promise.resolve();
    expect(jobs.get(job.id)?.progress).toEqual({
      message: 'Stopping processes',
      data: {
        step: 'stop',
        steps: [{ id: 'stop', label: 'Stopping processes' }],
      },
    });

    finish();
    await jobs.wait(job.id);
  });

  it('includes the current step in a terminal error event', async () => {
    const bus = createEventBus();
    const jobs = createJobQueue(bus);
    const job = jobs.start('failing-job', async (ctx) => {
      ctx.progress('Removing worktree', { step: 'remove' });
      throw new Error('not a working tree');
    });
    const events: { type: string; data: unknown }[] = [];
    const unsubscribe = bus.on(`job:${job.id}`, (event) => events.push(event));

    await jobs.wait(job.id);
    unsubscribe();

    expect(events.at(-1)).toEqual({
      type: 'error',
      data: expect.objectContaining({
        message: 'not a working tree',
        progress: { message: 'Removing worktree', data: { step: 'remove' } },
      }),
    });
  });
});
