// Self-hosted runners: list, pair, open, revoke.
//
// "Open" points a window at the runner's own dashboard (served through the
// relay) rather than folding remote worktrees into the local sidebar — a
// remote box has different files, different git credentials, and no Electron
// embeds, and window-level separation keeps that honest.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RunnerRow } from '../api';

const POLL_MS = 20_000;

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 60 / 24)}d ago`;
}

function openRunnerWindow(url: string): void {
  // The desktop shell opens a dedicated window; a plain browser gets a tab.
  if (window.strado?.openRunner) void window.strado.openRunner(url);
  else window.open(url, '_blank', 'noopener');
}

export function RunnersPanel() {
  const [runners, setRunners] = useState<RunnerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; installCommand: string; pairCommand: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // A bare "Loading…" that sits for 20s reads as broken. On a busy server
  // (worktree indexing at boot) the first list call really can take that long,
  // so say so instead of looking dead.
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const { runners: rows } = await api.runners.list();
      setRunners(rows);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setRunners([]);
    }
  }, []);

  // Poll so a box that finishes pairing (or drops offline) shows up without
  // the user hunting for a refresh button.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!live) return;
      await load();
      if (live) timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    const slowHint = setTimeout(() => {
      if (live) setSlow(true);
    }, 4000);
    void tick().finally(() => {
      clearTimeout(slowHint);
      if (live) setSlow(false);
    });
    return () => {
      live = false;
      clearTimeout(slowHint);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
  };

  const startPairing = async () => {
    setBusy('pair');
    try {
      setPairing(await api.runners.pairCode());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = async (r: RunnerRow) => {
    setBusy(r.runnerId);
    try {
      const { url } = await api.runners.attach(r.runnerId);
      openRunnerWindow(url);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (r: RunnerRow) => {
    setBusy(r.runnerId);
    try {
      const { url } = await api.runners.attach(r.runnerId);
      copy(url, r.runnerId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (r: RunnerRow) => {
    if (!confirm(`Revoke "${r.name}"? It stops being reachable immediately and must be paired again.`)) return;
    setBusy(r.runnerId);
    try {
      await api.runners.revoke(r.runnerId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-testid="runners-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Runners</h2>
          <p className="text-xs text-zinc-500">
            Other machines running Strado — reach their worktrees and agents from here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void startPairing()}
          disabled={busy === 'pair'}
          className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy === 'pair' ? 'Creating…' : 'Add runner'}
        </button>
      </div>

      {error && (
        <p className="rounded border border-amber-900/60 bg-amber-950/40 px-2.5 py-2 text-xs text-amber-200">{error}</p>
      )}

      {pairing && (
        <div className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-300">Run these on the machine you want to add</span>
            <button type="button" onClick={() => setPairing(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
              Done
            </button>
          </div>
          {[
            { label: '1. Install', cmd: pairing.installCommand },
            { label: '2. Pair', cmd: pairing.pairCommand },
          ].map((s) => (
            <div key={s.label} className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">{s.label}</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-zinc-200">
                  {s.cmd}
                </code>
                <button
                  type="button"
                  onClick={() => copy(s.cmd, s.label)}
                  className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  {copied === s.label ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-zinc-500">
            The pairing code expires {relativeTime(pairing.expiresAt).replace(' ago', '')} from now and works once.
          </p>
        </div>
      )}

      {runners === null ? (
        <p className="text-xs text-zinc-500">
          {slow ? 'Still loading — the server is busy indexing worktrees.' : 'Loading…'}
        </p>
      ) : runners.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No runners yet. “Add runner” gives you a one-line installer to run on any Linux machine.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-800 rounded border border-zinc-800">
          {runners.map((r) => (
            <li key={r.runnerId} className="flex items-center gap-3 px-3 py-2" data-testid={`runner-${r.runnerId}`}>
              <span
                aria-label={r.online ? 'online' : 'offline'}
                title={r.online ? 'online' : `last seen ${relativeTime(r.lastOnlineAt)}`}
                className={`size-2 shrink-0 rounded-full ${r.online ? 'bg-emerald-500' : 'bg-zinc-600'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-zinc-100">{r.name}</div>
                <div className="truncate text-[11px] text-zinc-500">
                  {r.online ? 'online' : `last seen ${relativeTime(r.lastOnlineAt)}`}
                  {r.runnerVersion ? ` · v${r.runnerVersion}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void open(r)}
                disabled={!r.online || busy === r.runnerId}
                title={r.online ? 'Open this machine’s dashboard' : 'Runner is offline'}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => void copyLink(r)}
                disabled={!r.online || busy === r.runnerId}
                title="Copy a single-use link (open it on your phone)"
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                {copied === r.runnerId ? 'Copied' : 'Link'}
              </button>
              <button
                type="button"
                onClick={() => void revoke(r)}
                disabled={busy === r.runnerId}
                className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-40"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
