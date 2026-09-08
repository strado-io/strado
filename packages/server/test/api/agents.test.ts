import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { createTerminalManager, claudeKey, shellKey } from '../../src/services/terminalManager';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-agents-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  // A fake interactive program; pass the registry's envFor so spawns carry identity.
  deps.terminal = createTerminalManager(() => ({ file: 'cat', args: [] }), undefined, undefined, undefined, deps.agents.envFor);
  app = await buildApp(deps);
  await app.inject({
    method: 'POST', url: '/api/w/default/repos',
    payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
  });
});
afterEach(async () => { await app.close(); await fs.rm(tmp, { recursive: true, force: true }); });

describe('GET /api/agents/me', () => {
  it('401 UNAUTHENTICATED without a bearer token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/me' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('resolves a minted token to its identity, and stops after release', async () => {
    const key = claudeKey(repo, '1');
    const ex = await deps.agents.register({ key, cwd: repo, scopeId: 'default' });
    const ok = await app.inject({ method: 'GET', url: '/api/agents/me', headers: { authorization: `Bearer ${ex.token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ agentId: `claude-1@repo`, scopeId: 'default', executionId: ex.executionId, alias: null });
    expect(JSON.stringify(ok.json())).not.toContain(ex.token);
    await deps.agents.release(key);
    const gone = await app.inject({ method: 'GET', url: '/api/agents/me', headers: { authorization: `Bearer ${ex.token}` } });
    expect(gone.statusCode).toBe(401);
  });

  it('ignores identity supplied in the query', async () => {
    const ex = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' });
    const r = await app.inject({ method: 'GET', url: '/api/agents/me?agentId=claude-2@repo', headers: { authorization: `Bearer ${ex.token}` } });
    expect(r.json().agentId).toBe('claude-1@repo');
  });
});

describe('GET /api/w/:ws/agents', () => {
  it('lists agents in the workspace without tokens', async () => {
    await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    await deps.agents.register({ key: shellKey(repo, '1'), cwd: repo, scopeId: 'default' });
    await deps.agents.register({ key: claudeKey('/elsewhere', '1'), cwd: '/elsewhere', scopeId: 'other' });
    const r = await app.inject({ method: 'GET', url: '/api/w/default/agents' });
    expect(r.statusCode).toBe(200);
    const ids = r.json().agents.map((a: any) => a.agentId);
    expect(ids).toEqual(['claude-1@repo', 'shell-1@repo']);
    expect(JSON.stringify(r.json())).not.toMatch(/token/i);
  });
});

describe('PUT /api/w/:ws/agents/:agentId/alias', () => {
  it('sets, conflicts, validates, clears', async () => {
    await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' });
    const set = await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-1@repo/alias', payload: { alias: 'reviewer' } });
    expect(set.statusCode).toBe(200);
    expect(set.json().agent.alias).toBe('reviewer');
    const dup = await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-2@repo/alias', payload: { alias: 'Reviewer' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
    const bad = await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-2@repo/alias', payload: { alias: 'no spaces' } });
    expect(bad.statusCode).toBe(400);
    const clr = await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-1@repo/alias', payload: { alias: null } });
    expect(clr.json().agent.alias).toBeNull();
  });

  it('404 for an agent in another workspace', async () => {
    await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'other' });
    const r = await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-1@repo/alias', payload: { alias: 'x' } });
    expect(r.statusCode).toBe(404);
  });

  it('a malformed percent-encoding in the agentId is 404, not 500', async () => {
    // The raw URL segment "%25zz" is valid — Fastify decodes it once itself
    // ("%25" -> "%", "zz" stays literal), landing req.params.agentId = "%zz",
    // a perfectly fine (if not extant) agentId. A handler that then calls
    // decodeURIComponent AGAIN on that already-decoded param throws a raw
    // URIError on "%zz" (not itself valid percent-encoding), which the app's
    // error handler maps to 500 for any non-AppError. The param must be used
    // as Fastify handed it, undecoded a second time.
    const r = await app.inject({ method: 'PUT', url: '/api/w/default/agents/%25zz/alias', payload: { alias: 'x' } });
    expect(r.statusCode).toBe(404);
  });
});
