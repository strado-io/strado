import { randomUUID } from 'node:crypto';

// Server → window command channel for app control. Splits, focus and Browser
// tabs are client-only state (localStorage in the hub), so the server cannot
// apply them itself: it picks ONE connected window, writes a `ui.command` on
// that window's event stream, and waits a short while for the window's ack.
// Everything here is best-effort by design — an agent is never blocked on a
// window, and no window at all is an answer (`no_window`), not an error.

export const UI_ACK_TIMEOUT_MS = 3000;
/** A window that has not reported state for this long is still a target (its
 * stream is open), but loses every focus tie-break to one that has. */
export const UI_STATE_STALE_MS = 60_000;

/** `jarvis.action`: a Focus Jarvis action ({ action, args }), run by the window's own executor. */
export type UiOp = 'place' | 'browser.open' | 'jarvis.action';

export type UiCommand = { id: string; op: UiOp; args: Record<string, unknown> };

export type UiClientState = {
  focused: boolean;
  worktreePath: string | null;
  visibleKeys: string[];
  layout: unknown;
};

export type UiClient = UiClientState & {
  clientId: string;
  wsId: string;
  remote: boolean;
  connectedAt: number;
  lastFocusAt: number;
  lastStateAt: number;
};

export type UiDispatchResult = {
  applied: boolean;
  reason?: string;
  result?: Record<string, unknown>;
  clientId?: string;
};

export type UiAck = { applied: boolean; reason?: string; result?: Record<string, unknown> };

export type UiClients = {
  /** A window's event stream opened. `send` writes one `ui.command` event to it. */
  connect(input: { clientId: string; wsId: string; remote: boolean; send: (cmd: UiCommand) => void }): () => void;
  /** The window reported its state. False when the client is not connected (it should reconnect). */
  report(wsId: string, clientId: string, state: UiClientState): boolean;
  /** The window answered a command. False for an unknown, late, or foreign id. */
  ack(wsId: string, clientId: string, commandId: string, ack: UiAck): boolean;
  /** Which window a command would go to, or null. Preference: a window that
   * shows `preferKey` (the anchor tab), then one showing `preferWorktree` (the
   * worktree the command changes — its layout lives in that window's memory,
   * so another window writing it to storage would be overwritten), then the
   * most recently focused. */
  pick(wsId: string, preferKey?: string | null, preferWorktree?: string | null): UiClient | null;
  /** `opts.clientId`: only that window (closed → `window_closed`, no fallback);
   *  `opts.timeoutMs`: a longer ack wait for commands that do real work. */
  dispatch(wsId: string, op: UiOp, args: Record<string, unknown>, preferKey?: string | null, preferWorktree?: string | null, opts?: { clientId?: string; timeoutMs?: number }): Promise<UiDispatchResult>;
  list(wsId: string): UiClient[];
};

export type UiClientsDeps = {
  now?: () => number;
  ackTimeoutMs?: number;
  /** Relay/remote windows are skipped unless this says otherwise. */
  allowRemote?: () => boolean;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  newId?: () => string;
};

const defaultSchedule: NonNullable<UiClientsDeps['schedule']> = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

type Entry = UiClient & { send: (cmd: UiCommand) => void };
type Pending = { wsId: string; clientId: string; resolve: (r: UiDispatchResult) => void; timer: { cancel(): void } };

