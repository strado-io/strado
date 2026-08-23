// Turning a host spawn spec into "run this inside the worktree's container".
//
// The PTY itself never moves: ptyd still spawns a process on the host, and
// that process is `podman exec`. Sessions therefore keep surviving server
// restarts and daemon upgrades exactly as before — the container is on the
// other side of the pty, not around it.

import type { BuildSpec, SpawnSpec, SpecWrapper } from '../terminalManager.js';
import type { SandboxRuntime } from './runtime.js';

/** Where the host hook socket is bind-mounted inside every sandbox — the
 * container side of `sandbox.create({ socketPath })`. Task 8 owns the host
 * end; this constant is the contract the two halves agree on. */
export const SANDBOX_SOCKET_PATH = '/run/strado/api.sock';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Session identity forwarded into the container. `--env KEY` (no value)
 * copies KEY from the exec client's environment — which is sessionEnv(),
 * because ptyd spawns THIS command with that env. Values never hit argv.
 *
 * Every key here is guaranteed to be set on a sandboxed spawn: sessionEnv
 * computes the four STRADO_* ones unconditionally, node-pty sets TERM, and
 * the generated script exports STRADO_SERVER_SOCKET itself (see below). */
const FORWARDED = [
  'STRADO_SESSION_ID',
  'STRADO_WORKTREE',
  'STRADO_STATUS_PORT',
  'STRADO_SERVER',
  'STRADO_SERVER_SOCKET',
  'TERM',
];

// Basenames we are willing to swap for the container's bash. A spec's `file`
// is a HOST path (defaultShell() — /bin/zsh on a Mac, $SHELL anywhere) and
// need not exist in the image, so the shell inside is always bash; the args
// carry over verbatim, which keeps `-l -c <cmd>` a command and `-il` an
// interactive shell without special-casing either.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);

/** The argv to run INSIDE the container.
 *
 * Deliberately NOT "lift the last arg": the shell-mode spec is `['-il']`
 * (routes/terminal.ts), and `bash -l -c '-il'` would run the flag as a
 * command. Substituting the interpreter and passing the args through handles
 * every shape the call sites produce. A spec whose file is not a shell names
 * a program the image is expected to have, so it runs verbatim rather than
 * being rewritten on a guess. */
function containerArgv(spec: SpawnSpec): string[] {
  const base = spec.file.split('/').pop() ?? spec.file;
  return SHELLS.has(base) ? ['bash', ...spec.args] : [spec.file, ...spec.args];
}

function wrap(rt: SandboxRuntime, slug: string, cwd: string, inner: SpawnSpec): SpawnSpec {
  const ctr = `strado-sbx-${slug}`;
  const envFlags = FORWARDED.map((k) => `--env ${k}`).join(' ');
  const innerCmd = containerArgv(inner).map(shq).join(' ');
  // The socket path is a property of being sandboxed, so the wrapper — not
  // sessionEnv — defines it: an unsandboxed session cannot inherit a var that
  // is only ever exported inside this script, and the host pty env stays
  // byte-for-byte what it is today.
  const socketEnv = `STRADO_SERVER_SOCKET=${shq(SANDBOX_SOCKET_PATH)}; export STRADO_SERVER_SOCKET;`;
  // start is idempotent: a parked (stopped) sandbox resumes on attach, and a
  // running one is a no-op. Its stdout is dropped — both runtimes echo the
  // container name, which is noise in the user's terminal — but its STDERR is
  // not: a resume that fails (a published port no longer free, a container
  // that was removed) has to be readable in the pty, or the session dies with
  // an empty screen and nothing to debug.
  //
  // What survives what: ptyd runs outside the container, so the DAEMON is
  // untouched by container stops, server restarts and its own upgrades. A
  // LIVE SESSION is not: the exec'd process dies with its container and the
  // pty exits; only the next attach brings it back, via the start above.
  // Parking a sandbox (Task 10) is therefore free only for worktrees with no
  // live session — it kills the agents running in the ones that have them.
  const script =
    `${socketEnv} ${rt.bin} start ${ctr} >/dev/null; ` +
    `exec ${rt.bin} exec -it ${envFlags} -w ${shq(cwd)} ${ctr} ${innerCmd}`;
  return { file: '/bin/sh', args: ['-c', script] };
}

export function sandboxBuildSpec(opts: {
  rt: SandboxRuntime;
  isSandboxed: (cwd: string) => string | null;
  inner: BuildSpec;
}): BuildSpec {
  return (cwd: string): SpawnSpec => {
    const slug = opts.isSandboxed(cwd);
    const inner = opts.inner(cwd);
    if (!slug) return inner;
    return wrap(opts.rt, slug, cwd, inner);
  };
}

/** The same wrapper as a spec-to-spec transform, for the managers: they
 * resolve `override ?? buildSpec(cwd)` first and hand the winner here, so a
 * mode-specific override (shell/codex/opencode) is sandboxed too. */
export function sandboxSpecWrapper(opts: {
  rt: SandboxRuntime;
  isSandboxed: (cwd: string) => string | null;
}): SpecWrapper {
  return (cwd, spec) => sandboxBuildSpec({ ...opts, inner: () => spec })(cwd);
}
