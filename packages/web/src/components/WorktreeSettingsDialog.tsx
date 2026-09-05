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
  'h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600';
const labelCls = 'text-xs font-medium text-zinc-300';
const ghostBtn = 'rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200';

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
  worktrees: Worktree[];
  onSave: (patch: WorktreeSettingsPatch) => Promise<void> | void;
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
  const [runtimeOpen, setRuntimeOpen] = useState(
    Boolean(meta?.startCommand || meta?.previewUrl || Object.keys(meta?.env ?? {}).length > 0),
  );
  const [linkMode, setLinkMode] = useState<'link' | 'relink' | null>(null);
  const [linkSource, setLinkSource] = useState('');
  const [adoptTicket, setAdoptTicket] = useState('');
  const [adoptTitle, setAdoptTitle] = useState('');

  const linkCandidates = (() => {
    const seen = new Set<string>([worktree.path]);
    const candidates: { path: string; label: string }[] = [];
    if (repo && !seen.has(repo.path)) {
      seen.add(repo.path);
      candidates.push({ path: repo.path, label: `${repo.name} (main checkout)` });
    }
    for (const sibling of worktrees) {
      if (sibling.repoId !== worktree.repoId || seen.has(sibling.path)) continue;
      if (sibling.nodeModules?.status !== 'directory') continue;
      seen.add(sibling.path);
      candidates.push({
        path: sibling.path,
        label: sibling.meta?.ticketId || sibling.branch || sibling.path.split('/').pop() || sibling.path,
      });
    }
    return candidates;
  })();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const nodeModulesStatus = worktree.nodeModules?.status;
  const label = meta?.ticketId || worktree.branch || worktree.path.split('/').pop();
  // A missing node_modules directory in a Rust, Go, or Java repository is not
  // an action item. Only show these controls for an actual Node-style repo.
  const nodeProject = nodeModulesStatus === 'directory' || nodeModulesStatus === 'symlink'
    || /(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\s|$)/.test(repo?.startCommand ?? '');
  const hasMaintenanceActions = worktree.tracked
    && (nodeProject || (worktree.activitySeconds ?? 0) > 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!title.trim()) throw new Error('Title is required.');
      if (port.trim()) {
        const parsedPort = Number(port);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          throw new Error('Port must be a whole number between 1 and 65535.');
        }
      }

      const patch: WorktreeSettingsPatch = {};
      if (ticketId.trim() !== (meta?.ticketId ?? '')) patch.ticketId = ticketId.trim();
      if (title.trim() !== meta?.title) patch.title = title.trim();
      const portNumber = Number(port);
      if (port.trim() && portNumber !== meta?.port) patch.port = portNumber;
      const command = startCommand.trim();
      if (command !== (meta?.startCommand ?? '')) patch.startCommand = command || null;
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
    } catch (saveError) {
      setError((saveError as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={busy ? undefined : onClose}
    >
      <form
        aria-labelledby="worktree-settings-title"
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (worktree.tracked) void save();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 id="worktree-settings-title" className="shrink-0 text-base font-semibold text-zinc-100">
                Worktree settings
              </h2>
              <span className="truncate rounded bg-zinc-900 px-2 py-0.5 font-mono text-xs text-zinc-400">
                {label}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-zinc-600" title={worktree.path}>
              {worktree.path}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {!worktree.tracked ? (
            <section className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4">
              <h3 className="text-sm font-medium text-amber-200">Add this worktree to Strado</h3>
              <p className="mt-1 text-xs leading-5 text-amber-300/70">
                This Git worktree is not tracked yet. Add its ticket and title to manage it here.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-[9rem_1fr]">
                <label className="block">
                  <span className={`mb-1.5 block ${labelCls}`}>Ticket ID</span>
                  <input
                    value={adoptTicket}
                    onChange={(event) => setAdoptTicket(event.target.value)}
                    placeholder="FD-1234"
                    aria-label="Adopt ticket ID"
                    className={`${inputCls} font-mono`}
                  />
                </label>
                <label className="block">
                  <span className={`mb-1.5 block ${labelCls}`}>Title</span>
                  <input
                    value={adoptTitle}
                    onChange={(event) => setAdoptTitle(event.target.value)}
                    placeholder="What is this worktree for?"
                    aria-label="Adopt title"
                    className={inputCls}
                  />
                </label>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => onAdopt(adoptTicket.trim(), adoptTitle.trim())}
                  disabled={!adoptTicket.trim()}
                  className="rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
                >
                  Add worktree
                </button>
              </div>
            </section>
          ) : (
            <div className="space-y-4">
              <section>
                <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
                  <label className="block">
                    <span className={`mb-1.5 block ${labelCls}`}>
                      Ticket <span className="font-normal text-zinc-600">(optional)</span>
                    </span>
                    <input
                      aria-label="Ticket ID"
                      value={ticketId}
                      onChange={(event) => setTicketId(event.target.value)}
                      placeholder="FD-1234"
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="block">
                    <span className={`mb-1.5 block ${labelCls}`}>Title</span>
                    <input
                      aria-label="Title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="What is this worktree for?"
                      className={inputCls}
                    />
                  </label>
                </div>
              </section>

              <details
                className="group overflow-hidden rounded-lg border border-zinc-800"
                open={runtimeOpen}
                onToggle={(event) => setRuntimeOpen(event.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-3.5 py-3 hover:bg-zinc-900/70 [&::-webkit-details-marker]:hidden">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-zinc-500">
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                      <path d="M3 4h10M3 8h10M3 12h10" />
                      <circle cx="6" cy="4" r="1.3" fill="currentColor" />
                      <circle cx="10" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="7" cy="12" r="1.3" fill="currentColor" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-300">Runtime &amp; environment</span>
                    <span className="mt-0.5 block text-[11px] text-zinc-600">Port, start command, preview URL and variables</span>
                  </span>
                  <svg className="text-zinc-600 transition-transform group-open:rotate-90" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                    <path d="m5 3.5 3.5 3.5L5 10.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>

                <div className="space-y-4 border-t border-zinc-800 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className={`mb-1.5 block ${labelCls}`}>Port</span>
                      <input
                        aria-label="Port"
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                        inputMode="numeric"
                        placeholder={repo ? String(repo.defaultPort) : '3000'}
                        className={`${inputCls} font-mono`}
                      />
                    </label>
                    {profiles.length > 0 && (
                      <label className="block">
                        <span className={`mb-1.5 block ${labelCls}`}>Environment profile</span>
                        <select
                          aria-label="Env profile"
                          value={envProfile}
                          onChange={(event) => setEnvProfile(event.target.value)}
                          title="Switching restarts a running dev server"
                          className={`${inputCls} cursor-pointer uppercase`}
                        >
                          {profiles.map((profile) => (
                            <option key={profile.name} value={profile.name}>{profile.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  <label className="block">
                    <span className={`mb-1.5 block ${labelCls}`}>Start command override</span>
                    <input
                      value={startCommand}
                      onChange={(event) => setStartCommand(event.target.value)}
                      aria-label="Start command override"
                      placeholder={repo?.startCommand || 'No repository command configured'}
                      className={`${inputCls} font-mono`}
                    />
                    <span className="mt-1.5 block text-[11px] text-zinc-600">
                      Leave empty to use the repository command{profiles.length > 0 ? ". The selected profile's variables are injected at start; write {ENV_FILE} where the command should receive the file itself" : ''}.
                    </span>
                  </label>

                  <label className="block">
                    <span className={`mb-1.5 block ${labelCls}`}>Preview URL override</span>
                    <input
                      value={previewUrl}
                      onChange={(event) => setPreviewUrl(event.target.value)}
                      aria-label="Preview URL override"
                      placeholder={`http://localhost:${meta?.port ?? repo?.defaultPort ?? 3000}`}
                      className={`${inputCls} font-mono`}
                    />
                    <span className="mt-1.5 block text-[11px] text-zinc-600">Leave empty to use the detected local URL.</span>
                  </label>

                  <div className="border-t border-zinc-800 pt-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div>
                        <h4 className={labelCls}>Environment variables</h4>
                        <p className="mt-0.5 text-[11px] text-zinc-600">Injected when this worktree starts.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEnvRows((previous) => [...previous, { key: '', value: '' }])}
                        className={ghostBtn}
                      >
                        Add variable
                      </button>
                    </div>
                    <div className="space-y-2">
                      {envRows.length === 0 && (
                        <p className="rounded-md border border-dashed border-zinc-800 px-3 py-2.5 text-xs text-zinc-600">No custom variables.</p>
                      )}
                      {envRows.map((row, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            value={row.key}
                            onChange={(event) => setEnvRows((previous) => previous.map((item, itemIndex) => (
                              itemIndex === index ? { ...item, key: event.target.value } : item
                            )))}
                            placeholder="KEY"
                            aria-label={`Env key ${index + 1}`}
                            className={`${inputCls} w-2/5 font-mono uppercase`}
                          />
                          <input
                            value={row.value}
                            onChange={(event) => setEnvRows((previous) => previous.map((item, itemIndex) => (
                              itemIndex === index ? { ...item, value: event.target.value } : item
                            )))}
                            placeholder="value"
                            aria-label={`Env value ${index + 1}`}
                            className={`${inputCls} font-mono`}
                          />
                          <button
                            type="button"
                            aria-label={`Remove env var ${index + 1}`}
                            onClick={() => setEnvRows((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}
                            className="shrink-0 rounded-md p-2 text-zinc-500 hover:bg-red-950/50 hover:text-red-300"
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </details>

              {hasMaintenanceActions && (
                <section className="rounded-lg border border-zinc-800 p-3.5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-medium text-zinc-300">Worktree maintenance</h3>
                      <p className="mt-1 text-[11px] leading-4 text-zinc-600">
                        {nodeProject && nodeModulesStatus === 'symlink'
                          ? 'node_modules is linked from another checkout.'
                          : nodeProject && nodeModulesStatus === 'directory'
                            ? 'This worktree has its own installed node_modules.'
                            : nodeProject
                              ? 'Share node_modules from an existing checkout.'
                              : 'Manage local activity data for this worktree.'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {nodeProject && nodeModulesStatus === 'symlink' && (
                        <>
                          <button type="button" className={ghostBtn} onClick={onUnlink}>Unlink node_modules</button>
                          <button type="button" className={ghostBtn} onClick={() => setLinkMode('relink')}>Relink…</button>
                        </>
                      )}
                      {nodeProject && nodeModulesStatus === 'directory' && (
                        <button type="button" className={ghostBtn} onClick={() => setLinkMode('link')}>Replace with link…</button>
                      )}
                      {nodeProject && (nodeModulesStatus === 'missing' || nodeModulesStatus == null) && (
                        <button type="button" className={ghostBtn} onClick={() => setLinkMode('link')}>Link node_modules…</button>
                      )}
                      {(worktree.activitySeconds ?? 0) > 0 && (
                        <button type="button" className={ghostBtn} onClick={onResetTime}>Reset tracked time</button>
                      )}
                    </div>
                  </div>

                  {linkMode && (
                    <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3">
                      <select
                        value={linkSource}
                        onChange={(event) => setLinkSource(event.target.value)}
                        aria-label="Link source worktree"
                        className={`${inputCls} cursor-pointer`}
                      >
                        <option value="" disabled>Choose source worktree…</option>
                        {linkCandidates.map((candidate) => (
                          <option key={candidate.path} value={candidate.path}>{candidate.label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          if (linkMode === 'relink') onRelink(linkSource);
                          else onLink(linkSource);
                        }}
                        disabled={!linkSource}
                        className="shrink-0 rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
                      >
                        {linkMode === 'relink' ? 'Relink' : 'Link'}
                      </button>
                      <button type="button" onClick={() => setLinkMode(null)} className={ghostBtn}>Cancel</button>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="mt-4 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3.5">
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 text-xs text-red-400/80 hover:bg-red-950/50 hover:text-red-300"
            onClick={onDelete}
          >
            Delete worktree…
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-40"
            >
              Cancel
            </button>
            {worktree.tracked && (
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-zinc-100 px-4 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </footer>
      </form>
    </div>
  );
}
