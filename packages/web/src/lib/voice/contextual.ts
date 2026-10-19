import type { ParseContext } from '../jarvis/types';

const MAX_NAMES = 100;

/** The names speech recognition is primed with, so "claude-1", "FD-9" or a
 * Focus name come back spelled as Strado knows them. Nearest first, capped. */
export function contextualNames(ctx: ParseContext): string[] {
  const names = [
    ...ctx.tabs.map((t) => t.label),
    ...ctx.peers.flatMap((p) => [p.agentId.split('@')[0]!, p.alias ?? '']),
    ...ctx.worktrees.flatMap((w) => [w.name, w.branch ?? '']),
    ...ctx.focuses.map((f) => f.name),
    ...(ctx.repos ?? []).map((r) => r.name),
    ...Object.keys(ctx.packageScripts),
  ];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, MAX_NAMES);
}
