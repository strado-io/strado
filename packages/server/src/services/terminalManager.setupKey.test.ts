import { afterEach, describe, expect, it } from 'vitest';
import { SSH_SETUP_KEY_PREFIX } from './sshSetup/types.js';
import { createTerminalManager, isSetupKey, shellKey, spawnEnv, type TerminalManager } from './terminalManager.js';

// "Add over SSH" ptys belong to the setup job: not a tab, not an agent, and
// an ssh to another machine must carry none of this instance's identity.
const KEY = `${SSH_SETUP_KEY_PREFIX}job-1`;
let m: TerminalManager | null = null;
afterEach(() => { m?.kill(KEY); m?.killUnder('/'); m = null; });

const output = (mgr: TerminalManager, key: string, until: string) => new Promise<string>((resolve) => {
  let buf = mgr.snapshot(key);
  if (buf.includes(until)) return resolve(buf);
  const unsub = mgr.subscribe(key, (d) => { buf += d; if (buf.includes(until)) { unsub(); resolve(buf); } });
});

describe('ssh setup ptys', () => {
  it('isSetupKey matches only the prefix', () => {
    expect(isSetupKey(KEY)).toBe(true);
    expect(isSetupKey(shellKey('/tmp', '1'))).toBe(false);
    expect(isSetupKey('/tmp\0ssh-setup:x')).toBe(false);
  });

  it('spawn without the session env or the agent identity', async () => {
    process.env.STRADO_AGENT_TOKEN = 'outer-token';
    try {
      m = createTerminalManager(undefined, undefined, undefined, undefined, () => ({ STRADO_AGENT_ID: 'minted', STRADO_AGENT_TOKEN: 'minted-token' }));
      await m.ensure(KEY, '/tmp', { file: '/bin/sh', args: ['-c', 'echo "[$STRADO_AGENT_ID|$STRADO_AGENT_TOKEN|$STRADO_WORKTREE|$STRADO_SESSION_ID|${HOME:+home}]"; sleep 5'] });
      expect(await output(m, KEY, ']')).toContain('[||||home]');
    } finally {
      delete process.env.STRADO_AGENT_TOKEN;
    }
  });

  it('spawnEnv: a setup key sees only an allowlist of the user\'s env', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { OPENAI_API_KEY: 'sk-x', AWS_SECRET_ACCESS_KEY: 'y', SSH_AUTH_SOCK: '/tmp/agent.sock', LC_ALL: 'en_US.UTF-8', HOME: '/home/me' });
    try {
      const env = spawnEnv(KEY, '/tmp');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
      expect(env.LC_ALL).toBe('en_US.UTF-8');
      expect(env.HOME).toBe('/home/me');
      expect(Object.keys(env).every((k) => ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'SSH_AUTH_SOCK'].includes(k) || k.startsWith('LC_'))).toBe(true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('spawnEnv: every STRADO_* is dropped for a setup key; ordinary keys keep the session env', () => {
    process.env.STRADO_HOME = '/x';
    try {
      const setup = spawnEnv(KEY, '/tmp', () => ({ STRADO_AGENT_TOKEN: 't' }));
      expect(Object.keys(setup).filter((k) => k.startsWith('STRADO_'))).toEqual([]);
      const shell = spawnEnv(shellKey('/tmp', '1'), '/tmp', () => ({ STRADO_AGENT_TOKEN: 't' }));
      expect(shell.STRADO_AGENT_TOKEN).toBe('t');
      expect(shell.STRADO_WORKTREE).toBe('/tmp');
    } finally {
      delete process.env.STRADO_HOME;
    }
  });

  it('is never sandbox-wrapped and never a live session', async () => {
    const wrapped: string[] = [];
    m = createTerminalManager(undefined, undefined, undefined, (cwd, spec) => { wrapped.push(cwd); return spec; });
    await m.ensure(KEY, '/tmp', { file: '/bin/sh', args: ['-c', 'sleep 5'] });
    await m.ensure(shellKey('/tmp/wt', '1'), '/tmp/wt', { file: '/bin/sh', args: ['-c', 'sleep 5'] });
    expect(wrapped).toEqual(['/tmp/wt']);
    expect(m.status(KEY).status).toBe('running');
    expect(m.liveSessions()).toEqual([{ path: '/tmp/wt', mode: 'shell', id: '1' }]);
  });
});
