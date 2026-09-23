import { describe, expect, it, vi } from 'vitest';
import { createEventBus, type BusEvent } from '../events/bus.js';
import type { AgentRegistry, Execution } from './agentRegistry.js';
import { CODEX_MCP_ENV_VARS, agentSpawnSpec, codexConfigFlags, nextSessionId, spawnAgentTab } from './agentSpawn.js';
import { defaultShell } from './platform.js';
import { codexKey, parseSessionKey, type LiveSession, type SpawnSpec, type TerminalManager } from './terminalManager.js';

const live = (mode: LiveSession['mode'], path: string, id: string): LiveSession => ({ mode, path, id });

describe('nextSessionId', () => {
  it("returns '1' when the worktree has no session of that mode", () => {
    expect(nextSessionId([], 'codex', '/w')).toBe('1');
    expect(nextSessionId([live('claude', '/w', '3')], 'codex', '/w')).toBe('1');
    expect(nextSessionId([live('codex', '/other', '3')], 'codex', '/w')).toBe('1');
  });

  it('returns the max existing id for the (path, mode) pair plus one', () => {
    const sessions = [
      live('codex', '/w', '1'),
      live('codex', '/w', '4'),
      live('codex', '/w', '2'),
      live('claude', '/w', '9'),
      live('codex', '/other', '7'),
    ];
    expect(nextSessionId(sessions, 'codex', '/w')).toBe('5');
    expect(nextSessionId(sessions, 'claude', '/w')).toBe('10');
    expect(nextSessionId(sessions, 'codex', '/other')).toBe('8');
  });

  it('ignores ids that are not positive integers (a shell-hosted agent)', () => {
    expect(nextSessionId([live('codex', '/w', 'shell:2')], 'codex', '/w')).toBe('1');
  });
});

describe('agentSpawnSpec', () => {
  it('is undefined for claude — the manager builds the default spec', () => {
    expect(agentSpawnSpec('claude', '1', '/w')).toBeUndefined();
    expect(agentSpawnSpec('claude', '3', '/w')).toBeUndefined();
  });

  it('runs the shell bootstrap through a login shell for a shell tab', () => {
    expect(agentSpawnSpec('shell', '1', '/w')).toEqual({
      file: defaultShell(),
      args: ['-l', '-c', 'exec "$STRADO_SHELL_BOOTSTRAP"'],
    });
  });

  it('builds the codex command the terminal route builds, with notify and no resume for a secondary tab', () => {
    const spec = agentSpawnSpec('codex', '2', '/w') as SpawnSpec;
    expect(spec.file).toBe(defaultShell());
    expect(spec.args.slice(0, 2)).toEqual(['-l', '-c']);
    const command = spec.args[2]!;
    expect(command).toContain("codex -c 'notify=[");
    expect(command).toContain('"/w"');
    expect(command).not.toContain('resume --last');
  });

  it('registers the strado MCP server on the codex command line, forwarding the tab identity by name', () => {
    const flags = codexConfigFlags('/w');
    expect(flags).toMatch(/^-c 'notify=\["node",".*codex-notify-hook\.mjs","\d+","\/w"\]'/);
    expect(flags).toContain(`-c 'mcp_servers.strado.command="node"'`);
    expect(flags).toMatch(/-c 'mcp_servers\.strado\.args=\[".*\/strado-mcp\.mjs"\]'/);
    expect(flags).toContain(`-c 'mcp_servers.strado.env_vars=[${CODEX_MCP_ENV_VARS.map((n) => `"${n}"`).join(',')}]'`);
    for (const name of ['STRADO_AGENT_TOKEN', 'STRADO_STATUS_PORT', 'STRADO_SERVER_SOCKET', 'STRADO_WORKTREE']) {
      expect(CODEX_MCP_ENV_VARS).toContain(name);
    }
    // Names only: no value from the process environment leaks into the command.
    expect(flags).not.toContain('STRADO_AGENT_TOKEN=');
    // Both launch forms carry the same flags.
    expect(agentSpawnSpec('codex', '1', '/w')!.args[2]).toBe(`codex ${flags} resume --last || codex ${flags}`);
    expect(agentSpawnSpec('codex', '2', '/w')!.args[2]).toBe(`codex ${flags}`);
  });

  it('resumes the directory conversation for the primary codex, opencode and pi tabs only', () => {
    expect(agentSpawnSpec('codex', '1', '/w')!.args[2]).toContain('resume --last');
    expect(agentSpawnSpec('opencode', '1', '/w')!.args[2]).toContain('opencode --continue');
    expect(agentSpawnSpec('opencode', '2', '/w')!.args[2]).toBe('opencode');
    expect(agentSpawnSpec('pi', '1', '/w')!.args[2]).toContain('pi -c -e');
    expect(agentSpawnSpec('pi', '2', '/w')!.args[2]).not.toContain('-c -e');
  });
});

type Recorded = { key: string; cwd: string; spec: SpawnSpec | undefined; size: { cols: number; rows: number } | undefined };

