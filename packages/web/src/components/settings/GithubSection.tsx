import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { ConnectionStatus } from './IntegrationStatus';

type Installation = Awaited<ReturnType<typeof api.github.appStatus>>['installations'][number];

// GitHub.com uses a GitHub App installation: the cloud broker mints short-lived
// repository tokens for runners. PATs remain as the compatibility path for
// GitHub Enterprise Server and existing local-only setups.
export function GithubSection() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [appAvailable, setAppAvailable] = useState(true);
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reloadLegacy = () => api.github.config()
    .then((config) => setHosts(config.hosts))
    .catch(() => setError('Could not load the GitHub connection.'));
  const reloadApp = async () => {
    try {
      const status = await api.github.appStatus();
      setInstallations(status.installations);
      setAppAvailable(true);
      return status.installations;
    } catch {
      setAppAvailable(false);
      return [];
    }
  };

  useEffect(() => {
    void Promise.all([reloadLegacy(), reloadApp()]).finally(() => setLoading(false));
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function connectApp() {
    setBusy(true);
    setError(null);
    try {
      const existingIds = new Set(installations.map((installation) => installation.installationId));
      const { url } = await api.github.appConnect();
      window.open(url, '_blank', 'noopener,noreferrer');
      const startedAt = Date.now();
      timer.current = setInterval(() => {
        if (Date.now() - startedAt > 10 * 60_000) {
          clearInterval(timer.current!);
          setBusy(false);
          setError('GitHub connection timed out — try again.');
          return;
        }
        api.github.appStatus().then((status) => {
          if (status.installations.length === 0) return;
          if (existingIds.size > 0 && !status.installations.some((installation) => !existingIds.has(installation.installationId))) return;
          clearInterval(timer.current!);
          setInstallations(status.installations);
          setAppAvailable(true);
          setBusy(false);
          window.dispatchEvent(new Event('strado:git-provider-connected'));
        }).catch(() => undefined);
      }, 2000);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : 'Failed to start GitHub connection');
    }
  }

  async function unlink(installationId: number) {
    setError(null);
    try {
      await api.github.appDisconnect(installationId);
      await reloadApp();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to unlink GitHub');
    }
  }

  async function savePat() {
    setBusy(true);
    setError(null);
    setConnected(null);
    try {
      const response = await api.github.saveConfig({
        host: host.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        token,
        owner: owner.trim() || undefined,
      });
      setConnected(response.username);
      setToken('');
      setOwner('');
      await reloadLegacy();
      window.dispatchEvent(new Event('strado:git-provider-connected'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTested(false);
    setError(null);
    try {
      await api.github.testConfig();
      setTested(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'GitHub connection failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h3 className="text-sm font-medium text-zinc-200">GitHub Connection</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Install the Strado GitHub App once. Runners receive short-lived, repository-scoped credentials automatically.
        </p>
      </div>

      <section className="rounded-xl bg-zinc-900/25 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <span>{installations.length > 0 ? 'Connected accounts' : 'Connection'}</span>
          <ConnectionStatus connected={installations.length > 0} loading={loading} />
        </div>

        {installations.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {installations.map((installation) => (
            <li key={installation.installationId} className="flex items-center justify-between rounded-lg bg-zinc-900/50 px-3 py-2.5">
              <div>
                <div className="text-sm text-zinc-200">{installation.accountLogin}</div>
                <div className="text-[11px] text-zinc-500">
                  {installation.accountType} · {installation.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
                  {installation.suspended ? ' · suspended' : ''}
                </div>
              </div>
              <button type="button" className="text-xs text-zinc-500 hover:text-red-300"
                onClick={() => void unlink(installation.installationId)}>
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

        <div className="mt-3 flex justify-end">
          <button type="button" disabled={busy} onClick={() => void connectApp()}
            className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
            {busy ? 'Waiting for GitHub…' : installations.length > 0 ? 'Add another GitHub account' : 'Connect GitHub'}
          </button>
        </div>
        {!appAvailable && (
          <p className="mt-3 text-xs text-amber-300">Sign in to your Strado account to use the GitHub App connection.</p>
        )}
        <p className="mt-3 text-[11px] text-zinc-600">
          Unlink removes the connection from Strado; uninstalling the app remains an explicit action in GitHub settings.
        </p>
      </section>

      <details className="rounded-xl bg-zinc-900/25 p-4">
        <summary className="cursor-pointer text-xs text-zinc-400">GitHub Enterprise Server or manual PAT fallback</summary>
        <div className="mt-3 space-y-3">
          {hosts.length > 0 && (
            <ul className="space-y-1.5 text-sm text-zinc-300">
              {hosts.map((savedHost) => (
                <li key={savedHost} className="flex items-center justify-between rounded-lg bg-zinc-900/50 px-3 py-2.5">
                  <span>{savedHost}</span>
                  <button type="button" className="text-zinc-500 hover:text-red-300"
                    onClick={async () => { await api.github.removeConfig(savedHost); await reloadLegacy(); }}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tested && <p className="text-xs text-emerald-400">Connection is working.</p>}
          {hosts.length > 0 && (
            <button type="button" disabled={testing} onClick={() => void testConnection()}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-40">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" placeholder="GitHub Enterprise host"
              value={host} onChange={(event) => setHost(event.target.value)} />
            <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600"
              placeholder="owner (optional)" value={owner} onChange={(event) => setOwner(event.target.value)} />
          </div>
          <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" type="password"
            placeholder="personal access token" value={token} onChange={(event) => setToken(event.target.value)} />
          <button disabled={busy || !host || !token} onClick={() => void savePat()}
            className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
            Test &amp; Save PAT
          </button>
          {connected && <p className="text-xs text-emerald-400">Connected as {connected}.</p>}
        </div>
      </details>

      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
