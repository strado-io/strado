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

  it('search and code navigation: query flags, 1-based positions, the same rpc path for runners', async () => {
    stub();
    await api.files.search('ws1', '/wt', { q: 'a b', word: true, regex: true, glob: '*.ts' });
    await api.lsp.definition('ws1', '/wt', { path: 'src/a.ts', line: 3, col: 9 });
    await api.lsp.references('ws1', '/wt', { path: 'a.ts', line: 1, col: 1 });
    await api.lsp.hover('ws1', '/wt', { path: 'a.ts', line: 1, col: 2 });
    await api.lsp.outline('ws1', '/wt', 'a.ts');
    await api.lsp.definition('ws1', '/wt', { path: 'a.ts', line: 1, col: 2 }, { runnerId: 'r1', remoteWsId: 'default' });
    expect(calls.slice(0, 5)).toEqual([
      '/api/w/ws1/worktrees/%2Fwt/files/search?q=a+b&word=1&regex=1&glob=*.ts',
      '/api/w/ws1/worktrees/%2Fwt/lsp/definition?path=src%2Fa.ts&line=3&col=9',
      '/api/w/ws1/worktrees/%2Fwt/lsp/references?path=a.ts&line=1&col=1',
      '/api/w/ws1/worktrees/%2Fwt/lsp/hover?path=a.ts&line=1&col=2',
      '/api/w/ws1/worktrees/%2Fwt/lsp/outline?path=a.ts',
    ]);
    expect(new URL(calls[5]!, 'http://x').searchParams.get('path')).toBe('/api/w/default/worktrees/%2Fwt/lsp/definition?path=a.ts&line=1&col=2');
  });

  it('a caller\'s signal cancels the request', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      seen.push(init!.signal!);
      init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const ac = new AbortController();
    const p = api.lsp.hover('ws1', '/wt', { path: 'a.ts', line: 1, col: 1 }, undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(seen[0]!.aborted).toBe(true);
  });
});
