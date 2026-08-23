import { describe, expect, it } from 'vitest';
import { createTerminalManager } from '../../src/services/terminalManager';

// Use `cat` as a fake interactive program: it echoes stdin to stdout.
const catSpec = () => ({ file: 'cat', args: [] as string[] });

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

describe('terminalManager', () => {
  it('spawns, echoes input, and buffers output for replay', async () => {
    const tm = createTerminalManager(catSpec);
    const info = await tm.ensure('/wt/a', process.cwd());
    expect(info.status).toBe('running');
    expect(info.pid).toBeTypeOf('number');

    let received = '';
    const unsub = tm.subscribe('/wt/a', (d) => { received += d; });
    tm.write('/wt/a', 'hello\n');
    await waitFor(() => received.includes('hello'));
    unsub();

    // snapshot contains the buffered scrollback for a late attacher
    expect(tm.snapshot('/wt/a')).toContain('hello');
    tm.kill('/wt/a');
    await waitFor(() => tm.status('/wt/a').status === 'exited');
  });

  it('ensure() reuses a live session and respawns an exited one', async () => {
    const tm = createTerminalManager(catSpec);
    const first = await tm.ensure('/wt/b', process.cwd());
    const same = await tm.ensure('/wt/b', process.cwd());
    expect(same.pid).toBe(first.pid);

    tm.kill('/wt/b');
    await waitFor(() => tm.status('/wt/b').status === 'exited');
    const respawned = await tm.ensure('/wt/b', process.cwd());
    expect(respawned.status).toBe('running');
    expect(respawned.pid).not.toBe(first.pid);
    tm.kill('/wt/b');
  });

  it('resize does not throw on a live session', async () => {
    const tm = createTerminalManager(catSpec);
    await tm.ensure('/wt/c', process.cwd());
    expect(() => tm.resize('/wt/c', 120, 40)).not.toThrow();
    tm.kill('/wt/c');
  });

  it('killUnder kills sessions at or under a path prefix only', async () => {
    const tm = createTerminalManager(catSpec);
    await tm.ensure('/wt/keep', process.cwd());
    await tm.ensure('/wt/gone', process.cwd());
    await tm.ensure('/wt/gone/sub', process.cwd());

    tm.killUnder('/wt/gone');
    await waitFor(() => tm.status('/wt/gone').status === 'exited');
    await waitFor(() => tm.status('/wt/gone/sub').status === 'exited');
    expect(tm.status('/wt/keep').status).toBe('running');
    tm.kill('/wt/keep');
  });

  it('ensure() honours an explicit spawn-spec override', async () => {
    // Default buildSpec would launch `claude`; the override wins.
    const tm = createTerminalManager(() => ({ file: 'sh', args: ['-c', 'exit 0'] }));
    let received = '';
    const info = await tm.ensure('/wt/ov', process.cwd(), { file: 'cat', args: [] });
    expect(info.status).toBe('running');
    const unsub = tm.subscribe('/wt/ov', (d) => { received += d; });
    tm.write('/wt/ov', 'echoed\n');
    await waitFor(() => received.includes('echoed')); // proves `cat` (not the exiting sh) is running
    unsub();
    tm.kill('/wt/ov');
  });

  it('routes the built-in spec through wrapSpec when one is supplied', async () => {
    const seen: { cwd: string; spec: { file: string; args: string[] } }[] = [];
    const tm = createTerminalManager(
      () => ({ file: 'sh', args: ['-c', 'exit 0'] }),
      undefined,
      undefined,
      (cwd, spec) => {
        seen.push({ cwd, spec });
        return { file: 'cat', args: [] };
      },
    );
    let received = '';
    await tm.ensure('/wt/wrap1', process.cwd());
    const unsub = tm.subscribe('/wt/wrap1', (d) => { received += d; });
    tm.write('/wt/wrap1', 'echoed\n');
    await waitFor(() => received.includes('echoed')); // the wrapper's `cat`, not the exiting sh
    unsub();
    expect(seen).toEqual([{ cwd: process.cwd(), spec: { file: 'sh', args: ['-c', 'exit 0'] } }]);
    tm.kill('/wt/wrap1');
  });

  it('routes an explicit override through wrapSpec too', async () => {
    // The mode-specific specs (shell/codex/opencode) arrive as overrides — a
    // sandboxed worktree must not get an unsandboxed codex session.
    const seen: { cwd: string; spec: { file: string; args: string[] } }[] = [];
    const tm = createTerminalManager(
      () => ({ file: 'sh', args: ['-c', 'exit 0'] }),
      undefined,
      undefined,
      (cwd, spec) => {
        seen.push({ cwd, spec });
        return { file: 'cat', args: [] };
      },
    );
    let received = '';
    await tm.ensure('/wt/wrap2', process.cwd(), { file: 'sh', args: ['-c', 'exit 3'] });
    const unsub = tm.subscribe('/wt/wrap2', (d) => { received += d; });
    tm.write('/wt/wrap2', 'echoed\n');
    await waitFor(() => received.includes('echoed'));
    unsub();
    expect(seen).toEqual([{ cwd: process.cwd(), spec: { file: 'sh', args: ['-c', 'exit 3'] } }]);
    tm.kill('/wt/wrap2');
  });

  it('killUnder also kills a worktree session carrying a mode suffix', async () => {
    const tm = createTerminalManager(catSpec);
    await tm.ensure('/wt/x', process.cwd());                 // claude-mode key (bare path)
    await tm.ensure('/wt/x\u0000shell', process.cwd());      // shell-mode key (suffixed)

    tm.killUnder('/wt/x');
    await waitFor(() => tm.status('/wt/x').status === 'exited');
    await waitFor(() => tm.status('/wt/x\u0000shell').status === 'exited');
  });

  it('onExit fires with the real exit code', async () => {
    const tm = createTerminalManager(() => ({ file: 'sh', args: ['-c', 'exit 7'] }));
    await tm.ensure('/wt/exit7', process.cwd());
    let received: number | undefined;
    const unsub = tm.onExit('/wt/exit7', (code) => { received = code; });
    await waitFor(() => received !== undefined);
    expect(received).toBe(7);
    unsub();
  });

  it('invokes the constructor onExit hook with the session key on exit', async () => {
    const exited: string[] = [];
    const tm = createTerminalManager(() => ({ file: 'sh', args: ['-c', 'exit 0'] }), undefined, (key) => {
      exited.push(key);
    });
    await tm.ensure('/wt/hook', process.cwd());
    await waitFor(() => exited.includes('/wt/hook'));
    expect(exited).toContain('/wt/hook');
  });


  it('liveSessions lists running sessions with their mode, excluding exited', async () => {
    const tm = createTerminalManager(catSpec);
    await tm.ensure('/wt/p', process.cwd());                 // claude key
    await tm.ensure('/wt/p\u0000shell', process.cwd());      // shell key
    await tm.ensure('/wt/q', process.cwd());

    const live = tm.liveSessions().sort((a, b) => (a.path + a.mode).localeCompare(b.path + b.mode));
    expect(live).toEqual([
      { path: '/wt/p', mode: 'claude', id: '1' },
      { path: '/wt/p', mode: 'shell', id: '1' },
      { path: '/wt/q', mode: 'claude', id: '1' },
    ]);

    tm.kill('/wt/q');
    await waitFor(() => tm.status('/wt/q').status === 'exited');
    expect(tm.liveSessions().some((s) => s.path === '/wt/q')).toBe(false);

    tm.kill('/wt/p');
    tm.kill('/wt/p\u0000shell');
  });
});