export function createUiClients(deps: UiClientsDeps = {}): UiClients {
  const now = deps.now ?? Date.now;
  const ackTimeoutMs = deps.ackTimeoutMs ?? UI_ACK_TIMEOUT_MS;
  const allowRemote = deps.allowRemote ?? (() => process.env.STRADO_UI_REMOTE === '1');
  const schedule = deps.schedule ?? defaultSchedule;
  const newId = deps.newId ?? randomUUID;
  const clients = new Map<string, Entry>();
  const pending = new Map<string, Pending>();

  const keyOf = (wsId: string, clientId: string) => `${wsId}\0${clientId}`;

  const settle = (id: string, r: UiDispatchResult): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.timer.cancel();
    p.resolve(r);
  };

  /** A stale reporter loses to a fresh one; then the most recent focus (a
   * focused window refreshes lastFocusAt on every report, so a window that
   * never sent its blur cannot win on a stale `focused` flag); then newest. */
  const rank = (a: Entry, b: Entry): number => {
    const t = now();
    const fresh = (c: Entry) => (t - c.lastStateAt <= UI_STATE_STALE_MS ? 1 : 0);
    return (fresh(b) - fresh(a)) || (b.lastFocusAt - a.lastFocusAt) || (b.connectedAt - a.connectedAt);
  };

  const pick: UiClients['pick'] = (wsId, preferKey, preferWorktree) => {
    const candidates = [...clients.values()].filter((c) => c.wsId === wsId && (!c.remote || allowRemote()));
    if (candidates.length === 0) return null;
    const showingKey = preferKey ? candidates.filter((c) => c.visibleKeys.includes(preferKey)) : [];
    const showingWorktree = preferWorktree ? candidates.filter((c) => c.worktreePath === preferWorktree) : [];
    const pool = showingKey.length > 0 ? showingKey : showingWorktree.length > 0 ? showingWorktree : candidates;
    return [...pool].sort(rank)[0] ?? null;
  };

  return {
    connect({ clientId, wsId, remote, send }) {
      const k = keyOf(wsId, clientId);
      const t = now();
      const entry: Entry = {
        clientId, wsId, remote, send, connectedAt: t, lastFocusAt: 0, lastStateAt: 0,
        focused: false, worktreePath: null, visibleKeys: [], layout: null,
      };
      clients.set(k, entry);
      return () => {
        // A reconnect with the same id replaced the entry; this close is stale.
        if (clients.get(k) !== entry) return;
        clients.delete(k);
        for (const [id, p] of pending) {
          if (p.wsId === wsId && p.clientId === clientId) settle(id, { applied: false, reason: 'window_closed', clientId });
        }
      };
    },
    report(wsId, clientId, state) {
      const c = clients.get(keyOf(wsId, clientId));
      if (!c) return false;
      const t = now();
      if (state.focused) c.lastFocusAt = t;
      c.focused = state.focused;
      c.worktreePath = state.worktreePath;
      c.visibleKeys = [...state.visibleKeys];
      c.layout = state.layout;
      c.lastStateAt = t;
      return true;
    },
    ack(wsId, clientId, commandId, a) {
      const p = pending.get(commandId);
      if (!p || p.wsId !== wsId || p.clientId !== clientId) return false;
      settle(commandId, { applied: a.applied, ...(a.reason ? { reason: a.reason } : {}), ...(a.result ? { result: a.result } : {}), clientId });
      return true;
    },
    pick,
    dispatch(wsId, op, args, preferKey, preferWorktree, opts = {}) {
      const target = opts.clientId !== undefined
        ? clients.get(keyOf(wsId, opts.clientId)) ?? null
        : pick(wsId, preferKey, preferWorktree) as Entry | null;
      if (!target) return Promise.resolve({ applied: false, reason: opts.clientId !== undefined ? 'window_closed' : 'no_window' });
      const id = newId();
      return new Promise<UiDispatchResult>((resolve) => {
        const timer = schedule(() => settle(id, { applied: false, reason: 'timeout', clientId: target.clientId }), opts.timeoutMs ?? ackTimeoutMs);
        pending.set(id, { wsId, clientId: target.clientId, resolve, timer });
        try {
          target.send({ id, op, args });
        } catch {
          settle(id, { applied: false, reason: 'window_closed', clientId: target.clientId });
        }
      });
    },
    list(wsId) {
      return [...clients.values()].filter((c) => c.wsId === wsId).sort(rank).map(({ send: _send, ...c }) => c);
    },
  };
}
