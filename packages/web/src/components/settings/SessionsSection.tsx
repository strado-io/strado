// Settings → Sessions: where this machine's memory goes, by repo, worktree and
// session — every pty the daemon holds, each VS Code window, each Browser
// preview, and Strado's own processes.
//
// The sidebar only shows sessions for worktrees in the current workspace.
// Sessions whose worktree was deleted, or that belong to another workspace,
// are invisible there yet can hold an agent and a gigabyte for weeks; they
// collect under "Not in this workspace" with a bulk End.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { readBrowserTabIds, rememberBrowserTab, rememberBrowserTabIds } from '../../hooks/browserTabs';
import { useWorkspace } from '../../hooks/useWorkspace';
import { readVscodeTabs, rememberVscodeTab } from '../../hooks/vscodeTabs';
import { closeVscodeTab } from '../../pages/vscodeTabClose';
import type { RepoConfig, SessionMetrics, Worktree } from '../../types';
import { ClaudeIcon, CodexIcon, GlobeIcon, OpencodeIcon, PiIcon, ReloadIcon, ScreenIcon, ShellIcon, VsCodeIcon } from '../hub/icons';
import { BranchIcon, RepoIcon } from '../sidebar/SidebarBody';
import {
  KIND_BG, KIND_LABEL, KIND_TEXT, MB, appRows, filterGroups, fmtCpu, fmtMem, groupSessions, memoryByKind, serverPids, sum,
  type AppMetric, type Group, type Kind, type SessionRow, type SortKey, type Usage,
} from './sessionsModel';

const POLL_MS = 5_000;
const HEAVY_BYTES = 1024 * MB; // memory at or above this reads amber
const CONFIRM_MS = 4_000;

function KindIcon({ kind, size = 13 }: { kind: Kind; size?: number }) {
  const cls = `shrink-0 ${KIND_TEXT[kind]}`;
  if (kind === 'claude') return <ClaudeIcon size={size} className={cls} />;
  if (kind === 'codex') return <CodexIcon size={size} className={cls} />;
  if (kind === 'opencode') return <OpencodeIcon size={size} className={cls} />;
  if (kind === 'pi') return <PiIcon size={size} className={cls} />;
  if (kind === 'vscode') return <VsCodeIcon size={size} className={cls} />;
  if (kind === 'browser') return <GlobeIcon className={`h-[13px] w-[13px] ${cls}`} />;
  if (kind === 'app') return <StradoMark className={cls} />;
  if (kind === 'server') return <ScreenIcon size={size} className={cls} />;
  return <ShellIcon size={size} className={cls} />;
}

function StradoMark({ className = '' }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className={className}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden
      className={`shrink-0 text-zinc-500 transition-transform duration-150 motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// One bar per row, sized against the heaviest row on the page so rows compare
// at a glance. Group rows stack their kinds; a session row is one colour.
function ShareBar({ parts, max, label }: { parts: Array<{ kind: Kind; bytes: number }>; max: number; label: string }) {
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  const pct = max > 0 ? Math.min(100, (total / max) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label} memory share`}
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80"
    >
      <div className="flex h-full" style={{ width: `${pct}%` }}>
        {parts.map((p) => (
          <div key={p.kind} className={`h-full ${KIND_BG[p.kind]}`} style={{ width: `${total ? (p.bytes / total) * 100 : 0}%` }} />
        ))}
      </div>
    </div>
  );
}

const partsOf = (byKind: Partial<Record<Kind, number>>) =>
  (Object.entries(byKind) as Array<[Kind, number]>).filter(([, b]) => b > 0).map(([kind, bytes]) => ({ kind, bytes }));

