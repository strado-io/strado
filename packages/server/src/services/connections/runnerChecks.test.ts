import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realExec, type ExecFn } from '../sandbox/runtime.js';
import { checkAgent, type CheckDeps } from './runnerChecks.js';

const rt = { bin: 'podman' as const };
const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRETSECRET';

type Call = { file: string; args: string[]; input?: string };
type Reply = { code: number; stdout?: string; stderr?: string };

/** Fake runtime: `run` gets the scripted reply, `rm` always succeeds. */
function fake(reply: Reply | ((c: Call) => Reply | Promise<Reply>)) {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, _t, _o, input) => {
    const c = { file, args, input };
    calls.push(c);
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
    const r = typeof reply === 'function' ? await reply(c) : reply;
    return { stdout: '', stderr: '', ...r };
  };
  return { calls, exec };
}

const deps = (exec: ExecFn, token: string | null = TOKEN): CheckDeps => ({
  rt, exec, image: 'img:1', userArgs: ['--userns=keep-id'], readClaudeToken: async () => token,
});
const runs = (calls: Call[]) => calls.filter((c) => c.args[0] === 'run');
const cmdOf = (c: Call) => c.args.slice(c.args.indexOf('img:1') + 1);
const esc = (s: string) => `\x1b[94m${s}\x1b[0m`;

describe('claude', () => {
  it('runs one tiny call with the token on stdin only', async () => {
    const { calls, exec } = fake({ code: 0, stdout: 'ok\n' });
    expect(await checkAgent('claude', deps(exec))).toEqual({ state: 'connected', detail: 'Logged in with a Claude subscription' });
    const [run] = runs(calls);
    expect(run!.args.join(' ')).not.toContain('SECRET');
    expect(run!.input).toBe(`${TOKEN}\n`);
    expect(cmdOf(run!).slice(0, 4)).toEqual(['timeout', '-s', 'KILL', expect.any(String)]);
    expect(cmdOf(run!).join(' ')).toContain('claude -p ok --max-turns 1');
    // Not on the shared volume: the call must not leave a session there.
    expect(run!.args.join(' ')).not.toContain('strado-sandbox-home');
  });

  it('no stored token is not-connected without running anything', async () => {
    const { calls, exec } = fake({ code: 0 });
    expect(await checkAgent('claude', deps(exec, null))).toEqual({ state: 'not-connected', detail: null });
    expect(calls).toHaveLength(0);
  });

  it('a 401 is failed with a fixed reason, never the output', async () => {
    const { exec } = fake({ code: 1, stdout: `Failed to authenticate. API Error: 401 Invalid bearer token ${TOKEN}` });
    const r = await checkAgent('claude', deps(exec));
    expect(r).toEqual({ state: 'failed', detail: 'Claude rejected the stored token' });
  });

  it('any other failure is unknown and the container is removed', async () => {
    const { calls, exec } = fake({ code: 1, stdout: 'network down' });
    expect(await checkAgent('claude', deps(exec))).toEqual({ state: 'unknown', detail: 'could not run the check on this runner' });
    const run = runs(calls)[0]!;
    const name = run.args[run.args.indexOf('--name') + 1];
    expect(name).toMatch(/^strado-conn-[0-9a-f]{12}$/);
    expect(calls.at(-1)!.args).toEqual(['rm', '-f', name]);
  });
});

describe('codex', () => {
  it('ChatGPT login', async () => {
    const { calls, exec } = fake({ code: 0, stdout: esc('Logged in using ChatGPT') + '\n' });
    expect(await checkAgent('codex', deps(exec))).toEqual({ state: 'connected', detail: 'Logged in with ChatGPT' });
    expect(cmdOf(runs(calls)[0]!).slice(4)).toEqual(['codex', 'login', 'status']);
    expect(runs(calls)[0]!.args).toContain('strado-sandbox-home:/home/node');
  });
  it('API key login never echoes the masked key', async () => {
    const { exec } = fake({ code: 0, stdout: 'Logged in using an API key - sk-proj-***ABCD\n' });
    expect(await checkAgent('codex', deps(exec))).toEqual({ state: 'connected', detail: 'Logged in with an API key' });
  });
  it('not logged in', async () => {
    const { exec } = fake({ code: 1, stdout: 'Not logged in\n' });
    expect(await checkAgent('codex', deps(exec))).toEqual({ state: 'not-connected', detail: null });
  });
  it('anything else is unknown', async () => {
    const { exec } = fake({ code: 125, stderr: 'Error: no such image' });
    expect((await checkAgent('codex', deps(exec))).state).toBe('unknown');
  });
});

