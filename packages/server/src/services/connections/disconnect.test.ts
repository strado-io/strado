import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realExec, type ExecFn } from '../sandbox/runtime.js';
import type { RunnerAgentLogins } from '../agentLogins/runnerStore.js';
import { disconnectAgent } from './disconnect.js';

const rt = { bin: 'podman' as const };
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-disc-'));
});

/** Runs the in-container script with plain node against the temp HOME. */
function localRunner() {
  const calls: { args: string[]; input?: string }[] = [];
  const exec: ExecFn = async (_f, args, _t, _o, input) => {
    calls.push({ args, input });
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
    const cmd = args.slice(args.indexOf('img') + 5);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      return await realExec(process.execPath, cmd.slice(1), 10_000, undefined, input);
    } finally {
      process.env.HOME = prev;
    }
  };
  return { calls, exec };
}

function memStore(initial: RunnerAgentLogins) {
  let cur = initial;
  return {
    get: () => cur,
    readStore: async () => cur,
    writeStore: async (next: RunnerAgentLogins) => {
      cur = JSON.parse(JSON.stringify(next));
    },
  };
}

const put = (rel: string, v: unknown) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), JSON.stringify(v));
};
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));

const or = { type: 'oauth' as const, access: 'sk-or-SECRET', refresh: '' as const, expires: 9 };

describe('disconnect', () => {
  it('claude clears only the stored token, with no container', async () => {
    const { calls, exec } = localRunner();
    const store = memStore({ lastIssuedAt: 5, claudeToken: 'sk-ant-oat01-x', volume: { codex: { apiKey: 'k' } } });
    await disconnectAgent('claude', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(store.get()).toEqual({ lastIssuedAt: 5, volume: { codex: { apiKey: 'k' } }, disconnected: ['claude'], changedAt: { claude: expect.any(Number) } });
    expect(calls).toHaveLength(0);
  });

  it('codex removes a synced auth.json from the volume and the store', async () => {
    put('.codex/auth.json', { auth_mode: 'apikey', OPENAI_API_KEY: 'k' });
    const { exec } = localRunner();
    const store = memStore({ claudeToken: 't', volume: { codex: { apiKey: 'k' } } });
    await disconnectAgent('codex', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(fs.existsSync(path.join(home, '.codex/auth.json'))).toBe(false);
    expect(store.get()).toEqual({ claudeToken: 't', volume: {}, managed: {}, disconnected: ['codex'], changedAt: { codex: expect.any(Number) } });
  });

  it('codex removes a login a Connect made, and clears the record', async () => {
    put('.codex/auth.json', { tokens: { refresh_token: 'r' } });
    const { exec } = localRunner();
    const store = memStore({ managed: { codex: true, opencode: ['openai'] } });
    await disconnectAgent('codex', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(fs.existsSync(path.join(home, '.codex/auth.json'))).toBe(false);
    expect(store.get().managed).toEqual({ opencode: ['openai'] });
  });

  it('codex leaves a login made by hand: no container runs', async () => {
    put('.codex/auth.json', { tokens: { refresh_token: 'r' } });
    const { calls, exec } = localRunner();
    await disconnectAgent('codex', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...memStore({}) });
    expect(fs.existsSync(path.join(home, '.codex/auth.json'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('opencode removes a Connect-made login by id, whatever it now holds', async () => {
    put('.local/share/opencode/auth.json', {
      openai: { type: 'oauth', access: 'refreshed', refresh: 'r2', expires: 5 },
      anthropic: { type: 'api', key: 'by-hand' },
    });
    const { exec } = localRunner();
    const store = memStore({ managed: { opencode: ['openai'] } });
    await disconnectAgent('opencode', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(read('.local/share/opencode/auth.json')).toEqual({ anthropic: { type: 'api', key: 'by-hand' } });
    expect(store.get().managed).toEqual({});
  });

  it('opencode removes only the synced entries that still match, secrets on stdin only', async () => {
    put('.local/share/opencode/auth.json', {
      anthropic: { type: 'api', key: 'synced-key' },
      openrouter: { type: 'api', key: 'changed-on-runner' },
      openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    });
    const { calls, exec } = localRunner();
    const store = memStore({
      volume: {
        opencode: { providers: { anthropic: { type: 'api', key: 'synced-key' }, openrouter: { type: 'api', key: 'old' } } },
      },
    });
    await disconnectAgent('opencode', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(read('.local/share/opencode/auth.json')).toEqual({
      openrouter: { type: 'api', key: 'changed-on-runner' },
      openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    });
    expect(store.get().volume?.opencode).toBeUndefined();
    expect(calls[0]!.args.join(' ')).not.toContain('synced-key');
    expect(calls[0]!.input).toContain('synced-key');
  });

  it('pi removes the synced static entry and keeps a login made on the runner', async () => {
    put('.pi/agent/auth.json', { openrouter: or, google: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    const { exec } = localRunner();
    const store = memStore({ volume: { pi: { providers: { openrouter: or } } } });
    await disconnectAgent('pi', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(read('.pi/agent/auth.json')).toEqual({ google: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
    expect(fs.statSync(path.join(home, '.pi/agent/auth.json')).mode & 0o777).toBe(0o600);
  });

  it('a missing file is fine', async () => {
    const { exec } = localRunner();
    const store = memStore({ volume: { pi: { providers: { openrouter: or } } } });
    await disconnectAgent('pi', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store });
    expect(store.get().volume?.pi).toBeUndefined();
  });

  it('an unreadable file fails and the store keeps what to remove', async () => {
    fs.mkdirSync(path.join(home, '.pi/agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi/agent/auth.json'), '{half');
    const { exec } = localRunner();
    const store = memStore({ volume: { pi: { providers: { openrouter: or } } } });
    await expect(
      disconnectAgent('pi', { oneShot: { rt, exec, image: 'img', userArgs: [] }, ...store }),
    ).rejects.toThrow('disconnect failed');
    expect(store.get().volume?.pi).toEqual({ providers: { openrouter: or } });
  });

  it('no image yet: only the store changes', async () => {
    const store = memStore({ volume: { codex: { apiKey: 'k' } } });
    await disconnectAgent('codex', { oneShot: null, ...store });
    expect(store.get()).toEqual({ volume: {}, managed: {}, disconnected: ['codex'], changedAt: { codex: expect.any(Number) } });
  });

  it('every disconnect is recorded once, so a sync skips the agent', async () => {
    const store = memStore({ disconnected: ['pi'] });
    await disconnectAgent('claude', { oneShot: null, ...store });
    await disconnectAgent('claude', { oneShot: null, ...store });
    await disconnectAgent('pi', { oneShot: null, ...store });
    expect(store.get().disconnected).toEqual(['pi', 'claude']);
  });
});
