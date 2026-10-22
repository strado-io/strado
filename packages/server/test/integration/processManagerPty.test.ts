import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus';
import { createProcessManager, type ProcessManager } from '../../src/services/processManager';
import { createTerminalManager, runKey, type TerminalManager } from '../../src/services/terminalManager';

// Run in a real terminal: the start command lives in the worktree's run PTY
// (`<path>\0run`), which the hub shows as a tab; status, port and stop work as before.

let tmp: string;
let term: TerminalManager;
let pm: ProcessManager;
const KEY = '/path/run-a';

// Listens on $PORT from a CHILD of the shell, in a pipeline (its own process
// group under job control), and prints colour and a secret it got from the env.
const SERVER = `
const http = require('node:http');
const port = Number(process.env.PORT);
http.createServer((_q, r) => r.end('ok')).listen(port, '127.0.0.1', () => {
  console.log('\\x1b[32mready\\x1b[0m on http://localhost:' + port + ' token=' + process.env.API_TOKEN);
});
process.on('SIGINT', () => process.exit(130));
`;

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-pty-'));
  await fs.writeFile(path.join(tmp, 'server.js'), SERVER);
  await fs.writeFile(path.join(tmp, 'quiet.js'), "require('node:http').createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');");
  await fs.writeFile(path.join(tmp, 'crash.js'), 'console.log("boom"); process.exit(3);');
  term = createTerminalManager();
  pm = createProcessManager(createEventBus(), undefined, undefined, () => term);
});

afterEach(async () => {
  await pm.stop(KEY).catch(() => {});
  term.killUnder('/');
  await fs.rm(tmp, { recursive: true, force: true });
});

const start = (port: number, script = 'server.js', env: Record<string, string> = {}) =>
  pm.start({ key: KEY, cwd: tmp, command: '/bin/sh', args: ['-c', `node ${script} | cat`], env, port });

describe('process manager: the start command in a real terminal', () => {
  it('runs in the run PTY with the env on the spawn; a child in a pipeline still counts as ready on its port', async () => {
    const port = await freePort();
    await start(port, 'server.js', { API_TOKEN: 's3cret' });
    expect(pm.status(KEY)).toMatchObject({ status: 'starting', tab: 'run' });
    expect(term.status(runKey(KEY)).status).toBe('running');
    await waitFor(() => pm.status(KEY).status === 'running');
    expect(pm.status(KEY).port).toBe(port);
    // The env reached the program (PORT and the worktree env) without being typed.
    await waitFor(() => term.snapshot(runKey(KEY)).includes('token=s3cret'));
    expect(term.snapshot(runKey(KEY)).split('s3cret')).toHaveLength(2);
  });

  it('ready by its port alone, under job control (an interactive shell puts the job in its own process group)', async () => {
    const port = await freePort();
    await pm.start({ key: KEY, cwd: tmp, command: '/bin/sh', args: ['-ic', 'node quiet.js | cat'], env: {}, port });
    await waitFor(() => pm.status(KEY).status === 'running');
    expect(pm.status(KEY)).toMatchObject({ port, detectedUrl: null });
  });

  it('feeds the old log stream from the terminal, colour codes stripped; the URL is detected', async () => {
    const port = await freePort();
    await start(port);
    await waitFor(() => pm.snapshot(KEY).some((l) => l.includes('ready on')));
    const line = pm.snapshot(KEY).find((l) => l.includes('ready on'))!;
    expect(line).toBe(`ready on http://localhost:${port} token=undefined`);
    await waitFor(() => pm.status(KEY).detectedUrl !== null);
    expect(pm.status(KEY).detectedUrl).toBe(`http://localhost:${port}`);
  });

  it('Stop kills the run terminal and says stopped', async () => {
    await start(await freePort());
    await waitFor(() => pm.status(KEY).status === 'running');
    await pm.stop(KEY);
    expect(pm.status(KEY).status).toBe('stopped');
    await waitFor(() => term.status(runKey(KEY)).status === 'exited');
    expect(pm.isRunning(KEY)).toBe(false);
  });

  it('Ctrl-C typed in the tab stops it (stopped, not crashed)', async () => {
    await start(await freePort());
    await waitFor(() => pm.status(KEY).status === 'running');
    term.write(runKey(KEY), '\x03');
    await waitFor(() => !pm.isRunning(KEY));
    expect(pm.status(KEY).status).toBe('stopped');
  });

  it('a crash keeps its exit code, and the tab keeps its output', async () => {
    await pm.start({ key: KEY, cwd: tmp, command: '/bin/sh', args: ['-c', 'node crash.js'], env: {}, port: await freePort() });
    await waitFor(() => pm.status(KEY).status === 'crashed');
    expect(pm.status(KEY)).toMatchObject({ status: 'crashed', exitCode: 3, tab: 'run' });
    expect(pm.snapshot(KEY)).toContain('boom');
  });

  it('a run left over from before a restart (live PTY, idle manager) is replaced, not reused', async () => {
    await term.ensure(runKey(KEY), tmp, { file: '/bin/sh', args: ['-c', 'echo stale; sleep 30'] });
    const stalePid = term.status(runKey(KEY)).pid;
    const port = await freePort();
    await start(port);
    await waitFor(() => pm.status(KEY).status === 'running');
    expect(term.status(runKey(KEY)).pid).not.toBe(stalePid);
  });

  it('a second start while live is refused, as before', async () => {
    await start(await freePort());
    await expect(start(await freePort())).rejects.toMatchObject({ code: 'PROCESS_ALREADY_RUNNING' });
  });

  it('never a tab or agent: the run session is not a live session', async () => {
    await start(await freePort());
    expect(term.liveSessions()).toEqual([]);
  });
});

