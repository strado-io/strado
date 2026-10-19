import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const peersFn = vi.hoisted(() => vi.fn());
const escList = vi.hoisted(() => vi.fn());
const taskList = vi.hoisted(() => vi.fn());
const escResolve = vi.hoisted(() => vi.fn());
const subscribe = vi.hoisted(() => vi.fn());
const subscribeTabs = vi.hoisted(() => vi.fn());

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { intercom: { peers: peersFn, escalations: { list: escList, resolve: escResolve, dismiss: vi.fn() }, tasks: { list: taskList, create: vi.fn(), assign: vi.fn(), release: vi.fn(), done: vi.fn(), cancel: vi.fn() } } } };
});
vi.mock('../eventStream', async () => {
  const actual = await vi.importActual<typeof import('../eventStream')>('../eventStream');
  return { ...actual, subscribeIntercom: subscribe, subscribeWorktrees: subscribeTabs };
});

import { IntercomProvider, useIntercom } from './IntercomContext';

function Probe() {
  const s = useIntercom();
  return <div>{s.loaded ? `open:${s.escalations.filter((e) => e.status === 'open').length} tasks:${s.tasks.length}` : 'loading'}</div>;
}

beforeEach(() => { peersFn.mockReset().mockResolvedValue([]); escList.mockReset().mockResolvedValue([]); taskList.mockReset().mockResolvedValue([]); escResolve.mockReset(); subscribe.mockReset().mockReturnValue(() => {}); subscribeTabs.mockReset().mockReturnValue(() => {}); });

