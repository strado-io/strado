import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { LspServerId, LspServerStatus } from '../../types';

export type LspAdminClient = {
  list(): Promise<LspServerStatus[]>;
  setEnabled(id: LspServerId, enabled: boolean): Promise<void>;
  stop(id: LspServerId): Promise<void>;
};

// Settings › Files › Language servers: which ones this Mac has, which are on,
// what is running and how much memory it takes. Installing never happens in
// the background: the command is typed into a Shell tab in the open worktree,
// where the person sees it run (and can stop it).

const REFRESH_MS = 5000;

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition disabled:opacity-40 ${checked ? 'border-sky-500 bg-sky-500' : 'border-zinc-700 bg-zinc-900'}`}
    >
      <span aria-hidden className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** A long path cut in the middle, keeping its start and the binary's name. */
function middleTruncate(p: string, max = 64): string {
  if (p.length <= max) return p;
  const slash = p.lastIndexOf('/');
  const tail = slash >= 0 && p.length - slash <= max / 2 ? p.slice(slash) : p.slice(-Math.floor(max / 2));
  return `${p.slice(0, max - tail.length - 1)}…${tail}`;
}

function stateText(s: LspServerStatus): string {
  if (!s.installed) return 'Not installed';
  if (!s.enabled) return 'Off';
  if (s.lastError) return 'Failed';
  const n = s.running.length;
  if (!n) return 'Installed · starts when you navigate';
  const mem = s.running.reduce((sum, r) => sum + (r.rssBytes ?? 0), 0);
  return `Running in ${n} worktree${n === 1 ? '' : 's'}${mem ? ` · ${mb(mem)}` : ''}`;
}

export function LanguageServersSection({ client = api.lspServers, install }: {
  client?: LspAdminClient;
  /** The worktree an Install opens a shell in; null when none is open on this Mac. */
  install: { label: string; run: (command: string) => void } | null;
}) {
  const [servers, setServers] = useState<LspServerStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await client.list());
      setError(null);
    } catch {
      setError("Couldn't load the language servers");
    }
  }, [client]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch {
      setError("Couldn't change that — try again");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Language servers</h1>
        <p className="mt-1 text-[13px] text-zinc-400">
          Go to definition, references and hover in the Files tab. A server starts on first use in a worktree and stops after 10 idle minutes; without one, Files falls back to a whole-word search.
        </p>
        <p className="mt-2 text-[11px] text-zinc-500">
          {install ? `Install opens a shell in ${install.label} and types the command there.` : 'Open a worktree on this Mac to install from here.'}
        </p>
      </div>
      {error && <p role="alert" className="mb-3 text-[13px] text-red-300">{error}</p>}
      {!servers ? (
        !error && <p className="text-[13px] text-zinc-500">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((s) => (
            <li key={s.id} role="group" aria-label={s.lang} className="glass pane-card rounded-xl border px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-zinc-100">{s.lang}</div>
                  <div className="text-[11px] text-zinc-500">{stateText(s)}</div>
                </div>
                {s.enabled && s.lastError && (
                  <button
                    type="button"
                    aria-label={`Retry ${s.lang} language server`}
                    disabled={busy !== null}
                    // A stop is the retry: it ends any half-alive instance and clears the
                    // failure and its count, so the next navigation starts it afresh.
                    onClick={() => void act(`retry:${s.id}`, () => client.stop(s.id))}
                    className="rounded-md border border-zinc-800 px-2 py-1 text-[13px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                  >
                    Retry
                  </button>
                )}
                {s.running.length > 0 && (
                  <button
                    type="button"
                    aria-label={`Stop ${s.lang} language server`}
                    disabled={busy !== null}
                    onClick={() => void act(`stop:${s.id}`, () => client.stop(s.id))}
                    className="rounded-md border border-zinc-800 px-2 py-1 text-[13px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                  >
                    Stop
                  </button>
                )}
                <Toggle
                  label={`Use the ${s.lang} language server`}
                  checked={s.enabled}
                  disabled={busy !== null}
                  onChange={(v) => void act(`enable:${s.id}`, () => client.setEnabled(s.id, v))}
                />
              </div>
              {s.binary && <div className="mt-1 overflow-hidden whitespace-nowrap font-mono text-[11px] text-zinc-500" title={s.binary}>{middleTruncate(s.binary)}</div>}
              {s.enabled && s.lastError && (
                <details data-testid={`lsp-error-${s.id}`} className="mt-1.5 min-w-0">
                  <summary className="cursor-pointer truncate font-mono text-[11px] text-red-300">{s.lastError.split('\n')[0]}</summary>
                  <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-400">{s.lastError}</pre>
                </details>
              )}
              {!s.installed && s.install.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {s.install.map((opt) => {
                    const why = !opt.available ? `Needs ${opt.needs ?? 'a tool this Mac doesn’t have'}` : null;
                    return (
                      <li key={opt.command} className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300" title={opt.command}>{opt.command}</code>
                        {why && <span className="shrink-0 text-[11px] text-zinc-500">{why}</span>}
                        <button
                          type="button"
                          aria-label={`Install with: ${opt.command}`}
                          title={why ?? (install ? `Type it into a new shell in ${install.label}` : 'Open a worktree on this Mac first')}
                          disabled={!opt.available || !install}
                          onClick={() => install?.run(opt.command)}
                          className="shrink-0 rounded-md border border-zinc-800 px-2 py-1 text-[13px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                        >
                          Install
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
