import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePtyDaemon, readExpectedDaemonVersion, versionLess } from './supervisor.js';

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
  // Kill any daemon this test spawned (manifest records the pid).
  const manifest = path.join(stateDir, 'ptyd', 'manifest.json');
  if (fs.existsSync(manifest)) {
    const { pid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
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

  it('ensurePtyDaemon reports the running daemon version', async () => {
    const { daemonVersion } = await ensurePtyDaemon({ stateDir, daemonScript });
    expect(daemonVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    spawned.push(m.pid);
  }, 15000);
});