describe('IntercomProvider', () => {
  it('refreshes peers on ordinary tab changes and unsubscribes on unmount', async () => {
    let ctx: ReturnType<typeof useIntercom> | null = null;
    function Grab() { ctx = useIntercom(); return null; }
    const stop = vi.fn();
    subscribeTabs.mockReturnValue(stop);
    const { unmount } = render(<IntercomProvider wsId="default"><Grab /></IntercomProvider>);
    await waitFor(() => expect(ctx?.loaded).toBe(true));
    peersFn.mockResolvedValue([{ agentId: 'claude-1@repo', live: true }]);
    await act(async () => {
      subscribeTabs.mock.calls[0]![0]({ type: 'worktree.updated', data: { path: '/repo', claudeSessions: ['1'] } });
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(ctx!.peers).toEqual([{ agentId: 'claude-1@repo', live: true }]);
    expect(escList).toHaveBeenCalledTimes(1);
    peersFn.mockResolvedValue([]);
    await act(async () => {
      subscribeTabs.mock.calls[0]![0]({ type: 'worktree.updated', data: { path: '/repo', claudeSessions: [] } });
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(ctx!.peers).toEqual([]);
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('loads the three collections once and subscribes to the workspace stream', async () => {
    escList.mockResolvedValue([{ id: 'E1', status: 'open' }]);
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('open:1 tasks:0');
    expect(peersFn).toHaveBeenCalledWith('default');
    expect(subscribe).toHaveBeenCalledWith('default', expect.any(Function));
  });
  it('an escalation event refetches only escalations; a task event only tasks', async () => {
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('open:0 tasks:0');
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    escList.mockResolvedValue([{ id: 'E1', status: 'open' }]);
    await act(async () => { handler({ type: 'escalation.opened', data: { scopeId: 'default', id: 'E1' } }); await new Promise((r) => setTimeout(r, 200)); });
    await screen.findByText('open:1 tasks:0');
    expect(taskList).toHaveBeenCalledTimes(1);
    taskList.mockResolvedValue([{ id: 'T1', status: 'open' }]);
    await act(async () => { handler({ type: 'task.created', data: { scopeId: 'default', id: 'T1' } }); await new Promise((r) => setTimeout(r, 200)); });
    await screen.findByText('open:1 tasks:1');
    expect(escList).toHaveBeenCalledTimes(2);
  });
  it('a peer.registered event refetches peers and nothing else', async () => {
    let ctx: ReturnType<typeof useIntercom> | null = null;
    function Grab() { ctx = useIntercom(); return null; }
    render(<IntercomProvider wsId="default"><Grab /></IntercomProvider>);
    await waitFor(() => expect(ctx?.loaded).toBe(true));
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    peersFn.mockResolvedValue([{ agentId: 'codex-1@repo', live: true }]);
    await act(async () => { handler({ type: 'peer.registered', data: { scopeId: 'default', agentId: 'codex-1@repo', executionId: 'x' } }); await new Promise((r) => setTimeout(r, 200)); });
    expect(ctx!.peers).toEqual([{ agentId: 'codex-1@repo', live: true }]);
    expect(peersFn).toHaveBeenCalledTimes(2);
    expect(escList).toHaveBeenCalledTimes(1);
    expect(taskList).toHaveBeenCalledTimes(1);
  });

  it('feed.changed (a new message on the line) refetches nothing here — the Dock feed handles it', async () => {
    let ctx: ReturnType<typeof useIntercom> | null = null;
    function Grab() { ctx = useIntercom(); return null; }
    render(<IntercomProvider wsId="default"><Grab /></IntercomProvider>);
    await waitFor(() => expect(ctx?.loaded).toBe(true));
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    await act(async () => { handler({ type: 'feed.changed', data: { scopeId: 'default' } }); await new Promise((r) => setTimeout(r, 200)); });
    expect(peersFn).toHaveBeenCalledTimes(1);
    expect(escList).toHaveBeenCalledTimes(1);
  });

  it('a burst of three task.* events inside the debounce window triggers exactly one tasks.list refetch', async () => {
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('open:0 tasks:0');
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    const callsBefore = taskList.mock.calls.length;
    taskList.mockResolvedValue([{ id: 'T1', status: 'open' }]);
    await act(async () => {
      handler({ type: 'task.created', data: { scopeId: 'default', id: 'T1' } });
      handler({ type: 'task.claimed', data: { scopeId: 'default', id: 'T1' } });
      handler({ type: 'task.released', data: { scopeId: 'default', id: 'T1' } });
      await new Promise((r) => setTimeout(r, 200));
    });
    await screen.findByText('open:0 tasks:1');
    expect(taskList.mock.calls.length - callsBefore).toBe(1);
  });
  it('resolve posts then refetches escalations', async () => {
    escList.mockResolvedValue([{ id: 'E1', status: 'open' }]);
    let ctx: ReturnType<typeof useIntercom> | null = null;
    function Grab() { ctx = useIntercom(); return null; }
    render(<IntercomProvider wsId="default"><Grab /></IntercomProvider>);
    await waitFor(() => expect(ctx?.loaded).toBe(true));
    escResolve.mockResolvedValue({ id: 'E1', status: 'resolved' });
    escList.mockResolvedValue([{ id: 'E1', status: 'resolved' }]);
    await act(async () => { await ctx!.resolve('E1', 'sqlite'); });
    expect(escResolve).toHaveBeenCalledWith('default', 'E1', 'sqlite');
    await waitFor(() => expect(ctx!.escalations[0]!.status).toBe('resolved'));
  });
  it('resets state and refetches when wsId changes', async () => {
    escList.mockResolvedValue([{ id: 'E1', status: 'open' }]);
    taskList.mockResolvedValue([{ id: 'T1', status: 'open' }]);
    const { rerender } = render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('open:1 tasks:1');
    escList.mockResolvedValue([{ id: 'E2', status: 'open' }, { id: 'E3', status: 'open' }]);
    taskList.mockResolvedValue([]);
    rerender(<IntercomProvider wsId="other"><Probe /></IntercomProvider>);
    // The switch blanks the surfaces before the new workspace's fetch resolves.
    expect(screen.getByText('loading')).toBeInTheDocument();
    // "other" has no tasks — proves `reset` actually blanked the previous
    // workspace's task instead of leaving it on screen.
    await screen.findByText('open:2 tasks:0');
    expect(escList).toHaveBeenCalledWith('other');
  });
  it('a slow fetch from the old workspace does not overwrite the new workspace', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldPromise = new Promise((res) => { resolveOld = res; });
    escList.mockImplementation((ws: string) => (ws === 'default' ? oldPromise : Promise.resolve([{ id: 'E-new', status: 'open' }])));
    const { rerender } = render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    rerender(<IntercomProvider wsId="other"><Probe /></IntercomProvider>);
    await screen.findByText('open:1 tasks:0');
    await act(async () => { resolveOld([{ id: 'E-old', status: 'open' }]); await Promise.resolve(); });
    // The stale "default" fetch resolved after the switch; it must not clobber "other"'s state.
    expect(screen.getByText('open:1 tasks:0')).toBeInTheDocument();
  });
  it('useIntercom throws outside the provider', () => {
    expect(() => render(<Probe />)).toThrow('useIntercom must be inside <IntercomProvider>');
  });
});
