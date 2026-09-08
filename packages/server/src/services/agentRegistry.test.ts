import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRegistry, type AgentRegistry } from './agentRegistry.js';
import { claudeKey, codexKey, opencodeKey, piKey, shellKey, type LiveSession, type TerminalManager, type TerminalInfo } from './terminalManager.js';
import { createClaudeStatusStore } from './claudeStatusStore.js';
import { createEventBus } from '../events/bus.js';
import { ASK_TIMEOUT_MAX_MS, WORKING_STALE_OUTPUT_MS } from './intercomSchema.js';

let dir: string;
let live: Map<string, TerminalInfo>;
let reg: AgentRegistry;

/** Minimal manager: only status() and liveSessions() are consulted. */
function fakeTerminal(): TerminalManager {
  const parse = (k: string): LiveSession => {
    const [p, suffix] = k.split('\0');
    if (!suffix) return { path: p!, mode: 'claude', id: '1' };
    const [m, id] = suffix.split(':');
    return { path: p!, mode: m as LiveSession['mode'], id: id ?? '1' };
  };
  return {
    status: (key) => live.get(key) ?? { status: 'exited', pid: null, exitCode: 0 },
    liveSessions: () => [...live.entries()].filter(([, i]) => i.status === 'running').map(([k]) => parse(k)),
    ensure: async () => ({ status: 'running', pid: 1, exitCode: null }),
    write: () => {}, resize: () => {}, snapshot: () => '', subscribe: () => () => {},
    onExit: () => () => {}, kill: () => {}, killUnder: () => {},
  };
}

let quietOutput = 0;   // ms since the fake PTY last printed, for the stale-`working` rule
async function makeRegistry(): Promise<AgentRegistry> {
  const bus = createEventBus();
  const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
  return createAgentRegistry({
    executionsFile: path.join(dir, 'agent-executions.json'),
    namesFile: path.join(dir, 'agent-names.json'),
    terminal: () => fakeTerminal(),
    statuses: () => s,
    quiet: () => ({ input: Infinity, output: quietOutput }),
  });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentreg-'));
  live = new Map();
  quietOutput = 0;
  reg = await makeRegistry();
});
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

const WT = '/home/u/wt/str-13';

