import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { daemonBinaryReplaced, pruneHelperCopies, stableHelperRuntime, ensurePtyDaemon, readExpectedDaemonVersion, readManifest, releasePtyDaemon, versionLess } from './supervisor.js';
import { launchdEnabled } from './launchd.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo-relative path to the built daemon bundle. Task 5 must have run
// `npm run build -w packages/ptyd` for these tests to pass — the test
// asserts this precondition explicitly for a readable failure.
const daemonScript = path.resolve(here, '../../../../ptyd/dist/ptyd.cjs');

let stateDir: string;
const spawned: number[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-sup-'));
  expect(fs.existsSync(daemonScript), `build ptyd first: npm run build -w packages/ptyd (missing ${daemonScript})`).toBe(true);
});

afterEach(() => {
  // Stop any daemon this test spawned: boots the launchd job out where there
  // is one (a loaded job with a dead process would otherwise linger in the
  // user's launchd domain), else SIGTERMs the manifest pid.
  releasePtyDaemon(stateDir);
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('ensurePtyDaemon', () => {
  it('spawns a daemon, writes the manifest, socket accepts', async () => {
    const { socketPath } = await ensurePtyDaemon({ stateDir, daemonScript });
    expect(fs.existsSync(socketPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    expect(manifest.socketPath).toBe(socketPath);
    expect(manifest.pid).toBeGreaterThan(0);
    spawned.push(manifest.pid);
  }, 15000);

  it('adopts a live daemon instead of spawning a second one', async () => {
    const first = await ensurePtyDaemon({ stateDir, daemonScript });
    const m1 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    spawned.push(m1.pid);
    const second = await ensurePtyDaemon({ stateDir, daemonScript });
    const m2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    expect(second.socketPath).toBe(first.socketPath);
    expect(m2.pid).toBe(m1.pid); // same daemon, no respawn
  }, 15000);

  it('replaces a dead daemon whose manifest is stale', async () => {
    const first = await ensurePtyDaemon({ stateDir, daemonScript });
    const m1 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    process.kill(m1.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300)); // let it die
    const second = await ensurePtyDaemon({ stateDir, daemonScript });
    const m2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    expect(m2.pid).not.toBe(m1.pid);
    expect(second.socketPath).toBe(first.socketPath);
    spawned.push(m2.pid);
  }, 15000);

  it('rejects when the daemon script cannot start', async () => {
    await expect(
      ensurePtyDaemon({ stateDir, daemonScript: path.join(stateDir, 'missing.cjs') }),
    ).rejects.toThrow(/ptyd/);
  }, 15000);

  it('readExpectedDaemonVersion reads ptyd.version beside the script', () => {
    expect(readExpectedDaemonVersion(daemonScript)).toBe(
      fs.readFileSync(path.join(path.dirname(daemonScript), 'ptyd.version'), 'utf8').trim(),
    );
    expect(readExpectedDaemonVersion('/nonexistent/ptyd.cjs')).toBeNull();
  });

  it('versionLess compares numeric x.y.z', () => {
    expect(versionLess('0.1.0', '0.2.0')).toBe(true);
    expect(versionLess('0.2.0', '0.2.0')).toBe(false);
    expect(versionLess('0.10.0', '0.9.0')).toBe(false);
    expect(versionLess('garbage', '0.2.0')).toBe(false);
  });

  // launchd makes the daemon its own "responsible process" for macOS privacy
  // grants (launchd.ts). Skipped where launchd is off; a GUI-less box (CI)
  // that refuses the job falls back to the detached spawn, which the test
  // reports rather than fails on.
  it.skipIf(!launchdEnabled())('macOS: the daemon runs under launchd and releasePtyDaemon boots it out', async () => {
    await ensurePtyDaemon({ stateDir, daemonScript });
    const m = readManifest(stateDir)!;
    if (!m.launchdLabel) {
      console.warn('launchd refused the job here; detached fallback exercised instead');
      spawned.push(m.pid);
      return;
    }
    expect(m.launchdLabel).toMatch(/^io\.strado\.ptyd\.[0-9a-f]{10}$/);
    const ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(m.pid)], { encoding: 'utf8' }).trim();
    expect(ppid).toBe('1');
    expect(execFileSync('launchctl', ['print', `gui/${process.getuid!()}/${m.launchdLabel}`], { encoding: 'utf8' }))
      .toContain(m.launchdLabel);

    releasePtyDaemon(stateDir);
    const start = Date.now();
    for (;;) {
      try { process.kill(m.pid, 0); } catch { break; }
      if (Date.now() - start > 5000) throw new Error('daemon survived releasePtyDaemon');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(() => execFileSync('launchctl', ['print', `gui/${process.getuid!()}/${m.launchdLabel}`], { stdio: 'pipe' })).toThrow();
  }, 20000);

  it('ensurePtyDaemon reports the running daemon version', async () => {
    const { daemonVersion } = await ensurePtyDaemon({ stateDir, daemonScript });
    expect(daemonVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    spawned.push(m.pid);
  }, 15000);
});

describe('daemonBinaryReplaced: an app update swapped the daemon\'s program file', () => {
  const started = Date.parse('Wed Oct 21 18:20:09 2026');
  const facts = { execPath: '/Applications/Strado.app/Contents/Helpers/Strado Terminals.app/Contents/MacOS/node', startedAt: started };
  const at = (ms: number | null) => () => ms;
  it('true when the file changed after the daemon started (macOS)', () => {
    expect(daemonBinaryReplaced(94488, { platform: 'darwin', inspect: () => facts, changedAt: at(started + 5 * 3600_000) })).toBe(true);
  });
  it('false when the file is older than the daemon, or within lstart\'s one-second grain', () => {
    expect(daemonBinaryReplaced(1, { platform: 'darwin', inspect: () => facts, changedAt: at(started - 60_000) })).toBe(false);
    expect(daemonBinaryReplaced(1, { platform: 'darwin', inspect: () => facts, changedAt: at(started + 900) })).toBe(false);
  });
  it('false off macOS, for an unknown pid, or when the process or file cannot be read', () => {
    expect(daemonBinaryReplaced(1, { platform: 'linux', inspect: () => facts, changedAt: at(started + 60_000) })).toBe(false);
    expect(daemonBinaryReplaced(-1, { platform: 'darwin', inspect: () => facts, changedAt: at(started + 60_000) })).toBe(false);
    expect(daemonBinaryReplaced(1, { platform: 'darwin', inspect: () => null, changedAt: at(started + 60_000) })).toBe(false);
    expect(daemonBinaryReplaced(1, { platform: 'darwin', inspect: () => facts, changedAt: at(null) })).toBe(false);
  });
  it.runIf(process.platform === 'darwin')('reads a real process: this one\'s node is not newer than itself', () => {
    expect(daemonBinaryReplaced(process.pid)).toBe(false);
  });
  it.runIf(process.platform === 'darwin')('reads a real process: a program replaced after it started is caught', async () => {
    // A program of our own (a copied system binary is killed on launch).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-rep-'));
    const bin = path.join(dir, 'nap');
    fs.writeFileSync(path.join(dir, 'nap.c'), '#include <unistd.h>\nint main(void){sleep(30);return 0;}\n');
    execFileSync('cc', ['-o', bin, path.join(dir, 'nap.c')]);
    fs.copyFileSync(bin, `${bin}.new`);
    const { spawn } = await import('node:child_process');
    const child = spawn(bin, [], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(daemonBinaryReplaced(child.pid!)).toBe(false);
      // An update: the new file is renamed over the old one while it runs.
      await new Promise((r) => setTimeout(r, 1_100));
      fs.renameSync(`${bin}.new`, bin);
      expect(daemonBinaryReplaced(child.pid!)).toBe(true);
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === 'darwin')('stableHelperRuntime: daemons run from a copy of the helper an update never rewrites', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-helper-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  /** A helper-shaped bundle: Contents/MacOS/{node,strado-disclaim}, Info.plist, a seal. */
  const bundle = (version: string, seal: string, node = '#!/bin/sh\n') => {
    const app = path.join(root, 'Strado.app', 'Contents', 'Helpers', 'Strado Terminals.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', '_CodeSignature'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'node'), node, { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'strado-disclaim'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>`);
    fs.writeFileSync(path.join(app, 'Contents', '_CodeSignature', 'CodeResources'), seal);
    return path.join(app, 'Contents', 'MacOS', 'node');
  };
  const state = () => path.join(root, 'state');
  const helpers = () => path.join(state(), 'ptyd', 'helpers');

  it('copies the helper once per build and runs node and the launcher from the copy', () => {
    const node = bundle('0.1.69', 'seal-a');
    const rt = stableHelperRuntime(node, state())!;
    expect(rt.node.startsWith(helpers() + path.sep)).toBe(true);
    expect(rt.node.endsWith('/Strado Terminals.app/Contents/MacOS/node')).toBe(true);
    expect(rt.launcher.endsWith('/Strado Terminals.app/Contents/MacOS/strado-disclaim')).toBe(true);
    expect(fs.readFileSync(rt.node, 'utf8')).toBe('#!/bin/sh\n');
    expect(fs.readdirSync(helpers())).toHaveLength(1);
    // Same build again: the same copy.
    expect(stableHelperRuntime(node, state())).toEqual(rt);
    expect(fs.readdirSync(helpers())).toHaveLength(1);
  });

  it('an update (a new seal) gets its own copy; the old one is retired, not deleted', () => {
    const node = bundle('0.1.69', 'seal-a');
    const a = stableHelperRuntime(node, state())!;
    bundle('0.1.70', 'seal-b');
    const b = stableHelperRuntime(node, state())!;
    expect(b.node).not.toBe(a.node);
    expect(fs.existsSync(a.node)).toBe(true); // tabs started under it may still be open
    const oldDir = path.dirname(path.dirname(path.dirname(path.dirname(a.node))));
    expect(fs.existsSync(path.join(oldDir, '.retired'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(path.dirname(b.node)))), '.retired'))).toBe(false);
  });

  it('pruneHelperCopies: a retired copy goes only once every open session started after it was retired', () => {
    const node = bundle('0.1.69', 'seal-a');
    const a = stableHelperRuntime(node, state())!;
    bundle('0.1.70', 'seal-b');
    const b = stableHelperRuntime(node, state())!;
    const oldDir = path.dirname(path.dirname(path.dirname(path.dirname(a.node))));
    const retiredAt = Number(fs.readFileSync(path.join(oldDir, '.retired'), 'utf8'));
    pruneHelperCopies(state(), retiredAt - 60_000); // a session from before the update is still open
    expect(fs.existsSync(a.node)).toBe(true);
    pruneHelperCopies(state(), retiredAt + 60_000); // every session is newer
    expect(fs.existsSync(a.node)).toBe(false);
    expect(fs.existsSync(b.node)).toBe(true); // the current copy is never pruned
    pruneHelperCopies(state(), null);
    expect(fs.existsSync(b.node)).toBe(true);
  });

  it('pruneHelperCopies: no sessions at all removes retired copies', () => {
    const node = bundle('0.1.69', 'seal-a');
    const a = stableHelperRuntime(node, state())!;
    bundle('0.1.70', 'seal-b');
    stableHelperRuntime(node, state());
    pruneHelperCopies(state(), null);
    expect(fs.existsSync(a.node)).toBe(false);
    expect(fs.readdirSync(helpers())).toHaveLength(1);
  });

  it('a retired copy something still runs from is kept even with no sessions', async () => {
    // A real program as the helper's node, so a process can run from the copy.
    const src = path.join(root, 'nap.c');
    fs.writeFileSync(src, '#include <unistd.h>\nint main(void){sleep(30);return 0;}\n');
    const nap = path.join(root, 'nap');
    execFileSync('cc', ['-o', nap, src]);
    const node = bundle('0.1.69', 'seal-a', fs.readFileSync(nap) as unknown as string);
    const a = stableHelperRuntime(node, state())!;
    const { spawn } = await import('node:child_process');
    const child = spawn(a.node, [], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      bundle('0.1.70', 'seal-b');
      stableHelperRuntime(node, state());
      pruneHelperCopies(state(), null);
      expect(fs.existsSync(a.node)).toBe(true); // in use: kept
    } finally {
      child.kill();
    }
  });

  it('null when node is not inside a helper app (dev), or the helper has no launcher', () => {
    expect(stableHelperRuntime(process.execPath, state())).toBeNull();
    const node = bundle('0.1.69', 'seal-a');
    fs.rmSync(path.join(path.dirname(node), 'strado-disclaim'));
    expect(stableHelperRuntime(node, state())).toBeNull();
  });

  it('follows the bin/node symlink the app ships into the helper', () => {
    const node = bundle('0.1.69', 'seal-a');
    const link = path.join(root, 'Strado.app', 'Contents', 'Resources', 'bin', 'node');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(node, link);
    expect(stableHelperRuntime(link, state())?.node.startsWith(helpers())).toBe(true);
  });
});