function fakes(over: { registerThrows?: boolean; ensureThrows?: boolean; sessions?: LiveSession[] } = {}) {
  const ensured: Recorded[] = [];
  const registered: { key: string; cwd: string; scopeId: string }[] = [];
  const events: BusEvent[] = [];
  let sessions = over.sessions ?? [];
  const bus = createEventBus();
  bus.on('worktrees', (e) => events.push(e));
  const terminal = {
    liveSessions: () => sessions,
    ensure: async (key: string, cwd: string, spec?: SpawnSpec, size?: { cols: number; rows: number }) => {
      if (over.ensureThrows) throw new Error('pty refused');
      ensured.push({ key, cwd, spec, size });
      sessions = [...sessions, parseSessionKey(key)];
      return { status: 'running' as const, pid: 1, exitCode: null };
    },
  } as unknown as TerminalManager;
  const agents = {
    release: vi.fn().mockResolvedValue(undefined),
    register: async (input: { key: string; cwd: string; scopeId: string }): Promise<Execution> => {
      if (over.registerThrows) throw new Error('registry down');
      registered.push(input);
      return {
        key: input.key, scopeId: input.scopeId, agentId: 'codex-1@repo',
        executionId: 'ex1', token: 't', spawnedAt: '2026-09-07T00:00:00.000Z',
      };
    },
  } as unknown as AgentRegistry;
  return { ensured, registered, events, terminal, agents, bus };
}

describe('spawnAgentTab', () => {
  it('allocates distinct live tabs when two forks start concurrently', async () => {
    const f = fakes();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = spawnAgentTab({ ...f, installers: () => gate }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' });
    const second = spawnAgentTab({ ...f, installers: async () => {} }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' });
    await vi.waitFor(() => expect(f.registered).toHaveLength(1));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.sessionId)).toEqual(['1', '2']);
    expect(new Set(f.ensured.map((s) => s.key)).size).toBe(2);
  });

  it('releases a failed execution and allows the next spawn through', async () => {
    const options = { ensureThrows: true };
    const f = fakes(options);
    await expect(spawnAgentTab({ ...f, installers: async () => {} }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' })).rejects.toThrow('pty refused');
    expect(f.agents.release).toHaveBeenCalledWith(codexKey('/w', '1'));
    options.ensureThrows = false;
    await expect(spawnAgentTab({ ...f, installers: async () => {} }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' })).resolves.toMatchObject({ sessionId: '1' });
  });
  it('registers the execution before ensure, spawns at the default size and announces the worktree', async () => {
    const f = fakes();
    const order: string[] = [];
    const agents = {
      register: async (input: { key: string; cwd: string; scopeId: string }) => {
        order.push('register');
        return f.agents.register(input);
      },
    } as unknown as AgentRegistry;
    const terminal = {
      liveSessions: f.terminal.liveSessions,
      ensure: async (...args: Parameters<TerminalManager['ensure']>) => {
        order.push('ensure');
        return f.terminal.ensure(...args);
      },
    } as unknown as TerminalManager;

    const result = await spawnAgentTab({ terminal, agents, bus: f.bus }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' });

    expect(order).toEqual(['register', 'ensure']);
    expect(result.sessionId).toBe('1');
    expect(result.key).toBe(codexKey('/w', '1'));
    expect(result.execution.agentId).toBe('codex-1@repo');
    expect(f.registered).toEqual([{ key: codexKey('/w', '1'), cwd: '/w', scopeId: 'ws' }]);
    expect(f.ensured).toHaveLength(1);
    expect(f.ensured[0]!.key).toBe(codexKey('/w', '1'));
    expect(f.ensured[0]!.cwd).toBe('/w');
    expect(f.ensured[0]!.size).toEqual({ cols: 120, rows: 40 });
    expect(f.ensured[0]!.spec).toEqual(agentSpawnSpec('codex', '1', '/w'));
    const updated = f.events.find((e) => e.type === 'worktree.updated');
    expect(updated?.data).toMatchObject({ path: '/w', hasCodexSession: true, codexSessions: ['1'] });
  });

  it('honours a caller size and runs the best-effort installers', async () => {
    const f = fakes();
    let installed = 0;
    await spawnAgentTab(
      { terminal: f.terminal, agents: f.agents, bus: f.bus, installers: async () => { installed += 1; } },
      { wsId: 'ws', mode: 'codex', worktreePath: '/w', size: { cols: 80, rows: 24 } },
    );
    expect(installed).toBe(1);
    expect(f.ensured[0]!.size).toEqual({ cols: 80, rows: 24 });
  });

  it('never lets a failing installer stop the spawn', async () => {
    const f = fakes();
    await expect(spawnAgentTab(
      { terminal: f.terminal, agents: f.agents, bus: f.bus, installers: async () => { throw new Error('hooks broken'); } },
      { wsId: 'ws', mode: 'codex', worktreePath: '/w' },
    )).resolves.toMatchObject({ sessionId: '1' });
    expect(f.ensured).toHaveLength(1);
  });

  it('rejects when the pty cannot start', async () => {
    const f = fakes({ ensureThrows: true });
    await expect(spawnAgentTab({ terminal: f.terminal, agents: f.agents, bus: f.bus }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' }))
      .rejects.toThrow('pty refused');
  });

  it('picks the next free session id for the worktree', async () => {
    const f = fakes({ sessions: [live('codex', '/w', '1'), live('codex', '/w', '2')] });
    const result = await spawnAgentTab({ terminal: f.terminal, agents: f.agents, bus: f.bus }, { wsId: 'ws', mode: 'codex', worktreePath: '/w' });
    expect(result.sessionId).toBe('3');
    expect(result.key).toBe(codexKey('/w', '3'));
  });
});
