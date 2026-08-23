// Agent (Claude/Codex/OpenCode) tabs the user has explicitly closed, persisted
// per worktree. Agent tabs are normally driven by server-side session detection
// and the hub's launch `mode`, so without this a closed tab would reappear on
// reload (mode defaults back to 'claude') or via a stale session snapshot.
// Cleared when the user opens that agent again. Broadcast so row icons / the
// sessions dock stay in sync.
type AgentMode = 'claude' | 'codex' | 'opencode';
type ClosedAgents = { claude: Set<string>; codex: Set<string>; opencode: Set<string> };

const KEY = 'strado:closed-agents';
const EVENT = 'strado:closed-agents';

export function readClosedAgents(): ClosedAgents {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<AgentMode, string[]>>;
    return {
      claude: new Set(raw.claude ?? []),
      codex: new Set(raw.codex ?? []),
      opencode: new Set(raw.opencode ?? []),
    };
  } catch {
    return { claude: new Set(), codex: new Set(), opencode: new Set() };
  }
}

export function rememberClosedAgent(mode: AgentMode, path: string, closed: boolean): void {
  const all = readClosedAgents();
  if (closed) all[mode].add(path);
  else all[mode].delete(path);
  localStorage.setItem(
    KEY,
    JSON.stringify({ claude: [...all.claude], codex: [...all.codex], opencode: [...all.opencode] }),
  );
  window.dispatchEvent(new Event(EVENT));
}
