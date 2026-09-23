#!/usr/bin/env node
// Claude Code hook notifier. Usage: node claude-status-hook.mjs <status> <port>
// Reports the worktree's Claude agent status to the local dashboard server.
// Worktree dir comes from CLAUDE_PROJECT_DIR (fallback: `cwd` in stdin JSON).
// Never blocks Claude: ~1s timeout, errors swallowed, always exits 0.

import { requestJson as transportRequest } from './lib/transport.mjs';

function readStdinPayload() {
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
        const parsed = JSON.parse(data);
        finish(parsed && typeof parsed === 'object' ? parsed : null);
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

// One JSON request to the server, over the sandbox socket when present, else
// loopback. Resolves the parsed JSON body on a 2xx, null on anything else
// (timeout, connection error, non-2xx, unparsable). Never throws: the shared
// transport rejects on transport errors, and this adapter swallows that.
async function requestJson({ socketPath, port, urlPath, body, token }) {
  try {
    const { status, json } = await transportRequest({ socketPath, port, urlPath, body, token });
    return status >= 200 && status < 300 ? json : null;
  } catch {
    return null;
  }
}

// Intercom passive delivery (step 4). SessionStart/UserPromptSubmit: ask the
// server for this tab's inbox, print it as additionalContext, then confirm the
// batch — only after the stdout write completed, which is the one moment we
// know the text reached Claude. Stop: acknowledge confirmed batches. Skipped
// entirely without an agent token (session not under Strado).
async function deliverIntercom({ payload, port, socketPath }) {
  const token = process.env.STRADO_AGENT_TOKEN;
  const event = payload && typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null;
  if (!token || !event) return;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit' && event !== 'Stop') return;
  const transport = socketPath ? 'socket' : 'port';
  const res = await requestJson({
    socketPath, port, urlPath: '/api/intercom/hook', token,
    body: JSON.stringify({ event, transport }),
  });
  if (event === 'Stop' || !res) return;
  const text = typeof res.additionalContext === 'string' ? res.additionalContext : '';
  if (!text) return;
  const line = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + '\n';
  // A closed/broken stdout pipe (e.g. Claude's reader already gone) raises
  // EPIPE as an 'error' event on process.stdout, which by default is an
  // unhandled error that crashes the process before the write callback below
  // ever runs. Swallow it here so the failure only reaches us as `err` in
  // that callback, `written` stays false, and we still exit 0 without confirming.
  process.stdout.on('error', () => {});
  const written = await new Promise((resolve) => process.stdout.write(line, (err) => resolve(!err)));
  if (!written || typeof res.batchId !== 'string') return;
  await requestJson({
    socketPath, port, urlPath: '/api/intercom/hook/confirm', token,
    body: JSON.stringify({ batchId: res.batchId }),
  });
}

async function main() {
  let status = process.argv[2];
  const port = process.argv[3] || '7777';
  if (!status) return;
  // Intercom delivery below reads hook_event_name off this payload, so it
  // depends on stdin arriving inside readStdinPayload's 200ms timer; a payload
  // that lands late means this turn pulls nothing from the inbox — no message
  // is lost, the next turn's hook invocation just retries the pull.
  const payload = await readStdinPayload();
  const cwd = process.env.CLAUDE_PROJECT_DIR || payload?.cwd;
  if (!cwd) return;

  // Claude's Notification hook covers two very different things: a permission /
  // elicitation prompt (the agent needs input) and `idle_prompt` (the agent has
  // sat at its prompt for a while). The installer maps the event to `waiting`;
  // an idle prompt is really `idle`, and the intercom's push delivery relies on
  // that distinction to nudge a long-idle tab.
  if (status === 'waiting' && payload?.notification_type === 'idle_prompt') status = 'idle';

  // Injected into the PTY env by the server; identifies WHICH Claude tab of
  // the worktree this hook belongs to. Absent on sessions spawned before
  // multi-session support — the server treats those as session 1.
  const rawSessionId = process.env.STRADO_SESSION_ID;
  const sessionId = rawSessionId && process.env.STRADO_SESSION_MODE === 'shell'
    ? `shell:${rawSessionId}`
    : rawSessionId;
  const providerSessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
  const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined;
  const body = JSON.stringify({
    cwd,
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  });

  const socketPath = process.env.STRADO_SERVER_SOCKET;
  if (socketPath) {
    await postOverSocket(socketPath, '/api/claude/status', body);
  } else {
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
  await deliverIntercom({ payload, port, socketPath });
}

main().finally(() => process.exit(0));