const OPENCODE_LIST = `
┌  Credentials ~/.local/share/opencode/auth.json
│
●  Anthropic api
│
●  Amazon Bedrock api
│
●  OpenRouter oauth
│
└  3 credentials
`;

describe('opencode', () => {
  it('lists providers by name', async () => {
    const { calls, exec } = fake({ code: 0, stdout: OPENCODE_LIST.replace(/●/g, esc('●')) });
    expect(await checkAgent('opencode', deps(exec))).toEqual({
      state: 'connected',
      detail: '3 providers: Anthropic, Amazon Bedrock, OpenRouter',
    });
    expect(cmdOf(runs(calls)[0]!).slice(4)).toEqual(['opencode', 'auth', 'list']);
  });
  it('one provider is singular', async () => {
    const { exec } = fake({ code: 0, stdout: '●  OpenAI oauth\n└  1 credentials\n' });
    expect((await checkAgent('opencode', deps(exec))).detail).toBe('1 provider: OpenAI');
  });
  it('zero credentials', async () => {
    const { exec } = fake({ code: 0, stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n' });
    expect(await checkAgent('opencode', deps(exec))).toEqual({ state: 'not-connected', detail: null });
  });
  it('a hostile provider name is trimmed to safe characters', async () => {
    const { exec } = fake({ code: 0, stdout: `●  Evil<script>${'x'.repeat(80)} api\n` });
    const d = (await checkAgent('opencode', deps(exec))).detail!;
    expect(d).not.toMatch(/[<>]/);
    expect(d.length).toBeLessThan(70);
  });
});

describe('pi', () => {
  let home: string;
  let bin: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-pi-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-pibin-'));
    // A stand-in `pi`: ready only for providers listed in READY.
    fs.writeFileSync(
      path.join(bin, 'pi'),
      `#!/bin/sh\nfor p in $READY; do [ "$p" = "$4" ] && { echo '{"status":"ready","provider":"'$4'"}'; exit 0; }; done\n` +
        `echo '{"status":"not_ready","provider":"'$4'","reason":"expired"}'; exit 1\n`,
      { mode: 0o755 },
    );
  });

  /** Runs the in-container script with plain node against the temp HOME. */
  const local = (ready: string): ExecFn => async (_f, args, _t, _o, input) => {
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
    const cmd = args.slice(args.indexOf('img:1') + 5);
    expect(cmd[0]).toBe('node');
    const prev = { HOME: process.env.HOME, PATH: process.env.PATH, READY: process.env.READY };
    Object.assign(process.env, { HOME: home, PATH: `${bin}:${prev.PATH}`, READY: ready });
    try {
      return await realExec(process.execPath, cmd.slice(1), 20_000, undefined, input);
    } finally {
      Object.assign(process.env, prev);
      if (prev.READY === undefined) delete process.env.READY;
    }
  };
  const auth = (v: unknown) => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), JSON.stringify(v));
  };

  it('no auth.json is not-connected', async () => {
    expect(await checkAgent('pi', deps(local('')))).toEqual({ state: 'not-connected', detail: null });
  });

  it('ready providers are listed; secrets never reach the output', async () => {
    auth({
      openrouter: { type: 'oauth', access: 'SECRET-A', refresh: '', expires: 1 },
      anthropic: { type: 'api', key: 'SECRET-K' },
    });
    const r = await checkAgent('pi', deps(local('openrouter anthropic')));
    expect(r).toEqual({ state: 'connected', detail: '2 providers: anthropic, openrouter' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('a refreshable login that is not ready needs a terminal', async () => {
    auth({
      openrouter: { type: 'oauth', access: 'a', refresh: '', expires: 1 },
      'google-gemini-cli': { type: 'oauth', access: 'a', refresh: 'r-SECRET', expires: 1 },
    });
    expect(await checkAgent('pi', deps(local('openrouter')))).toEqual({
      state: 'connected',
      detail: '1 provider: openrouter',
      needsTerminal: true,
    });
  });

  it('nothing ready is not-connected; a provider id that is not a plain name is skipped', async () => {
    auth({ openrouter: { type: 'api', key: 'k' }, '--credentials': { type: 'api', key: 'k' } });
    expect(await checkAgent('pi', deps(local('--credentials')))).toEqual({ state: 'not-connected', detail: null });
  });

  it('an unreadable auth.json is unknown', async () => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), '{not json');
    expect((await checkAgent('pi', deps(local('')))).state).toBe('unknown');
  });
});
