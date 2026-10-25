import type { UiTabRef } from '../../api';
import { rememberClosedAgent } from '../../hooks/agentTabs';
import { readBrowserTabIds, rememberBrowserTab, rememberBrowserTabIds } from '../../hooks/browserTabs';
import { rememberActiveTab, tabKeyOf } from '../../hooks/tabOrder';
import type { JarvisHubPort, ResolvedPlace } from '../../lib/jarvis/execute';
import type { TabRef } from '../../lib/jarvis/types';
import { applyStoredBrowserOpen, applyStoredPlace } from '../../lib/uiCommands';

const keyOf = (tab: TabRef) => tabKeyOf({ mode: tab.mode, id: tab.sessionId });
const asUi = (p: ResolvedPlace) => ({ split: p.split, anchor: p.anchor as UiTabRef | null, focus: p.focus });

/** A hub port for a worktree no hub shows, so Focus Jarvis can lay it out
 * without moving the window: placements go to its stored layout, focus to its
 * stored active tab, a Browser tab to its stored Browser tabs. Opening the
 * worktree (a card's Open, or a later visit) shows it all as left. Undo is the
 * box's, never Jarvis's: there is nothing to snapshot. */
export function storedHubPort(path: string): JarvisHubPort {
  const activate = (tab: TabRef) => {
    if (tab.mode !== 'shell' && tab.mode !== 'browser') rememberClosedAgent(tab.mode, path, false);
    rememberActiveTab(path, keyOf(tab));
  };
  return {
    path,
    snapshot: () => null,
    restore: () => undefined,
    place: async (tab, place) => {
      if (tab.mode === 'browser') {
        if (place.focus) activate(tab);
        return { ok: true };
      }
      applyStoredPlace({ op: 'place', worktreePath: path, tab: tab as UiTabRef, ...asUi(place) });
      if (place.focus) activate(tab);
      return { ok: true };
    },
    focus: (tab) => {
      if (tab.worktreePath !== path) return false;
      activate(tab);
      return true;
    },
    openBrowser: async (url, place) => {
      // Browser tabs are desktop webviews; a plain browser window has none.
      if (!window.strado) return null;
      const ack = applyStoredBrowserOpen({ op: 'browser.open', worktreePath: path, url, place: place ? asUi(place) : null });
      const id = String((ack.result as { tabId?: string } | undefined)?.tabId ?? '1');
      const tab: TabRef = { worktreePath: path, mode: 'browser', sessionId: id };
      // A new Browser tab shows itself, as it does on screen: Open (or a later visit) lands on it.
      activate(tab);
      return tab;
    },
    closeLocal: (tab) => {
      if (tab.worktreePath !== path || tab.mode !== 'browser') return;
      if (tab.sessionId === '1') rememberBrowserTab(path, false);
      else rememberBrowserTabIds(path, (readBrowserTabIds()[path] ?? []).filter((id) => id !== tab.sessionId));
    },
  };
}
