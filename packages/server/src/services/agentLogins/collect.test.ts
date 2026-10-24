import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBundle } from './collect.js';

let home: string;

async function put(rel: string, value: unknown) {
  const file = path.join(home, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const token = (t: string | null) => () => Promise.resolve(t);

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'collect-home-'));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe('collectBundle', () => {
  it('an empty home collects nothing', async () => {
    expect(await collectBundle({ home, readToken: token(null) })).toEqual({});
  });

  it('omits claude with no token, even when ~/.claude.json exists', async () => {
    await put('.claude.json', { hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'a@b.c' } });
    expect((await collectBundle({ home, readToken: token(null) })).claude).toBeUndefined();
  });

  it('claude: the stored token plus oauthAccount and lastOnboardingVersion', async () => {
    await put('.claude.json', { oauthAccount: { accountUuid: 'u1' }, lastOnboardingVersion: '2.1.162' });
    expect((await collectBundle({ home, readToken: token('tok') })).claude).toEqual({
      token: 'tok', oauthAccount: { accountUuid: 'u1' }, lastOnboardingVersion: '2.1.162',
    });
  });

  it('claude: an unreadable ~/.claude.json still sends the token alone', async () => {
    await put('.claude.json', '{broken');
    expect((await collectBundle({ home, readToken: token('tok') })).claude).toEqual({ token: 'tok' });
  });

  it('never includes mcpOAuth, projects, or any other ~/.claude.json key', async () => {
    await put('.claude.json', {
      oauthAccount: { accountUuid: 'u1' }, lastOnboardingVersion: '2.1.162',
      mcpOAuth: { figma: { clientSecret: 'MCP-SECRET' } }, projects: { '/x': { history: ['PROJECT-HISTORY'] } },
      mcpServers: { s: { env: { K: 'SERVER-SECRET' } } }, userID: 'uid',
    });
    const text = JSON.stringify(await collectBundle({ home, readToken: token('tok') }));
    for (const leak of ['mcpOAuth', 'MCP-SECRET', 'projects', 'PROJECT-HISTORY', 'mcpServers', 'SERVER-SECRET', 'userID']) {
      expect(text).not.toContain(leak);
    }
  });

  it('codex: OPENAI_API_KEY when set', async () => {
    await put('.codex/auth.json', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-1', tokens: null });
    expect((await collectBundle({ home, readToken: token(null) })).codex).toEqual({ apiKey: 'sk-proj-1' });
  });

  it('codex: a null key (ChatGPT login) is omitted, and its oauth tokens never travel', async () => {
    await put('.codex/auth.json', { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'RT' } });
    const b = await collectBundle({ home, readToken: token(null) });
    expect(b.codex).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('RT');
  });

  it('opencode: oauth providers dropped, api kept', async () => {
    await put('.local/share/opencode/auth.json', {
      anthropic: { type: 'api', key: 'k-ant' },
      openai: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 },
      openrouter: { type: 'api', key: 'k-or' },
      weird: { type: 'api' },
    });
    expect((await collectBundle({ home, readToken: token(null) })).opencode).toEqual({
      providers: { anthropic: { type: 'api', key: 'k-ant' }, openrouter: { type: 'api', key: 'k-or' } },
    });
  });

  it('opencode: only oauth providers → omitted', async () => {
    await put('.local/share/opencode/auth.json', { openai: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 } });
    expect((await collectBundle({ home, readToken: token(null) })).opencode).toBeUndefined();
  });

  it('opencode: an oauth entry with an empty refresh is static and travels; only its four fields', async () => {
    await put('.local/share/opencode/auth.json', {
      openrouter: { type: 'oauth', refresh: '', access: 'A-OR', expires: 5, accountId: 'acct' },
      copilot: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 },
      norefresh: { type: 'oauth', access: 'A-NR', expires: 7 },
      noaccess: { type: 'oauth', refresh: '', access: '', expires: 1 },
      noexpiry: { type: 'oauth', refresh: '', access: 'A' },
    });
    expect((await collectBundle({ home, readToken: token(null) })).opencode).toEqual({
      providers: {
        openrouter: { type: 'oauth', access: 'A-OR', refresh: '', expires: 5 },
        norefresh: { type: 'oauth', access: 'A-NR', refresh: '', expires: 7 },
      },
    });
  });

  it('pi: static entries from ~/.pi/agent/auth.json; a refresh token stays behind', async () => {
    await put('.pi/agent/auth.json', {
      openrouter: { type: 'oauth', refresh: '', access: 'A-PI', expires: 9 },
      anthropic: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 },
      groq: { type: 'api', key: 'k-groq', extra: 'x' },
    });
    expect((await collectBundle({ home, readToken: token(null) })).pi).toEqual({
      providers: {
        openrouter: { type: 'oauth', access: 'A-PI', refresh: '', expires: 9 },
        groq: { type: 'api', key: 'k-groq' },
      },
    });
  });

  it('a provider id the runner would refuse is left out, so it cannot sink the whole sync', async () => {
    await put('.pi/agent/auth.json', { 'my provider': { type: 'api', key: 'k1' }, __proto__x: { type: 'api', key: 'k2' }, ok: { type: 'api', key: 'k3' } });
    await put('.local/share/opencode/auth.json', { [`a${'b'.repeat(64)}`]: { type: 'api', key: 'k4' }, '-x': { type: 'api', key: 'k5' } });
    const b = await collectBundle({ home, readToken: token(null) });
    expect(Object.keys(b.pi!.providers)).toEqual(['ok']);
    expect(b.opencode).toBeUndefined();
  });

  it('pi: nothing static → omitted', async () => {
    await put('.pi/agent/auth.json', { anthropic: { type: 'oauth', refresh: 'R', access: 'A', expires: 1 } });
    expect((await collectBundle({ home, readToken: token(null) })).pi).toBeUndefined();
  });

  it('a corrupt codex or opencode file omits just that agent', async () => {
    await put('.codex/auth.json', 'not json');
    await put('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'k' } });
    const b = await collectBundle({ home, readToken: token('tok') });
    expect(b.codex).toBeUndefined();
    expect(b.opencode).toBeDefined();
    expect(b.claude?.token).toBe('tok');
  });
});
