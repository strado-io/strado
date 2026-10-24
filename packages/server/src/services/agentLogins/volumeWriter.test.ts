import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realExec, type ExecFn } from '../sandbox/runtime.js';
import { writeHomeVolume, type VolumePayload } from './volumeWriter.js';

const rt = { bin: 'podman' as const };

/** Records the call, then runs the in-container script with plain node
 * against a temp HOME — the real merge logic, without a container. */
function localRunner(home: string) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const exec: ExecFn = async (file, args, _t, _o, input) => {
    calls.push({ file, args, input });
    const script = args[args.indexOf('-e', args.indexOf('node')) + 1]!;
    const prev = process.env.HOME;
    // realExec inherits this process's env; HOME is all the script reads.
    process.env.HOME = home;
    try {
      return await realExec(process.execPath, ['-e', script], 10_000, undefined, input);
    } finally {
      process.env.HOME = prev;
    }
  };
  return { calls, exec };
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mode = (f: string) => fs.statSync(f).mode & 0o777;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-vol-'));
});

const full: VolumePayload = {
  claude: { oauthAccount: { emailAddress: 'a@b.c' }, lastOnboardingVersion: '2.0.1', trustPaths: ['/w/one'] },
  codex: { apiKey: 'sk-codex-SECRET' },
  opencode: { providers: { openai: { type: 'api', key: 'sk-oc-SECRET' } } },
};

