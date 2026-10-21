import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { daemonBinaryReplaced, ensurePtyDaemon, readExpectedDaemonVersion, readManifest, releasePtyDaemon, versionLess } from './supervisor.js';
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
