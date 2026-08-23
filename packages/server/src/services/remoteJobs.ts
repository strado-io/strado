// Follow a job running on a runner and report its progress as our own.
//
// A remote create is really two jobs: provisioning we do from here (check the
// runner, make sure the repo is on it) and the worktree job the runner runs. The
// client should see ONE list of steps, so this consumes the runner's own
// `/events/jobs/:id` stream and re-emits into the local job.
export type RemoteJobEvent =
  | { type: 'progress'; message: string; step?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Parse an SSE byte stream into events, tolerating chunk boundaries mid-frame. */
export async function* parseSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        // Comment lines are heartbeats — the stream's way of staying alive
        // through proxies. Never treat them as data.
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length > 0 || event !== 'message') yield { event, data: data.join('\n') };
      split = buffer.indexOf('\n\n');
    }
  }
}

/**
 * Consume a runner's job stream to completion.
 *
 * Resolves when the job reports done; throws with the runner's own message when
 * it errors. A stream that ends without a terminal event is a dropped
 * connection, not a success — reporting it as success would tell the user their
 * worktree exists when it may not.
 */
export async function followRemoteJob(
  url: string,
  onEvent: (evt: RemoteJobEvent) => void,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) {
    throw new Error(`could not follow the runner's job (HTTP ${res.status})`);
  }
  let terminal = false;
  for await (const { event, data } of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
    let payload: Record<string, unknown> = {};
    try {
      payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON frame — treat as empty */
    }
    if (event === 'progress') {
      const inner = (payload.data ?? {}) as { step?: unknown };
      onEvent({
        type: 'progress',
        message: typeof payload.message === 'string' ? payload.message : '',
        // A runner on our version sends a step id; an older one doesn't, and its
        // message becomes detail on the current step instead.
        step: typeof inner.step === 'string' ? inner.step : undefined,
      });
    } else if (event === 'done') {
      terminal = true;
      onEvent({ type: 'done' });
      return;
    } else if (event === 'error') {
      terminal = true;
      const message =
        (typeof payload.message === 'string' && payload.message) ||
        (typeof payload.error === 'string' && payload.error) ||
        'the runner reported a failure';
      onEvent({ type: 'error', message });
      throw new Error(message);
    }
  }
  if (!terminal) {
    throw new Error('lost contact with the runner while it was building the worktree');
  }
}
