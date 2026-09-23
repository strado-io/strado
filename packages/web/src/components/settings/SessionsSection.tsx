// Settings → Sessions: a bird's-eye view of every pty the daemon holds,
// machine-wide, with the CPU and memory of the process tree under each one.
//
// The sidebar only ever shows sessions for worktrees in the current
// workspace. Sessions whose worktree was deleted, or that belong to another
// workspace, are invisible there yet still hold a shell, an agent and memory
// for weeks — that is what "Other" surfaces, with a Kill that works by key.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { readBrowserTabIds, rememberBrowserTab, rememberBrowserTabIds } from '../../hooks/browserTabs';
import { useWorkspace } from '../../hooks/useWorkspace';
import { readVscodeTabs, rememberVscodeTab } from '../../hooks/vscodeTabs';
import { closeVscodeTab } from '../../pages/vscodeTabClose';
import type { RepoConfig, SessionMetric, SessionMetrics, Worktree } from '../../types';

const POLL_MS = 5_000;
const MB = 1024 * 1024;

const MODE_LABEL: Record<SessionMetric['mode'], string> = {
  claude: 'Claude', shell: 'Shell', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi',
};
const MODE_DOT: Record<SessionMetric['mode'], string> = {
  claude: 'bg-amber-300', codex: 'bg-sky-300', opencode: 'bg-violet-300', pi: 'bg-rose-300', shell: 'bg-zinc-400',
};

const fmtMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
const fmtCpu = (pct: number) => `${pct.toFixed(1)}%`;
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

type Usage = { cpu: number; rssBytes: number };
type AppMetric = { pid: number; type: string; name?: string; cpu: number; memoryKb: number; preview?: string };

// A pty session from the daemon, or a Browser preview (an Electron renderer
// tagged with its preview key by the shell). Both sit under their worktree.
type SessionRow =
  | { kind: 'pty'; key: string; label: string; mode: SessionMetric['mode']; usage: Usage }
  | { kind: 'browser'; key: string; label: string; path: string; id: string; usage: Usage }
  // one serve-web window (its extension host's process tree), reported by the strado-window extension
  | { kind: 'vscode'; key: string; label: string; path: string; usage: Usage };
type BrowserPreview = { key: string; path: string; id: string; usage: Usage };
type WorktreeRow = { path: string; label: string; usage: Usage; sessions: SessionRow[] };
type Group = { id: string; label: string; title?: string; usage: Usage; worktrees: WorktreeRow[] };

const sum = (rows: Usage[]): Usage => ({
  cpu: rows.reduce((a, r) => a + r.cpu, 0),
  rssBytes: rows.reduce((a, r) => a + r.rssBytes, 0),
});

// Preview keys are `<path>` for tab 1 and `<path>\0browser:<id>` beyond.
function parsePreviewKey(key: string): { path: string; id: string } {
  const [path, suffix] = key.split('\0');
  return { path: path!, id: suffix?.startsWith('browser:') ? suffix.slice('browser:'.length) : '1' };
}

function browserPreviews(app: AppMetric[] | null): BrowserPreview[] {
  if (!app) return [];
  return app
    .filter((m): m is AppMetric & { preview: string } => typeof m.preview === 'string')
    .map((m) => ({ key: m.preview, ...parsePreviewKey(m.preview), usage: { cpu: m.cpu, rssBytes: m.memoryKb * 1024 } }));
}

