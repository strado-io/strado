#!/usr/bin/env node
// Shell-scoped launcher for agents typed inside a Strado Shell tab.
// It keeps the user's global config untouched, registers a namespaced status
// while the process is alive, and injects Codex's completion notifier.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksRoot = path.dirname(fileURLToPath(import.meta.url));
const launcherBin = path.join(hooksRoot, 'bin');

function shellSessionId() {
  const id = process.env.STRADO_SESSION_ID;
  return id ? `shell:${id}` : undefined;
}

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
    }, resolve).catch(resolve);
  });
}

async function report(agent, status) {
  const cwd = process.env.STRADO_WORKTREE;
  const sessionId = shellSessionId();
  if (!cwd || !sessionId) return;
  const body = JSON.stringify({ cwd, status, sessionId });
  const route = `/api/${agent}/status`;
  const socketPath = process.env.STRADO_SERVER_SOCKET;
  if (socketPath) {
    await postOverSocket(socketPath, route, body);
    return;
  }
  const port = process.env.STRADO_STATUS_PORT || '7777';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Agent launch must never depend on the dashboard being reachable.
  } finally {
    clearTimeout(timer);
  }
}

function realPathEnv() {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  return entries
    .filter((entry) => !entry || path.resolve(entry) !== path.resolve(launcherBin))
    .join(path.delimiter);
}

export async function launchAgent(agent) {
  if (!['claude', 'codex', 'opencode'].includes(agent)) {
    throw new Error(`unsupported agent launcher: ${agent}`);
  }

  // Waiting doubles as "this agent is currently open in the Shell". Its real
  // prompt/turn hook will move to working; closed clears the registration.
  await report(agent, 'waiting');

  const env = { ...process.env, PATH: realPathEnv() };
  const argv = process.argv.slice(2);
  if (agent === 'codex') {
    const port = process.env.STRADO_STATUS_PORT || '7777';
    const cwd = process.env.STRADO_WORKTREE || process.cwd();
    const notify = `notify=${JSON.stringify([
      'node',
      path.join(hooksRoot, 'codex-notify-hook.mjs'),
      port,
      cwd,
    ])}`;
    argv.unshift('-c', notify);
  }

  const child = spawn(agent, argv, { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try { child.kill(signal); } catch { /* child already exited */ }
    });
  }

  const code = await new Promise((resolve) => {
    child.once('error', (err) => {
      process.stderr.write(`[strado] could not start ${agent}: ${err.message}\n`);
      resolve(127);
    });
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  await report(agent, 'closed');
  process.exitCode = code;
}
