import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ConnectionStatus } from './IntegrationStatus';

// Connect GitLab without hand-editing ~/.strado/gitlab.json: the token is
// validated against GET /api/v4/user before being persisted per host. The
// token is write-only — the server only ever reports which hosts are connected.
export function GitlabSection() {
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  const reload = () => api.gitlab.config()
    .then((c) => setHosts(c.hosts))
    .catch(() => setError('Could not load the GitLab connection.'))
    .finally(() => setLoading(false));
  useEffect(() => { void reload(); }, []);

  async function save() {
    setBusy(true); setError(null); setConnected(null);
    try {
      const res = await api.gitlab.saveConfig({ host: host.replace(/^https?:\/\//, '').replace(/\/+$/, ''), token });
      setConnected(res.username);
      setToken('');
      setShowForm(false);
      await reload();
      // let the changes rail know it should re-probe for MRs now that a
      // token exists, instead of waiting for an unrelated refresh
      window.dispatchEvent(new Event('strado:git-provider-connected'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true); setTested(false); setError(null);
    try {
      await api.gitlab.testConfig();
      setTested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'GitLab connection failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <section className="rounded-xl bg-zinc-900/25 p-4">
      <div className="flex items-center">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <span>{hosts.length > 0 ? 'Connected hosts' : 'Connection'}</span>
          <ConnectionStatus connected={hosts.length > 0} loading={loading} />
        </div>
      </div>
      {hosts.length > 0 && (
        <div className="mt-3">
          <ul className="space-y-1.5 text-sm text-zinc-300">
          {hosts.map((h) => (
            <li key={h} className="flex items-center justify-between rounded-lg bg-zinc-900/50 px-3 py-2.5">
              <span>{h}</span>
              <button className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-red-950/50 hover:text-red-300"
                onClick={async () => { await api.gitlab.removeConfig(h); await reload(); }}>Remove</button>
            </li>
          ))}
          </ul>
        </div>
      )}
      {tested && <p className="mt-3 text-xs text-emerald-400">Connection is working.</p>}
      {hosts.length > 0 && (
        <div className="mt-3 flex justify-end">
          <button type="button" disabled={testing} onClick={() => void testConnection()}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-40">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      )}
      </section>
      <div className="flex items-center justify-end">
        <button type="button" onClick={() => setShowForm((visible) => !visible)}
          className={`rounded-md px-3 py-2 text-xs font-medium ${showForm ? 'border border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900' : 'bg-zinc-100 text-zinc-950 hover:bg-white'}`}>
          {showForm ? 'Cancel' : hosts.length > 0 ? '+ Add host' : 'Connect GitLab'}
        </button>
      </div>
      {showForm && <section className="space-y-3 rounded-xl bg-zinc-900/25 p-4">
        <div className="text-xs font-medium text-zinc-500">{hosts.length > 0 ? 'Add host' : 'Connect GitLab'}</div>
        <label className="block space-y-1 text-xs text-zinc-500">
          <span>Host</span>
          <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" placeholder="gitlab.com"
            value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className="block space-y-1 text-xs text-zinc-500">
          <span>Personal access token</span>
          <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" type="password"
            placeholder="Token with API access" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button disabled={busy || !host || !token} onClick={save}
          className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
          {busy ? 'Connecting…' : hosts.length > 0 ? 'Add host' : 'Connect GitLab'}
        </button>
      </section>}
      {connected && <p className="text-xs text-emerald-400">Connected as {connected}.</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
