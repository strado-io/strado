import type { PeerDto } from '../../api';
import type { RepoConfig, TabCardRef, Worktree } from '../../types';
import { uniqueWorktreeNames } from '../jarvis/jarvisContext';

export type CardMode = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell' | 'browser';
export type ResolvedCard =
  | { open: true; worktreePath: string; mode: CardMode; sessionId: string; busy: boolean;
      /** What the tab is doing, for the card's second line ("starting", "working", "needs you", "idle"); empty for a Browser tab. */
      status: string }
  | { open: false };

const CLOSED: ResolvedCard = { open: false };
// A tab stuck on "starting" is one that never came up (a trust or login screen): the card says so.
const STATUS: Record<string, string> = { starting: 'starting', working: 'working', needs_input: 'needs you', idle: 'idle', ready: 'idle' };

/** Finds a card's tab again in this window: the worktree by the name Jarvis
 * used (the same unique names its context gives it), the tab by its session
 * name ("claude-1"), alias, or either qualified with the worktree. A tab that
 * is no longer live is closed. Browser tabs aren't peers, so they are open
 * while their worktree is. */
export function resolveCard(card: TabCardRef, world: { worktrees: Worktree[]; repos: RepoConfig[]; peers: PeerDto[] }): ResolvedCard {
  // The exact path when the card has one; an older card only has the name.
  const names = uniqueWorktreeNames(world.worktrees, world.repos);
  const i = card.worktreePath
    ? world.worktrees.findIndex((x) => x.path === card.worktreePath)
    : names.findIndex((n) => n.toLowerCase() === card.worktree.toLowerCase());
  const w = i >= 0 ? world.worktrees[i] : undefined;
  if (!w) return CLOSED;
  const prefix = `${card.worktree.toLowerCase()}/`;
  const tab = card.tab.toLowerCase().startsWith(prefix) ? card.tab.slice(prefix.length) : card.tab;
  if (card.kind === 'browser') {
    const id = /^browser-(.+)$/i.exec(tab)?.[1] ?? tab;
    return { open: true, worktreePath: w.path, mode: 'browser', sessionId: id, busy: false, status: '' };
  }
  const want = tab.toLowerCase();
  const p = world.peers.find((x) => x.live && x.worktreePath === w.path && (
    `${x.mode}-${x.sessionId}`.toLowerCase() === want || x.agentId.split('@')[0]!.toLowerCase() === want || x.alias?.toLowerCase() === want));
  if (!p) return CLOSED;
  return { open: true, worktreePath: w.path, mode: p.mode, sessionId: p.sessionId, busy: p.lifecycle === 'working', status: p.attention === 'trust' ? 'needs you' : STATUS[p.lifecycle] ?? 'idle' };
}
