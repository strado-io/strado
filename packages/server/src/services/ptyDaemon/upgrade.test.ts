import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonTerminalManager } from './manager.js';
import { probeDaemon } from './supervisor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const realBundle = path.resolve(here, '../../../../ptyd/dist/ptyd.cjs');
// node-pty is bundled as `external` (native module) — the real dist/ptyd.cjs
// resolves it by walking up to the repo's hoisted root node_modules. Our
// private scriptDir copy lives under os.tmpdir(), well outside that chain,
// so requiring node-pty from there fails with MODULE_NOT_FOUND unless we
// give it a node_modules to find. Symlinking the repo root's in is enough —
// this is test-harness plumbing, not part of what upgrade drift verifies.
const repoNodeModules = path.resolve(here, '../../../../../node_modules');

let stateDir: string;
let scriptDir: string;

beforeEach(() => {
  expect(fs.existsSync(realBundle), 'build ptyd first').toBe(true);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-up-'));
  // A private copy of the bundle whose ptyd.version claims a NEWER version
  // than the running daemon reports — forcing the drift path. The bundle
  // bytes are identical (a self-swap), which is exactly what a real
  // upgrade is at the fd level.
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-bundle-'));
  fs.copyFileSync(realBundle, path.join(scriptDir, 'ptyd.cjs'));
  fs.writeFileSync(path.join(scriptDir, 'ptyd.version'), '99.0.0');
  // See repoNodeModules comment above: give the copy a node_modules to
  // resolve node-pty from.
  fs.symlinkSync(repoNodeModules, path.join(scriptDir, 'node_modules'), 'dir');
});

afterEach(async () => {
  const manifest = path.join(stateDir, 'ptyd', 'manifest.json');
  let manifestPid = -1;
  // The upgrade replaces the manifest daemon with a successor. If the test
  // failed mid-handoff the manifest can still name the predecessor, so probe
  // the socket for the CURRENT owner and reap that too.
  try {
    const { daemonPid } = await probeDaemon(path.join(stateDir, 'ptyd', 'ptyd.sock'), 1000);
    if (fs.existsSync(manifest)) manifestPid = JSON.parse(fs.readFileSync(manifest, 'utf8')).pid;
    if (daemonPid > 0 && daemonPid !== manifestPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
    }
  } catch { /* socket already gone */ }
  if (fs.existsSync(manifest)) {
    const { pid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

const shSpec = { file: '/bin/sh', args: ['-c', 'printf ready; cat'] };
const daemonScript = () => path.join(scriptDir, 'ptyd.cjs');

async function vwait(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('vwait timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('daemon upgrade at boot', () => {
  it('drift triggers handoff: session survives with same pid, zero exit events', async () => {
    // Boot 1: spawn a daemon (running version = bundle's real version),
    // open a session.
    const exits: string[] = [];
    const m1 = await createDaemonTerminalManager({ stateDir, daemonScript: daemonScript() });
    const info = await m1.ensure('/tmp\0shell', '/tmp', shSpec);
    await vwait(() => m1.snapshot('/tmp\0shell').includes('ready'));
    const manifest1 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    m1.destroy(); // server "restarts"

    // Boot 2: ptyd.version now claims 99.0.0 > running — manager must
    // upgrade via handoff during creation, with no exit events.
    const m2 = await createDaemonTerminalManager({
      stateDir,
      daemonScript: daemonScript(),
      onExit: (key) => exits.push(key),
    });
    try {
      // Session survived the handoff: same key, same shell pid, running.
      await vwait(() => m2.status('/tmp\0shell').status === 'running');
      expect(m2.status('/tmp\0shell').pid).toBe(info.pid);
      expect(exits).toEqual([]); // the expected disconnect emitted nothing
      // Scrollback came through the snapshot.
      await vwait(() => m2.snapshot('/tmp\0shell').includes('ready'));
      // Still interactive.
      const got: string[] = [];
      m2.subscribe('/tmp\0shell', (d) => got.push(d));
      m2.write('/tmp\0shell', 'post-upgrade\n');
      await vwait(() => got.join('').includes('post-upgrade'));
      // Nothing exited during the round-trip either: a late teardown from the
      // predecessor connection must not reach the manager after the successor
      // is live.
      expect(exits).toEqual([]);
      // And the daemon actually changed process.
      const manifest2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
      expect(manifest2.pid).not.toBe(manifest1.pid);
    } finally {
      m2.kill('/tmp\0shell');
      m2.destroy();
    }
  }, 40000);
});
