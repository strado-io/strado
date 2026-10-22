import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalManager, isRunKey, runKey, shellKey, type TerminalManager } from './terminalManager.js';

let m: TerminalManager | null = null;
afterEach(() => { m?.killUnder('/'); m = null; });

describe('createTerminalManager extraEnv', () => {
  it('merges extraEnv over sessionEnv for the spawned process', async () => {
    m = createTerminalManager(
      () => ({ file: '/bin/sh', args: ['-c', 'echo "$STRADO_AGENT_ID|$STRADO_WORKTREE"; sleep 5'] }),
      undefined, undefined, undefined,
      (key, cwd) => ({ STRADO_AGENT_ID: `id-for-${cwd.split('/').pop()}` }),
    );
    const key = shellKey('/tmp', '1');
    await m.ensure(key, '/tmp');
    const seen = await new Promise<string>((resolve) => {
      let buf = '';
      const unsub = m!.subscribe(key, (d) => { buf += d; if (buf.includes('\n')) { unsub(); resolve(buf); } });
      buf += m!.snapshot(key);
      if (buf.includes('\n')) { unsub(); resolve(buf); }
    });
    expect(seen).toContain('id-for-tmp|/tmp');
  });
});

describe('createTerminalManager: per-spawn env (the Run terminal)', () => {
  const output = (mgr: TerminalManager, key: string, until: string) => new Promise<string>((resolve) => {
    let buf = mgr.snapshot(key);
    if (buf.includes(until)) return resolve(buf);
    const unsub = mgr.subscribe(key, (d) => { buf += d; if (buf.includes(until)) { unsub(); resolve(buf); } });
  });

  it('ensure(…, { env }) sets the env on the spawn itself, over sessionEnv and extraEnv; nothing is typed', async () => {
    m = createTerminalManager(undefined, undefined, undefined, undefined, () => ({ API_TOKEN: 'from-extra', KEEP: 'kept' }));
    const key = runKey('/tmp');
    await m.ensure(key, '/tmp', { file: '/bin/sh', args: ['-c', 'echo "[$API_TOKEN|$PORT|$KEEP]"; sleep 5'] }, undefined, { env: { API_TOKEN: 's3cret', PORT: '4321' } });
    const seen = await output(m, key, ']');
    expect(seen).toContain('[s3cret|4321|kept]');
    // Only the program's own output: the value never appears as typed input.
    expect(seen.split('s3cret')).toHaveLength(2);
  });

  it('the wrapper is told which extra keys to forward (sandboxed worktrees)', async () => {
    const seen: (string[] | undefined)[] = [];
    m = createTerminalManager(undefined, undefined, undefined, (_cwd, spec, keys) => { seen.push(keys); return spec; });
    await m.ensure(runKey('/tmp'), '/tmp', { file: '/bin/sh', args: ['-c', 'sleep 5'] }, undefined, { env: { PORT: '1', DB_URL: 'x' } });
    await m.ensure(shellKey('/tmp', '1'), '/tmp', { file: '/bin/sh', args: ['-c', 'sleep 5'] });
    expect(seen).toEqual([['PORT', 'DB_URL'], undefined]);
  });

  it('a run session is not a live session: no tab, no agent', async () => {
    m = createTerminalManager();
    await m.ensure(runKey('/tmp/wt'), '/tmp/wt', { file: '/bin/sh', args: ['-c', 'sleep 5'] });
    await m.ensure(shellKey('/tmp/wt', '1'), '/tmp/wt', { file: '/bin/sh', args: ['-c', 'sleep 5'] });
    expect(m.liveSessions()).toEqual([{ path: '/tmp/wt', mode: 'shell', id: '1' }]);
    expect(m.status(runKey('/tmp/wt')).status).toBe('running');
  });

  it('runKey / isRunKey', () => {
    expect(runKey('/a/b')).toBe('/a/b\0run');
    expect(isRunKey(runKey('/a/b'))).toBe(true);
    expect(isRunKey(shellKey('/a/b', '1'))).toBe(false);
    expect(isRunKey('/a/b')).toBe(false);
    expect(runKey('/a/b', 'api')).toBe('/a/b\0run:api');
    expect(isRunKey(runKey('/a/b', 'api'))).toBe(true);
  });
});
