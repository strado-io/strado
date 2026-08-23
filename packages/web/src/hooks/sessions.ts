import type { Worktree } from '../types';

export type SessionChip = {
  path: string;
  mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'vscode' | 'browser';
  sessionId: string;
  modeLabel: string;
  label: string;
  title: string | null;
  claudeStatus?: 'idle' | 'working' | 'waiting';
  codexStatus?: 'idle' | 'working' | 'waiting';
  opencodeStatus?: 'idle' | 'working' | 'waiting';
};

function label(w: Worktree): string {
  return w.meta?.ticketId ?? w.path.split('/').pop() ?? w.path;
}

function title(w: Worktree): string | null {
  const t = w.meta?.title?.trim();
  return t && t !== label(w) ? t : null;
}

export function hasSession(w: Worktree, vscodeTabs?: Set<string>, browserTabs?: Set<string>): boolean {
  return !!(
    w.hasClaudeSession || w.hasCodexSession || w.hasOpencodeSession || w.hasShellSession ||
    vscodeTabs?.has(w.path) || browserTabs?.has(w.path)
  );
}

// vscodeTabs: client-side VS Code iframe tabs (see hooks/vscodeTabs) — the
// server doesn't know about them, so callers pass them in.
export function sessionChips(worktrees: Worktree[], vscodeTabs?: Set<string>, browserTabs?: Set<string>): SessionChip[] {
  const chips: SessionChip[] = [];
  for (const w of worktrees) {
    // One chip PER session, coloured by that session's own status (falling back
    // to the worktree aggregate for older payloads that lack the by-id map), so
    // the rail names the exact session that's working — same grammar the hub
    // tab strip already uses.
    // `?.length ? … : fallback` (not `??`) so a present-but-empty array can't
    // hide a live session when hasXSession is set — always at least one chip.
    const claudeIds = w.claudeSessions?.length ? w.claudeSessions : (w.hasClaudeSession ? ['1'] : []);
    for (const id of claudeIds) {
      chips.push({
        path: w.path, mode: 'claude', sessionId: id,
        modeLabel: id === '1' ? 'claude' : `claude ${id}`,
        label: label(w), title: title(w),
        claudeStatus: w.claudeStatusById?.[id] ?? w.claudeStatus,
      });
    }
    const codexIds = w.codexSessions?.length ? w.codexSessions : (w.hasCodexSession ? ['1'] : []);
    for (const id of codexIds) {
      chips.push({
        path: w.path, mode: 'codex', sessionId: id,
        modeLabel: id === '1' ? 'codex' : `codex ${id}`,
        label: label(w), title: title(w),
        codexStatus: w.codexStatusById?.[id] ?? w.codexStatus,
      });
    }
    const opencodeIds = w.opencodeSessions?.length ? w.opencodeSessions : (w.hasOpencodeSession ? ['1'] : []);
    for (const id of opencodeIds) {
      chips.push({
        path: w.path, mode: 'opencode', sessionId: id,
        modeLabel: id === '1' ? 'opencode' : `opencode ${id}`,
        label: label(w), title: title(w),
        opencodeStatus: w.opencodeStatusById?.[id] ?? w.opencodeStatus,
      });
    }
    const shellIds = w.shellSessions ?? (w.hasShellSession ? ['1'] : []);
    for (const id of shellIds) {
      chips.push({
        path: w.path, mode: 'shell', sessionId: id, modeLabel: id === '1' ? 'shell' : `shell ${id}`,
        label: label(w), title: title(w), claudeStatus: w.claudeStatus,
      });
    }
    if (vscodeTabs?.has(w.path)) {
      chips.push({
        path: w.path, mode: 'vscode', sessionId: '1', modeLabel: 'vs code',
        label: label(w), title: title(w),
      });
    }
    if (browserTabs?.has(w.path)) {
      chips.push({
        path: w.path, mode: 'browser', sessionId: '1', modeLabel: 'browser',
        label: label(w), title: title(w),
      });
    }
  }
  return chips;
}

const RANK: Record<string, number> = { waiting: 0, working: 1 };
function rank(w: Worktree): number {
  return w.claudeStatus && w.claudeStatus in RANK ? RANK[w.claudeStatus]! : 2;
}

export function bySessionPriority(a: Worktree, b: Worktree): number {
  return rank(a) - rank(b);
}

export function chipStatus(c: SessionChip): 'idle' | 'working' | 'waiting' | undefined {
  if (c.mode === 'claude') return c.claudeStatus;
  if (c.mode === 'codex') return c.codexStatus;
  if (c.mode === 'opencode') return c.opencodeStatus;
  return undefined;
}

const DISPLAY_BASE: Record<SessionChip['mode'], string> = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode',
  shell: 'Shell', vscode: 'VS Code', browser: 'Browser',
};

export function displayLabel(c: SessionChip): string {
  const base = DISPLAY_BASE[c.mode];
  return c.sessionId && c.sessionId !== '1' ? `${base} ${c.sessionId}` : base;
}