function UsageCells({ usage, parts, max, label, strong }: {
  usage: Usage; parts: Array<{ kind: Kind; bytes: number }>; max: number; label: string; strong?: boolean;
}) {
  const heavy = usage.rssBytes >= HEAVY_BYTES;
  const tone = heavy ? 'text-amber-300' : strong ? 'text-zinc-100' : 'text-zinc-400';
  return (
    <>
      <td className={`w-16 px-2 py-1.5 text-right text-[13px] tabular-nums ${strong ? 'text-zinc-300' : 'text-zinc-500'}`}>{fmtCpu(usage.cpu)}</td>
      <td className={`w-24 px-2 py-1.5 text-right text-[13px] tabular-nums ${tone}`} title={heavy ? 'Over 1 GB' : undefined}>{fmtMem(usage.rssBytes)}</td>
      <td className="w-36 px-3 py-1.5"><ShareBar parts={parts} max={max} label={label} /></td>
    </>
  );
}

// Destructive actions that end a live agent ask once: first click arms, a
// second within a few seconds confirms. Close (reopenable) acts at once.
function ActionButton({ label, confirmLabel, busy, onRun }: {
  label: string; confirmLabel?: string; busy: boolean; onRun: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const base = 'rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500';
  if (armed && confirmLabel) {
    return (
      <button type="button" onClick={() => { setArmed(false); onRun(); }} aria-label={`Confirm ${confirmLabel}`}
        className={`${base} bg-red-950/70 text-red-200 ring-1 ring-inset ring-red-800/70 hover:bg-red-900/60`}>
        {confirmLabel}?
      </button>
    );
  }
  return (
    <button type="button" disabled={busy} aria-label={label}
      onClick={() => (confirmLabel ? setArmed(true) : onRun())}
      className={`${base} text-zinc-500 opacity-0 hover:bg-red-950/50 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100`}>
      {busy ? '…' : label.split(' ')[0]}
    </button>
  );
}

function MemoryMap({ parts, filter, onFilter }: {
  parts: Array<{ kind: Kind; bytes: number }>; filter: Kind | null; onFilter: (k: Kind | null) => void;
}) {
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3.5" data-testid="sessions-memory-map">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-100">{fmtMem(total)}</span>
        <span className="text-xs text-zinc-500">in use by Strado and everything it runs</span>
      </div>
      <div className="mt-3 flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        {parts.map((p) => (
          <div key={p.kind}
            className={`h-full transition-opacity duration-150 motion-reduce:transition-none ${KIND_BG[p.kind]} ${filter && filter !== p.kind ? 'opacity-25' : ''}`}
            style={{ width: `${total ? (p.bytes / total) * 100 : 0}%` }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-1 gap-y-1" role="group" aria-label="Show only one kind">
        {parts.map((p) => {
          const on = filter === p.kind;
          const clickable = p.kind !== 'app';
          return (
            <button key={p.kind} type="button" disabled={!clickable} aria-pressed={on}
              onClick={() => onFilter(on ? null : p.kind)}
              title={clickable ? (on ? 'Show everything' : `Show only ${KIND_LABEL[p.kind]}`) : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:cursor-default ${
                on ? 'bg-zinc-800 text-zinc-100 ring-1 ring-inset ring-zinc-700' : 'text-zinc-400 enabled:hover:bg-zinc-800/60 enabled:hover:text-zinc-200'
              } ${filter && !on ? 'opacity-50' : ''}`}>
              <KindIcon kind={p.kind} size={12} />
              <span>{KIND_LABEL[p.kind]}</span>
              <span className="tabular-nums text-zinc-500">{fmtMem(p.bytes)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'memory', label: 'Memory' },
  { id: 'cpu', label: 'CPU' },
  { id: 'name', label: 'Name' },
];

export function SessionsSection() {
  const { workspace } = useWorkspace();
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [appMetrics, setAppMetrics] = useState<AppMetric[] | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Strado's own processes start folded: the page is about sessions.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['strado']));
  const [sort, setSort] = useState<SortKey>('memory');
  const [kindFilter, setKindFilter] = useState<Kind | null>(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      // Worktrees first: their dev-server pids are what the metrics call
      // measures alongside the daemon's sessions.
      const [wts, rs, appM] = await Promise.all([
        api.worktrees.list(workspace.id).catch(() => [] as Worktree[]),
        api.repos.list(workspace.id).catch(() => [] as RepoConfig[]),
        window.strado?.appMetrics ? window.strado.appMetrics().catch(() => null) : Promise.resolve(null),
      ]);
      const m = await api.sessions.metrics(serverPids(wts));
      setMetrics(m);
      setWorktrees(wts);
      setRepos(rs);
      setAppMetrics(appM);
      setError(null);
    } catch (err) {
      setError(`Could not read sessions: ${(err as Error).message}`);
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

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

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
  const endRow = (s: SessionRow) => {
    if (s.kind === 'pty') return run(s.key, () => api.sessions.kill(s.key));
    // Strado's own server stops through its process manager; an external one
    // gets the same SIGTERM the worktree row's Kill sends.
    if (s.kind === 'server') {
      return run(s.key, () => (s.external ? api.worktrees.killExternal(workspace.id, s.path) : api.worktrees.stop(workspace.id, s.path)));
    }
    // Same close the hub's ✕ does: forget the tab (the strip listens) and,
    // for VS Code, tell the server so it ends that window's extension host.
    if (s.kind === 'vscode') return run(s.key, async () => { closeVscodeTab(s.path); });
    return run(s.key, async () => {
      await window.strado?.preview?.('close', s.key);
      if (s.id === '1') rememberBrowserTab(s.path, false);
      else rememberBrowserTabIds(s.path, (readBrowserTabIds()[s.path] ?? []).filter((i) => i !== s.id));
    });
  };
  // Stopping the shared workbench strands every VS Code tab on a dead server,
  // so close them all; reopening one boots a fresh workbench.
  const stopVscode = () =>
    run('vscode', async () => {
      await api.sessions.stopVscode();
      for (const path of readVscodeTabs()) rememberVscodeTab(path, false);
    });
  const endGroup = (g: Group) =>
    run(`group:${g.id}`, async () => {
      for (const w of g.worktrees) for (const s of w.sessions) {
        if (s.kind === 'pty') await api.sessions.kill(s.key);
        else if (s.kind === 'server') continue; // orphan paths have no worktree to stop through
        else if (s.kind === 'vscode') closeVscodeTab(s.path);
        else await window.strado?.preview?.('close', s.key);
      }
    });

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const groups = useMemo(
    () => (metrics ? groupSessions({ sessions: metrics.sessions, app: appMetrics, windows: metrics.vscodeWindows ?? [], processes: metrics.processes, worktrees, repos, sort }) : []),
    [metrics, appMetrics, worktrees, repos, sort],
  );
  const app = metrics ? appRows(appMetrics, metrics.app) : [];
  const appTotal = sum(app.map((r) => r.usage));
  const map = memoryByKind(groups, app);
  const shown = filterGroups(groups, kindFilter, query);
  const maxRss = Math.max(appTotal.rssBytes, ...groups.map((g) => g.usage.rssBytes), 1);
  const sessionCount = groups.reduce((a, g) => a + g.worktrees.reduce((b, w) => b + w.sessions.length, 0), 0);
  const stradoOpen = !collapsed.has('strado');
  const showApp = !kindFilter && !query;

  return (
    <section className="flex flex-col gap-4" data-testid="sessions-section">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Sessions</h2>
          <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-zinc-500">
            Every terminal, agent, VS Code window and browser preview on this machine, with the memory and CPU of
            the processes behind it. Sessions outlive app restarts, so forgotten ones pile up here.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh now"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200">
          <span className="relative flex size-1.5" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
          </span>
          <span>Live</span>
          <ReloadIcon size={12} className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''} />
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      {metrics === null ? (
        <div className="h-28 animate-pulse rounded-lg bg-zinc-900/60 motion-reduce:animate-none" aria-label="Loading sessions" />
      ) : (
        <>
          <MemoryMap parts={map} filter={kindFilter} onFilter={setKindFilter} />

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by repo or branch"
              aria-label="Filter by repo or branch"
              className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <div className="flex rounded-md border border-zinc-800 p-0.5" role="group" aria-label="Sort by">
              {SORTS.map((s) => (
                <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}
                  className={`rounded px-2.5 py-1 text-xs ${sort === s.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {s.label}
                </button>
              ))}
            </div>
            <span className="text-xs tabular-nums text-zinc-600">
              {sessionCount} session{sessionCount === 1 ? '' : 's'}
            </span>
          </div>

          <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-zinc-800">
            <thead>
              <tr className="text-left text-[11px] font-medium text-zinc-500 [&>th]:border-b [&>th]:border-zinc-800 [&>th]:bg-zinc-900/50">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-2 py-2 text-right font-medium">CPU</th>
                <th className="px-2 py-2 text-right font-medium">Memory</th>
                <th className="px-3 py-2 font-medium">Share</th>
                <th className="w-20" />
              </tr>
            </thead>

            {showApp && (
              <tbody data-testid="sessions-group-strado">
                <tr className="[&>td]:border-t [&>td]:border-zinc-800 [&>td]:bg-zinc-900/30">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => toggle('strado')} aria-expanded={stradoOpen}
                      aria-label={`${stradoOpen ? 'Collapse' : 'Expand'} Strado`}
                      title="The app, its server, the terminal daemon and the shared VS Code workbench"
                      className="flex items-center gap-2 whitespace-nowrap text-sm font-medium text-zinc-100">
                      <Chevron open={stradoOpen} />
                      <KindIcon kind="app" />
                      <span>Strado</span>
                    </button>
                  </td>
                  <UsageCells usage={appTotal} max={maxRss} label="Strado" strong
                    parts={[
                      { kind: 'app', bytes: appTotal.rssBytes - (metrics.app.vscode?.rssBytes ?? 0) },
                      { kind: 'vscode', bytes: metrics.app.vscode?.rssBytes ?? 0 },
                    ]} />
                  <td />
                </tr>
                {stradoOpen && app.map((r) => (
                  <tr key={r.id} data-testid={`sessions-row-${r.id}`} className="group hover:bg-zinc-900/40">
                    <td className="py-1.5 pl-12 pr-3 text-[13px] text-zinc-400">
                      <span className="flex items-center gap-2">
                        {r.id === 'vscode' && <KindIcon kind="vscode" size={12} />}
                        <span>{r.label}</span>
                      </span>
                    </td>
                    <UsageCells usage={r.usage} max={maxRss} label={r.label}
                      parts={[{ kind: r.id === 'vscode' ? 'vscode' : 'app', bytes: r.usage.rssBytes }]} />
                    <td className="px-2 py-1 text-right">
                      {r.id === 'vscode' && (
                        <ActionButton label="Stop VS Code" busy={busy === 'vscode'} onRun={() => void stopVscode()} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}

            {shown.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-zinc-500">
                    {kindFilter || query
                      ? 'Nothing matches. Clear the filter to see every session.'
                      : 'No terminal sessions. Open a Claude, shell or Codex tab and it appears here.'}
                  </td>
                </tr>
              </tbody>
            )}

            {shown.map((g) => {
              const open = !collapsed.has(g.id);
              const all = g.worktrees.reduce((a, w) => a + w.sessions.length, 0);
              return (
                <tbody key={g.id} data-testid={`sessions-group-${g.id}`}>
                  <tr className="[&>td]:border-t [&>td]:border-zinc-800 [&>td]:bg-zinc-900/30">
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => toggle(g.id)} aria-expanded={open}
                        aria-label={`${open ? 'Collapse' : 'Expand'} ${g.orphan ? 'Other' : g.label}`}
                        className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm font-medium text-zinc-100">
                        <Chevron open={open} />
                        {g.orphan ? (
                          <span aria-hidden className="flex h-5 w-5 items-center justify-center text-zinc-500">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
                          </span>
                        ) : <RepoIcon />}
                        <span className="truncate">{g.label}</span>
                        <span className="text-xs font-normal tabular-nums text-zinc-600">{all}</span>
                      </button>
                      {g.orphan && open && (
                        <p className="mt-1 pl-[3.25rem] text-[11px] leading-snug text-zinc-500">
                          From worktrees this workspace doesn’t list, usually deleted ones. End them if you don’t need them.
                        </p>
                      )}
                    </td>
                    <UsageCells usage={g.usage} max={maxRss} label={g.label} strong parts={partsOf(g.byKind)} />
                    <td className="px-2 py-1 text-right">
                      {g.orphan && (
                        <span className="group">
                          <ActionButton label="End all" confirmLabel={`End ${all}`} busy={busy === `group:${g.id}`}
                            onRun={() => void endGroup(g)} />
                        </span>
                      )}
                    </td>
                  </tr>
                  {open && g.worktrees.flatMap((w) => [
                    <tr key={`wt:${w.path}`} data-testid={`sessions-worktree-${w.path}`} className="hover:bg-zinc-900/40">
                      <td className="py-1.5 pl-9 pr-3">
                        <span className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-200" title={w.path}>
                          <BranchIcon className="shrink-0 text-zinc-500" />
                          <span className="truncate">{w.label}</span>
                        </span>
                      </td>
                      <UsageCells usage={w.usage} max={maxRss} label={w.label} strong parts={partsOf(w.byKind)} />
                      <td />
                    </tr>,
                    ...w.sessions.map((s) => {
                      const processes = s.kind === 'browser' ? null : s.processes;
                      const verb = s.kind === 'pty' || (s.kind === 'server' && s.external) ? 'Kill' : s.kind === 'server' ? 'Stop' : 'Close';
                      const confirm = (s.kind === 'pty' && s.mode !== 'shell') || (s.kind === 'server' && s.external);
                      return (
                        <tr key={`${s.kind}:${s.key}`}
                          data-testid={s.kind === 'browser' ? `sessions-row-browser:${s.key}` : s.kind === 'vscode' ? `sessions-row-vscode:${s.path}` : `sessions-row-${s.key}`}
                          className="group hover:bg-zinc-900/40">
                          <td className="py-1.5 pl-16 pr-3">
                            <span className="flex items-center gap-2 text-[13px] text-zinc-300"
                              title={s.kind === 'browser' ? undefined : s.pid ? `pid ${s.pid}` : undefined}>
                              <KindIcon kind={s.mode} />
                              <span>{s.label}</span>
                              {s.kind === 'server' && (
                                <span
                                  title={s.external ? 'Started outside Strado; found listening on this worktree’s port' : 'Started by Strado'}
                                  className={`rounded px-1.5 py-px text-[10px] font-medium ${s.external ? 'bg-amber-500/10 text-amber-300/90 ring-1 ring-inset ring-amber-500/20' : 'bg-teal-500/10 text-teal-300/90 ring-1 ring-inset ring-teal-500/20'}`}>
                                  {s.external ? 'External' : 'Strado'}
                                </span>
                              )}
                              {processes !== null && processes > 1 && (
                                <span className="text-[11px] tabular-nums text-zinc-600">{processes} processes</span>
                              )}
                            </span>
                          </td>
                          <UsageCells usage={s.usage} max={maxRss} label={s.label} parts={[{ kind: s.mode, bytes: s.usage.rssBytes }]} />
                          <td className="px-2 py-1 text-right">
                            <ActionButton
                              label={`${verb} ${s.label} in ${w.label}`}
                              confirmLabel={confirm ? `${verb} ${s.label}` : undefined}
                              busy={busy === s.key}
                              onRun={() => void endRow(s)} />
                          </td>
                        </tr>
                      );
                    }),
                  ])}
                </tbody>
              );
            })}
          </table>
        </>
      )}
    </section>
  );
}