// Repo → worktree → session; anything not in this workspace's worktree list
// goes to "Other", one row per path so an orphan is still identifiable.
function groupSessions(
  sessions: SessionMetric[],
  previews: BrowserPreview[],
  windows: SessionMetrics['vscodeWindows'],
  worktrees: Worktree[],
  repos: RepoConfig[],
): Group[] {
  const wtByPath = new Map(worktrees.map((w) => [w.path, w]));
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const byPath = new Map<string, SessionRow[]>();
  const push = (path: string, row: SessionRow) => {
    const list = byPath.get(path);
    if (list) list.push(row);
    else byPath.set(path, [row]);
  };
  for (const s of sessions) {
    push(s.path, {
      kind: 'pty',
      key: s.key,
      mode: s.mode,
      label: s.id === '1' ? MODE_LABEL[s.mode] : `${MODE_LABEL[s.mode]} ${s.id}`,
      usage: { cpu: s.cpu, rssBytes: s.rssBytes },
    });
  }
  for (const b of previews) {
    push(b.path, { kind: 'browser', key: b.key, path: b.path, id: b.id, label: b.id === '1' ? 'Browser' : `Browser ${b.id}`, usage: b.usage });
  }
  for (const w of windows) {
    push(w.path, { kind: 'vscode', key: `vscode:${w.path}:${w.pid}`, path: w.path, label: 'VS Code', usage: { cpu: w.cpu, rssBytes: w.rssBytes } });
  }
  const groups = new Map<string, Group>();
  for (const [path, list] of byPath) {
    const wt = wtByPath.get(path);
    const gid = wt?.repoId ?? 'other';
    let g = groups.get(gid);
    if (!g) {
      g = {
        id: gid,
        label: wt ? (repoName.get(wt.repoId ?? '') ?? wt.repoId ?? 'repo') : 'Other',
        title: wt ? undefined : 'Sessions whose worktree is not in this workspace (deleted, or another workspace)',
        usage: { cpu: 0, rssBytes: 0 },
        worktrees: [],
      };
      groups.set(gid, g);
    }
    const rows = [...list].sort((a, b) => a.label.localeCompare(b.label));
    g.worktrees.push({
      path,
      label: wt ? (wt.meta?.ticketId?.trim() || wt.branch || basename(path)) : basename(path),
      usage: sum(rows.map((r) => r.usage)),
      sessions: rows,
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.worktrees.sort((a, b) => a.label.localeCompare(b.label));
    g.usage = sum(g.worktrees.map((w) => w.usage));
  }
  // Repos alphabetically; Other last.
  return out.sort((a, b) => (a.id === 'other' ? 1 : b.id === 'other' ? -1 : a.label.localeCompare(b.label)));
}

// Electron's process list folded into the rows people recognise. Browser
// previews are listed under their worktree instead, so Renderer is the
// dashboard alone. VS Code is the one shared `code serve-web` workbench.
type AppRow = { id: string; label: string; usage: Usage };
function appRows(app: AppMetric[] | null, m: SessionMetrics['app']): AppRow[] {
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

function ShareBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Memory share"
      className="h-1 w-full rounded-full bg-zinc-800"
    >
      <div className="h-1 rounded-full bg-zinc-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

function UsageCells({ usage, max, dim }: { usage: Usage; max: number; dim?: boolean }) {
  const tone = dim ? 'text-zinc-500' : 'text-zinc-200';
  return (
    <>
      <td className={`w-20 px-3 py-1.5 text-right text-sm tabular-nums ${tone}`}>{fmtCpu(usage.cpu)}</td>
      <td className={`w-28 px-3 py-1.5 text-right text-sm tabular-nums ${tone}`}>{fmtMb(usage.rssBytes)}</td>
      <td className="w-40 px-3 py-1.5"><ShareBar value={usage.rssBytes} max={max} /></td>
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden
      className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function SessionsSection() {
  const { workspace } = useWorkspace();
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [appMetrics, setAppMetrics] = useState<AppMetric[] | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, wts, rs, appM] = await Promise.all([
        api.sessions.metrics(),
        api.worktrees.list(workspace.id).catch(() => [] as Worktree[]),
        api.repos.list(workspace.id).catch(() => [] as RepoConfig[]),
        window.strado?.appMetrics ? window.strado.appMetrics().catch(() => null) : Promise.resolve(null),
      ]);
      setMetrics(m);
      setWorktrees(wts);
      setRepos(rs);
      setAppMetrics(appM);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspace.id]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!live) return;
      await load();
      if (live) timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const kill = (key: string) => run(key, () => api.sessions.kill(key));
  // Stopping the shared workbench strands every VS Code tab on a dead server,
  // so close them all; reopening one boots a fresh workbench.
  const stopVscode = () =>
    run('vscode', async () => {
      await api.sessions.stopVscode();
      for (const path of readVscodeTabs()) rememberVscodeTab(path, false);
    });
  // Same teardown the hub's ✕ does: drop the native view, then forget the tab
  // so the strip (which listens for the storage event) removes it.
  // Same close the hub's ✕ does: forget the tab (the strip listens) and tell
  // the server, which ends that window's extension host — VS Code would
  // otherwise keep it, and its memory, alive for hours.
  const closeVscode = (row: Extract<SessionRow, { kind: 'vscode' }>) =>
    run(row.key, async () => { closeVscodeTab(row.path); });
  const closeBrowser = (row: Extract<SessionRow, { kind: 'browser' }>) =>
    run(row.key, async () => {
      await window.strado?.preview?.('close', row.key);
      if (row.id === '1') rememberBrowserTab(row.path, false);
      else rememberBrowserTabIds(row.path, (readBrowserTabIds()[row.path] ?? []).filter((i) => i !== row.id));
    });

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const groups = useMemo(
    () => (metrics ? groupSessions(metrics.sessions, browserPreviews(appMetrics), metrics.vscodeWindows ?? [], worktrees, repos) : []),
    [metrics, appMetrics, worktrees, repos],
  );
  const app = metrics ? appRows(appMetrics, metrics.app) : [];
  const appTotal = sum(app.map((r) => r.usage));
  const maxRss = Math.max(appTotal.rssBytes, ...groups.map((g) => g.usage.rssBytes), 1);

  return (
    <section className="flex flex-col gap-3" data-testid="sessions-section">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Sessions</h2>
        <p className="text-xs text-zinc-500">
          Every terminal the daemon is holding on this machine, with the CPU and memory of the processes under it.
          Sessions survive app restarts, so this is where forgotten ones show up.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      {metrics === null ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <table className="w-full border-separate border-spacing-0 overflow-hidden rounded border border-zinc-800">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2 text-left font-medium">Process</th>
              <th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">Memory</th>
              <th className="px-3 py-2 text-left font-medium normal-case tracking-normal text-zinc-500">Memory share</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody data-testid="sessions-group-strado" className="border-t border-zinc-800">
            <tr className="border-t border-zinc-800">
              <td className="px-3 py-2 text-sm font-medium text-zinc-100">Strado</td>
              <UsageCells usage={appTotal} max={maxRss} />
              <td />
            </tr>
            {app.map((r) => (
              <tr key={r.id} data-testid={`sessions-row-${r.id}`} className="group">
                <td className="py-1.5 pl-9 pr-3 text-sm text-zinc-400">{r.label}</td>
                <UsageCells usage={r.usage} max={maxRss} dim />
                <td className="px-2 py-1 text-right">
                  {r.id === 'vscode' && (
                    <button
                      type="button"
                      onClick={() => void stopVscode()}
                      disabled={busy === 'vscode'}
                      aria-label="Stop VS Code"
                      title="Stop the shared VS Code workbench and close every VS Code tab"
                      className="rounded-md px-2 py-1 text-xs text-zinc-500 opacity-60 hover:bg-red-950/50 hover:text-red-300 group-hover:opacity-100 disabled:opacity-40"
                    >
                      {busy === 'vscode' ? 'Stopping…' : 'Stop'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>

          {groups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={5} className="border-t border-zinc-800 px-3 py-3 text-xs text-zinc-500">
                  No terminal sessions. Open a Claude, shell or Codex tab and it appears here.
                </td>
              </tr>
            </tbody>
          )}

          {groups.map((g) => {
            const open = !collapsed.has(g.id);
            return (
              <tbody key={g.id} data-testid={`sessions-group-${g.id}`}>
                <tr className="border-t border-zinc-800">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(g.id)}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${g.label}`}
                      title={g.title}
                      className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-zinc-100 hover:text-white"
                    >
                      <Chevron open={open} />
                      <span>{g.label}</span>
                    </button>
                  </td>
                  <UsageCells usage={g.usage} max={maxRss} />
                  <td />
                </tr>
                {open &&
                  g.worktrees.flatMap((w) => [
                    <tr key={`wt:${w.path}`} data-testid={`sessions-worktree-${w.path}`}>
                      <td className="py-1.5 pl-7 pr-3">
                        <span className="flex items-center gap-2 text-sm text-zinc-200" title={w.path}>
                          <Chevron open />
                          <span className="truncate">{w.label}</span>
                        </span>
                      </td>
                      <UsageCells usage={w.usage} max={maxRss} />
                      <td />
                    </tr>,
                    ...w.sessions.map((s) => (
                      <tr
                        key={`${s.kind}:${s.key}`}
                        data-testid={s.kind === 'browser' ? `sessions-row-browser:${s.key}` : s.kind === 'vscode' ? `sessions-row-vscode:${s.path}` : `sessions-row-${s.key}`}
                        className="group"
                      >
                        <td className="py-1.5 pl-14 pr-3">
                          <span className="flex items-center gap-2 text-sm text-zinc-300">
                            <span className={`size-1.5 shrink-0 rounded-full ${s.kind === 'browser' ? 'bg-emerald-400' : s.kind === 'vscode' ? 'bg-blue-400' : MODE_DOT[s.mode]}`} aria-hidden />
                            <span>{s.label}</span>
                          </span>
                        </td>
                        <UsageCells usage={s.usage} max={maxRss} dim />
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => void (s.kind === 'browser' ? closeBrowser(s) : s.kind === 'vscode' ? closeVscode(s) : kill(s.key))}
                            disabled={busy === s.key}
                            aria-label={`${s.kind === 'pty' ? 'Kill' : 'Close'} ${s.label} in ${w.label}`}
                            className="rounded-md px-2 py-1 text-xs text-zinc-500 opacity-60 hover:bg-red-950/50 hover:text-red-300 group-hover:opacity-100 disabled:opacity-40"
                          >
                            {busy === s.key ? '…' : s.kind === 'pty' ? 'Kill' : 'Close'}
                          </button>
                        </td>
                      </tr>
                    )),
                  ])}
              </tbody>
            );
          })}
        </table>
      )}
    </section>
  );
}
