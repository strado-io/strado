import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalManager, shellKey, type TerminalManager } from './terminalManager.js';

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