describe('several named runs in one worktree', () => {
  const API = `${KEY}\0run:api`;
  const events: Record<string, unknown>[] = [];
  const startApi = (script = 'echo api-up "[$PORT]"; sleep 30') =>
    pm.start({ key: API, worktree: KEY, runId: 'api', name: 'api', primary: false, cwd: tmp, command: '/bin/sh', args: ['-c', script], env: { DB: 'x' }, port: 0 });

  beforeEach(() => {
    events.length = 0;
    const bus = createEventBus();
    bus.on('worktrees', (e) => events.push(e.data as Record<string, unknown>));
    pm = createProcessManager(bus, undefined, undefined, () => term);
  });

  it('a second run gets its own terminal, alongside the default', async () => {
    const port = await freePort();
    await pm.start({ key: KEY, runId: 'dev', name: 'dev', cwd: tmp, command: '/bin/sh', args: ['-c', 'node server.js | cat'], env: {}, port });
    await startApi();
    expect(term.status(runKey(KEY)).status).toBe('running');
    expect(term.status(runKey(KEY, 'api')).status).toBe('running');
    await waitFor(() => pm.status(KEY).status === 'running');
    expect(pm.runs(KEY).map((r) => [r.runId, r.name, r.status])).toEqual([['dev', 'dev', 'running'], ['api', 'api', 'running']]);
    await pm.stop(API);
  });

  it('not the default: no PORT, no port, running as soon as it is up', async () => {
    await startApi();
    expect(pm.status(API)).toMatchObject({ status: 'running', port: null, runId: 'api', name: 'api', tab: 'run' });
    await waitFor(() => term.snapshot(runKey(KEY, 'api')).includes('api-up'));
    expect(term.snapshot(runKey(KEY, 'api'))).toContain('api-up []');
    await pm.stop(API);
    expect(pm.status(API).status).toBe('stopped');
  });

  it('its events name the worktree and carry it as `run`, never as the default `process`', async () => {
    await startApi();
    const mine = events.filter((e) => e.run);
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) expect(e).toMatchObject({ path: KEY, run: { runId: 'api', name: 'api' } });
    expect(events.some((e) => 'process' in e)).toBe(false);
    await pm.stop(API);
  });

  it('a non-zero exit is a crash; exit 0 is stopped', async () => {
    await startApi('exit 4');
    await waitFor(() => !pm.isRunning(API));
    expect(pm.status(API)).toMatchObject({ status: 'crashed', exitCode: 4 });
    await startApi('exit 0');
    await waitFor(() => !pm.isRunning(API));
    expect(pm.status(API).status).toBe('stopped');
  });

  it('stopAll ends every run of the worktree', async () => {
    await pm.start({ key: KEY, runId: 'dev', name: 'dev', cwd: tmp, command: '/bin/sh', args: ['-c', 'sleep 30'], env: {}, port: await freePort() });
    await startApi();
    await pm.stopAll(KEY);
    expect(pm.runs(KEY).every((r) => !['starting', 'running', 'stopping'].includes(r.status))).toBe(true);
  });
});

