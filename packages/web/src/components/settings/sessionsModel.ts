// Pure model for Settings → Sessions: fold the server's pty metrics, the
// shell's Electron process list and the VS Code window reports into
// repo → worktree → session rows, plus a by-kind breakdown for the memory map.
import type { RepoConfig, SessionMetric, SessionMetrics, Worktree } from '../../types';

export const MB = 1024 * 1024;

/** What a row is, for icon, colour and the memory-map legend. */
export type Kind = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell' | 'vscode' | 'browser' | 'app';

export const KIND_LABEL: Record<Kind, string> = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', shell: 'Shell',
  vscode: 'VS Code', browser: 'Browser', app: 'Strado app',
};
// Same hues as the tab strip and sidebar avatars (sessionAvatars.tsx).
export const KIND_TEXT: Record<Kind, string> = {
  claude: 'text-amber-300', codex: 'text-sky-300', opencode: 'text-violet-300', pi: 'text-rose-300',
  shell: 'text-zinc-300', vscode: 'text-blue-400', browser: 'text-emerald-400', app: 'text-zinc-400',
};
export const KIND_BG: Record<Kind, string> = {
  claude: 'bg-amber-300', codex: 'bg-sky-300', opencode: 'bg-violet-300', pi: 'bg-rose-300',
  shell: 'bg-zinc-400', vscode: 'bg-blue-400', browser: 'bg-emerald-400', app: 'bg-zinc-600',
};
export const KIND_ORDER: Kind[] = ['claude', 'codex', 'opencode', 'pi', 'vscode', 'browser', 'shell', 'app'];

export type Usage = { cpu: number; rssBytes: number };
export type AppMetric = { pid: number; type: string; name?: string; cpu: number; memoryKb: number; preview?: string };

export type SessionRow =
  | { kind: 'pty'; mode: SessionMetric['mode']; key: string; label: string; pid: number | null; processes: number; usage: Usage }
  | { kind: 'browser'; mode: 'browser'; key: string; label: string; path: string; id: string; usage: Usage }
  | { kind: 'vscode'; mode: 'vscode'; key: string; label: string; path: string; pid: number; processes: number; usage: Usage };
export type WorktreeRow = { path: string; label: string; usage: Usage; byKind: Partial<Record<Kind, number>>; sessions: SessionRow[] };
export type Group = { id: string; label: string; orphan: boolean; usage: Usage; byKind: Partial<Record<Kind, number>>; worktrees: WorktreeRow[] };
export type AppRow = { id: string; label: string; usage: Usage };

export type SortKey = 'memory' | 'cpu' | 'name';

export const sum = (rows: Usage[]): Usage => ({
  cpu: rows.reduce((a, r) => a + r.cpu, 0),
  rssBytes: rows.reduce((a, r) => a + r.rssBytes, 0),
});
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function fmtMem(bytes: number): string {
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;
}
export const fmtCpu = (pct: number) => `${pct.toFixed(1)}%`;

// Preview keys are `<path>` for tab 1 and `<path>\0browser:<id>` beyond.
function parsePreviewKey(key: string): { path: string; id: string } {
  const [path, suffix] = key.split('\0');
  return { path: path!, id: suffix?.startsWith('browser:') ? suffix.slice('browser:'.length) : '1' };
}

const addKind = (acc: Partial<Record<Kind, number>>, kind: Kind, bytes: number) => {
  acc[kind] = (acc[kind] ?? 0) + bytes;
};

function compare(sort: SortKey) {
  return (a: { label: string; usage: Usage }, b: { label: string; usage: Usage }) =>
    sort === 'memory' ? b.usage.rssBytes - a.usage.rssBytes
    : sort === 'cpu' ? b.usage.cpu - a.usage.cpu || b.usage.rssBytes - a.usage.rssBytes
    : a.label.localeCompare(b.label);
}

