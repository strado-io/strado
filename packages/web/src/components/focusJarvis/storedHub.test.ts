import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { storedHubPort } from './storedHub';
import { readActiveTab } from '../../hooks/tabOrder';
import { readBrowserTabIds, readBrowserTabs, readBrowserUrls, previewKey } from '../../hooks/browserTabs';
import { readPaneLayouts, leafKeys } from '../../hooks/paneLayout';
import { readClosedAgents } from '../../hooks/agentTabs';

const P = '/w/api';
beforeEach(() => { localStorage.clear(); (window as unknown as { strado?: unknown }).strado = {}; });
afterEach(() => { delete (window as unknown as { strado?: unknown }).strado; });

describe('storedHubPort', () => {
  it('focus makes the tab the worktree\'s active one and un-closes an agent', () => {
    const hub = storedHubPort(P);
    expect(hub.focus({ worktreePath: P, mode: 'claude', sessionId: '2' })).toBe(true);
    expect(readActiveTab(P)).toEqual({ mode: 'claude', id: '2' });
    expect(readClosedAgents().claude.has(P)).toBe(false);
  });

  it('place stores the split beside the anchor, and focus:true makes it active', async () => {
    const hub = storedHubPort(P);
    hub.focus({ worktreePath: P, mode: 'claude', sessionId: '1' });
    const r = await hub.place({ worktreePath: P, mode: 'shell', sessionId: '3' }, { split: 'right', anchor: { worktreePath: P, mode: 'claude', sessionId: '1' }, focus: true }, Date.now() + 1000);
    expect(r).toEqual({ ok: true });
    expect(leafKeys(readPaneLayouts()[P]![0]!)).toEqual(['claude:1', 'shell:3']);
    expect(readActiveTab(P)).toEqual({ mode: 'shell', id: '3' });
  });

  it('openBrowser adds a Browser tab with its url and placement, and makes the new one active', async () => {
    const hub = storedHubPort(P);
    const first = await hub.openBrowser('http://localhost:3000', null, Date.now() + 1000);
    expect(first).toEqual({ worktreePath: P, mode: 'browser', sessionId: '1' });
    expect(readBrowserTabs().has(P)).toBe(true);
    expect(readBrowserUrls()[previewKey(P, '1')]).toBe('http://localhost:3000');
    expect(readActiveTab(P)).toEqual({ mode: 'browser', id: '1' });
    const second = await hub.openBrowser('http://localhost:4000', { split: 'tab', anchor: null, focus: false }, Date.now() + 1000);
    expect(second?.sessionId).toBe('2');
    expect(readBrowserTabIds()[P]).toEqual(['2']);
    expect(readActiveTab(P)).toEqual({ mode: 'browser', id: '2' });
  });

  it('no desktop app: no Browser tab', async () => {
    delete (window as unknown as { strado?: unknown }).strado;
    expect(await storedHubPort(P).openBrowser('http://x.dev', null, Date.now() + 1000)).toBeNull();
  });

  it('closeLocal drops a stored Browser tab of its own worktree', async () => {
    const hub = storedHubPort(P);
    await hub.openBrowser('http://a.dev', null, Date.now() + 1000);
    await hub.openBrowser('http://b.dev', null, Date.now() + 1000);
    hub.closeLocal({ worktreePath: P, mode: 'browser', sessionId: '2' });
    expect(readBrowserTabIds()[P] ?? []).toEqual([]);
    hub.closeLocal({ worktreePath: P, mode: 'browser', sessionId: '1' });
    expect(readBrowserTabs().has(P)).toBe(false);
  });
});
