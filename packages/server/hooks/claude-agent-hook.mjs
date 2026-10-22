#!/usr/bin/env node
// Claude Code hook for Strado's mission control. Usage:
//   node claude-agent-hook.mjs permission <port>   (PermissionRequest)
//   node claude-agent-hook.mjs tool <port>         (PreToolUse, async)
//   node claude-agent-hook.mjs stop <port>         (Stop, async)
//
// permission: asks the server and waits while the TUI shows its own dialog.
// The box's Approve/Deny prints a decision; nothing printed leaves it to the
// dialog. When the user answers in the tab first, Claude cancels this hook.
// tool/stop: report the live tool line and the turn's final words.
// No agent token (a session not under Strado) or no server: does nothing.
// Always exits 0: a failure here must never change what Claude does.

import { requestJson } from './lib/transport.mjs';

/** Just under Claude's hook timeout (600s): answer before it gives up on us. */
const PERMISSION_WAIT_MS = 595_000;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    const timer = setTimeout(() => resolve(null), 2000);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function post(urlPath, body, timeoutMs) {
  const token = process.env.STRADO_AGENT_TOKEN;
  if (!token) return null;
  try {
    const { status, json } = await requestJson({
      socketPath: process.env.STRADO_SERVER_SOCKET || undefined,
      port: process.argv[3] || process.env.STRADO_STATUS_PORT || '7777',
      urlPath, body: JSON.stringify(body), token, timeoutMs,
    });
    return status >= 200 && status < 300 ? json : null;
  } catch {
    return null;
  }
}

async function main() {
  const mode = process.argv[2];
  const payload = await readStdin();
  if (!payload || typeof payload !== 'object') return;
  if (mode === 'permission') {
    if (typeof payload.tool_name !== 'string') return;
    const res = await post('/api/intercom/hook/permission', { tool_name: payload.tool_name, tool_input: payload.tool_input }, PERMISSION_WAIT_MS);
    const behavior = res?.decision;
    if (behavior !== 'allow' && behavior !== 'deny') return;
    const decision = behavior === 'deny' ? { behavior, message: 'Denied from Strado.' } : { behavior };
    process.stdout.on('error', () => {});
    await new Promise((r) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), r));
  } else if (mode === 'tool') {
    if (typeof payload.tool_name !== 'string') return;
    await post('/api/intercom/hook/activity', { phase: 'tool', tool_name: payload.tool_name, tool_input: payload.tool_input }, 1500);
  } else if (mode === 'stop') {
    const message = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;
    await post('/api/intercom/hook/activity', { phase: 'stop', message }, 1500);
  }
}

main().finally(() => process.exit(0));
