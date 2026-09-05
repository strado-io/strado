import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePtyDaemon, installPtydRuntime, probeDaemon } from './supervisor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.resolve(here, '../../../../ptyd/dist/ptyd.cjs');

let stateDir: string;

beforeEach(() => {
  expect(fs.existsSync(daemonScript), 'build ptyd first: npm run build -w packages/ptyd').toBe(true);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-inst-'));
});

afterEach(() => {
  const manifest = path.join(stateDir, 'ptyd', 'manifest.json');
  if (fs.existsSync(manifest)) {
    const { pid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const installedDir = () => path.join(stateDir, 'ptyd', 'bin');

describe('installPtydRuntime', () => {
  it('fresh install copies bundle, version file, and node-pty', () => {
    const { script: installed } = installPtydRuntime({ stateDir, daemonScript });
    expect(installed).toBe(path.join(installedDir(), 'ptyd.cjs'));
    expect(fs.existsSync(installed)).toBe(true);
    // Installed marker is now version:size:mtime (bundle identity), not a
    // bare version — so a rebuild without a version bump still re-installs.
    expect(fs.readFileSync(path.join(installedDir(), 'ptyd.version'), 'utf8').trim())
      .toMatch(/^\d+\.\d+\.\d+:\d+:\d+(:node-\d+-\d+)?$/); // node suffix present when installNode (Linux default)
    expect(fs.existsSync(path.join(installedDir(), 'node_modules', 'node-pty', 'package.json'))).toBe(true);
  });

  it('same version is a no-op (bundle not rewritten)', () => {
    const { script: installed } = installPtydRuntime({ stateDir, daemonScript });
    const before = fs.statSync(installed).mtimeMs;
    installPtydRuntime({ stateDir, daemonScript });
    expect(fs.statSync(installed).mtimeMs).toBe(before);
  });

  it('marker mismatch re-installs', () => {
    const { script: installed } = installPtydRuntime({ stateDir, daemonScript });
    // Simulate a stale/foreign installed marker.
    fs.writeFileSync(path.join(installedDir(), 'ptyd.version'), '0.0.1');
    // Also blow away node-pty — a marker mismatch must force a FULL
    // re-install (bundle + node_modules), not just a version-file rewrite.
    const nodePtyPkg = path.join(installedDir(), 'node_modules', 'node-pty', 'package.json');
    fs.rmSync(nodePtyPkg, { force: true });
    const before = fs.statSync(installed).mtimeMs;
    installPtydRuntime({ stateDir, daemonScript });
    expect(fs.statSync(installed).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(fs.readFileSync(path.join(installedDir(), 'ptyd.version'), 'utf8').trim()).not.toBe('0.0.1');
    expect(fs.existsSync(nodePtyPkg)).toBe(true);
  });

  it('a rebuilt source bundle (no version bump) still re-installs', () => {
    // Private copy of the bundle: most ptyd source changes ship WITHOUT a
    // version bump, so the skip-check must key on the source bundle's
    // identity (size+mtime), not the version string alone. We touch a
    // private copy rather than the shared dist/ptyd.cjs so this doesn't
    // perturb other tests that read the same file concurrently.
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-rebuild-'));
    const privateScript = path.join(scriptDir, 'ptyd.cjs');
    fs.copyFileSync(daemonScript, privateScript);
    fs.copyFileSync(
      path.join(path.dirname(daemonScript), 'ptyd.version'),
      path.join(scriptDir, 'ptyd.version'),
    );
    // node-pty is external to the bundle and resolves by walking up to a
    // node_modules near the script — give the private copy one (repo root's,
    // symlinked), mirroring upgrade.test.ts's harness plumbing.
    const repoNodeModules = path.resolve(here, '../../../../../node_modules');
    fs.symlinkSync(repoNodeModules, path.join(scriptDir, 'node_modules'), 'dir');
    try {
      const { script: installed } = installPtydRuntime({ stateDir, daemonScript: privateScript });
      const before = fs.statSync(installed).mtimeMs;
      // Simulate a rebuild: same version, new mtime — nothing bumped.
      const touched = new Date(Date.now() + 2000);
      fs.utimesSync(privateScript, touched, touched);
      installPtydRuntime({ stateDir, daemonScript: privateScript });
      expect(fs.statSync(installed).mtimeMs).toBeGreaterThan(before);
    } finally {
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('the installed copy actually boots (node-pty resolves from the installed node_modules)', async () => {
    // The whole point: a daemon started from the stable copy, with the app's
    // original install location gone, must still work.
    const { script: installed } = installPtydRuntime({ stateDir, daemonScript });
    const { socketPath, daemonVersion } = await ensurePtyDaemon({ stateDir, daemonScript });
    expect(daemonVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The daemon process must be running the INSTALLED script, not the source.
    // -ww disables ps's line-truncation so the full command survives.
    const { pid } = JSON.parse(fs.readFileSync(path.join(stateDir, 'ptyd', 'manifest.json'), 'utf8'));
    const cmd = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    expect(cmd).toContain(installed);
    expect(cmd).not.toContain(daemonScript);
    expect(fs.existsSync(socketPath)).toBe(true);
  }, 15000);

  it('installNode: the returned interpreter boots the daemon (AppImage survival property)', async () => {
    const { script, execPath } = installPtydRuntime({ stateDir, daemonScript, installNode: true });
    // Either the copy (a self-contained node) or, when a lone copy cannot run
    // (Homebrew's node dlopens ../lib/libnode by relative rpath), the original.
    // Both must actually boot the daemon — the old assertion pinned the copy
    // and failed on any Mac with a Homebrew node.
    expect([path.join(installedDir(), 'node'), process.execPath]).toContain(execPath);
    expect(fs.statSync(execPath).mode & 0o111).toBeTruthy();
    const sock = path.join(stateDir, 'probe.sock');
    const child = spawn(execPath, [script, `--socket=${sock}`], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    child.unref();
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const { daemonVersion } = await probeDaemon(sock, 500);
          expect(daemonVersion).toMatch(/^\d+\.\d+\.\d+$/);
          break;
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } finally {
      if (child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
    }
  }, 15000);

  // A stand-in interpreter: a shell script, so the outcome of copying it is
  // the same on every platform regardless of how the real node was built.
  function fakeNode(body: string): string {
    const file = path.join(stateDir, 'fake-node');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it('installNode: a relocatable interpreter is copied and the copy is what runs', () => {
    const nodeSource = fakeNode('echo v1.2.3');
    const { execPath } = installPtydRuntime({ stateDir, daemonScript, installNode: true, nodeSource });
    expect(execPath).toBe(path.join(installedDir(), 'node'));
    expect(fs.readFileSync(path.join(installedDir(), 'ptyd.version'), 'utf8')).toMatch(/:node-\d+-\d+$/);
    expect(fs.existsSync(path.join(installedDir(), 'node.unrelocatable'))).toBe(false);
  });

  it('installNode: an interpreter whose copy cannot run falls back to the original — once', () => {
    const nodeSource = fakeNode('exit 1');
    const first = installPtydRuntime({ stateDir, daemonScript, installNode: true, nodeSource });
    expect(first.execPath).toBe(nodeSource);
    expect(fs.existsSync(path.join(installedDir(), 'node'))).toBe(false);
    expect(fs.existsSync(path.join(installedDir(), 'node.unrelocatable'))).toBe(true);
    // The marker must describe what is actually installed (no interpreter),
    // or every boot would re-copy ~100MB just to discover the same thing.
    const marker = fs.readFileSync(path.join(installedDir(), 'ptyd.version'), 'utf8');
    expect(marker).not.toMatch(/node-/);
    const before = fs.statSync(first.script).mtimeMs;
    const second = installPtydRuntime({ stateDir, daemonScript, installNode: true, nodeSource });
    expect(second.execPath).toBe(nodeSource);
    expect(fs.statSync(second.script).mtimeMs).toBe(before);
  });

  it('installNode: a different interpreter gets a fresh try after a fallback', () => {
    installPtydRuntime({ stateDir, daemonScript, installNode: true, nodeSource: fakeNode('exit 1') });
    // Same path, new bytes — like an app update shipping a self-contained node.
    const nodeSource = fakeNode('echo v2.0.0 && exit 0');
    const { execPath } = installPtydRuntime({ stateDir, daemonScript, installNode: true, nodeSource });
    expect(execPath).toBe(path.join(installedDir(), 'node'));
  });
});
