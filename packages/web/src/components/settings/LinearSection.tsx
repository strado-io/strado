import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { publishTickets } from '../../hooks/tickets';
import { ConnectionStatus } from './IntegrationStatus';

// OAuth runs through api.strado.io (the broker holds the client secret); the
// token this exchanges for lands in ~/.strado/linear.json on this machine
// only — same write-only shape as the Jira/GitLab/GitHub connections.
function refreshConfiguredProviders(): void {
  api.tickets
    .providers()
    .then((providers) => publishTickets({ configured: providers.filter((p) => p.configured).map((p) => p.provider) }))
    .catch(() => undefined);
}

export function LinearSection() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.tickets.linearConfig().then((c) => {
      setConnected(c.connected);
      setWorkspace(c.workspaceName);
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { url, state } = await api.tickets.linearConnectStart();
      // Opening in the system browser rather than a window inside the shell:
      // a session cookie must not live in the app that composites the
      // preview (see LoginPanel.tsx for the same reasoning).
      window.open(url, '_blank', 'noopener,noreferrer');
      const startedAt = Date.now();
      timer.current = setInterval(() => {
        if (Date.now() - startedAt > 5 * 60_000) {
          clearInterval(timer.current!);
          setConnecting(false);
          setError('Timed out — try again');
          return;
        }
        api.tickets
          .linearConnectStatus(state)
          .catch(() => ({ connected: false as const }))
          .then((res) => {
            if (!res.connected) return;
            clearInterval(timer.current!);
            setConnecting(false);
            setConnected(true);
            setWorkspace(res.workspaceName ?? null);
            refreshConfiguredProviders();
          });
      }, 2000);
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const disconnect = async () => {
    await api.tickets.linearDisconnect();
    setConnected(false);
    setWorkspace(null);
    refreshConfiguredProviders();
  };

  const testConnection = async () => {
    setTesting(true); setTested(false); setError(null);
    try {
      await api.tickets.linearTest();
      setTested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Linear connection failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-xl space-y-5">
      <section className="rounded-xl bg-zinc-900/25 p-4">
      <div className="flex items-center">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <span>{connected ? 'Connected workspace' : 'Connection'}</span>
          <ConnectionStatus connected={connected === true} loading={connected === null} />
        </div>
      </div>
      {connected === true ? (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-900/50 px-3 py-2.5 text-sm">
          <div>
            <div className="text-xs text-zinc-500">Workspace</div>
            <div className="mt-0.5 font-medium text-zinc-200">{workspace}</div>
          </div>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-red-950/50 hover:text-red-300"
          >
            Disconnect
          </button>
        </div>
      ) : null}
      {tested && <p className="mt-3 text-xs text-emerald-400">Connection is working.</p>}
      {connected === true && (
        <div className="mt-3 flex justify-end">
          <button type="button" disabled={testing} onClick={() => void testConnection()}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-40">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      )}
      </section>
      {connected === false && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={connecting}
            onClick={() => void connect()}
            className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
          >
            {connecting ? 'Waiting for Linear…' : 'Connect Linear'}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
