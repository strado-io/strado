// Claude Code's folder-trust question, as a tab shows it before SessionStart
// (checked on Claude Code 2.1.310; fixture test/fixtures/claude-trust-screen.txt).
// The match is narrow on purpose: both the question and its "yes" answer must
// be on screen. No match means no "needs you", never a guess that blocks.
import type { AgentSummary } from './agentRegistry.js';
import { sessionKeyFor } from './terminalManager.js';
import { stripAnsi } from './terminalText.js';

const QUESTION = /Is this a project you created or one you trust\?/i;
const YES = /Yes, I trust this folder/i;

export function claudeTrustAsked(screen: string): boolean {
  const text = stripAnsi(screen).replace(/\s+/g, ' ');
  return QUESTION.test(text) && YES.test(text);
}

/** 'trust' while a live Claude tab that has not started yet shows the trust question. */
export function trustAttention(a: AgentSummary, snapshot: (key: string) => string): 'trust' | undefined {
  if (a.mode !== 'claude' || !a.live || a.lifecycle !== 'starting') return undefined;
  try {
    return claudeTrustAsked(snapshot(sessionKeyFor(a.mode, a.worktreePath, a.sessionId))) ? 'trust' : undefined;
  } catch {
    return undefined;
  }
}
