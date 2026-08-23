import { useEffect, useState } from 'react';
import type { RepoConfig, Worktree } from '../types';

export type WorktreeSettingsPatch = Partial<{
  ticketId: string;
  title: string;
  port: number;
  env: Record<string, string>;
  startCommand: string | null;
  previewUrl: string | null;
}>;

const inputCls =
  'h-8 w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none';
const labelCls = 'text-[11px] font-medium uppercase tracking-wide text-zinc-500';
const ghostBtn = 'rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200';

// Everything configurable about one worktree, plus its maintenance actions —
// this replaces the old row "⋯" menu (link/adopt/reset/delete live here now).
export function WorktreeSettingsDialog({
  worktree,
  repo,
  worktrees,
  onSave,
  onSetEnvProfile,
  onLink,
  onUnlink,
  onRelink,
  onAdopt,
  onDelete,
  onResetTime,
  onClose,
}: {
  worktree: Worktree;
  repo: RepoConfig | null;
  // all rows of the workspace — link/relink pick their source from these
  // (window.prompt does not exist in the Electron shell)
  worktrees: Worktree[];
  onSave: (patch: WorktreeSettingsPatch) => Promise<void> | void;
  // profile changes restart a running dev server, so they use their own route
  onSetEnvProfile: (profile: string) => Promise<void> | void;
  onLink: (source: string) => void;
  onUnlink: () => void;
  onRelink: (source: string) => void;
  onAdopt: (ticketId: string, title: string) => void;
  onDelete: () => void;
  onResetTime: () => void;
  onClose: () => void;
}) {
  const meta = worktree.meta;
  const [ticketId, setTicketId] = useState(meta?.ticketId ?? '');
  const [title, setTitle] = useState(meta?.title ?? '');
  const [port, setPort] = useState(meta?.port ? String(meta.port) : '');
  const [startCommand, setStartCommand] = useState(meta?.startCommand ?? '');
  const [previewUrl, setPreviewUrl] = useState(meta?.previewUrl ?? '');
  const profiles = repo?.envProfiles ?? [];
  const initialProfile = meta?.activeEnvProfile ?? repo?.defaultEnvProfile ?? profiles[0]?.name ?? '';
  const [envProfile, setEnvProfile] = useState(initialProfile);
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(meta?.env ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // link/relink source picker (inline, replaces the old window.prompt)
  const [linkMode, setLinkMode] = useState<'link' | 'relink' | null>(null);
  const [linkSource, setLinkSource] = useState('');
  // untracked adoption inputs
  const [adoptTicket, setAdoptTicket] = useState('');
  const [adoptTitle, setAdoptTitle] = useState('');

  // Sensible sources: the repo's main checkout plus sibling worktrees with a
  // REAL node_modules install (a symlink source must own the files).
  const linkCandidates = (() => {
    const seen = new Set<string>([worktree.path]);
    const out: { path: string; label: string }[] = [];
    if (repo && !seen.has(repo.path)) {
      seen.add(repo.path);
      out.push({ path: repo.path, label: `${repo.name} (main checkout)` });
    }
    for (const w of worktrees) {
      if (w.repoId !== worktree.repoId || seen.has(w.path)) continue;
      if (w.nodeModules?.status !== 'directory') continue;
      seen.add(w.path);
      out.push({ path: w.path, label: w.meta?.ticketId || w.branch || w.path.split('/').pop() || w.path });
    }
    return out;
  })();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nm = worktree.nodeModules?.status;
  const label = meta?.ticketId ?? worktree.path.split('/').pop();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const patch: WorktreeSettingsPatch = {};
      if (ticketId.trim() && ticketId.trim() !== meta?.ticketId) patch.ticketId = ticketId.trim();
      if (title.trim() && title.trim() !== meta?.title) patch.title = title.trim();
      const portNum = Number(port);
      if (port.trim() && Number.isInteger(portNum) && portNum > 0 && portNum !== meta?.port) patch.port = portNum;
      const cmd = startCommand.trim();
      if (cmd !== (meta?.startCommand ?? '')) patch.startCommand = cmd || null;
      const url = previewUrl.trim();
      if (url !== (meta?.previewUrl ?? '')) patch.previewUrl = url || null;
      const env: Record<string, string> = {};
      for (const row of envRows) {
        if (row.key.trim()) env[row.key.trim()] = row.value;
      }
      if (JSON.stringify(env) !== JSON.stringify(meta?.env ?? {})) patch.env = env;
      if (Object.keys(patch).length > 0) await onSave(patch);
      if (envProfile && envProfile !== initialProfile) await onSetEnvProfile(envProfile);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-zinc-200">
          Worktree settings · <span className="font-mono text-zinc-100">{label}</span>
          <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-600" title={worktree.path}>
            {worktree.path}
          </div>
        </div>

        {!worktree.tracked ? (
          <div className="flex flex-col gap-2 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            <span>Untracked worktree — adopt it to manage its settings.</span>
            <div className="flex items-center gap-1.5">
              <input
                value={adoptTicket}
                onChange={(e) => setAdoptTicket(e.target.value)}
                placeholder="FD-1234"
                aria-label="Adopt ticket ID"
                className={`${inputCls} w-32 font-mono`}
              />
              <input
                value={adoptTitle}
                onChange={(e) => setAdoptTitle(e.target.value)}
                placeholder="Title"
                aria-label="Adopt title"
                className={inputCls}
              />
              <button
                onClick={() => onAdopt(adoptTicket.trim(), adoptTitle.trim())}
                disabled={!adoptTicket.trim()}
                className="shrink-0 rounded bg-amber-700 px-2 py-1.5 font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                Adopt
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Ticket ID</span>
                <input value={ticketId} onChange={(e) => setTicketId(e.target.value)} placeholder="FD-1234" className={`${inputCls} font-mono`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Port</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder={repo ? String(repo.defaultPort) : '3000'} className={`${inputCls} font-mono`} />
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                <span className={labelCls}>Title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this worktree for?" className={inputCls} />
              </label>
              {profiles.length > 0 && (
                <label className="col-span-2 flex flex-col gap-1">
                  <span className={labelCls}>Env profile</span>
                  <select
                    value={envProfile}
                    onChange={(e) => setEnvProfile(e.target.value)}
                    title="Switching restarts a running dev server"
                    className={`${inputCls} cursor-pointer uppercase`}
                  >
                    {profiles.map((p) => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="col-span-2 flex flex-col gap-1">
                <span className={labelCls}>Start command override</span>
                <input
                  value={startCommand}
                  onChange={(e) => setStartCommand(e.target.value)}
                  aria-label="Start command override"
                  placeholder={repo?.startCommand ?? 'npm run dev'}
                  className={`${inputCls} font-mono`}
                />
                <span className="text-[11px] text-zinc-600">
                  Empty uses the repo command{profiles.length > 0 ? '; include {ENV_FILE} to keep env profiles' : ''}.
                </span>
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                <span className={labelCls}>Preview URL override</span>
                <input
                  value={previewUrl}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                  aria-label="Preview URL override"
                  placeholder={`http://localhost:${meta?.port ?? repo?.defaultPort ?? 3000}`}
                  className={`${inputCls} font-mono`}
                />
                <span className="text-[11px] text-zinc-600">Default Browser-tab URL for this worktree.</span>
              </label>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={labelCls}>Env variables (injected at start)</span>
              {envRows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={row.key}
                    onChange={(e) => setEnvRows((p) => p.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="KEY"
                    aria-label={`Env key ${i + 1}`}
                    className={`${inputCls} w-2/5 font-mono uppercase`}
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setEnvRows((p) => p.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder="value"
                    aria-label={`Env value ${i + 1}`}
                    className={`${inputCls} font-mono`}
                  />
                  <button
                    aria-label={`Remove env var ${i + 1}`}
                    onClick={() => setEnvRows((p) => p.filter((_, j) => j !== i))}
                    className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
              <button
                onClick={() => setEnvRows((p) => [...p, { key: '', value: '' }])}
                className="self-start rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                + Add variable
              </button>
            </div>
          </>
        )}

        {error && <div className="rounded bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}

        {linkMode && (
          <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-zinc-500">
              {linkMode === 'relink' ? 'Relink from' : 'Link from'}
            </span>
            <select
              value={linkSource}
              onChange={(e) => setLinkSource(e.target.value)}
              aria-label="Link source worktree"
              className={`${inputCls} cursor-pointer`}
            >
              <option value="" disabled>Pick a source…</option>
              {linkCandidates.map((c) => (
                <option key={c.path} value={c.path}>{c.label}</option>
              ))}
            </select>
            <button
              onClick={() => {
                if (linkMode === 'relink') onRelink(linkSource);
                else onLink(linkSource);
              }}
              disabled={!linkSource}
              className="shrink-0 rounded bg-sky-700 px-2 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {linkMode === 'relink' ? 'Relink' : 'Link'}
            </button>
            <button onClick={() => setLinkMode(null)} className={`${ghostBtn} shrink-0`}>
              Cancel
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 border-t border-zinc-900 pt-3">
          {worktree.tracked && (
            <>
              {nm === 'symlink' && (
                <>
                  <button className={ghostBtn} onClick={onUnlink}>Unlink node_modules</button>
                  <button className={ghostBtn} onClick={() => setLinkMode('relink')}>Relink…</button>
                </>
              )}
              {nm === 'directory' && (
                <button className={ghostBtn} onClick={() => setLinkMode('link')}>Replace installed with link…</button>
              )}
              {(nm === 'missing' || nm == null) && (
                <button className={ghostBtn} onClick={() => setLinkMode('link')}>Link node_modules…</button>
              )}
              {(worktree.activitySeconds ?? 0) > 0 && (
                <button className={ghostBtn} onClick={onResetTime}>Reset time</button>
              )}
            </>
          )}
          <button className={`${ghostBtn} hover:bg-red-950/60 hover:text-red-300`} onClick={onDelete}>
            Delete…
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="rounded px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
              Cancel
            </button>
            {worktree.tracked && (
              <button
                onClick={() => void save()}
                disabled={busy}
                className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
