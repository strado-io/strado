import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { claudeKey } from '../../src/services/terminalManager';

// Mission control over real HTTP: a Claude hook holds a permission request
// open while the TUI shows its own dialog, so the tests need a live socket
// they can cut, the way Claude cancels the hook when the tab answers first.

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let tok: string;
let agentId: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-mc-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({ method: 'POST', url: '/api/w/default/repos', payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' } });
  await deps.terminal.ensure(claudeKey(repo, '1'), repo, { file: 'cat', args: [] });
  const reg = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
  tok = reg.token;
  agentId = reg.agentId;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  app.deps.terminal.killUnder(tmp);
  await vi.waitFor(() => expect(app.deps.terminal.liveSessions().filter((s) => s.path.startsWith(tmp + path.sep))).toEqual([]), { timeout: 5000 });
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const hook = (urlPath: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}${urlPath}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body), signal });
const human = (urlPath: string, body: unknown = {}) =>
  fetch(`${base}/api/w/default${urlPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const station = async () => {
  const r = await fetch(`${base}/api/w/default/intercom/stations`);
  return ((await r.json()) as { stations: Array<Record<string, any>> }).stations.find((s) => s.agentId === agentId)!;
};
const waitFor = async <T>(f: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
};

describe('mission control: permission requests answered from the box', () => {
  it('the hook waits; the station shows the request as needing you; Approve answers the hook', async () => {
    const held = hook('/api/intercom/hook/permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    const s = await waitFor(station, (x) => x.approvals?.length === 1);
    expect(s.needsYou).toBe(true);
    expect(s.approvals[0]).toMatchObject({ kind: 'command', title: 'run a command', detail: 'rm -rf dist' });
    const answer = await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'allow' });
    expect(answer.status).toBe(200);
    expect(await (await held).json()).toEqual({ decision: 'allow' });
    expect((await station()).approvals).toEqual([]);
  });

  it('answered in the tab first (Claude cancels the hook): the request is gone, a late click gets 409 gone', async () => {
    const ac = new AbortController();
    const held = hook('/api/intercom/hook/permission', { tool_name: 'Write', tool_input: { file_path: `${repo}/x.txt` } }, ac.signal).catch(() => null);
    const s = await waitFor(station, (x) => x.approvals?.length === 1);
    expect(s.approvals[0]).toMatchObject({ kind: 'file-change', title: 'write x.txt' });
    ac.abort();
    await held;
    await waitFor(station, (x) => x.approvals.length === 0);
    const late = await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'allow' });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('gone');
  });

  it('Deny is passed through; only a valid decision is accepted', async () => {
    const held = hook('/api/intercom/hook/permission', { tool_name: 'Bash', tool_input: { command: 'curl evil.example' } });
    const s = await waitFor(station, (x) => x.approvals?.length === 1);
    expect((await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'maybe' })).status).toBe(400);
    expect((await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'deny' })).status).toBe(200);
    expect(await (await held).json()).toEqual({ decision: 'deny' });
  });

  it('only the agent itself may hold a request, and only the local hub may answer one', async () => {
    const noToken = await fetch(`${base}/api/intercom/hook/permission`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool_name: 'Bash' }) });
    expect(noToken.status).toBe(401);
    const held = hook('/api/intercom/hook/permission', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    const s = await waitFor(station, (x) => x.approvals?.length === 1);
    const foreign = await fetch(`${base}/api/w/default/intercom/approvals/${s.approvals[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ decision: 'allow' }) });
    expect(foreign.status).toBe(403);
    await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'deny' });
    await held;
  });

  it('a secret in the command never reaches the box', async () => {
    const fake = `${'sk-' + 'ant-'}api03-${'A'.repeat(40)}`;
    const held = hook('/api/intercom/hook/permission', { tool_name: 'Bash', tool_input: { command: `curl -H "x-api-key: ${fake}" https://api.example` } });
    const s = await waitFor(station, (x) => x.approvals?.length === 1);
    expect(JSON.stringify(s)).not.toContain(fake);
    await human(`/intercom/approvals/${s.approvals[0].id}`, { decision: 'deny' });
    await held;
  });
});

describe('mission control: the live line', () => {
  it('a tool start is the activity; the turn end clears it and keeps the final words', async () => {
    expect(await station()).toMatchObject({ activity: null, lastResult: null, approvals: [] });
    await hook('/api/intercom/hook/activity', { phase: 'tool', tool_name: 'Bash', tool_input: { command: 'npm test\n--watch' } });
    expect((await station()).activity).toMatchObject({ text: 'Bash: npm test' });
    await hook('/api/intercom/hook/activity', { phase: 'stop', message: 'All 40 tests pass.' });
    const s = await station();
    expect(s.activity).toBeNull();
    expect(s.lastResult).toMatchObject({ text: 'All 40 tests pass.' });
  });

  it('every change tells the hub to refetch (station.changed)', async () => {
    const seen: unknown[] = [];
    const off = app.deps.bus.on('intercom', (e) => { if (e.type === 'station.changed') seen.push(e.data); });
    await hook('/api/intercom/hook/activity', { phase: 'tool', tool_name: 'Read', tool_input: { file_path: `${repo}/a.md` } });
    off();
    expect(seen).toEqual([{ scopeId: 'default', agentId }]);
  });
});

describe('mission control: interrupt', () => {
  it('sends the agent\'s own Esc into its terminal', async () => {
    const write = vi.spyOn(app.deps.terminal, 'write');
    const r = await human(`/intercom/agents/${encodeURIComponent(agentId)}/interrupt`);
    expect(r.status).toBe(200);
    expect(write).toHaveBeenCalledWith(claudeKey(repo, '1'), '\x1b');
    expect((await human('/intercom/agents/nobody@x/interrupt')).status).toBe(404);
  });
});
