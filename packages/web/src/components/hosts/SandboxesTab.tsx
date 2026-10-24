// A host's Sandboxes tab: the containers the runner runs for its worktrees,
// one stats sample each, and the actions on them. Refreshes every 10s only
// while it is on screen (row expanded, tab selected). Never an env value: the
// runner sends only the SandboxRow fields.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { subscribeJob } from '../../eventStream';
import type { SandboxAction, SandboxList, SandboxRow } from '../../types';

const POLL_MS = 10_000;
const AGENT: Record<SandboxRow['staleLogins'][number], string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
const STATUS: Record<SandboxRow['status'], { text: string; dot: string }> = {
  running: { text: 'Running', dot: 'bg-emerald-500' },
  stopped: { text: 'Stopped', dot: 'bg-zinc-600' },
  creating: { text: 'Creating', dot: 'bg-sky-500' },
  unknown: { text: 'Unknown', dot: 'bg-amber-500' },
};

export function uptime(startedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (mins < 1) return 'up <1m';
  if (mins < 60) return `up ${mins}m`;
  if (mins < 60 * 24) return `up ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `up ${Math.floor(mins / 60 / 24)}d ${Math.floor(mins / 60) % 24}h`;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** "Claude was" / "Claude and Codex were" / "Claude, Codex and Pi were". */
export function staleText(agents: SandboxRow['staleLogins']): string {
  const names = agents.map((a) => AGENT[a]);
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Created before ${list} ${names.length > 1 ? 'were' : 'was'} connected`;
}

type Busy = { action: SandboxAction; progress: string | null };

export function SandboxesTab({ runnerId, online, visible }: {
  runnerId: string;
  online: boolean;
  /** On screen: the row is expanded and this tab selected. Polling runs only then. */
  visible: boolean;
}) {
  const [list, setList] = useState<SandboxList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const subs = useRef(new Map<string, () => void>());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.runners.sandboxes.list(runnerId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runnerId]);

  useEffect(() => {
    if (!visible || !online) return;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, online, load]);
  useEffect(() => () => { for (const off of subs.current.values()) off(); }, []);

  const done = (slug: string, err?: string) => {
    subs.current.get(slug)?.();
    subs.current.delete(slug);
    setBusy((b) => { const n = { ...b }; delete n[slug]; return n; });
    if (err) setRowErrors((e) => ({ ...e, [slug]: err }));
    void load();
  };

  const act = async (row: SandboxRow, action: SandboxAction) => {
    if (action === 'remove' && !confirm(`Remove the sandbox for ${row.worktreeName ?? row.slug}? Removing ends this sandbox's terminals.`)) return;
    const slug = row.slug;
    setRowErrors((e) => { const n = { ...e }; delete n[slug]; return n; });
    setBusy((b) => ({ ...b, [slug]: { action, progress: null } }));
    try {
      const res = await api.runners.sandboxes.action(runnerId, slug, action);
      if (!('jobId' in res)) return done(slug);
      subs.current.set(slug, subscribeJob(res.jobId, (evt) => {
        if (evt.type === 'progress') {
          const message = ((evt.data ?? {}) as { message?: string }).message ?? null;
          setBusy((b) => (b[slug] ? { ...b, [slug]: { ...b[slug]!, progress: message } } : b));
          return;
        }
        if (evt.type === 'done') return done(slug);
        const d = (evt.data ?? {}) as { message?: string; error?: string };
        done(slug, d.message || d.error || 'Rebuild failed');
      }));
    } catch (err) {
      done(slug, (err as Error).message);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="sandboxes-tab">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">
          {list?.runtime ? `Sandboxes on ${list.runtime}` : list ? 'No sandbox runtime on this runner' : ''}
        </span>
        <button type="button" onClick={() => void load()} disabled={!online || loading}
          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {!online && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" data-testid="sandboxes-offline">
          Runner offline — sandboxes can’t be listed or changed now.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-300">Couldn’t load sandboxes: {error}</p>}
      {online && list && list.sandboxes.length === 0 && <p className="text-xs text-zinc-500">No sandboxes on this runner.</p>}
      {list && list.sandboxes.length > 0 && (
        <ul className="flex flex-col divide-y divide-zinc-800 rounded border border-zinc-800">
          {list.sandboxes.map((row) => (
            <SandboxItem key={row.slug} row={row} online={online} busy={busy[row.slug]} error={rowErrors[row.slug]} onAct={(a) => void act(row, a)} />
          ))}
        </ul>
      )}
    </section>
  );
}

const btn = 'rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40';

function SandboxItem({ row, online, busy, error, onAct }: {
  row: SandboxRow;
  online: boolean;
  busy: Busy | undefined;
  error: string | undefined;
  onAct: (a: SandboxAction) => void;
}) {
  const ours = row.worktreePath !== null;
  const s = STATUS[row.status];
  const off = !online || !!busy;
  const title = ours ? [row.repoName, row.worktreeName].filter(Boolean).join(' / ') || row.slug : row.slug;
  const usage = [
    row.cpuPercent != null ? `CPU ${row.cpuPercent.toFixed(row.cpuPercent < 10 ? 1 : 0)}%` : null,
    row.memBytes != null ? `${bytes(row.memBytes)}${row.memLimitBytes ? ` / ${bytes(row.memLimitBytes)}` : ''}` : null,
    row.status === 'running' && row.startedAt ? uptime(row.startedAt) : null,
  ].filter(Boolean).join(' · ');
  const actions: SandboxAction[] = !ours ? []
    : row.status === 'running' ? ['restart', 'stop', 'rebuild', 'remove']
    : row.status === 'stopped' ? ['start', 'rebuild', 'remove']
    : row.status === 'unknown' ? ['rebuild', 'remove']
    : [];
  const label: Record<SandboxAction, string> = { restart: 'Restart', stop: 'Stop', start: 'Start', rebuild: 'Rebuild', remove: 'Remove' };

  return (
    <li className={`flex flex-col gap-1 px-3 py-2 ${ours ? '' : 'opacity-50'}`} data-testid={`sandbox-${row.slug}`} data-status={row.status}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-zinc-100">{title}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1"><span aria-hidden className={`size-1.5 rounded-full ${s.dot}`} />{s.text}</span>
            <span className="truncate font-mono" title={row.image}>{row.image}</span>
            {usage && <span>{usage}</span>}
            {!ours && <span>Not a Strado sandbox</span>}
          </div>
        </div>
        {busy ? (
          <span className="text-[11px] text-sky-300" data-testid="sandbox-busy">{busy.progress ?? `${label[busy.action]}…`}</span>
        ) : (
          actions.map((a) => (
            <button key={a} type="button" disabled={off} onClick={() => onAct(a)}
              className={a === 'remove' ? `${btn} border-zinc-800 text-zinc-500 hover:text-red-300` : btn}>
              {label[a]}
            </button>
          ))
        )}
      </div>
      {ours && row.staleLogins.length > 0 && !busy && (
        <div className="flex items-center gap-2 text-[11px] text-amber-300" data-testid="sandbox-stale">
          <span>{staleText(row.staleLogins)}</span>
          <span aria-hidden>·</span>
          <button type="button" disabled={off} onClick={() => onAct('rebuild')} className="underline-offset-2 hover:underline disabled:opacity-40">Rebuild</button>
        </div>
      )}
      {error && !busy && <p role="alert" className="text-[11px] text-red-300">{error}</p>}
    </li>
  );
}
