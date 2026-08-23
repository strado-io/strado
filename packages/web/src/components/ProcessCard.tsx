import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ProcInfo } from '../types';

const LOG_TAIL = 40;

export function ProcessCard({ wsId, path, process }: { wsId: string; path: string; process: ProcInfo }) {
  const [lines, setLines] = useState<string[]>([]);
  const [proc, setProc] = useState<ProcInfo>(process);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setProc(process); }, [process]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await api.worktrees.logs(wsId, path, LOG_TAIL);
        if (live) setLines(r.lines.slice(-4));
      } catch { /* logs are best-effort */ }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [wsId, path]);

  const running = proc.status === 'running' || proc.status === 'starting';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="ml-3.5 mb-1 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between text-zinc-400">
        <span>{running ? `running${proc.port ? ` · :${proc.port}` : ''}` : proc.status}</span>
        {running ? (
          <button disabled={busy} onClick={() => act(async () => setProc(await api.worktrees.stop(wsId, path).then(() => ({ ...proc, status: 'stopped' } as ProcInfo))))}
            className="rounded px-1.5 py-0.5 text-red-300 hover:bg-zinc-800 disabled:opacity-50">Stop</button>
        ) : (
          <button disabled={busy} onClick={() => act(async () => setProc(await api.worktrees.start(wsId, path)))}
            className="rounded px-1.5 py-0.5 text-emerald-300 hover:bg-zinc-800 disabled:opacity-50">Start</button>
        )}
      </div>
      {error && <div className="mb-1 text-red-300">{error}</div>}
      <pre className="max-h-16 overflow-hidden whitespace-pre-wrap font-mono text-[10px] leading-tight text-zinc-500">
        {lines.length ? lines.join('\n') : 'no recent output'}
      </pre>
    </div>
  );
}
