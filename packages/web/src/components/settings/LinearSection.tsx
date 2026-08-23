import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { publishTickets } from '../../hooks/tickets';

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

  if (connected === null) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-zinc-200">Linear Connection</h3>
      {connected ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-300">
            Connected to <span className="font-medium">{workspace}</span>
          </span>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={connecting}
          onClick={() => void connect()}
          className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {connecting ? 'Waiting for Linear…' : 'Connect Linear'}
        </button>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      <p className="text-[11px] text-zinc-600">Token is stored on this machine only (~/.strado/linear.json).</p>
    </div>
  );
}
