import type { Worktree } from './types';

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

export function subscribeWorktrees(handler: (evt: WorktreeEvent) => void): Unsub {
  const es = new EventSource('/events/worktrees');
  const listener = (e: MessageEvent) => {
    try {
      handler({ type: 'worktree.updated', data: JSON.parse(e.data) });
    } catch {
      // ignore malformed messages
    }
  };
  es.addEventListener('worktree.updated', listener as EventListener);
  return () => {
    es.removeEventListener('worktree.updated', listener as EventListener);
    es.close();
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
