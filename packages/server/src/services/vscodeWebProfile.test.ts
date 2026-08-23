// Boot-order regression guard. The profile must be applied to process.env
// BEFORE any module that reads STRADO_HOME is evaluated. vscodeWeb.ts builds a
// manager at module load which captures daemonFilePath() immediately, so an
// import that happens too early silently pins the STABLE path.
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFreePort } from './serveWebProcess.js';

const original = process.env.STRADO_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = original;
  vi.resetModules();
});

describe('serve-web daemon file follows the active profile', () => {
  // Cheap sanity check on serveWebProcess.ts's path expression in isolation.
  // NOTE: this does not exercise vscodeWeb.ts or index.ts's import order at
  // all, so on its own it cannot catch the boot-order defect below — it only
  // confirms daemonFilePath() reads STRADO_HOME correctly *whenever* it is
  // called. Kept as a fast, direct regression guard on that one expression;
  // the real guard against the ordering bug is the subprocess test below.
  it('resolves under STRADO_HOME when set before import', async () => {
    process.env.STRADO_HOME = '/tmp/profile-boot-dev';
    const { daemonFilePath } = await import('./serveWebProcess.js');
    expect(daemonFilePath()).toBe(path.join('/tmp/profile-boot-dev', 'serve-web-daemons.json'));
  });
});

// ── Real boot-order test ────────────────────────────────────────────────────
// The defect here was never a wrong path expression — it was WHEN the path is
// read, across module evaluation order. No in-process test of a pure function
// can observe that: importing serveWebProcess.js directly (above) can only
// prove the expression is correct, not that index.ts evaluates its imports in
// the right order. So this test boots the real server entrypoint as a child
// process via tsx (avoiding a dependency on `dist/` being freshly built — see
// the root `dev:server` script, which does the same) and asserts where the
// daemon file actually lands.
//
// Deliberately does NOT set STRADO_HOME on the child. In production the bug
// was triggered by STRADO_HOME being *unset* going in and computed only at
// runtime by applyProfileEnv() inside index.ts — if this test instead handed
// the child a STRADO_HOME env var directly, that value would already be in
// process.env before a single line of JS runs (Node populates process.env at
// process start, ahead of any module evaluation), so even the broken
// static-import ordering would read it correctly and the test would not
// discriminate (confirmed by hand: reverting index.ts to static imports and
// presetting STRADO_HOME still wrote the file to the right place). Instead,
// only STRADO_PROFILE=dev is set, and HOME points at an isolated temp dir so
// resolveProfile()/applyProfileEnv() compute STRADO_HOME themselves — same as
// a real dev launch, where os.homedir() falls back to the real user's home.
// That leaves a real gap for the ordering bug to fall into: a static import
// of vscodeWeb.js would still see STRADO_HOME unset and capture
// `<HOME>/.strado` (the stable-shaped sibling) before index.ts ever assigns
// the dev path.
describe('server boot places the daemon file under the active profile (real process)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../../../..');
  const serverDir = path.resolve(__dirname, '../..');
  const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const entry = path.join(serverDir, 'src/index.ts');

  let fakeHome: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child) await stopChild(child);
    child = undefined;
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
    fakeHome = undefined;
  });

  function stopChild(proc: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const forceKill = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5_000);
      proc.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  async function waitForFile(file: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(file)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${file} to appear`);
  }

  it(
    'creates serve-web-daemons.json under the dev profile home, never under the stable-shaped sibling',
    async () => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-boot-'));
      // OS-assigned free port — never a fixed one, so this never collides
      // with 7777/7877 (the real stable/dev defaults) or anything else on
      // the machine.
      const port = await findFreePort();

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        STRADO_PROFILE: 'dev',
        HOME: fakeHome,
        PORT: String(port),
      };
      delete childEnv.STRADO_HOME;
      delete childEnv.STRADO_CONFIG_DIR;

      let output = '';
      child = spawn(process.execPath, [tsxCli, entry], {
        cwd: repoRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (d) => { output += d.toString(); });
      child.stderr?.on('data', (d) => { output += d.toString(); });

      const devDaemonFile = path.join(fakeHome, '.strado-dev', 'serve-web-daemons.json');
      const stableShapedDaemonFile = path.join(fakeHome, '.strado', 'serve-web-daemons.json');

      try {
        await waitForFile(devDaemonFile, 15_000);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- child stdout/stderr ---\n${output}`);
      }

      expect(fs.existsSync(devDaemonFile)).toBe(true);
      expect(fs.existsSync(stableShapedDaemonFile)).toBe(false);
    },
    20_000,
  );
});
