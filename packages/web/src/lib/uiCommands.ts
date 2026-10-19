// Window side of app control: the server's `ui.command` ops (place,
// browser.open), validated here, applied by the hub when it shows the target
// worktree, or written straight to the stored layout when it doesn't.
import type { UiCommandAck, UiTabRef } from '../api';
import type { UiCommand } from '../eventStream';
import { rememberClosedAgent } from '../hooks/agentTabs';
import { previewKey, readBrowserTabIds, readBrowserTabs, rememberBrowserTab, rememberBrowserTabIds, rememberBrowserUrl } from '../hooks/browserTabs';
import { placeLeaf, readPaneLayouts, rememberPaneLayouts } from '../hooks/paneLayout';
import { readActiveTab, tabKeyOf } from '../hooks/tabOrder';

export type UiSplit = 'right' | 'down' | 'tab';
export type UiPlace = { split: UiSplit; anchor: UiTabRef | null; focus: boolean };
export type PlaceCmd = { op: 'place'; worktreePath: string; tab: UiTabRef } & UiPlace;
export type BrowserOpenCmd = { op: 'browser.open'; worktreePath: string; url: string; place: UiPlace | null };
export type ParsedUiCommand = PlaceCmd | BrowserOpenCmd;

const SPLITS = new Set<UiSplit>(['right', 'down', 'tab']);
const MODES = new Set<UiTabRef['mode']>(['claude', 'codex', 'opencode', 'pi', 'shell']);
const isSplit = (v: unknown): v is UiSplit => typeof v === 'string' && SPLITS.has(v as UiSplit);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function tabRef(v: unknown): UiTabRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (!nonEmpty(r.worktreePath) || !MODES.has(r.mode as UiTabRef['mode']) || !nonEmpty(r.sessionId)) return undefined;
  return { worktreePath: r.worktreePath, mode: r.mode as UiTabRef['mode'], sessionId: r.sessionId };
}
/** null/absent = no anchor; a malformed one = undefined (bad args). */
const optRef = (v: unknown): UiTabRef | null | undefined => (v == null ? null : tabRef(v));

/** The hub's key for a tab (`mode:id`). */
export const hubKeyOf = (ref: UiTabRef): string => tabKeyOf({ mode: ref.mode, id: ref.sessionId });
export const sameRef = (a: UiTabRef, b: UiTabRef): boolean => a.worktreePath === b.worktreePath && a.mode === b.mode && a.sessionId === b.sessionId;

export function parseUiCommand(cmd: UiCommand): { ok: true; cmd: ParsedUiCommand } | { ok: false; reason: string } {
  const a = cmd.args;
  if (cmd.op === 'place') {
    const tab = tabRef(a.tab);
    const anchor = optRef(a.anchor);
    if (!tab || !isSplit(a.split) || anchor === undefined) return { ok: false, reason: 'bad_args' };
    return { ok: true, cmd: { op: 'place', worktreePath: tab.worktreePath, tab, split: a.split, anchor, focus: a.focus === true } };
  }
  if (cmd.op === 'browser.open') {
    if (!nonEmpty(a.worktreePath) || typeof a.url !== 'string') return { ok: false, reason: 'bad_args' };
    let scheme: string;
    try { scheme = new URL(a.url).protocol; } catch { return { ok: false, reason: 'bad_url' }; }
    if (scheme !== 'http:' && scheme !== 'https:') return { ok: false, reason: 'bad_url' };
    let place: UiPlace | null = null;
    if (a.place != null) {
      const p = a.place as Record<string, unknown>;
      const anchor = typeof p === 'object' ? optRef(p.anchor) : undefined;
      if (!isSplit(p.split) || anchor === undefined) return { ok: false, reason: 'bad_args' };
      place = { split: p.split, anchor, focus: p.focus === true };
    }
    return { ok: true, cmd: { op: 'browser.open', worktreePath: a.worktreePath, url: a.url, place } };
  }
  return { ok: false, reason: 'unsupported_op' };
}

/** Browser tab 1 lives on the open flag; extras take the lowest free id. */
export function nextBrowserId(primaryOpen: boolean, extraIds: string[]): string {
  if (!primaryOpen) return '1';
  const used = new Set(['1', ...extraIds]);
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

/** Split `tabKey` beside the anchor in the stored layout — or, with no
 * anchor, beside the tab the worktree was last left on. An anchor in another
 * worktree can't be split against, so the tab just joins the strip. */
function storePlacement(path: string, tabKey: string, place: UiPlace): void {
  if (place.split === 'tab') return;
  const last = readActiveTab(path);
  const anchorKey = place.anchor ? (place.anchor.worktreePath === path ? hubKeyOf(place.anchor) : null) : last ? tabKeyOf(last) : null;
  if (!anchorKey) return;
  rememberPaneLayouts(path, placeLeaf(readPaneLayouts()[path] ?? [], tabKey, anchorKey, place.split));
}

/** `place` for a worktree no hub is showing: un-close the agent (an agent
 * asked for it explicitly) and store the split for the next time it opens. */
export function applyStoredPlace(cmd: PlaceCmd): UiCommandAck {
  if (cmd.tab.mode !== 'shell') rememberClosedAgent(cmd.tab.mode, cmd.worktreePath, false);
  storePlacement(cmd.worktreePath, hubKeyOf(cmd.tab), cmd);
  return { applied: true, reason: 'stored' };
}

/** `browser.open` for a worktree no hub is showing: persist the new tab, its url and placement. */
export function applyStoredBrowserOpen(cmd: BrowserOpenCmd): UiCommandAck {
  const path = cmd.worktreePath;
  const primaryOpen = readBrowserTabs().has(path);
  const extras = readBrowserTabIds()[path] ?? [];
  const id = nextBrowserId(primaryOpen, extras);
  if (id === '1') rememberBrowserTab(path, true);
  else rememberBrowserTabIds(path, [...extras, id].sort((a, b) => Number(a) - Number(b)));
  rememberBrowserUrl(previewKey(path, id), cmd.url);
  if (cmd.place) storePlacement(path, tabKeyOf({ mode: 'browser', id }), cmd.place);
  return { applied: true, reason: 'stored', result: { tabId: id } };
}
