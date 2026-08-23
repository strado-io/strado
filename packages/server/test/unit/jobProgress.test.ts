import { describe, expect, it } from 'vitest';
import { stepReporter } from '../../src/services/jobSteps.js';
import { followRemoteJob, parseSse } from '../../src/services/remoteJobs.js';

function recorder() {
  const events: { message: string; data?: unknown }[] = [];
  return { ctx: { progress: (message: string, data?: unknown) => events.push({ message, data }) }, events };
}

describe('stepReporter', () => {
  const steps = [
    { id: 'a', label: 'Step A' },
    { id: 'b', label: 'Step B' },
  ];

  it('announces the whole plan on the first event only', () => {
    const { ctx, events } = recorder();
    const step = stepReporter(ctx, steps);
    step('a');
    step('b');
    // The UI needs the full list up front — a list that grows one line at a
    // time can't say how much is left.
    expect((events[0]!.data as { steps?: unknown }).steps).toEqual(steps);
    expect((events[1]!.data as { steps?: unknown }).steps).toBeUndefined();
    expect(events.map((e) => e.message)).toEqual(['Step A', 'Step B']);
  });

  it('attributes detail to the step currently in flight', () => {
    const { ctx, events } = recorder();
    const step = stepReporter(ctx, steps);
    step('b');
    step.detail('Receiving objects: 45%');
    expect(events[1]!.data).toEqual({ step: 'b', detail: 'Receiving objects: 45%' });
  });
});

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  for (const p of parts) yield enc.encode(p);
}

describe('parseSse', () => {
  it('reassembles frames split across chunk boundaries', async () => {
    const out: { event: string; data: string }[] = [];
    for await (const f of parseSse(chunks('event: progress\nda', 'ta: {"n":1}\n\nevent: done\ndata: {}\n\n'))) {
      out.push(f);
    }
    expect(out).toEqual([
      { event: 'progress', data: '{"n":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('ignores heartbeat comments', async () => {
    // The stream sends `: heartbeat` to stay alive through proxies; treating it
    // as data would surface junk as a progress message.
    const out: { event: string; data: string }[] = [];
    for await (const f of parseSse(chunks(': heartbeat\n\nevent: done\ndata: {}\n\n'))) out.push(f);
    expect(out).toEqual([{ event: 'done', data: '{}' }]);
  });
});

function sseResponse(body: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    body: chunks(body),
  })) as unknown as typeof fetch;
}

describe('followRemoteJob', () => {
  it('forwards the runner’s steps and resolves on done', async () => {
    const seen: string[] = [];
    await followRemoteJob(
      'https://runner/events/jobs/1',
      (e) => { if (e.type === 'progress') seen.push(e.step ?? e.message); },
      {
        fetchImpl: sseResponse(
          'event: progress\ndata: {"message":"Creating git worktree","data":{"step":"worktree"}}\n\n' +
            'event: progress\ndata: {"message":"npm install","data":{}}\n\n' +
            'event: done\ndata: {}\n\n',
        ),
      },
    );
    // A runner on our version sends a step id; an older one's message is kept as
    // text rather than dropped.
    expect(seen).toEqual(['worktree', 'npm install']);
  });

  it('rejects with the runner’s own message on failure', async () => {
    await expect(
      followRemoteJob('https://runner/events/jobs/1', () => {}, {
        fetchImpl: sseResponse('event: error\ndata: {"message":"branch already exists"}\n\n'),
      }),
    ).rejects.toThrow('branch already exists');
  });

  it('treats a stream that ends without a verdict as failure, not success', async () => {
    // Reporting success here would tell the user their worktree exists when the
    // connection dropped mid-build and it may not.
    await expect(
      followRemoteJob('https://runner/events/jobs/1', () => {}, {
        fetchImpl: sseResponse('event: progress\ndata: {"message":"working"}\n\n'),
      }),
    ).rejects.toThrow(/lost contact/);
  });
});