describe('after the run: the tab becomes a shell', () => {
  // A plain /bin/sh, no login: the test must not depend on the user's rc files.
  const SHELL = { file: '/bin/sh', args: [] as string[] };
  const run = (script: string, env: Record<string, string> = { SECRET: 'xyz' }) =>
    pm.start({ key: KEY, cwd: tmp, command: '/bin/sh', args: ['-c', script], env, port: 0, primary: false, worktree: KEY, runId: 'job', name: 'job', shell: SHELL });
  const PTY = () => runKey(KEY, 'job');
  const screen = () => term.snapshot(PTY());
  const typeAndSee = async (cmd: string, want: string) => {
    term.write(PTY(), `${cmd}\r`);
    await waitFor(() => screen().includes(want));
  };

  it('exit 0: the exit line, then a usable shell with none of the run env; status stopped', async () => {
    await run('echo the-run');
    await waitFor(() => pm.status(KEY).status === 'stopped');
    expect(pm.status(KEY)).toMatchObject({ exitCode: 0, tab: 'run' });
    expect(term.status(PTY()).status).toBe('running');
    await waitFor(() => screen().includes('[process exited with code 0]'));
    expect(screen()).toContain('the-run');
    await typeAndSee('echo "hi-[$SECRET]-[$PORT]"', 'hi-[]-[]');
    // The marker is an OSC escape a terminal never shows, and it is not in the run's log.
    // eslint-disable-next-line no-control-regex
    expect(screen().replace(/\x1b\][^\x07]*\x07/g, '')).not.toContain('strado-run-exit');
    expect(pm.snapshot(KEY).join('\n')).not.toContain('strado-run-exit');
  });

  it('a crash: crashed with its code, and still a shell', async () => {
    await run('echo boom; exit 3');
    await waitFor(() => pm.status(KEY).status === 'crashed');
    expect(pm.status(KEY).exitCode).toBe(3);
    await typeAndSee('echo after-crash', 'after-crash\r\n');
  });

  it('Stop ends the command but keeps the shell', async () => {
    await run('echo up; sleep 30');
    await waitFor(() => screen().includes('up'));
    await pm.stop(KEY);
    expect(pm.status(KEY).status).toBe('stopped');
    await typeAndSee('echo after-stop', 'after-stop\r\n');
  });

  it('Ctrl-C ends the command (stopped), the shell stays', async () => {
    await run('echo up; sleep 30');
    await waitFor(() => screen().includes('up'));
    term.write(PTY(), '\x03');
    await waitFor(() => !pm.isRunning(KEY));
    expect(pm.status(KEY).status).toBe('stopped');
    await typeAndSee('echo after-int', 'after-int\r\n');
  });

  it('Run again replaces the shell with a fresh run', async () => {
    await run('echo first');
    await waitFor(() => pm.status(KEY).status === 'stopped');
    const shellPid = term.status(PTY()).pid;
    await run('echo second; sleep 30');
    await waitFor(() => term.snapshot(PTY()).includes('second'));
    expect(term.status(PTY()).pid).not.toBe(shellPid);
    expect(pm.isRunning(KEY)).toBe(true);
  });

  it('busy: the post-run shell running something is busy; idle is not; a live run is not "the shell"', async () => {
    await run('echo first');
    await waitFor(() => pm.status(KEY).status === 'stopped');
    await waitFor(async () => (await pm.runTabBusy(KEY)) === false);
    term.write(PTY(), 'sleep 30\r');
    await waitFor(async () => (await pm.runTabBusy(KEY)) === true);
  });

  it('closing the tab kills the idle shell and forgets the tab; refused while the run is live', async () => {
    await run('sleep 30');
    expect(() => pm.closeTab(KEY)).toThrow(expect.objectContaining({ details: { reason: 'running' } }));
    await pm.stop(KEY);
    pm.closeTab(KEY);
    await waitFor(() => term.status(PTY()).status === 'exited');
    expect(pm.status(KEY).tab).toBeNull();
  });

  it('with no shell given (or a command not run by -c), the old way: the terminal ends with the run', async () => {
    await pm.start({ key: KEY, cwd: tmp, command: '/bin/sh', args: ['-c', 'echo x'], env: {}, port: 0, primary: false, worktree: KEY, runId: 'job', name: 'job' });
    await waitFor(() => term.status(PTY()).status === 'exited');
    expect(pm.status(KEY).status).toBe('stopped');
  });
});

describe('the run wrapper keeps any command intact (zsh and bash as the user shell)', () => {
  // Quotes, $VARS, &&, a trailing comment and a heredoc-ish newline: the
  // wrapper's own lines must still run after it (they are newline-separated).
  const COMMAND = `A="it's"; echo "q1:$A" && echo 'q2:$HOME-literal' && echo "q3:[$SECRET1][$SECRET2]" # trailing comment && echo nope`;
  for (const shellPath of ['/bin/zsh', '/bin/bash']) {
    it(`${shellPath}: the command's output, then the exit line and a shell with all the run env unset`, async () => {
      await pm.start({
        key: KEY, cwd: tmp, command: shellPath, args: ['-c', COMMAND], env: { SECRET1: 'one', SECRET2: 'two', PORT_X: '3' },
        port: 0, primary: false, worktree: KEY, runId: 'q', name: 'q', shell: { file: '/bin/sh', args: [] },
      });
      await waitFor(() => pm.status(KEY).status === 'stopped');
      const s = () => term.snapshot(runKey(KEY, 'q'));
      expect(s()).toContain("q1:it's");
      expect(s()).toContain('q2:$HOME-literal');
      expect(s()).toContain('q3:[one][two]');
      expect(s()).not.toContain('nope');
      await waitFor(() => s().includes('[process exited with code 0]'));
      term.write(runKey(KEY, 'q'), 'echo "after:[$SECRET1][$SECRET2][$PORT_X]"\r');
      await waitFor(() => s().includes('after:[][][]'));
    });
  }
});
