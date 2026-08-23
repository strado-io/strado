import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

// True when `pid` has at least one direct child — i.e. a command is running in
// that shell (idle shells at the prompt have no children). A heuristic (counts
// background jobs too), but good enough to warn before killing a busy shell.
export function hasChildProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (_err, stdout) => {
      resolve(!!(stdout && stdout.trim())); // pgrep exits 1 (no stdout) when none
    });
  });
}

// lsof can wedge: it may block on a stuck fd, or a helper child can inherit the
// stdout pipe and keep it open so Node's 'close' never fires. Either way the
// promise must still settle — otherwise a single hung lsof freezes the whole
// worktrees endpoint (the dashboard sits on "Loading…" forever). Normal runs
// settle on 'close' (full output); a hard timeout is the backstop that kills a
// wedged lsof and resolves with whatever was captured so far.
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_BYTES = 16 * 1024 * 1024; // stop reading runaway output

// `-b` makes lsof avoid kernel calls that can block indefinitely on a stuck fd
// (a dead NFS mount, a wedged socket); `-w` suppresses the warnings that mode
// emits. Without `-b`, a single hung fd on ANY scanned process wedges lsof
// forever, and since Node waits on the pipe the whole worktrees endpoint hangs.
const LSOF_SAFE = ['-b', '-w'];

function runLsofTolerant(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('lsof', [...LSOF_SAFE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(stdout);
    };
    // Backstop: even with -b, kill and settle if lsof somehow wedges or floods.
    const timer = setTimeout(finish, LSOF_TIMEOUT_MS);
    child.stdout.on('data', (b) => {
      stdout += b.toString();
      if (stdout.length > LSOF_MAX_BYTES) finish();
    });
    child.stderr.on('data', () => undefined);
    child.on('error', () => finish());
    child.on('close', () => finish());
  });
}

export type ExternalProcInfo = {
  pid: number;
  port: number;
};

// PIDs currently LISTENING on a TCP port (any interface).
export async function pidsOnPort(port: number): Promise<number[]> {
  const out = await runLsofTolerant(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const pids = new Set<number>();
  for (const line of out.split('\n')) {
    if (!line.startsWith('p')) continue;
    const pid = Number(line.slice(1));
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Process group of a pid (listeners are usually grandchildren of a managed
// shell; the shell is its group leader thanks to detached spawn).
export async function pgidOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-o', 'pgid=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const pgid = Number(out.trim());
      resolve(Number.isInteger(pgid) && pgid > 0 ? pgid : null);
    });
  });
}

// SIGTERM every listener on a port, escalate to SIGKILL, and wait until the
// socket is actually released so a follow-up bind cannot race EADDRINUSE.
export async function evictPortListeners(port: number): Promise<void> {
  let pids = (await pidsOnPort(port)).filter((pid) => pid !== process.pid);
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone or not ours to signal
    }
  }
  const deadline = Date.now() + 4_000;
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(250);
    pids = (await pidsOnPort(port)).filter((pid) => pid !== process.pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (pids.length > 0) await sleep(300); // give the kernel a beat to release the socket
}

export type ExternalProbeTarget = {
  worktreePath: string;
  projectSubdir: string | null;
};

export async function findExternalProcesses(
  targets: ExternalProbeTarget[],
  ourPids: Set<number>,
): Promise<Map<string, ExternalProcInfo>> {
  const result = new Map<string, ExternalProcInfo>();
  if (targets.length === 0) return result;
  const listenerOutput = await runLsofTolerant(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  if (!listenerOutput) return result;

  const listeners: ExternalProcInfo[] = [];
  let currentPid: number | null = null;
  for (const raw of listenerOutput.split('\n')) {
    if (!raw) continue;
    const tag = raw.charAt(0);
    const value = raw.slice(1);
    if (tag === 'p') {
      currentPid = Number(value);
    } else if (tag === 'n' && currentPid !== null) {
      const match = value.match(/:(\d+)$/);
      if (match && match[1]) {
        listeners.push({ pid: currentPid, port: Number(match[1]) });
      }
    }
  }

  const candidatePids = [...new Set(listeners.map((l) => l.pid))].filter(
    (pid) => !ourPids.has(pid),
  );

  if (candidatePids.length === 0) return result;

  const projectDirs = targets.map((t) => ({
    worktreePath: t.worktreePath,
    projectDir: t.projectSubdir ? path.join(t.worktreePath, t.projectSubdir) : t.worktreePath,
  }));

  // Resolve every candidate PID's open paths in ONE lsof call. Previously this
  // ran a separate `lsof -p <pid>` per listening process, sequentially, which
  // cost ~(number of listening processes on the machine) × lsof latency on
  // every worktrees fetch. `lsof -p` accepts a comma-separated PID list.
  const detail = await runLsofTolerant(['-p', candidatePids.join(','), '-nP', '-Fpn']);
  if (!detail) return result;

  const pathsByPid = new Map<number, string[]>();
  let cursorPid: number | null = null;
  for (const line of detail.split('\n')) {
    if (!line) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === 'p') {
      cursorPid = Number(value);
      if (!pathsByPid.has(cursorPid)) pathsByPid.set(cursorPid, []);
    } else if (tag === 'n' && cursorPid !== null) {
      pathsByPid.get(cursorPid)!.push(value);
    }
  }

  for (const pid of candidatePids) {
    const paths = pathsByPid.get(pid) ?? [];
    let matchedWorktree: string | null = null;
    for (const filePath of paths) {
      if (matchedWorktree) break;
      for (const { worktreePath, projectDir } of projectDirs) {
        if (filePath === projectDir || filePath.startsWith(projectDir + path.sep)) {
          matchedWorktree = worktreePath;
          break;
        }
      }
    }

    if (matchedWorktree && !result.has(matchedWorktree)) {
      const listener = listeners.find((l) => l.pid === pid);
      if (listener) result.set(matchedWorktree, listener);
    }
  }

  return result;
}
