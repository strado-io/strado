import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { claudeKey, shellKey } from '../../src/services/terminalManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(__dirname, '../../hooks/bin/strado-mcp');

type Json = Record<string, any>;
export type McpClient = { call(method: string, params?: Json): Promise<Json>; notify(method: string, params?: Json): void; close(): Promise<void>; stderr(): string };

export function startMcp(env: Record<string, string | undefined>, cwd: string): McpClient {
  const merged: Record<string, string | undefined> = { ...process.env, STRADO_SERVER_SOCKET: undefined, STRADO_STATUS_PORT: undefined, STRADO_AGENT_TOKEN: undefined, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  const child: ChildProcess = spawn(process.execPath, [SHIM], { env: clean, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (m: Json) => void>();
  let buf = ''; let err = ''; let nextId = 0;
  child.stdout!.on('data', (c) => {
    buf += String(c);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  child.stderr!.on('data', (c) => { err += String(c); });
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`no reply to ${method} within 30 s`)); }, 30_000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    notify: (method, params) => { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    close: () => new Promise((resolve) => { child.once('close', () => resolve()); child.stdin!.end(); }),
    stderr: () => err,
  };
}

export const PREVIEW = ['preview_tabs', 'preview_status', 'preview_screenshot', 'preview_eval', 'preview_console', 'preview_network', 'preview_click', 'preview_fill', 'preview_navigate', 'preview_reload'];
export const INTERCOM = ['intercom_send', 'intercom_peers', 'intercom_inbox', 'intercom_diary', 'run_in_shell', 'read_tab', 'task_create', 'task_list', 'task_claim', 'task_done', 'task_release', 'intercom_escalate', 'intercom_ask', 'intercom_fork'];

describe('strado MCP server — protocol and preview tools', () => {
  let mcp: McpClient | null = null;
  afterEach(async () => { await mcp?.close(); mcp = null; });

  it('initialize names the server "strado"; tools/list has the preview tools first', async () => {
    mcp = startMcp({ STRADO_WORKTREE: '/nowhere' }, process.cwd());
    const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo).toEqual({ name: 'strado', version: '0.4.0' });
    mcp.notify('notifications/initialized');
    const list = await mcp.call('tools/list');
    const names = list.result.tools.map((t: Json) => t.name);
    expect(names.slice(0, 10)).toEqual(PREVIEW);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const t of list.result.tools) { expect(typeof t.description).toBe('string'); expect(t.inputSchema.type).toBe('object'); }
  });

  it('preview tools answer with the sandbox sentence when STRADO_SERVER_SOCKET is set, without touching the network', async () => {
    mcp = startMcp({ STRADO_SERVER_SOCKET: '/nonexistent/hook.sock', STRADO_SERVER: 'http://127.0.0.1:1' }, process.cwd());
    const r = await mcp.call('tools/call', { name: 'preview_tabs', arguments: {} });
    expect(r.result).toEqual({ content: [{ type: 'text', text: 'preview tools are not available inside a sandbox' }] });
  });

  it('preview tools report an unreachable server as an isError result', async () => {
    mcp = startMcp({ STRADO_SERVER: 'http://127.0.0.1:1', STRADO_WORKTREE: '/nowhere' }, process.cwd());
    const r = await mcp.call('tools/call', { name: 'preview_tabs', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('Strado server not reachable');
  });

  it('unknown tool → -32602', async () => {
    mcp = startMcp({}, process.cwd());
    const r = await mcp.call('tools/call', { name: 'nope', arguments: {} });
    expect(r.error).toEqual({ code: -32602, message: 'unknown tool nope' });
  });
});

describe('strado MCP server — intercom tools against a real app', () => {
  let tmp: string; let repo: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  let port: number; let tokClaude: string; let tokShell: string;
  let mcp: McpClient | null = null;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const shellEnv = () => ({ STRADO_STATUS_PORT: String(port), STRADO_AGENT_TOKEN: tokShell, STRADO_AGENT_ID: 'shell-1@repo', STRADO_WORKTREE: repo });
  const claudeEnv = () => ({ STRADO_STATUS_PORT: String(port), STRADO_AGENT_TOKEN: tokClaude, STRADO_AGENT_ID: 'claude-1@repo', STRADO_WORKTREE: repo });
  const callTool = async (name: string, args: Json = {}) => (await mcp!.call('tools/call', { name, arguments: args })).result;
  const textOf = (r: Json) => r.content[0].text as string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'strado-mcp-')));
    repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'a'), '1');
    await exec('git', ['add', '.'], { cwd: repo });
    await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    await app.inject({ method: 'POST', url: '/api/w/default/repos', payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' } });
    tokClaude = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    const shellK = shellKey(repo, '1');
    await deps.terminal.ensure(shellK, repo, { file: '/bin/sh', args: ['-i'] });
    tokShell = (await deps.agents.register({ key: shellK, cwd: repo, scopeId: 'default' })).token;
    const start = Date.now();
    while (!deps.terminal.snapshot(shellK).includes('$') && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 25));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });
  // The registry and the terminal manager flush state files on their own queues,
  // which app.close() does not await, so a file can land in homeStateDir while rm
  // is walking it (ENOTEMPTY). Retry rather than fail a passing test on teardown.
  const rmTmp = async () => {
    for (let i = 0; ; i++) {
      try { await fs.rm(tmp, { recursive: true, force: true }); return; } catch (err) {
        if (i >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  afterEach(async () => { await mcp?.close(); mcp = null; deps.terminal.killUnder(repo); await app.close(); await rmTmp(); });

  it('lists exactly 24 tools, intercom after preview', async () => {
    mcp = startMcp(shellEnv(), repo);
    const list = await mcp.call('tools/list');
    expect(list.result.tools.map((t: Json) => t.name)).toEqual([...PREVIEW, ...INTERCOM]);
  });

  it('peers marks the caller; send lands in the peer\'s pull with the right kind; reply without replyTo is an error', async () => {
    mcp = startMcp(shellEnv(), repo);
    const peers = textOf(await callTool('intercom_peers'));
    expect(peers).toMatch(/^shell-1@repo\s+shell\s+ready\s+\(you\)$/m);
    expect(peers).toMatch(/^claude-1@repo\s+claude\s+offline$/m);
    const sent = textOf(await callTool('intercom_send', { to: 'claude-1@repo', body: 'hello from mcp', kind: 'request' }));
    expect(sent).toMatch(/^sent [0-9A-HJKMNP-TV-Z]{26} to claude-1@repo \(request\)$/);
    const pulled = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: auth(tokClaude), payload: {} });
    expect(pulled.json().messages.map((m: Json) => [m.from.agentId, m.kind, m.body])).toEqual([['shell-1@repo', 'request', 'hello from mcp']]);
    const bad = await callTool('intercom_send', { to: 'claude-1@repo', body: 'x', kind: 'reply' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('replyTo');
    const ghost = await callTool('intercom_send', { to: 'ghost', body: 'x' });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0].text).toContain('no agent "ghost"');
  });

  it('inbox prints and acks; keep leaves them delivered; empty → no messages', async () => {
    mcp = startMcp(shellEnv(), repo);
    await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', body: 'first\nline two' } });
    const kept = textOf(await callTool('intercom_inbox', { keep: true }));
    expect(kept).toContain('── claude-1@repo · message · ');
    expect(kept).toContain('first\nline two\n');
    expect(deps.intercom.listScope('default').map((m) => m.state)).toEqual(['delivered']);
    expect(textOf(await callTool('intercom_inbox'))).toBe('no messages');          // inside the redelivery window
    await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokClaude), payload: { to: 'shell-1@repo', body: 'second' } });
    const drained = textOf(await callTool('intercom_inbox'));
    expect(drained).toContain('second');
    expect(deps.intercom.listScope('default').map((m) => [m.body, m.state])).toContainEqual(['second', 'acknowledged']);
  });

  it('diary renders a peer\'s recorded turns newest first; no turns → no turns recorded', async () => {
    mcp = startMcp(shellEnv(), repo);
    deps.intercom.recordTurns('default', 'claude-1@repo', 'sess-1', [
      { turnIndex: 0, prompt: 'fix the bug\nplease', promptTruncated: false, reply: 'done', replyTruncated: false, startedAt: 1_000, endedAt: 2_000 },
      { turnIndex: 1, prompt: 'thanks', promptTruncated: false, reply: 'np', replyTruncated: true, startedAt: 3_000, endedAt: 4_000 },
    ]);
    const d = textOf(await callTool('intercom_diary', { agent: 'claude-1@repo' }));
    expect(d.indexOf('turn 1')).toBeLessThan(d.indexOf('turn 0'));
    expect(d).toContain('> fix the bug\n> please\ndone');
    expect(d).toContain('np\n[truncated]');
    expect(textOf(await callTool('intercom_diary', { agent: 'shell-1@repo' }))).toBe('no turns recorded');
  });

  it('run_in_shell returns the output with a settled trailer; a non-shell target is the server\'s 400 text; read_tab returns lines and status', async () => {
    mcp = startMcp(claudeEnv(), repo);
    const r = textOf(await callTool('run_in_shell', { target: 'shell-1@repo', command: 'echo from-mcp' }));
    expect(r).toContain('\nfrom-mcp');
    expect(r).toMatch(/\n\[settled in \d+ ms\]$/);
    expect(r).not.toContain('__strado_done_');
    const bad = await callTool('run_in_shell', { target: 'claude-1@repo', command: 'echo x' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('target is not a shell tab');
    const capped = textOf(await callTool('run_in_shell', { target: 'shell-1@repo', command: 'sleep 4', timeoutMs: 1000 }));
    expect(capped).toMatch(/\[still running after \d+ ms — use read_tab to check on it\]$/);
    deps.terminal.write(shellKey(repo, '1'), '\x03');
    // 12, not 5: the capped `sleep 4` run below adds five lines of its own, so a
    // 5-line window no longer reaches back to the first command's output.
    const read = textOf(await callTool('read_tab', { agent: 'shell-1@repo', lines: 12 }));
    expect(read.endsWith('\n[running]')).toBe(true);
    expect(read).toContain('from-mcp');
  });

  it('without a token the intercom tools say so and the server stays up', async () => {
    mcp = startMcp({ STRADO_STATUS_PORT: String(port), STRADO_WORKTREE: repo }, repo);
    expect(textOf(await callTool('intercom_peers'))).toBe('this is not a Strado tab; open it from Strado to talk to peers');
    const list = await mcp.call('tools/list');
    expect(list.result.tools).toHaveLength(24);
  });

  it('an unreachable server is an isError with the transport message, never the token', async () => {
    mcp = startMcp({ STRADO_STATUS_PORT: '1', STRADO_AGENT_TOKEN: 'secret-token-value', STRADO_WORKTREE: repo }, repo);
    const r = await callTool('intercom_peers');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ECONNREFUSED|connect/);
    expect(r.content[0].text).not.toContain('secret-token-value');
  });

  it('tasks: create, list, claim, done through the tools; a second claim is an isError with the server reason', async () => {
    mcp = startMcp(claudeEnv(), repo);
    const c = await mcp.call('tools/call', { name: 'task_create', arguments: { title: 'write tests', ticketKey: 'FLT-1' } });
    const id = c.result.content[0].text.match(/^created (\S+): write tests$/)![1];
    const l = await mcp.call('tools/call', { name: 'task_list', arguments: {} });
    expect(l.result.content[0].text).toContain(`${id} · open · write tests`);
    expect(l.result.content[0].text).toContain('FLT-1');
    const cl = await mcp.call('tools/call', { name: 'task_claim', arguments: { id } });
    expect(cl.result.content[0].text).toBe(`claimed ${id}: write tests`);
    const shell = startMcp(shellEnv(), repo);
    try {
      const again = await shell.call('tools/call', { name: 'task_claim', arguments: { id } });
      expect(again.result.isError).toBe(true);
      expect(again.result.content[0].text).toContain('claimed by claude-1@repo');
    } finally { await shell.close(); }
    const d = await mcp.call('tools/call', { name: 'task_done', arguments: { id } });
    expect(d.result.content[0].text).toBe(`done ${id}: write tests`);
    const empty = await mcp.call('tools/call', { name: 'task_list', arguments: { status: 'open' } });
    expect(empty.result.content[0].text).toBe('no tasks');
  });

  it('intercom_escalate returns at once; the human resolution shows up in intercom_inbox with the escalation id', async () => {
    mcp = startMcp(claudeEnv(), repo);
    const e = await mcp.call('tools/call', { name: 'intercom_escalate', arguments: { title: 'db?', body: 'pg or sqlite' } });
    const id = e.result.content[0].text.match(/^escalated (\S+); the human will reply to your inbox$/)![1];
    deps.intercom.resolveEscalation('default', id, { agentId: 'human', executionId: 'human' }, 'sqlite');
    const inbox = await mcp.call('tools/call', { name: 'intercom_inbox', arguments: {} });
    expect(inbox.result.content[0].text).toContain(`── human · resolution · `);
    expect(inbox.result.content[0].text).toContain(`· re: escalation ${id}\nsqlite`);
  });

  it('intercom_ask blocks until the peer replies to the ask through intercom_send; a timeout retargets to the human', async () => {
    mcp = startMcp(claudeEnv(), repo);
    const shell = startMcp(shellEnv(), repo);
    try {
      const pending = mcp.call('tools/call', { name: 'intercom_ask', arguments: { to: 'shell-1@repo', body: 'ready?' } });
      await new Promise((r) => setTimeout(r, 300));
      const inbox = await shell.call('tools/call', { name: 'intercom_inbox', arguments: { keep: true } });
      const askId = inbox.result.content[0].text.match(/── claude-1@repo · ask · (\S+) ·/)![1];
      await shell.call('tools/call', { name: 'intercom_send', arguments: { to: 'claude-1@repo', kind: 'reply', replyTo: askId, body: 'yes' } });
      const answer = await pending;
      expect(answer.result.content[0].text).toBe('yes');
      const t = await mcp.call('tools/call', { name: 'intercom_ask', arguments: { to: 'shell-1@repo', body: 'again?', timeoutMs: 5000 } });
      expect(t.result.content[0].text).toMatch(/^\[no reply after 5 s — retargeted to the human; the answer will arrive in your inbox\]$/);
      expect(deps.intercom.listEscalations('default', { status: 'open' })[0]!.to).toBe('human');
    } finally { await shell.close(); }
  }, 20_000);

  it('intercom_fork queues a peer hand-over; delivering off the bus lands it in the target\'s inbox, and acking it accepts the fork', async () => {
    mcp = startMcp(claudeEnv(), repo);
    // claude-1@repo is registered but not live, so the source goes straight to
    // the diary fallback instead of being asked to summarise.
    const created = await mcp.call('tools/call', { name: 'intercom_fork', arguments: { to: 'shell-1@repo', notes: 'take over the parser fix' } });
    const createdText = created.result.content[0].text as string;
    const id = createdText.match(/^fork (\S+) queued → shell-1@repo$/)![1]!;
    expect(createdText).toBe(`fork ${id} queued → shell-1@repo`);

    await deps.forks.settle();

    const shell = startMcp(shellEnv(), repo);
    try {
      const inbox = await shell.call('tools/call', { name: 'intercom_inbox', arguments: {} });
      const body = inbox.result.content[0].text as string;
      expect(body).toContain('── strado · fork · ');
      expect(body).toContain('FORK HAND-OVER');
      expect(body).toContain('[reply with intercom_send to=strado kind=reply replyTo=');
    } finally { await shell.close(); }

    expect(deps.intercom.getFork('default', id).status).toBe('accepted');
  });
});
