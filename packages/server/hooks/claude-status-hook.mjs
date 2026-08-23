#!/usr/bin/env node
// Claude Code hook notifier. Usage: node claude-status-hook.mjs <status> <port>
// Reports the worktree's Claude agent status to the local dashboard server.
// Worktree dir comes from CLAUDE_PROJECT_DIR (fallback: `cwd` in stdin JSON).
// Never blocks Claude: ~1s timeout, errors swallowed, always exits 0.

function readStdinCwd() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(null), 200);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        finish(JSON.parse(data).cwd ?? null);
      } catch {
        finish(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

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
  const status = process.argv[2];
  const port = process.argv[3] || '7777';
  if (!status) return;
  const cwd = process.env.CLAUDE_PROJECT_DIR || (await readStdinCwd());
  if (!cwd) return;

  // Injected into the PTY env by the server; identifies WHICH Claude tab of
  // the worktree this hook belongs to. Absent on sessions spawned before
  // multi-session support — the server treats those as session 1.
  const sessionId = process.env.STRADO_SESSION_ID;
  const body = JSON.stringify(sessionId ? { cwd, status, sessionId } : { cwd, status });

  const socketPath = process.env.STRADO_SERVER_SOCKET;
  if (socketPath) {
    await postOverSocket(socketPath, '/api/claude/status', body);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await fetch(`http://127.0.0.1:${port}/api/claude/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Server down/slow — never block Claude.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
