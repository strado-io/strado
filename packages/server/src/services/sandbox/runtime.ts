import { spawn } from 'node:child_process';

export type SandboxRuntime = { bin: 'podman' | 'docker' };
export type ExecFn = (
  file: string,
  args: string[],
  timeoutMs?: number,
  /** Every chunk of stdout/stderr as it arrives, for commands that run minutes. */
  onOutput?: (chunk: string) => void,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Keep the last 16 MB of each stream: a build log dwarfs execFile's 1 MB
// default and must not fail the command mid-build.
const MAX_CAPTURE = 16 * 1024 * 1024;

// Default 10s suits the fast control commands (--version, inspect, create,
// start, stop). Slow commands pass their own budget: an image build pulls a
// base image and runs `npm i -g`, which is minutes, not seconds — capping it
// at 10s silently kills every first build and degrades the worktree to
// unsandboxed. Spawn rather than execFile so a long command can report
// progress while it runs instead of being a silent spinner until exit.
export const realExec: ExecFn = (file, args, timeoutMs = 10_000, onOutput) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1, stdout: '', stderr: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const capture = (which: 'stdout' | 'stderr') => (buf: Buffer) => {
      const chunk = buf.toString();
      if (which === 'stdout') stdout = (stdout + chunk).slice(-MAX_CAPTURE);
      else stderr = (stderr + chunk).slice(-MAX_CAPTURE);
      try {
        onOutput?.(chunk);
      } catch {
        /* a reporter must never break the command */
      }
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || String(err.message) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // Say so: a build killed at its budget otherwise reads as a build error
        // with a truncated log, and the user chases the wrong thing.
        stderr = `${stderr}\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
      }
      resolve({ code: timedOut ? 1 : code ?? 1, stdout, stderr });
    });
  });

/** Podman first: rootless by default, which matches how the runner runs
 * (unprivileged, systemd --user). Never installs anything.
 *
 * `--version` only proves a binary is on PATH. `info` proves the runtime can
 * actually run containers for THIS user: docker without group membership and
 * rootless podman without subuid/subgid both pass the first and fail the
 * second, and treating them as present made every worktree create fail at
 * the image build and fall back to the host. */
export async function detectRuntime(
  exec: ExecFn = realExec,
  log: (line: string) => void = () => {},
): Promise<SandboxRuntime | null> {
  for (const bin of ['podman', 'docker'] as const) {
    try {
      const r = await exec(bin, ['--version']);
      if (r.code !== 0) continue;
      const info = await exec(bin, ['info'], 20_000);
      if (info.code === 0) return { bin };
      log(`${bin} is installed but cannot run containers for this user (skipping): ${info.stderr.trim().split('\n').pop() ?? `exit ${info.code}`}`);
    } catch { /* treat as absent */ }
  }
  return null;
}

/** Sandboxing is a runner feature, and the operator can switch it off with
 * STRADO_SANDBOX=0 in runner.env — a box with a working runtime that should
 * still run agents on the host. */
export function sandboxEnabled(runtime: SandboxRuntime | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return runtime !== null && env.STRADO_RUNNER === '1' && env.STRADO_SANDBOX !== '0';
}
