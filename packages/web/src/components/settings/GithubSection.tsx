import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ConnectionStatus } from './IntegrationStatus';

// Connect GitHub without hand-editing ~/.strado/github.json: the token is
// validated against GET /user before being persisted per host. The token is
// write-only — the server only ever reports which hosts are connected.
export function GithubSection() {
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  const reload = () => api.github.config()
    .then((c) => setHosts(c.hosts))
    .catch(() => setError('Could not load the GitHub connection.'))
    .finally(() => setLoading(false));
  useEffect(() => { void reload(); }, []);

  async function save() {
    setBusy(true); setError(null); setConnected(null);
    try {
      const res = await api.github.saveConfig({ host: host.replace(/^https?:\/\//, '').replace(/\/+$/, ''), token, owner: owner.trim() || undefined });
      setConnected(res.username);
      setToken('');
      setOwner('');
      setShowForm(false);
      await reload();
      // let the changes rail know it should re-probe now that a token exists
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
      await api.github.testConfig();
      setTested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'GitHub connection failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <section className="rounded-xl bg-zinc-900/25 p-4">
      <div className="flex items-center">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <span>{hosts.length > 0 ? 'Connected accounts' : 'Connection'}</span>
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
                onClick={async () => { await api.github.removeConfig(h); await reload(); }}>Remove</button>
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
          {showForm ? 'Cancel' : hosts.length > 0 ? '+ Add account' : 'Connect account'}
        </button>
      </div>
      {showForm && <section className="space-y-3 rounded-xl bg-zinc-900/25 p-4">
        <div className="text-xs font-medium text-zinc-500">{hosts.length > 0 ? 'Add account' : 'Connect account'}</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-zinc-500">
            <span>Host</span>
            <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" placeholder="github.com"
              value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-zinc-500">
            <span>Organization or username <span className="text-zinc-700">optional</span></span>
            <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600"
              placeholder="strado-io" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
        </div>
        <label className="block space-y-1 text-xs text-zinc-500">
          <span>Personal access token</span>
          <input className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-inset ring-zinc-800 focus:ring-zinc-600" type="password"
            placeholder="Token with repository read access" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button disabled={busy || !host || !token} onClick={save}
          className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
          {busy ? 'Connecting…' : hosts.length > 0 ? 'Add account' : 'Connect GitHub'}
        </button>
      </section>}
      {connected && <p className="text-xs text-emerald-400">Connected as {connected}.</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
