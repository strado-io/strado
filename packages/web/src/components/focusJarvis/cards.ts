import type { PeerDto } from '../../api';
import type { RepoConfig, TabCardRef, Worktree } from '../../types';
import { uniqueWorktreeNames } from '../jarvis/jarvisContext';

export type CardMode = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell' | 'browser';
export type ResolvedCard =
  | { open: true; worktreePath: string; mode: CardMode; sessionId: string; busy: boolean }
  | { open: false };

const CLOSED: ResolvedCard = { open: false };

/** Finds a card's tab again in this window: the worktree by the name Jarvis
 * used (the same unique names its context gives it), the tab by its session
 * name ("claude-1"), alias, or either qualified with the worktree. A tab that
 * is no longer live is closed. Browser tabs aren't peers, so they are open
 * while their worktree is. */
export function resolveCard(card: TabCardRef, world: { worktrees: Worktree[]; repos: RepoConfig[]; peers: PeerDto[] }): ResolvedCard {
  const names = uniqueWorktreeNames(world.worktrees, world.repos);
  const i = names.findIndex((n) => n.toLowerCase() === card.worktree.toLowerCase());
  const w = i >= 0 ? world.worktrees[i] : undefined;
  if (!w) return CLOSED;
  const prefix = `${card.worktree.toLowerCase()}/`;
  const tab = card.tab.toLowerCase().startsWith(prefix) ? card.tab.slice(prefix.length) : card.tab;
  if (card.kind === 'browser') {
    const id = /^browser-(.+)$/i.exec(tab)?.[1] ?? tab;
    return { open: true, worktreePath: w.path, mode: 'browser', sessionId: id, busy: false };
  }
  const want = tab.toLowerCase();
  const p = world.peers.find((x) => x.live && x.worktreePath === w.path && (
    `${x.mode}-${x.sessionId}`.toLowerCase() === want || x.agentId.split('@')[0]!.toLowerCase() === want || x.alias?.toLowerCase() === want));
  if (!p) return CLOSED;
  return { open: true, worktreePath: w.path, mode: p.mode, sessionId: p.sessionId, busy: p.lifecycle === 'working' };
}