describe('register / envFor / byToken', () => {
  it('mints an execution with derived id and a 43-char base64url token', async () => {
    const ex = await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    expect(ex.agentId).toBe('claude-1@str-13');
    expect(ex.scopeId).toBe('default');
    expect(ex.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ex.executionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('envFor carries id, scope, token and MCP_TOOL_TIMEOUT for a registered key', async () => {
    const prior = process.env.MCP_TOOL_TIMEOUT;
    delete process.env.MCP_TOOL_TIMEOUT;
    try {
      const ex = await reg.register({ key: shellKey(WT, '2'), cwd: WT, scopeId: 'default' });
      expect(reg.envFor(shellKey(WT, '2'), WT)).toEqual({
        STRADO_AGENT_ID: 'shell-2@str-13', STRADO_SCOPE_ID: 'default', STRADO_AGENT_TOKEN: ex.token,
        MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MAX_MS + 5000),
      });
    } finally {
      if (prior === undefined) delete process.env.MCP_TOOL_TIMEOUT; else process.env.MCP_TOOL_TIMEOUT = prior;
    }
  });

  it('envFor never overrides an MCP_TOOL_TIMEOUT the user already set', async () => {
    const prior = process.env.MCP_TOOL_TIMEOUT;
    process.env.MCP_TOOL_TIMEOUT = '30000';
    try {
      const ex = await reg.register({ key: shellKey(WT, '3'), cwd: WT, scopeId: 'default' });
      const env = reg.envFor(shellKey(WT, '3'), WT);
      expect(env).toEqual({ STRADO_AGENT_ID: 'shell-3@str-13', STRADO_SCOPE_ID: 'default', STRADO_AGENT_TOKEN: ex.token });
      expect(env.MCP_TOOL_TIMEOUT).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.MCP_TOOL_TIMEOUT; else process.env.MCP_TOOL_TIMEOUT = prior;
    }
  });

  it('envFor is empty for an unregistered key', () => {
    expect(reg.envFor(claudeKey(WT, '9'), WT)).toEqual({});
  });

  it('byToken resolves the current token and rejects unknown ones', async () => {
    const ex = await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    expect(reg.byToken(ex.token)?.executionId).toBe(ex.executionId);
    expect(reg.byToken('x'.repeat(43))).toBeNull();
    expect(reg.byToken('')).toBeNull();
  });

  it('register is a no-op while the key is running with an execution', async () => {
    const key = claudeKey(WT, '1');
    const a = await reg.register({ key, cwd: WT, scopeId: 'default' });
    live.set(key, { status: 'running', pid: 42, exitCode: null });
    const b = await reg.register({ key, cwd: WT, scopeId: 'default' });
    expect(b.executionId).toBe(a.executionId);
    expect(b.token).toBe(a.token);
  });

  it('register replaces the execution when the process is gone, invalidating the old token', async () => {
    const key = claudeKey(WT, '1');
    const a = await reg.register({ key, cwd: WT, scopeId: 'default' });
    // no live entry → status() says exited → respawn path
    const b = await reg.register({ key, cwd: WT, scopeId: 'default' });
    expect(b.executionId).not.toBe(a.executionId);
    expect(reg.byToken(a.token)).toBeNull();
    expect(reg.byToken(b.token)?.executionId).toBe(b.executionId);
  });

  it('release drops the execution and its token; releasing twice is harmless', async () => {
    const key = claudeKey(WT, '1');
    const ex = await reg.register({ key, cwd: WT, scopeId: 'default' });
    await reg.release(key);
    expect(reg.byToken(ex.token)).toBeNull();
    expect(reg.envFor(key, WT)).toEqual({});
    await expect(reg.release(key)).resolves.toBeUndefined();
  });

  it('emits peer.registered on register and peer.dropped on release, with ids but never the token', async () => {
    const key = claudeKey(WT, '1');
    const bus = createEventBus();
    const seen: { type: string; data: unknown }[] = [];
    bus.on('intercom', (e) => seen.push({ type: e.type, data: e.data }));
    const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
    const r = await createAgentRegistry({
      executionsFile: path.join(dir, 'e3.json'), namesFile: path.join(dir, 'n3.json'),
      terminal: () => fakeTerminal(), statuses: () => s, bus,
    });
    const ex = await r.register({ key, cwd: WT, scopeId: 'default' });
    await r.release(key);
    const peerEvents = seen.filter((e) => e.type.startsWith('peer.'));
    expect(peerEvents.map((e) => e.type)).toEqual(['peer.registered', 'peer.dropped']);
    expect(peerEvents[0]!.data).toEqual({ scopeId: 'default', agentId: 'claude-1@str-13', executionId: ex.executionId });
    expect(JSON.stringify(peerEvents)).not.toContain(ex.token);
  });

  it('release calls onDropped with agentStillLive false when it was the agent\'s only execution', async () => {
    const key = claudeKey(WT, '1');
    const dropped: { execution: { key: string }; agentStillLive: boolean }[] = [];
    const bus = createEventBus();
    const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
    const r = await createAgentRegistry({
      executionsFile: path.join(dir, 'e2.json'), namesFile: path.join(dir, 'n2.json'),
      terminal: () => fakeTerminal(), statuses: () => s,
      onDropped: (d) => dropped.push(...d),
    });
    await r.register({ key, cwd: WT, scopeId: 'default' });
    await r.release(key);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.execution.key).toBe(key);
    expect(dropped[0]!.agentStillLive).toBe(false);
  });
});

describe('persistence', () => {
  it('writes executions to a 0600 file and reloads them', async () => {
    const key = claudeKey(WT, '1');
    const ex = await reg.register({ key, cwd: WT, scopeId: 'default' });
    const file = path.join(dir, 'agent-executions.json');
    const mode = (await fsp.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    live.set(key, { status: 'running', pid: 42, exitCode: null });
    const reg2 = await makeRegistry();
    expect(reg2.byToken(ex.token)?.executionId).toBe(ex.executionId);
  });

  it('starts empty when the file is missing or corrupt', async () => {
    await fsp.writeFile(path.join(dir, 'agent-executions.json'), '{not json');
    const reg2 = await makeRegistry();
    expect(reg2.byToken('anything')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'agent-executions.json'))).toBe(true);
  });

  it('backs up a corrupt executions file before overwriting it', async () => {
    const file = path.join(dir, 'agent-executions.json');
    const garbage = '{not json';
    await fsp.writeFile(file, garbage);

    await makeRegistry();

    const entries = await fsp.readdir(dir);
    const backups = entries.filter((f) => f.startsWith('agent-executions.json.corrupt-'));
    expect(backups.length).toBe(1);
    expect(await fsp.readFile(path.join(dir, backups[0]!), 'utf8')).toBe(garbage);

    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ executions: [] });
    const mode = (await fsp.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('flush waits for a still-pending register write to land on disk', async () => {
    const key = claudeKey(WT, '1');
    // Not awaited: the write is queued in the registry's serialize chain.
    // flush() must wait for that queued write, not just the ones already
    // settled, so this deliberately races it.
    const pending = reg.register({ key, cwd: WT, scopeId: 'default' });
    await reg.flush();
    const ex = await pending;
    const file = path.join(dir, 'agent-executions.json');
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(onDisk.executions.some((e: { executionId: string }) => e.executionId === ex.executionId)).toBe(true);
  });
});

describe('reconcile', () => {
  it('drops executions whose key is not live', async () => {
    const key = claudeKey(WT, '1');
    const ex = await reg.register({ key, cwd: WT, scopeId: 'default' });
    // not in `live` → gone
    await reg.reconcile();
    expect(reg.byToken(ex.token)).toBeNull();
  });

  it('keeps executions for live keys', async () => {
    const key = claudeKey(WT, '1');
    const ex = await reg.register({ key, cwd: WT, scopeId: 'default' });
    live.set(key, { status: 'running', pid: 1, exitCode: null });
    await reg.reconcile();
    expect(reg.byToken(ex.token)?.executionId).toBe(ex.executionId);
  });

  it('mints an execution for a live key that has none, scoped "default"', async () => {
    const key = shellKey(WT, '4');
    live.set(key, { status: 'running', pid: 1, exitCode: null });
    await reg.reconcile();
    const env = reg.envFor(key, WT);
    expect(env.STRADO_AGENT_ID).toBe('shell-4@str-13');
    expect(env.STRADO_SCOPE_ID).toBe('default');
  });

  it('logs once per minted orphan, naming the key and the default scope', async () => {
    const key = shellKey(WT, '4');
    live.set(key, { status: 'running', pid: 1, exitCode: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await reg.reconcile();
      expect(warn).toHaveBeenCalledTimes(1);
      const [msg] = warn.mock.calls[0]!;
      expect(String(msg)).toContain(key);
      expect(String(msg)).toContain('default');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('register re-scoping an orphan', () => {
  it('re-scopes a running "default" execution to the real scope on next attach, keeping token/executionId', async () => {
    const key = shellKey(WT, '4');
    // Simulate reconcile minting an orphan under 'default'.
    const orphan = await reg.register({ key, cwd: WT, scopeId: 'default' });
    live.set(key, { status: 'running', pid: 1, exitCode: null });

    const attached = await reg.register({ key, cwd: WT, scopeId: 'ws1' });

    expect(attached.token).toBe(orphan.token);
    expect(attached.executionId).toBe(orphan.executionId);
    expect(attached.scopeId).toBe('ws1');
    expect(attached.agentId).toBe('shell-4@str-13');

    const inWs1 = (await reg.list('ws1')).map((a) => a.agentId);
    expect(inWs1).toContain('shell-4@str-13');
    const inDefault = (await reg.list('default')).map((a) => a.agentId);
    expect(inDefault).not.toContain('shell-4@str-13');
  });
});

describe('slug assignment', () => {
  it('a second worktree with the same basename in one scope gets ~2', async () => {
    const a = await reg.register({ key: claudeKey('/x/app', '1'), cwd: '/x/app', scopeId: 'default' });
    const b = await reg.register({ key: claudeKey('/y/app', '1'), cwd: '/y/app', scopeId: 'default' });
    expect(a.agentId).toBe('claude-1@app');
    expect(b.agentId).toBe('claude-1@app~2');
  });

  it('the assignment survives release and restart; deleting the first does not renumber the second', async () => {
    await reg.register({ key: claudeKey('/x/app', '1'), cwd: '/x/app', scopeId: 'default' });
    await reg.register({ key: claudeKey('/y/app', '1'), cwd: '/y/app', scopeId: 'default' });
    await reg.release(claudeKey('/x/app', '1'));
    await reg.release(claudeKey('/y/app', '1'));
    const reg2 = await makeRegistry();
    const b = await reg2.register({ key: shellKey('/y/app', '1'), cwd: '/y/app', scopeId: 'default' });
    expect(b.agentId).toBe('shell-1@app~2');
  });

  it('same basename in different scopes does not collide', async () => {
    const a = await reg.register({ key: claudeKey('/x/app', '1'), cwd: '/x/app', scopeId: 'ws1' });
    const b = await reg.register({ key: claudeKey('/y/app', '1'), cwd: '/y/app', scopeId: 'ws2' });
    expect(a.agentId).toBe('claude-1@app');
    expect(b.agentId).toBe('claude-1@app');
  });
});

describe('list', () => {
  it('reports lifecycle from the manager and status stores', async () => {
    const bus = createEventBus();
    const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
    const r = await createAgentRegistry({
      executionsFile: path.join(dir, 'e.json'), namesFile: path.join(dir, 'n.json'),
      terminal: () => fakeTerminal(), statuses: () => s,
    });
    const k1 = claudeKey(WT, '1'), k2 = claudeKey(WT, '2'), k3 = shellKey(WT, '1'), k4 = codexKey(WT, '1');
    const k5 = codexKey(WT, '2'), k6 = opencodeKey(WT, '1'), k7 = piKey(WT, '1');
    for (const k of [k1, k2, k3, k4, k5, k6, k7]) await r.register({ key: k, cwd: WT, scopeId: 'default' });
    live.set(k1, { status: 'running', pid: 1, exitCode: null });
    live.set(k2, { status: 'running', pid: 2, exitCode: null });
    live.set(k3, { status: 'running', pid: 3, exitCode: null });
    // k4 not live → offline
    for (const k of [k5, k6, k7]) live.set(k, { status: 'running', pid: 5, exitCode: null });
    s.claude.set(WT, 'working', '1');
    s.claude.set(WT, 'waiting', '2');
    // The hook-less harnesses post `waiting` when a turn ends — that is idle, not a prompt.
    s.codex.set(WT, 'waiting', '2');
    s.opencode.set(WT, 'waiting', '1');
    s.pi.set(WT, 'waiting', '1');
    const byId = Object.fromEntries((await r.list('default')).map((a) => [a.agentId, a]));
    expect(byId['claude-1@str-13']!.lifecycle).toBe('working');
    expect(byId['claude-2@str-13']!.lifecycle).toBe('needs_input');
    expect(byId['shell-1@str-13']!.lifecycle).toBe('ready');
    expect(byId['codex-1@str-13']!.lifecycle).toBe('offline');
    expect(byId['codex-1@str-13']!.live).toBe(false);
    expect(byId['codex-2@str-13']!.lifecycle).toBe('idle');
    expect(byId['opencode-1@str-13']!.lifecycle).toBe('idle');
    expect(byId['pi-1@str-13']!.lifecycle).toBe('idle');
    expect(byId['claude-1@str-13']!.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(byId)).not.toContain('token');
  });

  it('a hook-less harness marked working whose PTY has been silent for 20 s reads as idle; Claude does not', async () => {
    const codex = codexKey(WT, '3'), claude = claudeKey(WT, '3');
    await reg.register({ key: codex, cwd: WT, scopeId: 'default' });
    await reg.register({ key: claude, cwd: WT, scopeId: 'default' });
    live.set(codex, { status: 'running', pid: 1, exitCode: null });
    live.set(claude, { status: 'running', pid: 2, exitCode: null });
    // makeRegistry() builds its own stores; reach them through a fresh registry with shared stores instead.
    const bus = createEventBus();
    const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
    const r = await createAgentRegistry({
      executionsFile: path.join(dir, 'e4.json'), namesFile: path.join(dir, 'n4.json'),
      terminal: () => fakeTerminal(), statuses: () => s, quiet: () => ({ input: Infinity, output: quietOutput }),
    });
    await r.register({ key: codex, cwd: WT, scopeId: 'default' });
    await r.register({ key: claude, cwd: WT, scopeId: 'default' });
    s.codex.set(WT, 'working', '3');
    s.claude.set(WT, 'working', '3');
    const byId = async () => Object.fromEntries((await r.list('default')).map((a) => [a.agentId, a.lifecycle]));
    quietOutput = 500;                          // still painting → a real turn
    expect(await byId()).toMatchObject({ 'codex-3@str-13': 'working', 'claude-3@str-13': 'working' });
    quietOutput = WORKING_STALE_OUTPUT_MS;      // silent for 20 s → Codex is at its prompt; Claude has its own recovery
    expect(await byId()).toMatchObject({ 'codex-3@str-13': 'idle', 'claude-3@str-13': 'working' });
  });

  it('a fresh agent with no status yet is starting', async () => {
    const key = piKey(WT, '1');
    await reg.register({ key, cwd: WT, scopeId: 'default' });
    live.set(key, { status: 'running', pid: 1, exitCode: null });
    expect((await reg.list('default'))[0]!.lifecycle).toBe('starting');
  });

  it('a shell tab hosting an agent reports that agent status', async () => {
    const bus = createEventBus();
    const s = { claude: createClaudeStatusStore(bus), codex: createClaudeStatusStore(bus), opencode: createClaudeStatusStore(bus), pi: createClaudeStatusStore(bus) };
    const r = await createAgentRegistry({
      executionsFile: path.join(dir, 'e.json'), namesFile: path.join(dir, 'n.json'),
      terminal: () => fakeTerminal(), statuses: () => s,
    });
    const key = shellKey(WT, '2');
    await r.register({ key, cwd: WT, scopeId: 'default' });
    live.set(key, { status: 'running', pid: 1, exitCode: null });
    s.codex.set(WT, 'working', 'shell:2');
    expect((await r.list('default'))[0]!.lifecycle).toBe('working');
    s.codex.set(WT, 'waiting', 'shell:2');
    expect((await r.list('default'))[0]!.lifecycle).toBe('idle');   // a finished Codex turn, not a prompt
  });

  it('is scoped', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'a' });
    await reg.register({ key: claudeKey('/o/x', '1'), cwd: '/o/x', scopeId: 'b' });
    expect((await reg.list('a')).map((x) => x.agentId)).toEqual(['claude-1@str-13']);
  });
});

describe('setAlias / resolve', () => {
  it('sets, lists, clears', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    const a = await reg.setAlias('default', 'claude-1@str-13', 'Reviewer');
    expect(a.alias).toBe('Reviewer');
    expect((await reg.list('default'))[0]!.alias).toBe('Reviewer');
    expect((await reg.setAlias('default', 'claude-1@str-13', null)).alias).toBeNull();
  });

  it('rejects an invalid alias with VALIDATION', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'has space')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects the alias "human" (case-insensitive) with VALIDATION', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'human')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'Human')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('resolve("human") is always NOT_FOUND, never a real or aliased agent', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await expect(reg.resolve('default', 'human')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects the alias "strado" (case-insensitive) with VALIDATION, like "human"', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'strado')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'Strado')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('resolve("strado") is always NOT_FOUND: the fork sender is never a registered peer', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await expect(reg.resolve('default', 'strado')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reg.resolve('default', 'STRADO')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a case-insensitive duplicate in the same scope with CONFLICT', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await reg.register({ key: claudeKey(WT, '2'), cwd: WT, scopeId: 'default' });
    await reg.setAlias('default', 'claude-1@str-13', 'reviewer');
    await expect(reg.setAlias('default', 'claude-2@str-13', 'REVIEWER')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('re-setting the same alias on the same agent is fine', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await reg.setAlias('default', 'claude-1@str-13', 'reviewer');
    await expect(reg.setAlias('default', 'claude-1@str-13', 'reviewer')).resolves.toMatchObject({ alias: 'reviewer' });
  });

  it('unknown agent id in scope is NOT_FOUND, even if it exists in another scope', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'other' });
    await expect(reg.setAlias('default', 'claude-1@str-13', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('alias survives release + re-register (attached to the key)', async () => {
    const key = claudeKey(WT, '1');
    await reg.register({ key, cwd: WT, scopeId: 'default' });
    await reg.setAlias('default', 'claude-1@str-13', 'reviewer');
    await reg.release(key);
    await reg.register({ key, cwd: WT, scopeId: 'default' });
    expect((await reg.resolve('default', 'reviewer')).agentId).toBe('claude-1@str-13');
  });

  it('resolve: exact id first, then unique case-insensitive alias, never prefix', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await reg.setAlias('default', 'claude-1@str-13', 'reviewer');
    expect((await reg.resolve('default', 'claude-1@str-13')).agentId).toBe('claude-1@str-13');
    expect((await reg.resolve('default', 'REVIEWER')).agentId).toBe('claude-1@str-13');
    await expect(reg.resolve('default', 'review')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reg.resolve('default', 'Claude-1@str-13')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolve: a corrupted duplicate alias is CONFLICT, not a guess', async () => {
    await reg.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await reg.register({ key: claudeKey(WT, '2'), cwd: WT, scopeId: 'default' });
    // simulate a hand-edited names file
    const namesPath = path.join(dir, 'agent-names.json');
    await fsp.writeFile(namesPath, JSON.stringify({
      aliases: [
        { scopeId: 'default', key: claudeKey(WT, '1'), alias: 'dup' },
        { scopeId: 'default', key: claudeKey(WT, '2'), alias: 'DUP' },
      ],
      slugs: [{ scopeId: 'default', worktreePath: WT, slug: 'str-13' }],
    }));
    const reg2 = await makeRegistry();
    await reg2.register({ key: claudeKey(WT, '1'), cwd: WT, scopeId: 'default' });
    await reg2.register({ key: claudeKey(WT, '2'), cwd: WT, scopeId: 'default' });
    await expect(reg2.resolve('default', 'dup')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
