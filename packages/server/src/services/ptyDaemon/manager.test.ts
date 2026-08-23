import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonTerminalManager } from './manager.js';
import type { TerminalManager } from '../terminalManager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.resolve(here, '../../../../ptyd/dist/ptyd.cjs');

let stateDir: string;
let manager: TerminalManager & { destroy(): void };

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-mgr-'));
  manager = await createDaemonTerminalManager({ stateDir, daemonScript });
});

afterEach(() => {
  manager.destroy();
  const manifest = path.join(stateDir, 'ptyd', 'manifest.json');
  if (fs.existsSync(manifest)) {
    const { pid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const shSpec = { file: '/bin/sh', args: ['-c', 'printf ready; cat'] };

async function vwait(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('vwait timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('DaemonTerminalManager', () => {
  it('ensure spawns; snapshot/subscribe/status work like the in-process manager', async () => {
    const key = '/tmp\0shell';
    const info = await manager.ensure(key, '/tmp', shSpec);
    expect(info.status).toBe('running');
    expect(info.pid).toBeGreaterThan(0);
    await vwait(() => manager.snapshot(key).includes('ready'));
    const got: string[] = [];
    const unsub = manager.subscribe(key, (d) => got.push(d));
    manager.write(key, 'hello\n');
    await vwait(() => got.join('').includes('hello'));
    unsub();
    expect(manager.status(key).status).toBe('running');
    expect(manager.liveSessions()).toEqual([{ path: '/tmp', mode: 'shell', id: '1' }]);
  }, 15000);

  it('snapshot re-asserts SGR mouse encoding (1006) that addon-serialize drops', async () => {
    // A reattached mouse TUI (opencode) still expects the SGR-encoded reports it
    // enabled at startup; addon-serialize restores tracking but not encoding, so
    // snapshot() must add it back or clicks/scroll break after a tab switch.
    const key = '/tmp\0shell';
    await manager.ensure(key, '/tmp', shSpec);
    await vwait(() => manager.snapshot(key).includes('ready'));
    // `cat` echoes this back, so the server emulator records drag tracking + SGR.
    // Trailing newline flushes the pty's canonical-mode line buffer.
    manager.write(key, '\x1b[?1002h\x1b[?1006h\n');
    await vwait(() => manager.snapshot(key).includes('\x1b[?1006h'));
    expect(manager.snapshot(key)).toContain('\x1b[?1006h');
  }, 15000);

  it('ensure is idempotent on a live session', async () => {
    const key = '/tmp\0shell';
    const a = await manager.ensure(key, '/tmp', shSpec);
    const b = await manager.ensure(key, '/tmp', shSpec);
    expect(b.pid).toBe(a.pid);
  }, 15000);

  it('kill ends the session; onExit fires; status flips to exited', async () => {
    const key = '/tmp\0shell';
    await manager.ensure(key, '/tmp', shSpec);
    let exit: number | null | undefined;
    manager.onExit(key, (code) => { exit = code; });
    manager.kill(key);
    await vwait(() => exit !== undefined);
    expect(manager.status(key).status).toBe('exited');
    expect(manager.liveSessions()).toEqual([]);
  }, 15000);

  it('a second manager (server restart) adopts sessions with replayed buffers', async () => {
    const key = '/tmp\0shell';
    await manager.ensure(key, '/tmp', shSpec);
    await vwait(() => manager.snapshot(key).includes('ready'));
    manager.destroy(); // server "dies" — daemon keeps running

    const manager2 = await createDaemonTerminalManager({ stateDir, daemonScript });
    try {
      await vwait(() => manager2.liveSessions().length === 1);
      expect(manager2.liveSessions()).toEqual([{ path: '/tmp', mode: 'shell', id: '1' }]);
      await vwait(() => manager2.snapshot(key).includes('ready')); // replay refilled the mirror
      expect(manager2.status(key).status).toBe('running');
      // and it's still interactive
      const got: string[] = [];
      manager2.subscribe(key, (d) => got.push(d));
      manager2.write(key, 'alive\n');
      await vwait(() => got.join('').includes('alive'));
    } finally {
      manager2.kill(key);
      manager2.destroy();
    }
  }, 20000);

  it('killUnder closes every session whose key path is under the prefix', async () => {
    await manager.ensure('/tmp/a\0shell', '/tmp', shSpec);
    await manager.ensure('/tmp/a\0codex', '/tmp', shSpec);
    await manager.ensure('/tmp/b\0shell', '/tmp', shSpec);
    manager.killUnder('/tmp/a');
    await vwait(() => manager.liveSessions().length === 1);
    expect(manager.liveSessions()).toEqual([{ path: '/tmp/b', mode: 'shell', id: '1' }]);
  }, 15000);

  it('decodes multibyte UTF-8 split across output chunks', async () => {
    const key = '/tmp\0shell';
    // printf the two bytes of 'é' with a flush-forcing sleep between them
    await manager.ensure(key, '/tmp', {
      file: '/bin/sh',
      args: ['-c', "printf '\\303'; sleep 0.2; printf '\\251'; sleep 30"],
    });
    await vwait(() => manager.snapshot(key).includes('é'));
    expect(manager.snapshot(key)).not.toContain('�');
    manager.kill(key);
  }, 15000);

  it('concurrent ensure() calls for the same key share one open', async () => {
    const key = '/tmp\0shell:9';
    const [a, b] = await Promise.all([
      manager.ensure(key, '/tmp', shSpec),
      manager.ensure(key, '/tmp', shSpec),
    ]);
    expect(a.pid).toBeGreaterThan(0);
    expect(b.pid).toBe(a.pid);
    manager.kill(key);
  }, 15000);

  it('routes both the built-in spec and an override through wrapSpec', async () => {
    // Same contract as the in-process manager: the sandbox wrapper must see
    // the mode-specific override specs (shell/codex/opencode), not just the
    // default one, or a sandboxed worktree gets an unsandboxed codex session.
    const seen: { cwd: string; spec: { file: string; args: string[] } }[] = [];
    const wrapped = await createDaemonTerminalManager({
      stateDir,
      daemonScript,
      buildSpec: () => ({ file: '/bin/sh', args: ['-c', 'printf fromdefault; cat'] }),
      wrapSpec: (cwd, spec) => {
        seen.push({ cwd, spec });
        return { file: '/bin/sh', args: ['-c', 'printf fromwrapper; cat'] };
      },
    });
    const keyA = '/tmp/wrapA\0shell';
    const keyB = '/tmp/wrapB\0codex';
    try {
      await wrapped.ensure(keyA, '/tmp', undefined);
      await wrapped.ensure(keyB, '/tmp', shSpec);
      await vwait(() => wrapped.snapshot(keyA).includes('fromwrapper'));
      await vwait(() => wrapped.snapshot(keyB).includes('fromwrapper'));
      expect(seen).toEqual([
        { cwd: '/tmp', spec: { file: '/bin/sh', args: ['-c', 'printf fromdefault; cat'] } },
        { cwd: '/tmp', spec: shSpec },
      ]);
    } finally {
      wrapped.kill(keyA);
      wrapped.kill(keyB);
      wrapped.destroy();
    }
  }, 20000);

  it('ensure() re-arms after the daemon dies and reconnect gave up', async () => {
    const key = '/tmp\0shell';
    await manager.ensure(key, '/tmp', shSpec);
    // Kill the daemon out from under the manager.
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    process.kill(manifest.pid, 'SIGKILL');
    await vwait(() => manager.status(key).status === 'exited', 15000);
    // A fresh ensure spawns a new daemon (background loop may or may not
    // have won the race — both paths must end with a working session).
    const info = await manager.ensure(key, '/tmp', shSpec);
    expect(info.status).toBe('running');
    const m2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    expect(m2.pid).not.toBe(manifest.pid);
    manager.kill(key);
  }, 30000);
});
