import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuotaService } from './quota.js';
import type { RateLimitSnapshot } from './codexLogs.js';

let home = '';

const codexSnapshot: RateLimitSnapshot = {
  capturedAt: 1_788_260_000_000,
  windows: [
    { label: 'Session (5h)', usedPercent: 36, resetsAt: 1_788_266_796_000 },
    { label: 'Weekly', usedPercent: 40, resetsAt: 1_788_773_664_000 },
  ],
};

const idToken = (claims: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${body}.signature`;
};

const writeClaudeAccount = async (over: Record<string, unknown> = {}) => {
  await fsp.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'dev@example.com',
        organizationName: 'Acme',
        organizationType: 'claude_team',
        userRateLimitTier: 'default_claude_max_5x',
        ...over,
      },
    }),
    'utf8',
  );
};

const writeCodexAuth = async (claims: Record<string, unknown> = {}) => {
  await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
  await fsp.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: idToken({
          email: 'dev@example.com',
          'https://api.openai.com/auth.chatgpt_plan_type': 'plus',
          ...claims,
        }),
      },
    }),
    'utf8',
  );
};

const service = (over: Partial<Parameters<typeof createQuotaService>[0]> = {}) => createQuotaService({
  agentHomeDir: home,
  codexRateLimits: async () => codexSnapshot,
  readClaudeToken: async () => 'oauth-token',
  fetchImpl: (async () => new Response(JSON.stringify({
    five_hour: { utilization: 2, resets_at: '2026-09-01T18:00:00Z' },
    seven_day: { utilization: 0, resets_at: '2026-09-07T18:00:00Z' },
  }), { status: 200 })) as typeof fetch,
  ...over,
});

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-quota-'));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('claude account card', () => {
  it('reads identity locally and quota from the usage endpoint', async () => {
    await writeClaudeAccount();

    const [claude] = await service().accounts();

    expect(claude).toMatchObject({
      agent: 'claude',
      accountLabel: 'dev@example.com',
      plan: 'TEAM',
      quotaStatus: 'official',
    });
    expect(claude!.windows).toEqual([
      { label: 'Session (5h)', usedPercent: 2, resetsAt: Date.parse('2026-09-01T18:00:00Z') },
      { label: 'Weekly', usedPercent: 0, resetsAt: Date.parse('2026-09-07T18:00:00Z') },
    ]);
  });

  it('labels a max subscription without an organization', async () => {
    await writeClaudeAccount({ organizationType: 'claude_personal', organizationName: null });

    const [claude] = await service().accounts();

    expect(claude!.plan).toBe('MAX');
  });

  it('reports quota unavailable when the fetch fails, keeping the account', async () => {
    await writeClaudeAccount();

    const [claude] = await service({
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    }).accounts();

    expect(claude).toMatchObject({ agent: 'claude', quotaStatus: 'unavailable' });
    expect(claude!.windows).toEqual([]);
  });

  it('reports quota unavailable on a non-200 response', async () => {
    await writeClaudeAccount();

    const [claude] = await service({
      fetchImpl: (async () => new Response('nope', { status: 403 })) as typeof fetch,
    }).accounts();

    expect(claude!.quotaStatus).toBe('unavailable');
  });

  it('reports quota unavailable when the payload has no known windows', async () => {
    await writeClaudeAccount();

    const [claude] = await service({
      fetchImpl: (async () => new Response(JSON.stringify({ something_else: true }), { status: 200 })) as typeof fetch,
    }).accounts();

    expect(claude!.quotaStatus).toBe('unavailable');
  });

  it('reports quota unavailable when no credential can be read', async () => {
    await writeClaudeAccount();
    const fetchImpl = vi.fn();

    const [claude] = await service({
      readClaudeToken: async () => { throw new Error('keychain locked'); },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).accounts();

    expect(claude!.quotaStatus).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits the claude card when the machine has no claude account', async () => {
    const cards = await service().accounts();

    expect(cards.some((card) => card.agent === 'claude')).toBe(false);
  });

  it('accepts a fractional utilization expressed as a share of one', async () => {
    await writeClaudeAccount();

    const [claude] = await service({
      fetchImpl: (async () => new Response(JSON.stringify({
        five_hour: { utilization: 0.42, resets_at: '2026-09-01T18:00:00Z' },
      }), { status: 200 })) as typeof fetch,
    }).accounts();

    expect(claude!.windows[0]!.usedPercent).toBe(42);
  });
});

describe('codex account card', () => {
  it('reads identity from the id token and windows from the rollout snapshot', async () => {
    await writeCodexAuth();

    const cards = await service().accounts();
    const codex = cards.find((card) => card.agent === 'codex');

    expect(codex).toMatchObject({
      accountLabel: 'dev@example.com',
      plan: 'PLUS',
      credentialSource: '~/.codex',
      quotaStatus: 'official',
    });
    expect(codex!.windows).toEqual(codexSnapshot.windows);
  });

  it('keeps the card with unavailable quota when no snapshot exists yet', async () => {
    await writeCodexAuth();

    const cards = await service({ codexRateLimits: async () => null }).accounts();
    const codex = cards.find((card) => card.agent === 'codex');

    expect(codex).toMatchObject({ quotaStatus: 'unavailable', windows: [] });
  });

  it('omits the codex card when there is no auth file', async () => {
    const cards = await service().accounts();

    expect(cards.some((card) => card.agent === 'codex')).toBe(false);
  });

  it('survives a malformed id token', async () => {
    await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(home, '.codex', 'auth.json'), '{"tokens":{"id_token":"garbage"}}', 'utf8');

    const cards = await service().accounts();
    const codex = cards.find((card) => card.agent === 'codex');

    expect(codex).toMatchObject({ agent: 'codex', accountLabel: 'Codex account' });
  });
});

describe('caching', () => {
  it('serves a second call from cache', async () => {
    await writeClaudeAccount();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: 5, resets_at: '2026-09-01T18:00:00Z' },
    }), { status: 200 }));
    const quota = service({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await quota.accounts();
    await quota.accounts();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache window passes', async () => {
    vi.useFakeTimers();
    await writeClaudeAccount();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: 5, resets_at: '2026-09-01T18:00:00Z' },
    }), { status: 200 }));
    const quota = service({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await quota.accounts();
    vi.advanceTimersByTime(6 * 60_000);
    await quota.accounts();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
