// The state word carries meaning; colour only supports it.
export type AgentStateName = 'needs_you' | 'failed' | 'limited' | 'working' | 'idle' | 'offline';

/** At most `n` lines; a cut ends in "…". */
export function clampLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `${lines.slice(0, n).join('\n')}…`;
}
