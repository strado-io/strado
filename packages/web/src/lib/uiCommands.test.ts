import { beforeEach, describe, expect, it } from 'vitest';
import { placeLeaf, readPaneLayouts } from '../hooks/paneLayout';
import { rememberActiveTab } from '../hooks/tabOrder';
import { readClosedAgents, rememberClosedAgent } from '../hooks/agentTabs';
import { readBrowserTabIds, readBrowserTabs, readBrowserUrls, rememberBrowserTab } from '../hooks/browserTabs';
import { applyStoredBrowserOpen, applyStoredPlace, hubKeyOf, nextBrowserId, parseUiCommand } from './uiCommands';

const ref = (mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi', sessionId: string, worktreePath = '/w/a') => ({ worktreePath, mode, sessionId });

const leaf = (key: string) => ({ kind: 'leaf' as const, key });

describe('placeLeaf', () => {
  it('splits the anchor leaf inside its layout: right = row, down = col', () => {
    const base = [{ kind: 'split' as const, dir: 'row' as const, ratio: 0.5, a: leaf('claude:1'), b: leaf('shell:1') }];
    expect(placeLeaf(base, 'shell:2', 'shell:1', 'down')).toEqual([
      { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('claude:1'), b: { kind: 'split', dir: 'col', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:2') } },
    ]);
  });
  it('an anchor that is a plain full-size tab starts a new split group', () => {
    expect(placeLeaf([], 'shell:2', 'claude:1', 'right')).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('claude:1'), b: leaf('shell:2') }]);
  });
  it('moves the new key out of any layout it already sat in', () => {
    const base = [{ kind: 'split' as const, dir: 'row' as const, ratio: 0.5, a: leaf('claude:1'), b: leaf('shell:2') }];
    expect(placeLeaf(base, 'shell:2', 'claude:1', 'down')).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: leaf('claude:1'), b: leaf('shell:2') }]);
  });
  it('placing a key next to itself is a no-op', () => {
    expect(placeLeaf([], 'shell:1', 'shell:1', 'right')).toEqual([]);
  });
});

describe('uiCommands', () => {
  beforeEach(() => localStorage.clear());

  it('hubKeyOf: a TabRef as the hub tab key', () => {
    expect(hubKeyOf(ref('claude', '1'))).toBe('claude:1');
    expect(hubKeyOf(ref('shell', '3'))).toBe('shell:3');
  });

  it('parseUiCommand validates place and browser.open, and names the target worktree', () => {
    expect(parseUiCommand({ id: 'C', op: 'place', args: { tab: ref('shell', '2'), split: 'right', anchor: ref('claude', '1'), focus: false } })).toEqual({
      ok: true, cmd: { op: 'place', worktreePath: '/w/a', tab: ref('shell', '2'), split: 'right', anchor: ref('claude', '1'), focus: false },
    });
    expect(parseUiCommand({ id: 'C', op: 'place', args: { tab: ref('shell', '2'), split: 'sideways', anchor: null } })).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseUiCommand({ id: 'C', op: 'place', args: { tab: { worktreePath: '/w/a', mode: 'vscode', sessionId: '1' }, split: 'tab' } })).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseUiCommand({ id: 'C', op: 'place', args: { tab: ref('shell', '2'), split: 'tab', anchor: { mode: 'shell' } } })).toEqual({ ok: false, reason: 'bad_args' });
    expect(parseUiCommand({ id: 'C', op: 'browser.open', args: { worktreePath: '/w/a', url: 'https://x.dev' } })).toEqual({
      ok: true, cmd: { op: 'browser.open', worktreePath: '/w/a', url: 'https://x.dev', place: null },
    });
    expect(parseUiCommand({ id: 'C', op: 'browser.open', args: { worktreePath: '/w/a', url: 'javascript:alert(1)' } })).toEqual({ ok: false, reason: 'bad_url' });
    expect(parseUiCommand({ id: 'C', op: 'browser.open', args: { worktreePath: '/w/a', url: 'http://localhost:5173', place: { split: 'down', anchor: ref('claude', '1'), focus: true } } })).toEqual({
      ok: true, cmd: { op: 'browser.open', worktreePath: '/w/a', url: 'http://localhost:5173', place: { split: 'down', anchor: ref('claude', '1'), focus: true } },
    });
    expect(parseUiCommand({ id: 'C', op: 'teleport', args: {} })).toEqual({ ok: false, reason: 'unsupported_op' });
  });

  it('nextBrowserId: 1 when the primary is closed, else the lowest free id', () => {
    expect(nextBrowserId(false, [])).toBe('1');
    expect(nextBrowserId(true, [])).toBe('2');
    expect(nextBrowserId(true, ['2', '4'])).toBe('3');
  });

  it('applyStoredPlace un-closes a user-closed agent and writes the split into the stored layout', () => {
    rememberClosedAgent('claude', '/w/a', true);
    const ack = applyStoredPlace({ op: 'place', worktreePath: '/w/a', tab: ref('claude', '2'), split: 'right', anchor: ref('shell', '1'), focus: false });
    expect(ack).toEqual({ applied: true, reason: 'stored' });
    expect(readClosedAgents().claude.has('/w/a')).toBe(false);
    expect(readPaneLayouts()['/w/a']).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('shell:1'), b: leaf('claude:2') }]);
  });

  it('applyStoredPlace with split tab, or an anchor in another worktree, leaves the layout alone', () => {
    expect(applyStoredPlace({ op: 'place', worktreePath: '/w/a', tab: ref('shell', '2'), split: 'tab', anchor: ref('claude', '1'), focus: false })).toEqual({ applied: true, reason: 'stored' });
    expect(applyStoredPlace({ op: 'place', worktreePath: '/w/a', tab: ref('shell', '2'), split: 'right', anchor: ref('claude', '1', '/w/b'), focus: false })).toEqual({ applied: true, reason: 'stored' });
    expect(readPaneLayouts()['/w/a']).toBeUndefined();
  });

  it('applyStoredPlace with a null anchor splits beside the worktree\'s last active tab', () => {
    rememberActiveTab('/w/a', 'claude:1');
    applyStoredPlace({ op: 'place', worktreePath: '/w/a', tab: ref('shell', '2'), split: 'down', anchor: null, focus: false });
    expect(readPaneLayouts()['/w/a']).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: leaf('claude:1'), b: leaf('shell:2') }]);
  });

  it('applyStoredBrowserOpen adds a Browser tab with the url and places it', () => {
    rememberBrowserTab('/w/a', true);
    const ack = applyStoredBrowserOpen({ op: 'browser.open', worktreePath: '/w/a', url: 'https://x.dev', place: { split: 'down', anchor: ref('claude', '1'), focus: false } });
    expect(ack).toEqual({ applied: true, reason: 'stored', result: { tabId: '2' } });
    expect(readBrowserTabIds()['/w/a']).toEqual(['2']);
    expect(readBrowserUrls()['/w/a\0browser:2']).toBe('https://x.dev');
    expect(readPaneLayouts()['/w/a']).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: leaf('claude:1'), b: leaf('browser:2') }]);
  });

  it('applyStoredBrowserOpen opens the primary Browser tab when none is open', () => {
    const ack = applyStoredBrowserOpen({ op: 'browser.open', worktreePath: '/w/a', url: 'https://x.dev', place: null });
    expect(ack).toEqual({ applied: true, reason: 'stored', result: { tabId: '1' } });
    expect(readBrowserTabs().has('/w/a')).toBe(true);
    expect(readBrowserUrls()['/w/a']).toBe('https://x.dev');
  });
});
