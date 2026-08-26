import type { Worktree } from '../types';

export type ClaudeStatusValue = 'idle' | 'working' | 'waiting' | undefined;
/** keyed by `path\0sessionId` — one entry per Claude session, not per worktree */
export type ClaudeStatusMap = Record<string, ClaudeStatusValue>;
export type ClaudeNotification = {
  path: string;
  sessionId: string;
  mode: 'claude' | 'shell';
  title: string;
  /** repo · branch (· on <runner>) — context under the title, '' when unknown */
  body: string;
  kind: 'waiting' | 'finished';
};

function label(w: Worktree): string {
  // `||`, not `??`: a ticketId of '' rendered the banner as ": Claude finished"
  // with no worktree named at all (seen live 2026-08-02).
  return w.meta?.ticketId?.trim() || w.path.split('/').pop() || w.path;
}

function body(w: Worktree, repoNames?: Record<string, string>): string {
  const parts = [
    (w.repoId && repoNames?.[w.repoId]) || null,
    w.branch,
    w.remote ? `on ${w.remote.runnerName}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

// "Claude" for the primary session, "Claude 2" beyond — matches the tab strip
// so the notification names the tab it came from.
function sessionName(id: string): string {
  if (id.startsWith('shell:')) {
    const shellId = id.slice('shell:'.length);
    return shellId === '1' ? 'Claude (Shell)' : `Claude (Shell ${shellId})`;
  }
  return id === '1' ? 'Claude' : `Claude ${id}`;
}

function sessionTarget(id: string): { mode: 'claude' | 'shell'; sessionId: string } {
  return id.startsWith('shell:')
    ? { mode: 'shell', sessionId: id.slice('shell:'.length) }
    : { mode: 'claude', sessionId: id };
}

// A worktree's per-session statuses; older servers only send the aggregate,
// which maps to the single session '1' (pre-multi-session behavior).
function sessionsOf(w: Worktree): Record<string, ClaudeStatusValue> {
  const byId = w.claudeStatusById;
  if (byId && Object.keys(byId).length > 0) return byId;
  return { '1': w.claudeStatus };
}

export function snapshotStatuses(worktrees: Worktree[]): ClaudeStatusMap {
  const map: ClaudeStatusMap = {};
  for (const w of worktrees) {
    for (const [id, status] of Object.entries(sessionsOf(w))) map[`${w.path}\0${id}`] = status;
  }
  return map;
}

// Diff PER SESSION, not per worktree: with several Claudes in one worktree
// the aggregate hides transitions (session 2 turning waiting while session 1
// still works keeps the aggregate at 'working' — no notification ever fired).
export function computeClaudeNotifications(
  prev: ClaudeStatusMap,
  worktrees: Worktree[],
  repoNames?: Record<string, string>,
): ClaudeNotification[] {
  const out: ClaudeNotification[] = [];
  for (const w of worktrees) {
    for (const [id, after] of Object.entries(sessionsOf(w))) {
      const before = prev[`${w.path}\0${id}`];
      if (after === before) continue;
      const target = sessionTarget(id);
      if (after === 'waiting' && before !== undefined) {
        out.push({
          path: w.path,
          ...target,
          title: `${label(w)}: ${sessionName(id)} needs your input`,
          body: body(w, repoNames),
          kind: 'waiting',
        });
      } else if (after === 'idle' && before === 'working') {
        out.push({
          path: w.path,
          ...target,
          title: `${label(w)}: ${sessionName(id)} finished`,
          body: body(w, repoNames),
          kind: 'finished',
        });
      }
    }
  }
  return out;
}
