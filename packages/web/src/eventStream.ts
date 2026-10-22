import type { Worktree } from './types';
import type { ToolStatus } from './api';

export type WorktreeEvent = {
  type: 'worktree.updated';
  data: Partial<Worktree> & { path: string; removed?: boolean };
};

export function worktreesReducer(state: Worktree[], event: WorktreeEvent): Worktree[] {
  const target = event.data.path;
  const idx = state.findIndex((w) => w.path === target);
  if (idx === -1) return state;
  if (event.data.removed) return state.filter((_, i) => i !== idx);
  const next = [...state];
  next[idx] = { ...state[idx]!, ...event.data, process: { ...state[idx]!.process, ...(event.data.process ?? {}) } } as Worktree;
  return next;
}

export type Unsub = () => void;

// One /events/worktrees stream for the whole window, ref-counted by its
// subscribers. Browsers allow only 6 HTTP/1.1 connections per host and every
// EventSource holds one for good: a stream per subscriber (board, hub,
// intercom…) starved ordinary fetches until the app looked frozen.
const worktreeHandlers = new Set<(evt: WorktreeEvent) => void>();
let worktreeSource: EventSource | null = null;

export function subscribeWorktrees(handler: (evt: WorktreeEvent) => void): Unsub {
  // A distinct entry per call, so subscribing the same function twice still
  // takes two unsubscribes.
  const entry = (evt: WorktreeEvent) => handler(evt);
  worktreeHandlers.add(entry);
  if (!worktreeSource) {
    const es = new EventSource('/events/worktrees');
    es.addEventListener('worktree.updated', ((e: MessageEvent) => {
      let evt: WorktreeEvent;
      try { evt = { type: 'worktree.updated', data: JSON.parse(e.data) }; } catch { return; /* ignore malformed messages */ }
      for (const h of [...worktreeHandlers]) {
        try { h(evt); } catch (err) { console.error('[worktrees] subscriber failed', err); }
      }
    }) as EventListener);
    worktreeSource = es;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    worktreeHandlers.delete(entry);
    if (worktreeHandlers.size === 0 && worktreeSource) {
      worktreeSource.close();
      worktreeSource = null;
    }
  };
}

export type LogEvent = { stream: 'stdout' | 'stderr'; line: string; ts: string };

export function subscribeLogs(worktreePath: string, handler: (evt: LogEvent) => void): Unsub {
  const url = `/events/logs/${encodeURIComponent(worktreePath)}`;
  const es = new EventSource(url);
  const listener = (e: MessageEvent) => {
    try {
      handler(JSON.parse(e.data));
    } catch {
      // ignore
    }
  };
  es.addEventListener('log', listener as EventListener);
  return () => {
    es.removeEventListener('log', listener as EventListener);
    es.close();
  };
}

export type JobEvent = { type: 'progress' | 'done' | 'error'; data: unknown };

export function subscribeJob(jobId: string, handler: (evt: JobEvent) => void): Unsub {
  const es = new EventSource(`/events/jobs/${jobId}`);
  const subscribe = (type: 'progress' | 'done' | 'error') => {
    const listener = (e: MessageEvent) => {
      try {
        handler({ type, data: JSON.parse(e.data) });
      } catch {
        // ignore
      }
    };
    es.addEventListener(type, listener as EventListener);
    return () => es.removeEventListener(type, listener as EventListener);
  };
  const offs = [subscribe('progress'), subscribe('done'), subscribe('error')];
  return () => {
    for (const off of offs) off();
    es.close();
  };
}

// Resolve when a job finishes, reject if it errors. The /events/jobs SSE
// replays a terminal state on connect, so this is race-safe even if the job
// completes before we subscribe.
export function awaitJob(jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = subscribeJob(jobId, (evt) => {
      if (evt.type === 'done') {
        off();
        resolve();
      } else if (evt.type === 'error') {
        off();
        const d = evt.data as { message?: string; error?: string } | null;
        reject(new Error(d?.message || d?.error || 'Job failed'));
      }
    });
  });
}

export type WorkspaceListEvent = {
  type: 'workspace.created' | 'workspace.updated' | 'workspace.deleted' | 'workspace.active-changed';
  data: unknown;
};

