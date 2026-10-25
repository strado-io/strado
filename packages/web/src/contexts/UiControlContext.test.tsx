import { act, render } from '@testing-library/react';
import { useEffect, useState as ReactUseState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiCommandAck, UiTabRef } from '../api';
import type { UiCommand } from '../eventStream';

type Opts = { wsId: string; getState: () => { focused: boolean; worktreePath: string | null; visible: unknown[]; layout?: unknown }; onCommand: (c: UiCommand) => Promise<UiCommandAck> };
const ctl = vi.hoisted(() => ({ opts: null as null | Opts, stop: vi.fn(), notify: vi.fn() }));
vi.mock('../lib/uiControl', () => ({
  startUiControl: (o: Opts) => { ctl.opts = o; const s = Object.assign(() => ctl.stop(), { notify: ctl.notify }); return s; },
}));

import { readPaneLayouts } from '../hooks/paneLayout';
import { UI_COMMAND_BUDGET_MS, UiControlProvider, useJarvisActionHandler, useUiHubBridge, type JarvisActionHandler, type UiHubBridge } from './UiControlContext';

function JarvisHandler({ run }: { run: JarvisActionHandler }) {
  useJarvisActionHandler(run);
  return null;
}

function Hub({ bridge }: { bridge: UiHubBridge | null }) {
  useUiHubBridge(bridge);
  return null;
}
const ref = (mode: UiTabRef['mode'], sessionId: string, worktreePath = '/w/a'): UiTabRef => ({ worktreePath, mode, sessionId });
const place = (over: Record<string, unknown> = {}): UiCommand => ({ id: 'C1', op: 'place', args: { tab: ref('shell', '2'), split: 'right', anchor: ref('claude', '1'), focus: false, ...over } });
const bridgeFor = (path: string, apply = vi.fn().mockResolvedValue({ applied: true })): UiHubBridge & { apply: ReturnType<typeof vi.fn> } =>
  ({ path, visible: () => [ref('claude', '1', path)], layout: () => ({ panes: [] }), apply });

beforeEach(() => { localStorage.clear(); ctl.opts = null; ctl.stop.mockReset(); ctl.notify.mockReset(); (window as unknown as { strado?: unknown }).strado = {}; });
afterEach(() => { delete (window as unknown as { strado?: unknown }).strado; });

describe('UiControlProvider', () => {
  it('starts ui control for the workspace and stops on unmount', () => {
    const r = render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={null} /></UiControlProvider>);
    expect(ctl.opts!.wsId).toBe('ws1');
    r.unmount();
    expect(ctl.stop).toHaveBeenCalled();
  });

  it('state comes from the registered hub; none registered = no worktree', () => {
    const b = bridgeFor('/w/a');
    const r = render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={null} /></UiControlProvider>);
    expect(ctl.opts!.getState()).toMatchObject({ worktreePath: null, visible: [] });
    r.rerender(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={b} /></UiControlProvider>);
    expect(ctl.opts!.getState()).toMatchObject({ worktreePath: '/w/a', visible: [ref('claude', '1')], layout: { panes: [] } });
    expect(ctl.notify).toHaveBeenCalled();
  });

  it('a command for the worktree the hub shows goes to the hub', async () => {
    const b = bridgeFor('/w/a', vi.fn().mockResolvedValue({ applied: true, reason: 'anchor_not_visible' }));
    render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={b} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(place())).resolves.toEqual({ applied: true, reason: 'anchor_not_visible' });
    expect(b.apply).toHaveBeenCalledWith({ op: 'place', worktreePath: '/w/a', tab: ref('shell', '2'), split: 'right', anchor: ref('claude', '1'), focus: false }, expect.any(Number));
    // One deadline for the whole command, inside the server's 3 s ack wait.
    const deadline = b.apply.mock.calls[0]![1] as number;
    expect(deadline - Date.now()).toBeGreaterThan(2_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(UI_COMMAND_BUDGET_MS);
  });

  it('bad args and unknown ops ack applied:false without touching the hub', async () => {
    const b = bridgeFor('/w/a');
    render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={b} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(place({ split: 'diagonal' }))).resolves.toEqual({ applied: false, reason: 'bad_args' });
    await expect(ctl.opts!.onCommand({ id: 'C', op: 'nope', args: {} })).resolves.toEqual({ applied: false, reason: 'unsupported_op' });
    expect(b.apply).not.toHaveBeenCalled();
  });

  it('another worktree without focus updates the stored layout only', async () => {
    render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={bridgeFor('/w/other')} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(place())).resolves.toEqual({ applied: true, reason: 'stored' });
    expect(readPaneLayouts()['/w/a']).toHaveLength(1);
  });

  it('focus:true switches the window to the worktree, then applies through its hub once it registers', async () => {
    const target = bridgeFor('/w/a');
    function Switcher({ path }: { path: string | null }) {
      return <Hub bridge={path === '/w/a' ? target : null} />;
    }
    let setPath: (p: string) => void = () => undefined;
    function App() {
      const [path, set] = ReactUseState<string | null>(null);
      useEffect(() => { setPath = set; }, [set]);
      return <UiControlProvider wsId="ws1" openWorktree={(p) => { setTimeout(() => setPath(p), 10); return true; }}><Switcher path={path} /></UiControlProvider>;
    }
    render(<App />);
    const ack = ctl.opts!.onCommand(place({ focus: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await expect(ack).resolves.toEqual({ applied: true });
    expect(target.apply).toHaveBeenCalled();
  });

  it('focus:true for a worktree this window does not know acks unknown_worktree', async () => {
    render(<UiControlProvider wsId="ws1" openWorktree={() => false}><Hub bridge={null} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(place({ focus: true }))).resolves.toEqual({ applied: false, reason: 'unknown_worktree' });
  });

  it('browser.open outside the desktop app acks no_browser', async () => {
    delete (window as unknown as { strado?: unknown }).strado;
    render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={bridgeFor('/w/a')} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand({ id: 'C', op: 'browser.open', args: { worktreePath: '/w/a', url: 'https://x.dev' } })).resolves.toEqual({ applied: false, reason: 'no_browser' });
  });

  it('jarvis.action runs in the registered Jarvis handler and acks its result; none registered says so', async () => {
    const jarvisCmd: UiCommand = { id: 'J', op: 'jarvis.action', args: { action: 'tab.open', args: { mode: 'shell', worktree: 'api' } } };
    const r = render(<UiControlProvider wsId="ws1" openWorktree={() => true}><Hub bridge={null} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(jarvisCmd)).resolves.toEqual({ applied: false, reason: 'no_jarvis' });
    const run = vi.fn(async () => ({ ok: true, text: 'opened shell-3' }));
    r.rerender(<UiControlProvider wsId="ws1" openWorktree={() => true}><JarvisHandler run={run} /></UiControlProvider>);
    await expect(ctl.opts!.onCommand(jarvisCmd)).resolves.toEqual({ applied: true, result: { ok: true, text: 'opened shell-3' } });
    expect(run).toHaveBeenCalledWith({ action: 'tab.open', args: { mode: 'shell', worktree: 'api' } });
    await expect(ctl.opts!.onCommand({ id: 'J2', op: 'jarvis.action', args: { action: 7 } })).resolves.toEqual({ applied: false, reason: 'bad_args' });
  });
});
