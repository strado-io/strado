import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecFn } from '../sandbox/runtime.js';
import { createDeviceLogins, DEVICE_LOGIN_TIMEOUT_MS } from './deviceLogin.js';

const rt = { bin: 'podman' as const };

const CODEX_OUT = [
  'WARNING: proceeding, even though we could not create PATH aliases\n\nWelcome to Codex [v\x1b[90m0.164.0\x1b[0m]\n',
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n',
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mEMNE-7R5NE\x1b[0m\n',
];
const OPENCODE_OUT = [
  '\n┌  Add credential\n│\n●  Go to: https://auth.openai.com/codex/device\n│\n●  Enter code: EMX4-E6YIJ\n│\n',
  '◒  Waiting for authorization\r◐  Waiting for authorization.',
];

type Run = { args: string[]; finish(code: number): void };

/** A fake runtime whose `run` streams the given chunks, then waits to be finished. */
function fakeRuntime(chunks: string[]) {
  const runs: Run[] = [];
  const removed: string[] = [];
  const exec: ExecFn = (_file, args, _t, onOutput) => {
    if (args[0] === 'rm') {
      removed.push(args[2]!);
      // Removing the container ends its run.
      runs.find((r) => r.args.includes(args[2]!))?.finish(137);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return new Promise((resolve) => {
      let done = false;
      const run: Run = {
        args,
        finish: (code) => {
          if (done) return;
          done = true;
          resolve({ code, stdout: '', stderr: '' });
        },
      };
      runs.push(run);
      queueMicrotask(() => chunks.forEach((c) => onOutput?.(c)));
    });
  };
  return { exec, runs, removed };
}

const deps = (exec: ExecFn) => ({ rt, exec, image: 'img:1', userArgs: ['--userns=keep-id'], now: () => 1_000 });
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('device login', () => {
  it('codex: parses the URL and code through ANSI, on the shared volume', async () => {
    const { exec, runs } = fakeRuntime(CODEX_OUT);
    const logins = createDeviceLogins(deps(exec));
    const p = await logins.start('codex');
    expect(p).toEqual({
      loginId: expect.stringMatching(/^[0-9a-f]{32}$/),
      url: 'https://auth.openai.com/codex/device',
      code: 'EMNE-7R5NE',
      expiresAt: 1_000 + 15 * 60_000,
    });
    const args = runs[0]!.args;
    expect(args).toContain('strado-sandbox-home:/home/node');
    expect(args.slice(args.indexOf('img:1') + 1)).toEqual([
      'timeout', '-s', 'KILL', String(DEVICE_LOGIN_TIMEOUT_MS / 1000), 'codex', 'login', '--device-auth',
    ]);
    expect(logins.status(p.loginId)).toEqual({ done: false });
    runs[0]!.finish(0);
    await tick();
    expect(logins.status(p.loginId)).toEqual({ done: true, ok: true });
  });

  it('opencode: always passes -p and -m, and parses its spinner output', async () => {
    const { exec, runs } = fakeRuntime(OPENCODE_OUT);
    const logins = createDeviceLogins(deps(exec));
    const p = await logins.start('opencode');
    expect(p.code).toBe('EMX4-E6YIJ');
    expect(p.url).toBe('https://auth.openai.com/codex/device');
    const args = runs[0]!.args;
    expect(args.slice(args.indexOf('img:1') + 5)).toEqual([
      'opencode', 'auth', 'login', '-p', 'openai', '-m', 'ChatGPT Pro/Plus (headless)',
    ]);
  });

  it('a non-zero exit (expired, killed) is done and not ok', async () => {
    const { exec, runs } = fakeRuntime(CODEX_OUT);
    const logins = createDeviceLogins(deps(exec));
    const p = await logins.start('codex');
    runs[0]!.finish(137);
    await tick();
    expect(logins.status(p.loginId)).toEqual({ done: true, ok: false });
  });

  it('a link that is not OpenAI\'s is never handed to the laptop', async () => {
    const { exec, removed } = fakeRuntime(['Open https://evil.example/codex/device\nEnter code ABCD-EFGHI\n']);
    const logins = createDeviceLogins({ ...deps(exec), startTimeoutMs: 50 });
    await expect(logins.start('codex')).rejects.toThrow('device login did not start');
    expect(new Set(removed).size).toBe(1);
  });

  it('a run that exits before printing a code fails with a fixed message', async () => {
    const { exec, runs } = fakeRuntime(['error: something SECRET went wrong\n']);
    const logins = createDeviceLogins(deps(exec));
    const started = logins.start('codex');
    await tick();
    runs[0]!.finish(1);
    const err = await started.catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('device login did not start');
  });

  it('a second start for the same agent ends the first', async () => {
    const { exec, removed, runs } = fakeRuntime(CODEX_OUT);
    const logins = createDeviceLogins(deps(exec));
    const a = await logins.start('codex');
    const b = await logins.start('codex');
    const nameA = runs[0]!.args[runs[0]!.args.indexOf('--name') + 1];
    expect(removed).toContain(nameA);
    await tick();
    expect(logins.status(a.loginId)).toEqual({ done: true, ok: false });
    expect(logins.status(b.loginId)).toEqual({ done: false });
  });

  it('a cancelled run that exits 0 (codex on SIGTERM) is still not ok', async () => {
    const { exec, runs } = fakeRuntime(CODEX_OUT);
    const logins = createDeviceLogins({
      ...deps(async (f, a, t, o, i) => (a[0] === 'rm' ? (runs[0]!.finish(0), { code: 0, stdout: '', stderr: '' }) : exec(f, a, t, o, i))),
    });
    const p = await logins.start('codex');
    await logins.cancel(p.loginId);
    await tick();
    expect(logins.status(p.loginId)).toEqual({ done: true, ok: false });
  });

  it('cancel removes the container; an unknown id is null', async () => {
    const { exec, removed } = fakeRuntime(CODEX_OUT);
    const logins = createDeviceLogins(deps(exec));
    const p = await logins.start('codex');
    expect(await logins.cancel(p.loginId)).toBe(true);
    expect(new Set(removed).size).toBe(1);
    await tick();
    expect(logins.status(p.loginId)).toEqual({ done: true, ok: false });
    expect(logins.status('nope')).toBeNull();
    expect(await logins.cancel('nope')).toBe(false);
  });

  it('success is recorded before the login reads done; a failed record is not ok', async () => {
    const { exec, runs } = fakeRuntime(CODEX_OUT);
    let release!: () => void;
    const onSuccess = vi.fn(() => new Promise<void>((r) => (release = r)));
    const logins = createDeviceLogins({ ...deps(exec), onSuccess });
    const p = await logins.start('codex');
    runs[0]!.finish(0);
    await tick();
    expect(onSuccess).toHaveBeenCalledWith('codex');
    expect(logins.status(p.loginId)).toEqual({ done: false });
    release();
    await tick();
    expect(logins.status(p.loginId)).toEqual({ done: true, ok: true });

    const f = fakeRuntime(CODEX_OUT);
    const failing = createDeviceLogins({ ...deps(f.exec), onSuccess: async () => { throw new Error('disk'); } });
    const q = await failing.start('codex');
    f.runs[0]!.finish(0);
    await tick();
    await tick();
    expect(failing.status(q.loginId)).toEqual({ done: true, ok: false });
  });

  it('a cancelled login is never recorded', async () => {
    const { exec, runs } = fakeRuntime(CODEX_OUT);
    const onSuccess = vi.fn(async () => {});
    const logins = createDeviceLogins({
      ...deps(async (f, a, t, o, i) => (a[0] === 'rm' ? (runs[0]!.finish(0), { code: 0, stdout: '', stderr: '' }) : exec(f, a, t, o, i))),
      onSuccess,
    });
    const p = await logins.start('codex');
    await logins.cancel(p.loginId);
    await tick();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('only codex and opencode have a device login', async () => {
    const { exec } = fakeRuntime(CODEX_OUT);
    await expect(createDeviceLogins(deps(exec)).start('pi' as never)).rejects.toThrow('no device login for this agent');
  });
});
