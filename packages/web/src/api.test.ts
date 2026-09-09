import { describe, expect, it, vi, beforeEach } from 'vitest';
import { api } from './api';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/workspaces' && (!init || init.method === 'GET' || !init.method)) {
          return new Response(JSON.stringify({ activeWorkspaceId: null, workspaces: [] }), { status: 200 });
        }
        if (url === '/api/w/default/repos' && (!init || init.method === 'GET' || !init.method)) {
          return new Response(JSON.stringify({ repos: [] }), { status: 200 });
        }
        if (url === '/api/w/default/worktrees' && (!init || init.method === 'GET' || !init.method)) {
          return new Response(JSON.stringify({ worktrees: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ error: { code: 'VALIDATION', message: 'bad' } }),
          { status: 400 },
        );
      }),
    );
  });

  it('lists workspaces', async () => {
    const result = await api.workspaces.list();
    expect(result.activeWorkspaceId).toBeNull();
  });

  it('lists repos for a workspace', async () => {
    const result = await api.repos.list('default');
    expect(result).toEqual([]);
  });

  it('throws typed error on non-2xx', async () => {
    await expect(api.repos.add('default', {} as never)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('forwards ticketProvider when creating a remote worktree', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/w/default/remote-worktrees' && init?.method === 'POST') {
        return new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'bad' } }), { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.runners.createRemote('default', {
      runnerId: 'box-1',
      repoId: 'r',
      ticketId: 'ENG-9',
      ticketProvider: 'linear',
      title: 'Ship linear',
      sourceBranch: 'main',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ ticketProvider: 'linear' });
  });
});

describe('api.agentConfig', () => {
  function stubOk(body: unknown = { ok: true }) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  describe('agents', () => {
    it('builds the bare URL with no host', async () => {
      const fetchMock = stubOk({ agents: [] });
      await api.agentConfig.agents();
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/agents', expect.anything());
    });

    it('omits host when it is "local"', async () => {
      const fetchMock = stubOk({ agents: [] });
      await api.agentConfig.agents('local');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/agents', expect.anything());
    });

    it('sends a non-local host as a query param', async () => {
      const fetchMock = stubOk({ agents: [] });
      await api.agentConfig.agents('r1');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/agents?host=r1', expect.anything());
    });

    it('encodes a host id containing a slash', async () => {
      const fetchMock = stubOk({ agents: [] });
      await api.agentConfig.agents('r/1');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/agents?host=r%2F1', expect.anything());
    });
  });

  describe('read', () => {
    it('reads agent surfaces for a scope', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'global', surfaces: [] });
      await api.agentConfig.read('claude', { scope: 'global' });
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude?scope=global', expect.anything());
    });

    it('passes worktree and host through as query params, in order', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'project', surfaces: [] });
      await api.agentConfig.read('claude', { scope: 'project', worktree: '/wt/a', host: 'r1' });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agent-config/claude?scope=project&worktree=${encodeURIComponent('/wt/a')}&host=r1`,
        expect.anything(),
      );
    });

    it('omits worktree and host when absent', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'global', surfaces: [] });
      await api.agentConfig.read('claude', { scope: 'global' });
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).not.toContain('worktree=');
      expect(url).not.toContain('host=');
    });

    it('omits host when it is "local" but keeps worktree', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'project', surfaces: [] });
      await api.agentConfig.read('claude', { scope: 'project', worktree: '/wt/a', host: 'local' });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agent-config/claude?scope=project&worktree=${encodeURIComponent('/wt/a')}`,
        expect.anything(),
      );
    });

    it('encodes a worktree path with a slash and a space', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'project', surfaces: [] });
      const worktree = '/Users/x/my repo';
      await api.agentConfig.read('claude', { scope: 'project', worktree });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agent-config/claude?scope=project&worktree=${encodeURIComponent(worktree)}`,
        expect.anything(),
      );
    });

    it('encodes an agent id containing a space', async () => {
      const fetchMock = stubOk({ agent: 'my agent', scope: 'global', surfaces: [] });
      await api.agentConfig.read('my agent', { scope: 'global' });
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/my%20agent?scope=global', expect.anything());
    });
  });

  describe('patch', () => {
    const body = { surfaceId: 'mcp.foo', scope: 'global' as const, value: true };

    it('PATCHes with no host param when absent', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'global', surfaces: [] });
      await api.agentConfig.patch('claude', body);
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude', {
        method: 'PATCH',
        signal: expect.any(AbortSignal),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    });

    it('omits host when it is "local"', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'global', surfaces: [] });
      await api.agentConfig.patch('claude', body, 'local');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude', expect.objectContaining({ method: 'PATCH' }));
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).not.toContain('host=');
    });

    it('sends a non-local host as a query param', async () => {
      const fetchMock = stubOk({ agent: 'claude', scope: 'global', surfaces: [] });
      await api.agentConfig.patch('claude', body, 'r1');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude?host=r1', expect.objectContaining({ method: 'PATCH' }));
    });
  });

  describe('raw', () => {
    it('GETs with only file when worktree/host absent', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', text: 'hi' });
      await api.agentConfig.raw('claude', 'CLAUDE.md');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude/raw?file=CLAUDE.md', expect.anything());
    });

    it('appends worktree and host when present', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', text: 'hi' });
      await api.agentConfig.raw('claude', 'CLAUDE.md', { worktree: '/wt/a', host: 'r1' });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agent-config/claude/raw?file=CLAUDE.md&worktree=${encodeURIComponent('/wt/a')}&host=r1`,
        expect.anything(),
      );
    });

    it('omits host when it is "local"', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', text: 'hi' });
      await api.agentConfig.raw('claude', 'CLAUDE.md', { worktree: '/wt/a', host: 'local' });
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agent-config/claude/raw?file=CLAUDE.md&worktree=${encodeURIComponent('/wt/a')}`,
        expect.anything(),
      );
    });

    it('encodes a file path with a slash and a space', async () => {
      const fetchMock = stubOk({ file: 'a/b c.json', text: 'hi' });
      const file = 'a/b c.json';
      await api.agentConfig.raw('claude', file);
      expect(fetchMock).toHaveBeenCalledWith(`/api/agent-config/claude/raw?file=${encodeURIComponent(file)}`, expect.anything());
    });
  });

  describe('saveRaw', () => {
    it('PUTs with no host param when absent', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', saved: true });
      await api.agentConfig.saveRaw('claude', 'CLAUDE.md', 'new text');
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude/raw', {
        method: 'PUT',
        signal: expect.any(AbortSignal),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'CLAUDE.md', text: 'new text' }),
      });
    });

    it('omits host when it is "local"', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', saved: true });
      await api.agentConfig.saveRaw('claude', 'CLAUDE.md', 'new text', { host: 'local' });
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toBe('/api/agent-config/claude/raw');
    });

    it('sends a non-local host as a query param', async () => {
      const fetchMock = stubOk({ file: 'CLAUDE.md', saved: true });
      await api.agentConfig.saveRaw('claude', 'CLAUDE.md', 'new text', { host: 'r1' });
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-config/claude/raw?host=r1', expect.objectContaining({ method: 'PUT' }));
    });
  });
});

describe('api client request timeout', () => {
  it('aborts a hung request and throws a TIMEOUT error', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', fetchMock);

      const pending = api.repos.list('default');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves long-running calls like repo clone without a timeout', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', fetchMock);

      void api.repos.clone('default', 'git@host:g/p.git').then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
