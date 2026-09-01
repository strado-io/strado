// The Usage page reads three endpoints. These tests pin the contract at the
// route boundary: the summary shape the chart and tables need, the day windows
// the UI is allowed to ask for, and that a machine with no agent logs still
// answers instead of erroring.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../app.js';

let tmp: string;
let home: string;
let agentHome: string;
let prevHome: string | undefined;
let prevLicense: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

const DAY = 86_400_000;

const claudeLine = (over: { cwd?: string; model?: string; id?: string } = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date(Date.now() - DAY).toISOString(),
  requestId: `req_${over.id ?? '1'}`,
  cwd: over.cwd ?? path.join(tmp, 'repos', 'app'),
  message: {
    id: `msg_${over.id ?? '1'}`,
    model: over.model ?? 'claude-opus-5',
    usage: { input_tokens: 1_000, cache_read_input_tokens: 50_000, output_tokens: 800 },
  },
});

const writeClaudeLog = async (cwd: string, lines: string[]) => {
  const dir = path.join(agentHome, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'session.jsonl'), lines.map((l) => `${l}\n`).join(''), 'utf8');
};

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-route-')));
  home = path.join(tmp, 'strado-home');
  agentHome = path.join(tmp, 'agent-home');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(agentHome, { recursive: true });
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
  prevLicense = process.env.STRADO_LICENSE_REQUIRED;
  delete process.env.STRADO_LICENSE_REQUIRED;
  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'state'),
    agentHomeDir: agentHome,
  });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevLicense === undefined) delete process.env.STRADO_LICENSE_REQUIRED;
  else process.env.STRADO_LICENSE_REQUIRED = prevLicense;
  await fs.rm(tmp, { recursive: true, force: true });
});

const addRepo = async () => {
  const stores = await app.deps.registry.get('default');
  await stores.repos.add({
    id: 'app',
    name: 'app',
    path: path.join(tmp, 'repos', 'app'),
    cloneUrl: null,
    projectSubdir: null,
    startCommand: 'npm run dev',
    defaultPort: 3000,
    editor: 'code' as const,
  });
};

describe('GET /api/w/:ws/usage/summary', () => {
  it('answers with an empty summary on a machine with no agent logs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary?days=7' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.tokens).toBe(0);
    expect(body.series).toHaveLength(7);
    expect(body.models).toEqual([]);
  });

  it('prices local transcripts and attributes them to the repo', async () => {
    await addRepo();
    await writeClaudeLog(path.join(tmp, 'repos', 'app'), [claudeLine()]);

    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary?days=30' });

    const body = res.json();
    expect(body.totals.tokens).toBe(51_800);
    expect(body.totals.cost).toBeGreaterThan(0);
    expect(body.byAgent.claude.tokens).toBe(51_800);
    expect(body.models[0]).toMatchObject({ id: 'claude-opus-5', agent: 'claude', priced: true });
    expect(body.worktrees[0]).toMatchObject({ label: 'app', path: path.join(tmp, 'repos', 'app') });
    expect(body.series).toHaveLength(30);
  });

  it('pools work done outside the workspace as unattributed', async () => {
    await addRepo();
    await writeClaudeLog('/elsewhere/project', [claudeLine({ cwd: '/elsewhere/project', id: 'x' })]);

    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary?days=30' });

    expect(res.json().worktrees).toEqual([
      { label: 'Unattributed', path: null, cost: expect.any(Number), tokens: 51_800 },
    ]);
  });

  it('says which rate table priced the figures', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary?days=7' });

    const { pricing } = res.json();
    // Offline in tests: the built-in table, with no fetch date to show.
    expect(pricing.source).toBe('builtin');
    expect(pricing.fetchedAt).toBeNull();
  });

  it('defaults to the 30-day window', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary' });

    expect(res.json().series).toHaveLength(30);
  });

  it('rejects a window it does not serve', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/summary?days=5' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('GET /api/w/:ws/usage/accounts', () => {
  it('returns no cards when no agent is signed in on this machine', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/accounts' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [] });
  });

  it('reports a signed-in codex account with quota unavailable before any snapshot', async () => {
    await fs.mkdir(path.join(agentHome, '.codex'), { recursive: true });
    const claims = Buffer.from(JSON.stringify({
      email: 'dev@example.com',
      'https://api.openai.com/auth.chatgpt_plan_type': 'pro',
    })).toString('base64url');
    await fs.writeFile(
      path.join(agentHome, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: `h.${claims}.s` } }),
      'utf8',
    );

    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/accounts' });

    expect(res.json().accounts).toEqual([{
      agent: 'codex',
      accountLabel: 'dev@example.com',
      plan: 'PRO',
      credentialSource: '~/.codex',
      windows: [],
      quotaStatus: 'unavailable',
    }]);
  });
});

describe('GET /api/w/:ws/usage/machine', () => {
  it('samples this machine', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/usage/machine' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.memTotalBytes).toBeGreaterThan(0);
    expect(body.cpuCount).toBeGreaterThan(0);
  });
});
