import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { HUMAN } from '../../src/services/intercomStore';
import { claudeKey, shellKey } from '../../src/services/terminalManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(__dirname, '../../hooks/bin/strado');

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;
let port: number;
let tokClaude: string;
let tokShell: string;

async function makeRepo(): Promise<void> {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'strado-cli-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
}

type Run = { stdout: string; stderr: string; code: number | null };
function cli(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      STRADO_SERVER_SOCKET: undefined,
      STRADO_STATUS_PORT: String(port),
      STRADO_AGENT_TOKEN: tokShell,
      STRADO_AGENT_ID: 'shell-1@repo',
      ...env,
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
    const child = spawn(process.execPath, [SHIM, ...args], { env: clean, cwd: repo });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await makeRepo();
  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST', url: '/api/w/default/repos',
    payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
  });
  tokClaude = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
  tokShell = (await deps.agents.register({ key: shellKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});
afterEach(async () => { deps.terminal.killUnder(repo); await app.close(); await fs.rm(tmp, { recursive: true, force: true }); });

describe('strado CLI', () => {
  it('peers lists every agent in the tab\'s workspace and marks the caller', async () => {
    const r = await cli(['peers'], {});
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.startsWith('shell-1@repo'))).toMatch(/shell\s+offline\s+\(you\)$/);
    expect(lines.find((l) => l.startsWith('claude-1@repo'))).toMatch(/claude\s+offline$/);
  });

  it('send delivers from the shell tab; --request sets the kind; the id is printed', async () => {
    const r = await cli(['send', 'claude-1@repo', 'please', 'review', 'src/a.ts'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^sent [0-9A-HJKMNP-TV-Z]{26} → claude-1@repo\n$/);
    const req = await cli(['send', 'claude-1@repo', '--request', 'ready?'], {});
    expect(req.code).toBe(0);
    const pulled = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: auth(tokClaude), payload: {} });
    expect(pulled.json().messages.map((m: any) => [m.from.agentId, m.kind, m.body])).toEqual([
      ['shell-1@repo', 'message', 'please review src/a.ts'],
      ['shell-1@repo', 'request', 'ready?'],
    ]);
  });

  it('send --reply-to answers a request; --request and --reply-to together is a usage error', async () => {
    const req = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', kind: 'request', body: 'status?' } });
    const reqId = req.json().id;
    const r = await cli(['send', 'claude-1@repo', '--reply-to', reqId, 'all', 'green'], {});
    expect(r.code).toBe(0);
    const receipt = await app.inject({ method: 'GET', url: `/api/intercom/messages/${reqId}`, headers: auth(tokClaude) });
    expect(receipt.json().replyId).toBe(r.stdout.split(' ')[1]);
    const both = await cli(['send', 'claude-1@repo', '--request', '--reply-to', reqId, 'x'], {});
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('usage:');
  });

  it('inbox prints and acknowledges; --keep leaves messages queued; empty prints "no messages"', async () => {
    await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', body: 'first\nline two' } });
    await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', kind: 'request', body: 'second' } });
    const kept = await cli(['inbox', '--keep'], {});
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain('── claude-1@repo · message · ');
    expect(kept.stdout).toContain('first\nline two\n');
    expect(kept.stdout).toContain('── claude-1@repo · request · ');
    expect(kept.stdout).toContain('second\n');
    // --keep: pulled (delivered) but never acknowledged
    expect(deps.intercom.listScope('default').map((m) => m.state).sort()).toEqual(['delivered', 'delivered']);
    // Still inside the 5-minute redelivery window, so there is nothing new to pull.
    const empty = await cli(['inbox'], {});
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe('no messages\n');
    const third = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', body: 'third' } });
    expect(third.statusCode).toBe(201);
    const drained = await cli(['inbox'], {});
    expect(drained.code).toBe(0);
    expect(drained.stdout).toContain('── claude-1@repo · message · ');
    expect(drained.stdout).toContain('third\n');
    expect(deps.intercom.listScope('default').map((m) => [m.body, m.state])).toContainEqual(['third', 'acknowledged']);
  });

  it('inbox strips terminal escapes from peer-supplied text', async () => {
    // A peer could otherwise move the cursor or retitle the user's real tab.
    await app.inject({
      method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude),
      payload: { to: 'shell-1@repo', body: '\x1b[31mred\x1b[0m\x1b]0;evil\x07 text' },
    });
    const r = await cli(['inbox'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('red text');
    expect(r.stdout).not.toContain('\x1b');
    expect(r.stdout).not.toContain('evil');
  });

  it('exit 2 without a token or a server; exit 1 with the server\'s message on an unknown recipient', async () => {
    const noToken = await cli(['peers'], { STRADO_AGENT_TOKEN: undefined });
    expect(noToken.code).toBe(2);
    expect(noToken.stderr).toContain('STRADO_AGENT_TOKEN');
    const noServer = await cli(['peers'], { STRADO_STATUS_PORT: undefined });
    expect(noServer.code).toBe(2);
    expect(noServer.stderr).toContain('STRADO_SERVER_SOCKET or STRADO_STATUS_PORT');
    const ghost = await cli(['send', 'ghost', 'hi'], {});
    expect(ghost.code).toBe(1);
    expect(ghost.stderr).toMatch(/^error: .+\n$/);
    expect(ghost.stdout).toBe('');
    const usage = await cli([], {});
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('strado send <agent> <message...>');
    const unknown = await cli(['frobnicate'], {});
    expect(unknown.code).toBe(2);
  });

  it('task verbs: create prints the id, list shows it, claim/done/release round trip; usage errors exit 2', async () => {
    const c = await cli(['task', 'create', 'write', 'tests', '--ticket', 'FLT-1'], {});
    expect(c.code).toBe(0);
    const id = c.stdout.match(/^created (\S+): write tests\n$/)![1]!;
    const l = await cli(['task', 'list'], {});
    expect(l.stdout).toContain(`${id}  open  write tests`);
    expect(l.stdout).toContain('FLT-1');
    expect((await cli(['task', 'claim', id], {})).stdout).toBe(`claimed ${id}: write tests\n`);
    const again = await cli(['task', 'claim', id], { STRADO_AGENT_TOKEN: tokClaude, STRADO_AGENT_ID: 'claude-1@repo' });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('claimed by shell-1@repo');
    expect((await cli(['task', 'release', id], {})).stdout).toBe(`released ${id}: write tests\n`);
    expect((await cli(['task', 'claim', id], {})).code).toBe(0);
    expect((await cli(['task', 'done', id], {})).stdout).toBe(`done ${id}: write tests\n`);
    expect((await cli(['task'], {})).code).toBe(2);
    expect((await cli(['task', 'bogus'], {})).code).toBe(2);
  });

  it('escalate prints the id; ask blocks until the peer replies and exits 3 on timeout', async () => {
    const e = await cli(['escalate', 'db choice', '-m', 'pg or sqlite?'], {});
    expect(e.code).toBe(0);
    expect(e.stdout).toMatch(/^escalated \S+; the human will reply to your inbox\n$/);
    const pending = cli(['ask', 'claude-1@repo', 'ready?'], {});
    await new Promise((r) => setTimeout(r, 400));
    const ask = deps.intercom.listEscalations('default', { status: 'open' }).find((x) => x.to === 'claude-1@repo')!;
    deps.intercom.resolveEscalation('default', ask.id, { agentId: 'claude-1@repo', executionId: deps.agents.byKey(claudeKey(repo, '1'))!.executionId }, 'yes');
    const answer = await pending;
    expect(answer.code).toBe(0);
    expect(answer.stdout).toBe('yes\n');
    const t = await cli(['ask', 'claude-1@repo', 'again?', '--timeout', '5'], {});
    expect(t.code).toBe(3);
    expect(t.stderr).toContain('no reply after 5 s');
  }, 20_000);

  it('inbox renders a peer ask with the reply hint and a human resolution with its escalation id', async () => {
    const ask = await app.inject({
      method: 'POST', url: '/api/intercom/escalations', headers: auth(tokClaude),
      payload: { title: 'db choice', body: 'pg or sqlite?', to: 'shell-1@repo' },
    });
    expect(ask.statusCode).toBe(201);
    const askId = ask.json().escalation.askMessageId as string;

    const human = await app.inject({
      method: 'POST', url: '/api/intercom/escalations', headers: auth(tokShell),
      payload: { title: 'need a call', body: 'which one?' },
    });
    const humanEscId = human.json().escalation.id as string;
    deps.intercom.resolveEscalation('default', humanEscId, HUMAN, 'ok, go with the first');

    const r = await cli(['inbox', '--keep'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`── claude-1@repo · ask · ${askId} · `);
    expect(r.stdout).toContain('pg or sqlite?\n[reply with: strado send claude-1@repo <answer> --reply-to ' + askId + ']\n');
    expect(r.stdout).toContain(`· resolution · `);
    expect(r.stdout).toContain(`· re: escalation ${humanEscId}\n`);
    expect(r.stdout).toContain('ok, go with the first\n');
  });

  it('fork: queues a peer hand-over, prints the fork id, and shows up in the target\'s inbox with the reply hint; usage errors exit 2', async () => {
    // The target must be live, or delivery finds it "gone" and never ships the package.
    await deps.terminal.ensure(claudeKey(repo, '1'), repo, { file: '/bin/sh', args: ['-i'] });
    const r = await cli(['fork', 'claude-1@repo', '-m', 'take over'], {});
    expect(r.code).toBe(0);
    const id = r.stdout.match(/^fork (\S+) queued → claude-1@repo\n$/)![1]!;

    await deps.forks.settle();

    const inbox = await cli(['inbox'], { STRADO_AGENT_TOKEN: tokClaude, STRADO_AGENT_ID: 'claude-1@repo' });
    expect(inbox.code).toBe(0);
    expect(inbox.stdout).toContain('── strado · fork · ');
    expect(inbox.stdout).toContain('FORK HAND-OVER');
    expect(inbox.stdout).toContain(`[reply with: strado send strado <message> --reply-to `);
    expect(deps.intercom.getFork('default', id).status).toBe('accepted');

    expect((await cli(['fork'], {})).code).toBe(2);
    expect((await cli(['fork', 'claude-1@repo', '--new', 'codex'], {})).code).toBe(2);
    expect((await cli(['fork', '--new', 'bogus'], {})).code).toBe(2);
  });
});
