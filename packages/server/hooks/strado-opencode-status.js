// Strado OpenCode status plugin. OpenCode auto-loads plugins from
// `.opencode/plugin/` in the project directory; Strado drops this file into
// each worktree it manages. It reports the worktree as `working` when a prompt
// is submitted and `waiting` when the turn finishes (session.idle).
//
// It no-ops unless STRADO_WORKTREE and a route to the server — a port
// (STRADO_STATUS_PORT) or, inside a sandbox, a unix socket
// (STRADO_SERVER_SOCKET) — are set, all of which happen only when opencode is
// launched by Strado, so running `opencode` manually in the same worktree is
// unaffected. Never blocks opencode: ~1s timeout, errors swallowed.
export const StradoStatus = async () => {
  const port = process.env.STRADO_STATUS_PORT;
  const cwd = process.env.STRADO_WORKTREE;
  // Which OpenCode tab of the worktree this process is (multi-session);
  // absent on sessions spawned before multi-session — treated as session 1.
  const sessionId = process.env.STRADO_SESSION_ID;
  // Set only inside a sandbox, where the host's loopback is unreachable: the
  // server is bind-mounted in as a unix socket that forwards status routes.
  const socketPath = process.env.STRADO_SERVER_SOCKET;

  // Inside a sandbox. Best-effort like the fetch below: resolves on any
  // failure, so a status post never blocks or crashes opencode.
  function postOverSocket(body) {
    return new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request(
          {
            socketPath,
            path: '/api/opencode/status',
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

  async function report(status) {
    // The socket stands in for the port inside a container; either one is a
    // route to the server, and a manual `opencode` run has neither.
    if (!cwd || (!port && !socketPath)) return;
    const body = JSON.stringify(sessionId ? { cwd, status, sessionId } : { cwd, status });
    if (socketPath) {
      await postOverSocket(body);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      await fetch(`http://127.0.0.1:${port}/api/opencode/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch {
      // server down/slow — never block opencode
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    'chat.message': async () => {
      await report('working');
    },
    event: async ({ event }) => {
      if (event?.type === 'session.idle') await report('waiting');
    },
  };
};
