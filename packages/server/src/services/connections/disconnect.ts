// Disconnect one agent on this runner: remove what Strado put here for it,
// both from the runner store (so the next sandbox provision does not write it
// back) and from the shared HOME volume (so running sandboxes lose it too).
//
// Claude: the stored token (it reaches sandboxes only via env at create).
// Codex: its auth.json, when Strado put it there (a synced key or a Connect).
// OpenCode / Pi: the entries this runner was sent, while they still hold
// exactly what was sent, plus the ids a Connect logged in (store `managed`).
// A login made on the runner by hand is never touched.
import { AppError } from '../../errors.js';
import { markChanged, type RunnerAgentLogins } from '../agentLogins/runnerStore.js';
import { runOneShot, type OneShotDeps } from './oneShot.js';
import type { ConnectionAgent } from './types.js';

export type DisconnectDeps = {
  /** null when this runner has no sandbox image yet: nothing is in a volume. */
  oneShot: OneShotDeps | null;
  readStore(): Promise<RunnerAgentLogins>;
  writeStore(next: RunnerAgentLogins): Promise<void>;
};

const FAILED = 'disconnect failed';

/** A Disconnect sticks: the sync route skips listed agents. */
const withAgent = (s: RunnerAgentLogins, agent: ConnectionAgent) => [...new Set([...(s.disconnected ?? []), agent])];

// Runs inside the container (plain node, CommonJS). stdin: {agent, synced, drop}.
// Prints one JSON line: {"ok":true} or {"ok":false}.
const SCRIPT = String.raw`
const fs = require('fs'), path = require('path');
process.umask(0o077);
const H = process.env.HOME;
const FILES = {
  codex: path.join(H, '.codex', 'auth.json'),
  opencode: path.join(H, '.local', 'share', 'opencode', 'auth.json'),
  pi: path.join(H, '.pi', 'agent', 'auth.json'),
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const { agent, synced, drop } = JSON.parse(raw);
  const f = FILES[agent];
  const done = (ok) => process.stdout.write(JSON.stringify({ ok }) + '\n');
  try {
    if (agent === 'codex') { fs.rmSync(f, { force: true }); return done(true); }
    let cur;
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return done(e && e.code === 'ENOENT'); }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return done(false);
    const next = { ...cur };
    for (const [name, entry] of Object.entries(synced || {})) if (same(next[name], entry)) delete next[name];
    // A Connect's login refreshes in place, so it is removed by id.
    for (const name of drop || []) delete next[name];
    if (same(next, cur)) return done(true);
    const tmp = f + '.strado-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, f);
    done(true);
  } catch { done(false); }
});
`;

export async function disconnectAgent(agent: ConnectionAgent, deps: DisconnectDeps): Promise<void> {
  let store: RunnerAgentLogins;
  try {
    store = await deps.readStore();
  } catch {
    throw new AppError('SHELL_FAILED', FAILED);
  }

  if (agent === 'claude') {
    try {
      await deps.writeStore(markChanged({ ...store, claudeToken: undefined, disconnected: withAgent(store, agent) }, [agent]));
    } catch {
      throw new AppError('SHELL_FAILED', FAILED);
    }
    return;
  }

  const synced = agent === 'codex' ? null : store.volume?.[agent]?.providers ?? {};
  const drop = agent === 'opencode' ? store.managed?.opencode ?? [] : [];
  const ours =
    agent === 'codex'
      ? !!(store.volume?.codex || store.managed?.codex)
      : Object.keys(synced ?? {}).length > 0 || drop.length > 0;

  // The volume first: if it fails, the store still says what to remove, so a
  // retry removes the same entries.
  if (deps.oneShot && ours) {
    const r = await runOneShot(deps.oneShot, {
      volume: true,
      cmd: ['node', '-e', SCRIPT],
      input: JSON.stringify({ agent, synced, drop }),
      timeoutMs: 60_000,
    });
    let ok = false;
    try {
      ok = r.code === 0 && JSON.parse(r.stdout.trim().split('\n').pop() ?? '').ok === true;
    } catch {
      /* ok stays false */
    }
    if (!ok) throw new AppError('SHELL_FAILED', FAILED);
  }

  const volume = { ...store.volume };
  delete volume[agent];
  const managed = { ...store.managed };
  if (agent === 'codex' || agent === 'opencode') delete managed[agent];
  try {
    await deps.writeStore(markChanged({ ...store, volume, managed, disconnected: withAgent(store, agent) }, [agent]));
  } catch {
    throw new AppError('SHELL_FAILED', FAILED);
  }
}
