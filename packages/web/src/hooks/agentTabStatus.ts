// Which status a tab shows. Agents launched by hand inside a Shell tab report
// under a `shell:<id>` session key, so a worktree's per-session map now mixes
// dedicated-tab ids ('1', '2', …) with Shell-hosted ones — and the worktree
// aggregate goes 'working' for either. Reading the aggregate per tab would let
// a Shell-hosted Claude light up the dedicated Claude tab, so these helpers
// keep the two namespaces apart.
export type AgentStatusValue = 'idle' | 'working' | 'waiting';
export type AgentMode = 'claude' | 'codex' | 'opencode';
export type StatusById = Record<string, AgentStatusValue> | undefined;

export const AGENT_MODES: AgentMode[] = ['claude', 'codex', 'opencode'];

/** Session key a Shell tab's hand-launched agents report under. */
export function shellAgentKey(shellId: string): string {
  return `shell:${shellId}`;
}

/**
 * Status of one dedicated agent tab, or undefined when nothing is known about
 * it. The aggregate is a fallback ONLY for pre-multi-session payloads that
 * carry no by-id map at all: once the map exists it is authoritative, and a tab
 * absent from it has no status of its own.
 */
export function agentTabStatus(
  id: string,
  byId: StatusById,
  aggregate?: AgentStatusValue,
): AgentStatusValue | undefined {
  if (byId) return byId[id];
  return id === '1' ? aggregate : undefined;
}

export type ShellHostedAgent = { mode: AgentMode; status: AgentStatusValue };

const HOSTED_RANK: Record<AgentStatusValue, number> = { working: 2, waiting: 1, idle: 0 };

/**
 * The agent a Shell tab is currently hosting, or null for a plain shell.
 * Presence in the map — not the status — is the signal: the launcher registers
 * the session when it starts the agent and the server drops it when the agent
 * exits, so a Claude sitting idle between turns is still open in that tab. The
 * busiest entry wins when a tab has hosted several agents.
 */
export function shellHostedAgent(
  shellId: string,
  byMode: Partial<Record<AgentMode, StatusById>>,
): ShellHostedAgent | null {
  const key = shellAgentKey(shellId);
  let best: ShellHostedAgent | null = null;
  for (const mode of AGENT_MODES) {
    const status = byMode[mode]?.[key];
    if (status === undefined) continue;
    if (!best || HOSTED_RANK[status] > HOSTED_RANK[best.status]) best = { mode, status };
  }
  return best;
}
