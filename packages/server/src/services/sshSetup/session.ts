import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import type { SpawnSpec } from '../terminalManager.js';

// One ssh connection for a setup run: the user's own `ssh` (their config,
// agent, keys, known_hosts), multiplexed over a ControlMaster. The master is
// opened interactively in a pty (password, MFA, host-key prompt); everything
// after rides it in BatchMode. The job builds every argv here; nothing the
// renderer sends reaches a command line except the validated destination.

/** Never let the user's config hand our agent or a local command to the box. */
const SAFE = ['-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no'];

export type Destination = { target: string; port: number | null };

const BAD = 'not an ssh destination';
// user@host or an ssh-config alias: no leading '-', no whitespace, no shell
// or control characters. ssh gets it after '--' anyway; this keeps it plain.
const TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._:[\]%-]+$/;

export function parseDestination(raw: string): Destination {
  const s = raw.trim();
  let target = s;
  let port: number | null = null;
  if (s.startsWith('ssh://')) {
    const m = /^ssh:\/\/([^/:]+)(?::(\d+))?$/.exec(s);
    if (!m) throw new Error(BAD);
    target = m[1]!;
    if (m[2] !== undefined) {
      port = Number(m[2]);
      if (port < 1 || port > 65535) throw new Error(BAD);
    }
  }
  if (!target || target.length > 255 || target.startsWith('-') || !TARGET.test(target)) throw new Error(BAD);
  if (target.includes('@-')) throw new Error(BAD); // a host that reads as an option
  return { target, port };
}

/** One word for a POSIX shell: single-quoted, embedded quotes escaped. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecFn = (
  file: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number; onStdout?: (chunk: string) => void },
) => Promise<ExecResult>;

/** argv only, no shell; stdin written and closed; never rejects (code 255-ish on spawn failure). */
export const realExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.stdout.on('data', (d: Buffer) => { const t = d.toString(); stdout += t; opts.onStdout?.(t); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', () => { if (timer) clearTimeout(timer); resolve({ code: 255, stdout, stderr }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 255, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });

export type SshSession = {
  controlDir: string;
  /** The interactive master, for the pty: prompts happen there, once. */
  connectSpec(): SpawnSpec;
  /** A command that needs a terminal (sudo), over the master, for the pty. */
  ttySpec(script: string): SpawnSpec;
  /** A script over the master in BatchMode: `sh -c <script>`, params on stdin. */
  run(script: string, stdin?: string, onLine?: (line: string) => void, timeoutMs?: number): Promise<ExecResult>;
  /** A remote argv over the master, each word quoted; secrets go on stdin. */
  exec(argv: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult>;
  /** `ssh -O exit` on the master and remove the control dir. Idempotent. */
  close(): Promise<void>;
};

export async function openSession(dest: Destination, deps: { exec?: ExecFn } = {}): Promise<SshSession> {
  const exec = deps.exec ?? realExec;
  const portArgs = dest.port ? ['-p', String(dest.port)] : [];
  // Let ssh itself say whether the name means anything (aliases included).
  const resolved = await exec('ssh', ['-G', ...portArgs, '--', dest.target], { timeoutMs: 5_000 });
  if (resolved.code !== 0) throw new Error('ssh cannot resolve that destination');

  // Short and 0700: a unix socket path is capped at 104 bytes on macOS, and
  // $TMPDIR there is too long.
  const controlDir = await fsp.mkdtemp('/tmp/strado-ssh-');
  await fsp.chmod(controlDir, 0o700);
  const controlPath = `${controlDir}/cm`;
  const over = [...SAFE, '-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', ...portArgs];
  let closed = false;

  const lineSplitter = (onLine?: (line: string) => void) => {
    if (!onLine) return undefined;
    let rest = '';
    return (chunk: string) => {
      rest += chunk;
      const parts = rest.split('\n');
      rest = parts.pop()!;
      for (const p of parts) if (p.trim()) onLine(p.replace(/\r$/, ''));
    };
  };

  return {
    controlDir,
    connectSpec: () => ({
      file: 'ssh',
      // 300s, not shorter: the idle clock runs while a question waits on the
      // person, and close() ends the master with `-O exit` when the run ends.
      args: [
        ...SAFE, '-o', 'ControlMaster=yes', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=300',
        '-o', 'ServerAliveInterval=15', ...portArgs, '--', dest.target, 'true',
      ],
    }),
    ttySpec: (script) => ({
      file: 'ssh',
      args: [...SAFE, '-t', '-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', ...portArgs, '--', dest.target, `sh -c ${shQuote(script)}`],
    }),
    run: (script, stdin, onLine, timeoutMs) =>
      exec('ssh', [...over, '--', dest.target, `sh -c ${shQuote(script)}`], { stdin, timeoutMs, onStdout: lineSplitter(onLine) }),
    exec: (argv, stdin, timeoutMs) =>
      exec('ssh', [...over, '--', dest.target, argv.map(shQuote).join(' ')], { stdin, timeoutMs }),
    async close() {
      if (closed) return;
      closed = true;
      await exec('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', ...portArgs, '--', dest.target], { timeoutMs: 5_000 });
      await fsp.rm(controlDir, { recursive: true, force: true });
    },
  };
}
