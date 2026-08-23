import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnPty, adoptFromFd } from '../src/pty.js';

const SH = '/bin/sh';
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * The child-process adopt tests must load the same module the daemon ships,
 * from a real subprocess — so they import the tsc output, not the TS source.
 */
const DIST_PTY = path.resolve(here, '../dist/src/pty.js');
const DIST_PTY_URL = pathToFileURL(DIST_PTY).href;

function requireDist(): void {
  expect(
    fs.existsSync(DIST_PTY),
    `missing ${DIST_PTY} — run \`npm run build -w packages/ptyd\` before this test ` +
      `(the tsc step emits dist/src/, which the child process imports)`,
  ).toBe(true);

  const srcPath = path.resolve(here, '../src/pty.ts');
  if (fs.statSync(DIST_PTY).mtimeMs < fs.statSync(srcPath).mtimeMs) {
    throw new Error(`stale build: ${DIST_PTY} is older than src/pty.ts — run: npm run build -w packages/ptyd`);
  }
}

function collect(pty: ReturnType<typeof spawnPty>): { data: () => Buffer } {
  const chunks: Buffer[] = [];
  pty.onData((c) => chunks.push(c));
  return { data: () => Buffer.concat(chunks) };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('spawnPty', () => {
  it('spawns, echoes raw bytes, exits', async () => {
    const pty = spawnPty({ shell: SH, argv: ['-c', 'printf hello'], cwd: '/tmp', cols: 80, rows: 24 });
    expect(pty.pid).toBeGreaterThan(0);
    const out = collect(pty);
    let exit: number | null | undefined;
    pty.onExit((code) => { exit = code; });
    await waitFor(() => exit !== undefined);
    expect(out.data().toString()).toContain('hello');
    expect(exit).toBe(0);
  });

  it('rejects a missing cwd with a readable error', () => {
    expect(() =>
      spawnPty({ shell: SH, argv: ['-c', ':'], cwd: '/nonexistent-strado-test', cols: 80, rows: 24 }),
    ).toThrow(/cwd does not exist/);
  });

  it('rejects invalid dims', () => {
    expect(() =>
      spawnPty({ shell: SH, argv: ['-c', ':'], cwd: '/tmp', cols: 0, rows: 24 }),
    ).toThrow(/invalid cols/);
  });

  it('kill() ends a plain shell', async () => {
    const pty = spawnPty({ shell: SH, argv: ['-i'], cwd: '/tmp', cols: 80, rows: 24 });
    let exited = false;
    pty.onExit(() => { exited = true; });
    pty.kill();
    await waitFor(() => exited);
  });

  it('kill() escalates to SIGKILL for a SIGHUP-trapping process', async () => {
    const pty = spawnPty({
      shell: SH,
      argv: ['-c', 'trap "" HUP; sleep 60'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });
    let exited = false;
    pty.onExit(() => { exited = true; });
    // Give the trap a moment to install before signalling.
    await new Promise((r) => setTimeout(r, 200));
    pty.kill();
    await waitFor(() => exited, 8000); // 2s grace + margin
  }, 10000);

  it('resize after exit is a safe no-op', async () => {
    const pty = spawnPty({ shell: SH, argv: ['-c', ':'], cwd: '/tmp', cols: 80, rows: 24 });
    let exited = false;
    pty.onExit(() => { exited = true; });
    await waitFor(() => exited);
    expect(() => pty.resize(100, 30)).not.toThrow();
  });
});

describe('getMasterFd', () => {
  it('exposes a real master fd on spawned ptys', async () => {
    const pty = spawnPty({ shell: SH, argv: ['-c', 'sleep 5'], cwd: '/tmp', cols: 80, rows: 24 });
    const fd = pty.getMasterFd();
    expect(Number.isInteger(fd)).toBe(true);
    expect(fd).toBeGreaterThanOrEqual(0);
    pty.killNow();
  });
});

describe('adoptFromFd', () => {
  it('rejects invalid inputs and closes nothing it does not own', () => {
    expect(() => adoptFromFd({ fd: -1, pid: 123, cols: 80, rows: 24 })).toThrow(/invalid fd/);
  });

  // The production topology: the master fd reaches the adopter through
  // child-process stdio inheritance, so the adopter is a SEPARATE process.
  // Both processes share one open file description, so the parent must
  // pause() its own reader before the handoff and stay paused until the
  // child is done — otherwise the two readers race for the same bytes.
  // Linux: this fixture keeps the PARENT alive with its (paused) node-pty
  // reader on the shared description, which starves the child's reads —
  // verified on Ubuntu 24.04: the same child with the parent exited (the
  // real handoff shape) drives the pty perfectly. Production coverage on
  // Linux comes from handoff.test.ts, which passes there. macOS (kqueue)
  // doesn't starve, so the fixture stays as extra coverage here.
  it.skipIf(process.platform === 'linux')('adoptFromFd drives a pty inherited via stdio (production topology)', async () => {
    requireDist();
    const spawned = spawnPty({ shell: SH, argv: ['-c', 'cat'], cwd: '/tmp', cols: 80, rows: 24 });
    spawned.pause(); // stop OUR reader consuming; the child owns the fd now
    const childScript = `
      import { adoptFromFd } from ${JSON.stringify(DIST_PTY_URL)};
      const pid = Number(process.argv[2]);
      const adopted = adoptFromFd({ fd: 3, pid, cols: 80, rows: 24 });
      let seen = '';
      let exiting = false;
      adopted.onData((c) => { process.stdout.write(c); seen += c.toString(); if (!exiting && seen.includes('through-child')) { exiting = true; setTimeout(() => process.exit(0), 50); } });
      adopted.write(Buffer.from('through-child\\n'));
      setTimeout(() => process.exit(1), 10000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, 'child', String(spawned.pid)], {
      stdio: ['ignore', 'pipe', 'inherit', spawned.getMasterFd()],
    });
    const out: Buffer[] = [];
    child.stdout!.on('data', (c) => out.push(c));
    await waitFor(() => Buffer.concat(out).toString().includes('through-child'), 12000);
    await new Promise<void>((r) => child.once('exit', () => r()));
    // The child exiting closed ITS fd copy; ours is still alive and owns the shell.
    spawned.resume();
    let exited = false;
    spawned.onExit(() => { exited = true; });
    spawned.kill();
    await waitFor(() => exited, 8000);
  }, 20000);

  it('closeLocal releases the fd copy without signaling the shell', async () => {
    requireDist();
    const spawned = spawnPty({ shell: SH, argv: ['-c', 'cat'], cwd: '/tmp', cols: 80, rows: 24 });
    spawned.pause();
    const childScript = `
      import { adoptFromFd } from ${JSON.stringify(DIST_PTY_URL)};
      const adopted = adoptFromFd({ fd: 3, pid: Number(process.argv[2]), cols: 80, rows: 24 });
      adopted.closeLocal();
      process.exit(0);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, 'child', String(spawned.pid)], {
      stdio: ['ignore', 'ignore', 'inherit', spawned.getMasterFd()],
    });
    await new Promise<void>((r) => child.once('exit', () => r()));
    // Shell must still be alive and interactive through OUR copy.
    spawned.resume();
    const chunks: Buffer[] = [];
    spawned.onData((c) => chunks.push(c));
    spawned.write(Buffer.from('still-alive\n'));
    await waitFor(() => Buffer.concat(chunks).toString().includes('still-alive'), 8000);
    spawned.killNow();
  }, 15000);
});
