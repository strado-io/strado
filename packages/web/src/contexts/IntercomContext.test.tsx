import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const peersFn = vi.hoisted(() => vi.fn());
const subscribe = vi.hoisted(() => vi.fn());
const subscribeTabs = vi.hoisted(() => vi.fn());

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { intercom: { peers: peersFn } } };
});
vi.mock('../eventStream', async () => {
  const actual = await vi.importActual<typeof import('../eventStream')>('../eventStream');
  return { ...actual, subscribeIntercom: subscribe, subscribeWorktrees: subscribeTabs };
});

import { IntercomProvider, useIntercom } from './IntercomContext';

function Probe() {
  const s = useIntercom();
  return <div>{s.loaded ? `peers:${s.peers.length}` : 'loading'}</div>;
}
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

beforeEach(() => { peersFn.mockReset().mockResolvedValue([]); subscribe.mockReset().mockReturnValue(() => {}); subscribeTabs.mockReset().mockReturnValue(() => {}); });

describe('IntercomProvider (peers only)', () => {
  it('loads the peers once and subscribes to the workspace stream', async () => {
    peersFn.mockResolvedValue([{ agentId: 'claude-1@repo', live: true }]);
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('peers:1');
    expect(peersFn).toHaveBeenCalledWith('default');
    expect(subscribe).toHaveBeenCalledWith('default', expect.any(Function));
  });

  it('refreshes peers on tab changes and unsubscribes on unmount', async () => {
    const stop = vi.fn();
    subscribeTabs.mockReturnValue(stop);
    const { unmount } = render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('peers:0');
    peersFn.mockResolvedValue([{ agentId: 'claude-1@repo', live: true }]);
    await act(async () => { subscribeTabs.mock.calls[0]![0]({ type: 'worktree.updated', data: { path: '/repo', claudeSessions: ['1'] } }); });
    await tick();
    await screen.findByText('peers:1');
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('a burst of intercom events (peer, call, task) inside the debounce window refetches once', async () => {
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('peers:0');
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    act(() => {
      handler({ type: 'peer.registered', data: { scopeId: 'default', agentId: 'codex-1@repo', executionId: 'x' } });
      handler({ type: 'escalation.opened', data: { scopeId: 'default', id: 'E1' } });
      handler({ type: 'task.created', data: { scopeId: 'default', id: 'T1' } });
    });
    await tick();
    expect(peersFn).toHaveBeenCalledTimes(2);
  });

  it('feed.changed (a new message on the line) refetches nothing here — the Dock feed handles it', async () => {
    render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    await screen.findByText('peers:0');
    const handler = subscribe.mock.calls[0]![1] as (e: unknown) => void;
    act(() => { handler({ type: 'feed.changed', data: { scopeId: 'default' } }); });
    await tick();
    expect(peersFn).toHaveBeenCalledTimes(1);
  });

  it('resets and refetches when wsId changes; a slow fetch from the old workspace is dropped', async () => {
    let resolveOld!: (value: unknown) => void;
    peersFn.mockImplementation((ws: string) => (ws === 'default' ? new Promise((res) => { resolveOld = res; }) : Promise.resolve([{ agentId: 'a' }, { agentId: 'b' }])));
    const { rerender } = render(<IntercomProvider wsId="default"><Probe /></IntercomProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    rerender(<IntercomProvider wsId="other"><Probe /></IntercomProvider>);
    await screen.findByText('peers:2');
    await act(async () => { resolveOld([{ agentId: 'old' }]); await Promise.resolve(); });
    expect(screen.getByText('peers:2')).toBeInTheDocument();
    expect(peersFn).toHaveBeenCalledWith('other');
  });

  it('useIntercom throws outside the provider', () => {
    expect(() => render(<Probe />)).toThrow('useIntercom must be inside <IntercomProvider>');
  });
});