describe('writeHomeVolume', () => {
  it('secret is on stdin, not in argv', async () => {
    const { calls, exec } = localRunner(home);
    await writeHomeVolume({ rt, exec, image: 'img:1', userArgs: ['--userns=keep-id'] }, full);
    expect(calls).toHaveLength(1);
    const { file, args, input } = calls[0]!;
    expect(file).toBe('podman');
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(args).toContain('--userns=keep-id');
    expect(args).toContain('strado-sandbox-home:/home/node');
    expect(args).toContain('img:1');
    expect(args.join(' ')).not.toContain('SECRET');
    expect(input).toContain('sk-codex-SECRET');
  });

  it('writes each agent 0600 and reports written, then unchanged', async () => {
    const { exec } = localRunner(home);
    const deps = { rt, exec, image: 'img', userArgs: [] };
    expect(await writeHomeVolume(deps, full)).toEqual({ claude: 'written', codex: 'written', opencode: 'written', pi: 'skipped' });

    const claude = read(path.join(home, '.claude.json'));
    expect(claude).toMatchObject({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.0.1',
      oauthAccount: { emailAddress: 'a@b.c' },
      projects: { '/w/one': { hasTrustDialogAccepted: true } },
    });
    expect(read(path.join(home, '.codex/auth.json'))).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-codex-SECRET' });
    expect(read(path.join(home, '.local/share/opencode/auth.json'))).toEqual({ openai: { type: 'api', key: 'sk-oc-SECRET' } });
    for (const f of ['.claude.json', '.codex/auth.json', '.local/share/opencode/auth.json']) {
      expect(mode(path.join(home, f))).toBe(0o600);
    }

    expect(await writeHomeVolume(deps, full)).toEqual({ claude: 'unchanged', codex: 'unchanged', opencode: 'unchanged', pi: 'skipped' });
  });

  it('merges into an existing .claude.json instead of replacing it', async () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ numStartups: 7, projects: { '/w/one': { allowedTools: ['x'] }, '/w/two': {} } }),
    );
    const { exec } = localRunner(home);
    await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { claude: { trustPaths: ['/w/one'] } });
    expect(read(path.join(home, '.claude.json'))).toEqual({
      numStartups: 7,
      hasCompletedOnboarding: true,
      projects: { '/w/one': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/w/two': {} },
    });
  });

  it('never clobbers a host ChatGPT login for codex', async () => {
    const chatgpt = { auth_mode: 'chatgpt', tokens: { refresh_token: 'r' }, last_refresh: 'x' };
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex/auth.json'), JSON.stringify(chatgpt));
    const { exec } = localRunner(home);
    const out = await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { codex: { apiKey: 'sk-new' } });
    expect(out.codex).toBe('unchanged');
    expect(read(path.join(home, '.codex/auth.json'))).toEqual(chatgpt);
  });

  it('keeps opencode oauth entries', async () => {
    const dir = path.join(home, '.local/share/opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r' } }));
    const { exec } = localRunner(home);
    await writeHomeVolume(
      { rt, exec, image: 'img', userArgs: [] },
      { opencode: { providers: { anthropic: { type: 'api', key: 'k1' }, openai: { type: 'api', key: 'k2' } } } },
    );
    expect(read(path.join(dir, 'auth.json'))).toEqual({
      anthropic: { type: 'oauth', refresh: 'r' },
      openai: { type: 'api', key: 'k2' },
    });
  });

  it('only ids this runner was sent are replaced or removed; hand-made entries stay', async () => {
    const dir = path.join(home, '.local/share/opencode');
    fs.mkdirSync(dir, { recursive: true });
    const oldOr = { type: 'oauth' as const, access: 'old', refresh: '' as const, expires: 1 };
    const gone = { type: 'api' as const, key: 'dropped-on-mac' };
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({
        openrouter: oldOr, // sent before, unchanged here → replaced
        groq: gone, // sent before, no longer sent → removed
        anthropic: { type: 'api', key: 'typed-on-runner' }, // never sent → kept
        mistral: { type: 'api', key: 'edited-on-runner' }, // sent before but changed here → kept
      }),
    );
    const { exec } = localRunner(home);
    const newOr = { ...oldOr, access: 'new', expires: 2 };
    await writeHomeVolume(
      { rt, exec, image: 'img', userArgs: [] },
      {
        opencode: {
          providers: { openrouter: newOr, anthropic: { type: 'api', key: 'from-mac' }, mistral: { type: 'api', key: 'm2' } },
          prev: { openrouter: oldOr, groq: gone, mistral: { type: 'api', key: 'm1' } },
        },
      },
    );
    expect(read(path.join(dir, 'auth.json'))).toEqual({
      openrouter: newOr,
      anthropic: { type: 'api', key: 'typed-on-runner' },
      mistral: { type: 'api', key: 'edited-on-runner' },
    });
  });

  it('without prev (a re-apply) a hand-changed entry is not restored', async () => {
    const dir = path.join(home, '.pi/agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'mine' } }));
    const { exec } = localRunner(home);
    const out = await writeHomeVolume(
      { rt, exec, image: 'img', userArgs: [] },
      { pi: { providers: { openrouter: { type: 'api', key: 'synced' }, xai: { type: 'api', key: 'x' } } } },
    );
    expect(out.pi).toBe('written');
    expect(read(path.join(dir, 'auth.json'))).toEqual({ openrouter: { type: 'api', key: 'mine' }, xai: { type: 'api', key: 'x' } });
  });

  it('a failed run removes its named container', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_f, args) => {
      calls.push(args);
      return { code: args[0] === 'rm' ? 0 : 1, stdout: '', stderr: '[timed out]' };
    };
    await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { codex: { apiKey: 'k' } });
    const name = calls[0]![calls[0]!.indexOf('--name') + 1];
    expect(name).toMatch(/^strado-vol-[0-9a-f]{12}$/);
    expect(calls[1]).toEqual(['rm', '-f', name]);
  });

  it('pi entries merge into ~/.pi/agent/auth.json 0600, keeping a refreshable login', async () => {
    const dir = path.join(home, '.pi/agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ google: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }));
    const { calls, exec } = localRunner(home);
    const or = { type: 'oauth' as const, access: 'sk-or-SECRET', refresh: '' as const, expires: 9 };
    const out = await writeHomeVolume(
      { rt, exec, image: 'img', userArgs: [] },
      { pi: { providers: { openrouter: or, google: { type: 'api', key: 'k' } } } },
    );
    expect(out).toEqual({ claude: 'skipped', codex: 'skipped', opencode: 'skipped', pi: 'written' });
    expect(read(path.join(dir, 'auth.json'))).toEqual({ google: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }, openrouter: or });
    expect(mode(path.join(dir, 'auth.json'))).toBe(0o600);
    expect(calls[0]!.args.join(' ')).not.toContain('SECRET');
  });

  it('an unreadable existing file fails that agent and is left alone', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ half-written');
    const { exec } = localRunner(home);
    const out = await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { claude: {}, codex: { apiKey: 'k' } });
    expect(out).toEqual({ claude: 'failed', codex: 'written', opencode: 'skipped', pi: 'skipped' });
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{ half-written');
  });

  it('absent agents are skipped, and an empty payload runs nothing', async () => {
    const { calls, exec } = localRunner(home);
    expect(await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, {})).toEqual({
      claude: 'skipped',
      codex: 'skipped',
      opencode: 'skipped',
      pi: 'skipped',
    });
    expect(calls).toHaveLength(0);
  });

  it('exec non-zero → all present agents failed', async () => {
    const exec: ExecFn = async () => ({ code: 125, stdout: '', stderr: 'no such image' });
    expect(
      await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { codex: { apiKey: 'k' }, opencode: { providers: {} } }),
    ).toEqual({ claude: 'skipped', codex: 'failed', opencode: 'failed', pi: 'skipped' });
  });

  it('exec that throws or prints garbage → failed, no throw', async () => {
    const throws: ExecFn = async () => {
      throw new Error('boom');
    };
    const garbage: ExecFn = async () => ({ code: 0, stdout: 'not json', stderr: '' });
    for (const exec of [throws, garbage]) {
      expect((await writeHomeVolume({ rt, exec, image: 'img', userArgs: [] }, { codex: { apiKey: 'k' } })).codex).toBe('failed');
    }
  });
});
