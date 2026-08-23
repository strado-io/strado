import { useEffect, useState } from 'react';
import { api } from '../../api';

// Connect GitHub without hand-editing ~/.strado/github.json: the token is
// validated against GET /user before being persisted per host. The token is
// write-only — the server only ever reports which hosts are connected.
export function GithubSection() {
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  const reload = () => api.github.config().then((c) => setHosts(c.hosts)).catch(() => undefined);
  useEffect(() => { void reload(); }, []);

  async function save() {
    setBusy(true); setError(null); setConnected(null);
    try {
      const res = await api.github.saveConfig({ host: host.replace(/^https?:\/\//, '').replace(/\/+$/, ''), token, owner: owner.trim() || undefined });
      setConnected(res.username);
      setToken('');
      setOwner('');
      await reload();
      // let the changes rail know it should re-probe now that a token exists
      window.dispatchEvent(new Event('strado:git-provider-connected'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-zinc-200">GitHub Connection</h3>
      {hosts.length > 0 && (
        <ul className="space-y-1 text-xs text-zinc-400">
          {hosts.map((h) => (
            <li key={h} className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1">
              <span>{h}</span>
              <button className="text-zinc-500 hover:text-red-300"
                onClick={async () => { await api.github.removeConfig(h); await reload(); }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <input className="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200" placeholder="github host (github.com or GHE domain)"
        value={host} onChange={(e) => setHost(e.target.value)} />
      <input className="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
        placeholder="owner (optional — org or username, for account-specific tokens)"
        value={owner} onChange={(e) => setOwner(e.target.value)} />
      <input className="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200" type="password"
        placeholder="PAT — classic: repo scope · fine-grained: Contents + Pull requests read" value={token} onChange={(e) => setToken(e.target.value)} />
      <p className="text-xs text-zinc-600">Separate work and personal accounts? Save one token per owner — the bare host entry is the fallback.</p>
      <button disabled={busy || !host || !token} onClick={save}
        className="rounded bg-emerald-700 px-3 py-1 text-sm text-white disabled:opacity-50">
        {busy ? 'Connecting…' : 'Test & Save'}
      </button>
      {connected && <p className="text-xs text-emerald-400">Connected as {connected}.</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
