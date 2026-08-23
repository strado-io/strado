import { execFile } from 'node:child_process';

export type SandboxRuntime = { bin: 'podman' | 'docker' };
export type ExecFn = (
  file: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Default 10s suits the fast control commands (--version, inspect, create,
// start, stop). Slow commands pass their own budget: an image build pulls a
// base image and runs `npm i -g`, which is minutes, not seconds — capping it
// at 10s silently kills every first build and degrades the worktree to
// unsandboxed. maxBuffer is 16 MB because a build log dwarfs execFile's 1 MB
// default and would otherwise error the command mid-build.
export const realExec: ExecFn = (file, args, timeoutMs = 10_000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code === 'ENOENT' ? 127 : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Podman first: rootless by default, which matches how the runner runs
 * (unprivileged, systemd --user). Never installs anything. */
export async function detectRuntime(exec: ExecFn = realExec): Promise<SandboxRuntime | null> {
  for (const bin of ['podman', 'docker'] as const) {
    try {
      const r = await exec(bin, ['--version']);
      if (r.code === 0) return { bin };
    } catch { /* treat as absent */ }
  }
  return null;
}

export function sandboxEnabled(runtime: SandboxRuntime | null): boolean {
  return runtime !== null && process.env.STRADO_RUNNER === '1';
}
