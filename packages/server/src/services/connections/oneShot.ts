// One short-lived container from the sandbox image, the way writeHomeVolume
// runs one: same user mapping as a real sandbox, optionally on the shared HOME
// volume. Used by the connection checks, device logins and disconnects.
//
// Killing a `podman run` client does not stop its container, so every run is
// named, the command inside is wrapped in `timeout -s KILL`, and a run that
// does not exit 0 is followed by a best-effort `rm -f` of that name.
//
// Secrets travel on stdin only: argv shows up in `ps`, and even a name-only
// `-e VAR` is stored in the container config that `inspect` prints.
import { randomBytes } from 'node:crypto';
import type { ExecFn, SandboxRuntime } from '../sandbox/runtime.js';
import { HOME_VOLUME } from '../sandbox/sandboxes.js';

export type OneShotDeps = { rt: SandboxRuntime; exec: ExecFn; image: string; userArgs: string[] };

export type OneShotSpec = {
  /** Mount the shared sandbox HOME volume at /home/node. */
  volume: boolean;
  cmd: string[];
  /** Hard limit for the command inside the container. */
  timeoutMs: number;
  input?: string;
  onOutput?: (chunk: string) => void;
  /** Overrides the generated container name (tests, cancel by name). */
  name?: string;
};

export const containerName = () => `strado-conn-${randomBytes(6).toString('hex')}`;

export function oneShotArgs(deps: OneShotDeps, spec: OneShotSpec, name: string): string[] {
  const secs = Math.max(1, Math.ceil(spec.timeoutMs / 1000));
  return [
    'run', '--rm', '-i',
    '--name', name,
    ...deps.userArgs,
    '-e', 'HOME=/home/node',
    ...(spec.volume ? ['-v', `${HOME_VOLUME}:/home/node`] : []),
    deps.image,
    'timeout', '-s', 'KILL', String(secs),
    ...spec.cmd,
  ];
}

export async function removeContainer(deps: Pick<OneShotDeps, 'rt' | 'exec'>, name: string): Promise<void> {
  try {
    await deps.exec(deps.rt.bin, ['rm', '-f', name], 15_000);
  } catch {
    /* best effort */
  }
}

export async function runOneShot(
  deps: OneShotDeps,
  spec: OneShotSpec,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const name = spec.name ?? containerName();
  // The outer budget adds room for a first keep-id run's layer copy-up.
  const outer = spec.timeoutMs + 3 * 60_000;
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await deps.exec(deps.rt.bin, oneShotArgs(deps, spec, name), outer, spec.onOutput, spec.input);
  } catch {
    r = { code: 1, stdout: '', stderr: '' };
  }
  if (r.code !== 0) await removeContainer(deps, name);
  return r;
}

// CSI and OSC sequences, then the bare carriage returns spinners use.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
