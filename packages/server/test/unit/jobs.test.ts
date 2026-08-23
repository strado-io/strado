import { describe, expect, it } from 'vitest';
import { createJobQueue } from '../../src/services/jobs';
import { createEventBus } from '../../src/events/bus';

describe('job queue', () => {
  it('runs a job to completion and emits progress + done', async () => {
    const bus = createEventBus();
    const queue = createJobQueue(bus);
    const events: Array<{ type: string; data: unknown }> = [];

    const { id } = queue.start('test:run', async (ctx) => {
      ctx.progress('step 1');
      ctx.progress('step 2');
      return { ok: true };
    });

    bus.on(`job:${id}`, (evt) => events.push(evt));

    const final = await queue.wait(id);

    expect(final.status).toBe('done');
    expect(final.result).toEqual({ ok: true });
    const types = events.map((e) => e.type);
    expect(types).toEqual(['progress', 'progress', 'done']);
  });

  it('captures errors and emits error event', async () => {
    const bus = createEventBus();
    const queue = createJobQueue(bus);
    const events: Array<{ type: string; data: unknown }> = [];

    const { id } = queue.start('test:fail', async () => {
      throw new Error('boom');
    });
    bus.on(`job:${id}`, (evt) => events.push(evt));

    const final = await queue.wait(id);
    expect(final.status).toBe('error');
    expect(events.at(-1)?.type).toBe('error');
  });
});
