// Strado Pi status extension. Pi loads extensions from an explicit path with
// `pi -e <path>`, so Strado points every pi session it launches at THIS file
// rather than copying anything into the worktree — no `.pi/` to git-exclude and
// no project-trust prompt (project-local extensions need one, an explicit `-e`
// does not).
//
// It no-ops unless STRADO_WORKTREE and a route to the server — a port
// (STRADO_STATUS_PORT) or, inside a sandbox, a unix socket
// (STRADO_SERVER_SOCKET) — are set, all of which happen only when pi is
// launched by Strado, so running `pi` manually is unaffected. Never blocks pi:
// ~1s timeout, errors swallowed.
//
// Deliberately untyped: pi loads this through jiti with no type-check, and
// importing `@earendil-works/pi-coding-agent` for types would make the file
// depend on pi's own node_modules being resolvable from Strado's hooks dir.
export default function stradoStatus(pi: any) {
  const port = process.env.STRADO_STATUS_PORT;
  const cwd = process.env.STRADO_WORKTREE;
  // Which Pi tab of the worktree this process is (multi-session). An agent
  // typed by hand inside a Shell tab reports under that tab's `shell:<id>`
  // namespace instead, so it can't light up a dedicated Pi tab.
  const rawSessionId = process.env.STRADO_SESSION_ID;
  const sessionId =
    rawSessionId && process.env.STRADO_SESSION_MODE === 'shell' ? `shell:${rawSessionId}` : rawSessionId;
  // Set only inside a sandbox, where the host's loopback is unreachable: the
  // server is bind-mounted in as a unix socket that forwards status routes.
  const socketPath = process.env.STRADO_SERVER_SOCKET;

  // Inside a sandbox. Best-effort like the fetch below: resolves on any
  // failure, so a status post never blocks or crashes pi.
  function postOverSocket(body: string) {
    return new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request(
          {
            socketPath,
            path: '/api/pi/status',
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

  // `ctx` is absent only where pi gives a handler none; the ids are then
  // simply left out, exactly as they are for a pre-handoff Strado build.
  function sessionRef(ctx: any): { providerSessionId?: string; transcriptPath?: string } {
    const manager = ctx?.sessionManager;
    if (!manager) return {};
    try {
      const providerSessionId = manager.getSessionId?.();
      // Unset for an ephemeral (`--no-session`) run, which has no history to
      // hand off — the id alone still identifies the tab's conversation.
      const transcriptPath = manager.getSessionFile?.();
      return {
        ...(typeof providerSessionId === 'string' ? { providerSessionId } : {}),
        ...(typeof transcriptPath === 'string' ? { transcriptPath } : {}),
      };
    } catch {
      return {};
    }
  }

  async function report(status: string, ctx?: any) {
    // The socket stands in for the port inside a container; either one is a
    // route to the server, and a manual `pi` run has neither.
    if (!cwd || (!port && !socketPath)) return;
    const body = JSON.stringify({
      cwd,
      status,
      ...(sessionId ? { sessionId } : {}),
      // Lets a handoff find THIS tab's pi session file instead of guessing
      // the newest one for the worktree.
      ...(status === 'closed' ? {} : sessionRef(ctx)),
    });
    if (socketPath) {
      await postOverSocket(body);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      await fetch(`http://127.0.0.1:${port}/api/pi/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch {
      // server down/slow — never block pi
    } finally {
      clearTimeout(timer);
    }
  }

  // The turn started. `turn_start` would fire per LLM round-trip; this fires
  // once per user prompt, which is the boundary Strado's "working" means.
  pi.on('before_agent_start', async (_event: unknown, ctx: any) => {
    await report('working', ctx);
  });
  // A blocking extension prompt (confirm/select/input) is the agent asking the
  // human for something — the same thing Claude's Notification hook reports.
  pi.on('ui_prompt_start', async (_event: unknown, ctx: any) => {
    await report('waiting', ctx);
  });
  // `agent_end` can be followed by an auto-retry, an auto-compact, or a queued
  // message; `agent_settled` is pi's own "I will not continue on my own" signal
  // and is what its docs point status integrations at.
  pi.on('agent_settled', async (_event: unknown, ctx: any) => {
    await report('waiting', ctx);
  });
  // The process is going away — drop the registration entirely rather than
  // leaving an idle session behind (matters for Shell-hosted pi, where presence
  // in the map is what claims the tab).
  pi.on('session_shutdown', async () => {
    await report('closed');
  });
}
