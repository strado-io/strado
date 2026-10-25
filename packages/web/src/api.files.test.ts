import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const calls: string[] = [];
afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); });
const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); }));

describe('api.files', () => {
  it('local: under /api/w/<ws>/worktrees/<encoded path>/files/*', async () => {
    stub();
    await api.files.tree('ws 1', '/Users/me/wt', 'src/lib', { ignored: true });
    await api.files.tree('ws1', '/wt', '');
    await api.files.list('ws1', '/wt');
    await api.files.read('ws1', '/wt', 'src/a b.ts');
    await api.files.marks('ws1', '/wt', 'src/a.ts');
    expect(calls).toEqual([
      '/api/w/ws%201/worktrees/%2FUsers%2Fme%2Fwt/files/tree?dir=src%2Flib&ignored=1',
      '/api/w/ws1/worktrees/%2Fwt/files/tree?dir=',
      '/api/w/ws1/worktrees/%2Fwt/files/list',
      '/api/w/ws1/worktrees/%2Fwt/files/read?path=src%2Fa+b.ts',
      '/api/w/ws1/worktrees/%2Fwt/files/marks?path=src%2Fa.ts',
    ]);
  });

  it('remote: the same route on the runner, through its rpc proxy', async () => {
    stub();
    await api.files.read('ws1', '/home/u/wt', 'a.ts', { runnerId: 'r 1', remoteWsId: 'default' });
    const url = new URL(calls[0]!, 'http://x');
    expect(url.pathname).toBe('/api/runners/r%201/rpc');
    expect(url.searchParams.get('path')).toBe('/api/w/default/worktrees/%2Fhome%2Fu%2Fwt/files/read?path=a.ts');
  });
});
