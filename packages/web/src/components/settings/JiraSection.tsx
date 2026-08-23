import { useEffect, useState } from 'react';
import { api } from '../../api';

// Connect Jira without hand-editing ~/.strado config files: credentials are
// validated against the Jira API before being persisted server-side. The
// token is write-only — the server never sends it back.
export function JiraSection({ onConnected }: { onConnected?: () => void }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
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
      .catch(() => undefined);
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
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = baseUrl.trim().length > 0 && email.trim().length > 0 && apiToken.length > 0 && !busy;

  const labelCls = 'flex flex-col gap-1 text-xs text-zinc-400';
  const inputCls = 'rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold text-zinc-100">Jira</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Credentials stay on this machine and are only used by the local server to proxy Jira calls.
      </p>
      {connected && (
        <div className="mb-3 rounded bg-emerald-900/30 px-3 py-2 text-xs text-emerald-300">
          Connected as {connected}
        </div>
      )}
      {error && <div className="mb-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="flex flex-col gap-3">
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
          Create one at{' '}
          <a
            className="text-sky-400 hover:underline"
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
          >
            id.atlassian.com → Security → API tokens
          </a>
        </p>
      </div>
      <button
        onClick={() => void save()}
        disabled={!canSave}
        className="mt-4 rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
      >
        {busy ? 'Testing…' : 'Test & save'}
      </button>
    </div>
  );
}
