import { useState } from 'react';
import { api, DetectedRepo } from '../api';

const INPUT =
  'w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none';

/**
 * First-run flow shown when a workspace has no repos: paste a folder path,
 * the server detects the git root / start command / port / env profiles,
 * and one click saves the prefilled repo config.
 */
export function OnboardingCard({
  wsId,
  onAdded,
  onOpenRepos,
}: {
  wsId: string;
  onAdded: () => void;
  onOpenRepos: () => void;
}) {
  const [path, setPath] = useState('');
  const [detected, setDetected] = useState<DetectedRepo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detect(pathArg?: string) {
    const p = (pathArg ?? path).trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      setDetected(await api.repos.detect(wsId, p));
    } catch (err) {
      setDetected(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Native folder picker — only in the desktop shell (feature-detected).
  const canPickFolder = typeof window !== 'undefined' && typeof window.strado?.pickDirectory === 'function';
  async function pickFolder() {
    const dir = await window.strado?.pickDirectory?.();
    if (!dir) return;
    setPath(dir);
    detect(dir);
  }

  async function add() {
    if (!detected) return;
    setBusy(true);
    setError(null);
    try {
      const { warnings: _warnings, ...repo } = detected;
      await api.repos.add(wsId, repo);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
      <h2 className="text-lg font-semibold text-zinc-100">Add your first repo</h2>
      <p className="mt-1 text-sm text-zinc-500">
        {canPickFolder
          ? 'Choose the folder of a git repo (or an app folder inside a monorepo). Everything else —'
          : 'Paste the folder of a git repo (or an app folder inside a monorepo). Everything else —'}
        {' '}worktrees dir, start command, port, env profiles — is detected for you.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          className={INPUT}
          placeholder="/Users/you/code/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') detect();
          }}
          aria-label="Repo folder path"
        />
        {canPickFolder && (
          <button
            type="button"
            className="shrink-0 rounded border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            onClick={pickFolder}
            disabled={busy}
          >
            Choose folder…
          </button>
        )}
        <button
          className="shrink-0 rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          onClick={() => detect()}
          disabled={busy || !path.trim()}
        >
          {busy && !detected ? 'Detecting…' : 'Detect'}
        </button>
      </div>

      {error && <div className="mt-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}

      {detected && (
        <div className="mt-4 rounded border border-zinc-800 bg-zinc-950 p-4" data-testid="detected-repo">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-zinc-100">{detected.name}</span>
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{detected.id}</code>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <dt>repo</dt>
            <dd className="truncate text-zinc-300" title={detected.path}>{detected.path}</dd>
            {detected.projectSubdir && (
              <>
                <dt>subdir</dt>
                <dd className="text-zinc-300">{detected.projectSubdir}</dd>
              </>
            )}
            <dt>start</dt>
            <dd className="text-zinc-300">
              {detected.startCommand} <span className="text-zinc-500">→ port {detected.defaultPort}</span>
            </dd>
            {(detected.envProfiles?.length ?? 0) > 0 && (
              <>
                <dt>env</dt>
                <dd className="text-zinc-300">{detected.envProfiles!.map((p) => p.name).join(', ')}</dd>
              </>
            )}
          </dl>
          {detected.warnings.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {detected.warnings.map((w) => (
                <li key={w} className="rounded bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200">
                  {w}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center justify-end gap-3">
            <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={onOpenRepos}>
              Edit details in settings
            </button>
            <button
              className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              onClick={add}
              disabled={busy}
            >
              {busy ? 'Adding…' : 'Add repo'}
            </button>
          </div>
        </div>
      )}

      <button className="mt-4 text-xs text-zinc-600 hover:text-zinc-400" onClick={onOpenRepos}>
        or configure manually →
      </button>
    </div>
  );
}
