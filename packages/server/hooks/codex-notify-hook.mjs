#!/usr/bin/env node
// Codex notify hook. Wired via `codex -c notify=["node", <this>, <port>, <cwd>]`;
// codex appends one JSON argument describing the notification. On
// agent-turn-complete we report the worktree as waiting for input.
// Never blocks codex: ~1s timeout, errors swallowed, always exits 0.

// Inside a sandbox there is no route to the host's loopback; the server is
// reachable over a bind-mounted unix socket instead, whose path the container
// wrapper exports as STRADO_SERVER_SOCKET. Only status routes are forwarded on
// the other end. Best-effort like the fetch below: resolves on any failure.
function postOverSocket(socketPath, urlPath, body) {
  return new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request(
        {
          socketPath,
          path: urlPath,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          timeout: 1000,
        },
        (res) => res.resume(),
      );
      req.on('timeout', () => req.destroy());
      req.on('error', resolve);
      req.on('close', resolve);
      req.end(body);
    }, resolve).catch(resolve); // a throw inside the then() must still settle
  });
}

async function main() {
  const port = process.argv[2] || '7777';
  const cwd = process.argv[3];
  const payloadRaw = process.argv[4];
  if (!cwd || !payloadRaw) return;

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return;
  }
  if (payload?.type !== 'agent-turn-complete') return;

  // Injected into the PTY env by the server (codex spawns us as a child, so
  // it's inherited); identifies WHICH Codex tab of the worktree this is.
  const rawSessionId = process.env.STRADO_SESSION_ID;
  const sessionId = rawSessionId && process.env.STRADO_SESSION_MODE === 'shell'
    ? `shell:${rawSessionId}`
    : rawSessionId;
  const providerSessionId = payload['thread-id'] ?? payload.thread_id ?? payload.threadId;
  const body = JSON.stringify({
    cwd,
    status: 'waiting',
    ...(sessionId ? { sessionId } : {}),
    ...(typeof providerSessionId === 'string' ? { providerSessionId } : {}),
  });

  const socketPath = process.env.STRADO_SERVER_SOCKET;
  if (socketPath) {
    await postOverSocket(socketPath, '/api/codex/status', body);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await fetch(`http://127.0.0.1:${port}/api/codex/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Server down/slow — never block codex.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
