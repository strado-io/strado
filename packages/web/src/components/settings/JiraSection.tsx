import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ConnectionStatus } from './IntegrationStatus';

// Connect Jira without hand-editing ~/.strado config files: credentials are
// validated against the Jira API before being persisted server-side. The
// token is write-only — the server never sends it back.
export function JiraSection({ onConnected }: { onConnected?: () => void }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  useEffect(() => {
    api.jira
      .config()
      .then((c) => {
        setBaseUrl(c.baseUrl ?? '');
        setEmail(c.email ?? '');
        setHasToken(c.hasToken);
      })
      .catch(() => setError('Could not load the Jira connection.'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setConnected(null);
    try {
      const res = await api.jira.saveConfig({ baseUrl: baseUrl.trim(), email: email.trim(), apiToken });
      setConnected(res.accountName);
      setHasToken(true);
      setApiToken('');
      setShowForm(false);
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true); setTested(false); setError(null);
    try {
      await api.jira.testConfig();
      setTested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jira connection failed');
    } finally {
      setTesting(false);
    }
  }

  const canSave = baseUrl.trim().length > 0 && email.trim().length > 0 && apiToken.length > 0 && !busy;
  const isConnected = Boolean(baseUrl && email && hasToken);

  const labelCls = 'flex flex-col gap-1 text-xs text-zinc-400';
  const inputCls = 'rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';

  return (
    <div className="max-w-xl space-y-5">
      <section className="rounded-xl bg-zinc-900/25 p-4">
      <div className="flex items-center">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <span>{isConnected ? 'Connected account' : 'Connection'}</span>
          <ConnectionStatus connected={isConnected} loading={loading} />
        </div>
      </div>
      {isConnected && (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-900/50 px-3 py-2.5 text-sm">
          <span className="text-zinc-300">{email}</span>
          <span className="truncate pl-4 text-xs text-zinc-500">{baseUrl}</span>
        </div>
      )}
      {connected && (
        <div className="rounded bg-emerald-900/30 px-3 py-2 text-xs text-emerald-300">
          Connected as {connected}
        </div>
      )}
      {tested && <p className="mt-3 text-xs text-emerald-400">Connection is working.</p>}
      {isConnected && (
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
          {showForm ? 'Cancel' : isConnected ? 'Edit connection' : 'Connect Jira'}
        </button>
      </div>
      {error && <div className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      {showForm && <section className="space-y-3 rounded-xl bg-zinc-900/25 p-4">
        <div className="text-xs font-medium text-zinc-500">{isConnected ? 'Update connection' : 'Connect Jira'}</div>
        <label className={labelCls}>
          Site URL
          <input
            className={inputCls}
            placeholder="https://yourorg.atlassian.net"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Account email
          <input
            className={inputCls}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          API token
          <input
            className={inputCls}
            type="password"
            placeholder={hasToken ? '•••••••• (saved — enter to replace)' : 'paste a Jira API token'}
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
          />
        </label>
        <p className="text-[11px] text-zinc-600">
          Get a token from{' '}
          <a
            className="text-sky-400 hover:underline"
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
          >
            Atlassian account settings
          </a>
        </p>
        <button
          onClick={() => void save()}
          disabled={!canSave}
          className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
        >
          {busy ? 'Connecting…' : isConnected ? 'Update Jira' : 'Connect Jira'}
        </button>
      </section>}
    </div>
  );
}
