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