export function subscribeWorkspaces(handler: (evt: WorkspaceListEvent) => void): Unsub {
  const es = new EventSource('/events/workspaces');
  const types: WorkspaceListEvent['type'][] = [
    'workspace.created', 'workspace.updated', 'workspace.deleted', 'workspace.active-changed',
  ];
  const offs: Unsub[] = types.map((t) => {
    const listener = (e: MessageEvent) => {
      try { handler({ type: t, data: JSON.parse(e.data) }); } catch { /* ignore */ }
    };
    es.addEventListener(t, listener as EventListener);
    return () => es.removeEventListener(t, listener as EventListener);
  });
  return () => { for (const off of offs) off(); es.close(); };
}

export type EnvInstallEvent =
  | { type: 'output'; data: { id: string; line: string } }
  | { type: 'done'; data: { id: string; ok: boolean; message: string | null; tool: ToolStatus | null } };

export const INTERCOM_EVENT_TYPES = ['task.created', 'task.claimed', 'task.released', 'task.done', 'task.cancelled', 'task.assigned', 'escalation.opened', 'escalation.resolved', 'escalation.dismissed', 'escalation.retargeted', 'peer.registered', 'peer.dropped', 'feed.changed', 'message.queued', 'station.changed'] as const;
export type IntercomEventType = (typeof INTERCOM_EVENT_TYPES)[number];
export type IntercomEvent = { type: IntercomEventType; data: { scopeId: string; id: string } & Record<string, unknown> };

export function subscribeIntercom(wsId: string, handler: (evt: IntercomEvent) => void): Unsub {
  const es = new EventSource(`/events/intercom?ws=${encodeURIComponent(wsId)}`);
  const listeners = INTERCOM_EVENT_TYPES.map((type) => {
    const listener = (e: MessageEvent) => {
      try { handler({ type, data: JSON.parse(e.data) }); } catch { /* ignore malformed messages */ }
    };
    es.addEventListener(type, listener as EventListener);
    return [type, listener] as const;
  });
  return () => {
    for (const [type, listener] of listeners) es.removeEventListener(type, listener as EventListener);
    es.close();
  };
}

// Live output from an onboarding-driven prerequisite install. One stream covers
// every tool — each event names its own id, so the welcome screen can run more
// than one install without opening a socket per row.
export function subscribeEnvInstall(handler: (evt: EnvInstallEvent) => void): Unsub {
  const es = new EventSource('/events/env-install');
  const types: EnvInstallEvent['type'][] = ['output', 'done'];
  const offs: Unsub[] = types.map((t) => {
    const listener = (e: MessageEvent) => {
      try { handler({ type: t, data: JSON.parse(e.data) } as EnvInstallEvent); } catch { /* ignore */ }
    };
    es.addEventListener(t, listener as EventListener);
    return () => es.removeEventListener(t, listener as EventListener);
  });
  return () => { for (const off of offs) off(); es.close(); };
}

/** A layout command the server sent to this one window; answered with an ack. */
export type UiCommand = { id: string; op: string; args: Record<string, unknown> };

/** `/events/ui` registers this window (`client`) for the workspace while open.
 * `onReady` fires on every (re)connect — the server's `ui.ready` — which is
 * when the window must (re)send its state. */
export function subscribeUi(
  wsId: string,
  clientId: string,
  handlers: { onCommand: (cmd: UiCommand) => void; onReady: () => void },
): Unsub {
  // No remote flag: the server treats any non-loopback connection as remote.
  const es = new EventSource(`/events/ui?ws=${encodeURIComponent(wsId)}&client=${encodeURIComponent(clientId)}`);
  const onCommand = (e: MessageEvent) => {
    let cmd: UiCommand;
    try { cmd = JSON.parse(e.data); } catch { return; /* ignore malformed messages */ }
    if (cmd && typeof cmd.id === 'string' && typeof cmd.op === 'string') handlers.onCommand({ ...cmd, args: cmd.args ?? {} });
  };
  const onReady = () => handlers.onReady();
  es.addEventListener('ui.command', onCommand as EventListener);
  es.addEventListener('ui.ready', onReady);
  return () => {
    es.removeEventListener('ui.command', onCommand as EventListener);
    es.removeEventListener('ui.ready', onReady);
    es.close();
  };
}
