import { beforeEach, describe, expect, it, vi } from 'vitest';

const jf = vi.hoisted(() => vi.fn());
vi.mock('./hubToken', () => ({ jarvisFetch: jf }));
const wt = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../../api', () => ({ api: { worktrees: wt } }));

import { createJarvisServerPort, scriptsContext } from './serverPort';

const tab = { worktreePath: '/w/a', mode: 'shell' as const, sessionId: '3', executionId: 'E3' };
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (i = 0) => JSON.parse(jf.mock.calls[i]![1].body as string);

beforeEach(() => { jf.mockReset(); wt.start.mockReset(); wt.stop.mockReset(); });

describe('Jarvis server port', () => {
  it('posts to the workspace jarvis routes through jarvisFetch, carrying the executionId', async () => {
    const port = createJarvisServerPort('ws 1');
    jf.mockResolvedValue(res(200, { ok: true }));
    await port.interrupt(tab);
    expect(jf.mock.calls[0]![0]).toBe('/api/w/ws%201/jarvis/interrupt');
    expect(jf.mock.calls[0]![1].method).toBe('POST');
    expect(bodyOf()).toEqual({ target: tab });
    await port.close(tab);
    expect(jf.mock.calls[1]![0]).toBe('/api/w/ws%201/jarvis/close');
  });
  it('409 tab_replaced reads as "that tab was replaced"; other errors carry the server message', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValueOnce(res(409, { error: { code: 'CONFLICT', message: 'x', details: { reason: 'tab_replaced' } } }));
    await expect(port.close(tab)).rejects.toThrow('That tab was closed and replaced');
    jf.mockResolvedValueOnce(res(404, { error: { code: 'NOT_FOUND', message: 'shell 3 is not live' } }));
    await expect(port.run(tab, 'ls')).rejects.toThrow('shell 3 is not live');
  });
  it('spawn returns the new tab with its executionId (no command: the box runs it after placing)', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValue(res(201, { agent: { agentId: 'shell-3@a', alias: null, mode: 'shell', worktreePath: '/w/a', sessionId: '3', executionId: 'E3' } }));
    await expect(port.spawn({ mode: 'shell', worktreePath: '/w/a' })).resolves.toEqual({ tab, agentId: 'shell-3@a' });
    expect(bodyOf()).toEqual({ mode: 'shell', worktreePath: '/w/a' });
  });
  it('run: an {error} result is a failure; an unsettled (long-running) command is fine', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValueOnce(res(200, { settled: false, output: 'vite ready', durationMs: 15000 }));
    await expect(port.run(tab, 'npm run dev')).resolves.toMatchObject({ settled: false });
    expect(bodyOf()).toEqual({ target: tab, command: 'npm run dev' });
    jf.mockResolvedValueOnce(res(200, { error: 'the user is typing in that tab' }));
    await expect(port.run(tab, 'ls')).rejects.toThrow('the user is typing in that tab');
  });
  it('scripts: fetched once per worktree and cached; a refresh refetches; a failure is empty, not an error', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockImplementation(async () => res(200, { packageManager: 'pnpm', scripts: ['dev', 'test'] }));
    expect(port.cachedScripts('/w/a')).toBeNull();
    await port.loadScripts('/w/a');
    await port.loadScripts('/w/a');
    expect(jf).toHaveBeenCalledTimes(1);
    expect(jf.mock.calls[0]![0]).toBe('/api/w/ws1/jarvis/scripts?worktreePath=%2Fw%2Fa');
    expect(port.cachedScripts('/w/a')).toEqual({ packageManager: 'pnpm', scripts: ['dev', 'test'] });
    await port.loadScripts('/w/a', { refresh: true });
    expect(jf).toHaveBeenCalledTimes(2);
    jf.mockResolvedValueOnce(res(400, { error: { code: 'VALIDATION', message: 'not a worktree' } }));
    await port.loadScripts('/w/b');
    expect(port.cachedScripts('/w/b')).toEqual({ packageManager: 'npm', scripts: [] });
  });
  it('scriptsContext turns script names into parser context with the package manager', () => {
    expect(scriptsContext({ packageManager: 'pnpm', scripts: ['dev', 'test'] })).toEqual({ packageManager: 'pnpm', packageScripts: { dev: 'pnpm run dev', test: 'pnpm run test' } });
    expect(scriptsContext(null)).toEqual({ packageScripts: {} });
  });
  it('message goes to the agent as the human; dev server start/stop use the worktree routes', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValue(res(201, { id: 'M1', to: { agentId: 'claude-1@a', alias: null } }));
    await port.message('claude-1@a', 'fix the test');
    expect(bodyOf()).toEqual({ to: 'claude-1@a', body: 'fix the test' });
    await port.startServer('/w/a', 'npm run dev', 'dev');
    await port.stopServer('/w/a');
    expect(wt.start).toHaveBeenCalledWith('ws1', '/w/a');
    expect(wt.stop).toHaveBeenCalledWith('ws1', '/w/a');
  });
});
