import type { EventBus } from '../events/bus.js';

export type ClaudeStatus = 'idle' | 'working' | 'waiting';

export type ClaudeStatusStore = {
  /** sessionId defaults to '1' — the only session pre-multi-Claude */
  set(path: string, status: ClaudeStatus, sessionId?: string): void;
  /** worktree-level aggregate: any working → working, else any waiting → waiting */
  get(path: string): ClaudeStatus | undefined;
  /** reset one session (sessionId given) or every session of the path */
  clear(path: string, sessionId?: string): void;
  /** drop one session entirely — a Shell-hosted agent that has exited */
  remove(path: string, sessionId: string): void;
  /** per-session statuses, for the worktrees listing */
  sessions(path: string): Record<string, ClaudeStatus>;
  /** True while a namespaced Shell launcher has an agent process open. */
  active(path: string, sessionId: string): boolean;
};

// One store per agent kind; `field` names the property carried on
// worktree.updated events ('claudeStatus', 'codexStatus', or 'opencodeStatus').
// Each event also carries `${field}ById` — the per-session map — so the
// renderer can show a chip per tab while the sidebar keeps the aggregate.
export function createAgentStatusStore(
  bus: EventBus,
  field: 'claudeStatus' | 'codexStatus' | 'opencodeStatus',
): ClaudeStatusStore {
  const map = new Map<string, Map<string, ClaudeStatus>>();

  function aggregate(sessions: Map<string, ClaudeStatus> | undefined): ClaudeStatus {
    if (!sessions) return 'idle';
    let waiting = false;
    for (const s of sessions.values()) {
      if (s === 'working') return 'working';
      if (s === 'waiting') waiting = true;
    }
    return waiting ? 'waiting' : 'idle';
  }

  function emit(path: string) {
    const sessions = map.get(path);
    bus.emit('worktrees', {
      type: 'worktree.updated',
      data: {
        path,
        [field]: aggregate(sessions),
        [`${field}ById`]: Object.fromEntries(sessions ?? []),
      },
    });
  }

  return {
    set(path, status, sessionId = '1') {
      const sessions = map.get(path) ?? new Map<string, ClaudeStatus>();
      sessions.set(sessionId, status);
      map.set(path, sessions);
      emit(path);
    },
    get(path) {
      const sessions = map.get(path);
      return sessions ? aggregate(sessions) : undefined;
    },
    sessions(path) {
      return Object.fromEntries(map.get(path) ?? []);
    },
    // Presence, not busyness: the launcher registers the session when it
    // starts the agent and removes it when the agent exits, so an idle Claude
    // between turns is still very much open in that Shell tab.
    active(path, sessionId) {
      return map.get(path)?.has(sessionId) ?? false;
    },
    remove(path, sessionId) {
      const sessions = map.get(path);
      if (!sessions?.delete(sessionId)) return;
      emit(path);
    },
    clear(path, sessionId) {
      const sessions = map.get(path) ?? new Map<string, ClaudeStatus>();
      if (sessionId === undefined) {
        for (const id of sessions.keys()) sessions.set(id, 'idle');
        if (sessions.size === 0) sessions.set('1', 'idle');
      } else {
        sessions.set(sessionId, 'idle');
      }
      map.set(path, sessions);
      emit(path);
    },
  };
}

export function createClaudeStatusStore(bus: EventBus): ClaudeStatusStore {
  return createAgentStatusStore(bus, 'claudeStatus');
}