// Repo → worktree → session; anything not in this workspace's worktree list
// goes to one "not in this workspace" group, a row per path.
export function groupSessions(input: {
  sessions: SessionMetric[];
  app: AppMetric[] | null;
  windows: SessionMetrics['vscodeWindows'];
  worktrees: Worktree[];
  repos: RepoConfig[];
  sort: SortKey;
}): Group[] {
  const wtByPath = new Map(input.worktrees.map((w) => [w.path, w]));
  const repoName = new Map(input.repos.map((r) => [r.id, r.name]));
  const byPath = new Map<string, SessionRow[]>();
  const push = (path: string, row: SessionRow) => {
    const list = byPath.get(path);
    if (list) list.push(row);
    else byPath.set(path, [row]);
  };
  for (const s of input.sessions) {
    const name = KIND_LABEL[s.mode];
    push(s.path, {
      kind: 'pty', mode: s.mode, key: s.key, pid: s.pid, processes: s.processes,
      label: s.id === '1' ? name : `${name} ${s.id}`,
      usage: { cpu: s.cpu, rssBytes: s.rssBytes },
    });
  }
  for (const m of input.app ?? []) {
    if (typeof m.preview !== 'string') continue;
    const { path, id } = parsePreviewKey(m.preview);
    push(path, {
      kind: 'browser', mode: 'browser', key: m.preview, path, id,
      label: id === '1' ? 'Browser' : `Browser ${id}`,
      usage: { cpu: m.cpu, rssBytes: m.memoryKb * 1024 },
    });
  }
  for (const w of input.windows) {
    push(w.path, {
      kind: 'vscode', mode: 'vscode', key: `vscode:${w.path}:${w.pid}`, path: w.path, pid: w.pid,
      processes: w.processes, label: 'VS Code', usage: { cpu: w.cpu, rssBytes: w.rssBytes },
    });
  }

  const groups = new Map<string, Group>();
  for (const [path, rows] of byPath) {
    const wt = wtByPath.get(path);
    const gid = wt?.repoId ?? 'other';
    let g = groups.get(gid);
    if (!g) {
      g = {
        id: gid,
        orphan: !wt,
        label: wt ? (repoName.get(wt.repoId ?? '') ?? wt.repoId ?? 'repo') : 'Not in this workspace',
        usage: { cpu: 0, rssBytes: 0 },
        byKind: {},
        worktrees: [],
      };
      groups.set(gid, g);
    }
    const byKind: Partial<Record<Kind, number>> = {};
    for (const r of rows) addKind(byKind, r.mode, r.usage.rssBytes);
    g.worktrees.push({
      path,
      label: wt ? (wt.meta?.ticketId?.trim() || wt.branch || basename(path)) : basename(path),
      usage: sum(rows.map((r) => r.usage)),
      byKind,
      sessions: [...rows].sort(compare(input.sort)),
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.worktrees.sort(compare(input.sort));
    g.usage = sum(g.worktrees.map((w) => w.usage));
    for (const w of g.worktrees) for (const [k, v] of Object.entries(w.byKind)) addKind(g.byKind, k as Kind, v);
  }
  // Leftovers last whatever the sort: they are a different question.
  const cmp = compare(input.sort);
  return out.sort((a, b) => (a.orphan !== b.orphan ? (a.orphan ? 1 : -1) : cmp(a, b)));
}

// Electron's process list folded into the rows people recognise. Browser
// previews are listed under their worktree instead, so Renderer is the
// dashboard alone. VS Code (shared) is the serve-web tree minus windows.
export function appRows(app: AppMetric[] | null, m: SessionMetrics['app']): AppRow[] {
  const rows: AppRow[] = [];
  if (app) {
    const pick = (pred: (p: AppMetric) => boolean) =>
      sum(app.filter(pred).map((p) => ({ cpu: p.cpu, rssBytes: p.memoryKb * 1024 })));
    rows.push({ id: 'main', label: 'Main', usage: pick((p) => p.type === 'Browser') });
    rows.push({ id: 'renderer', label: 'Renderer', usage: pick((p) => p.type === 'Tab' && !p.preview) });
    rows.push({ id: 'gpu', label: 'GPU', usage: pick((p) => p.type === 'GPU') });
    rows.push({ id: 'other', label: 'Other', usage: pick((p) => !['Browser', 'Tab', 'GPU'].includes(p.type)) });
  }
  rows.push({ id: 'server', label: 'Server', usage: { cpu: m.server.cpu, rssBytes: m.server.rssBytes } });
  if (m.daemon) rows.push({ id: 'daemon', label: 'Daemon', usage: { cpu: m.daemon.cpu, rssBytes: m.daemon.rssBytes } });
  if (m.vscode) rows.push({ id: 'vscode', label: 'VS Code (shared)', usage: { cpu: m.vscode.cpu, rssBytes: m.vscode.rssBytes } });
  return rows;
}

/** Whole-picture breakdown for the memory map: every byte in exactly one kind. */
export function memoryByKind(groups: Group[], app: AppRow[]): Array<{ kind: Kind; bytes: number }> {
  const acc: Partial<Record<Kind, number>> = {};
  for (const g of groups) for (const [k, v] of Object.entries(g.byKind)) addKind(acc, k as Kind, v);
  for (const r of app) addKind(acc, r.id === 'vscode' ? 'vscode' : 'app', r.usage.rssBytes);
  return KIND_ORDER.filter((k) => (acc[k] ?? 0) > 0).map((k) => ({ kind: k, bytes: acc[k]! }));
}

/** Keep only rows matching the kind filter and the search text (repo, branch or path). */
export function filterGroups(groups: Group[], kind: Kind | null, query: string): Group[] {
  const q = query.trim().toLowerCase();
  const out: Group[] = [];
  for (const g of groups) {
    const gMatch = q !== '' && g.label.toLowerCase().includes(q);
    const worktrees: WorktreeRow[] = [];
    for (const w of g.worktrees) {
      if (q && !gMatch && !w.label.toLowerCase().includes(q) && !w.path.toLowerCase().includes(q)) continue;
      const sessions = kind ? w.sessions.filter((s) => s.mode === kind) : w.sessions;
      if (sessions.length === 0) continue;
      worktrees.push(kind ? { ...w, sessions, usage: sum(sessions.map((s) => s.usage)) } : w);
    }
    if (worktrees.length) out.push({ ...g, worktrees, usage: kind || q ? sum(worktrees.map((w) => w.usage)) : g.usage });
  }
  return out;
}
