// Settings › Projects: the repos of this workspace ("projects" in the UI).
// One opens to its settings: name, port and the rest, its run commands (the
// same editor as the hub's "+ Add run command…"), its worktrees (Delete, for
// the ones in no Focus too), and Remove project.
import { useState } from 'react';
import type { RepoConfig, Worktree } from '../../types';
import { RunCommandsEditor, type RunCommandDraft } from '../runCommands/RunCommandsDialog';
import { worktreeLabel } from '../sidebar/labels';

export type ProjectsProps = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  /** Opens the Add repo dialog. */
  onAdd: () => void;
  onPatch: (repo: RepoConfig, patch: Partial<RepoConfig>) => Promise<void>;
  onSaveRunCommands: (repo: RepoConfig, commands: RunCommandDraft[]) => Promise<void>;
  /** After the person confirmed. */
  onRemove: (repo: RepoConfig) => Promise<void>;
  onDeleteWorktree: (w: Worktree) => void;
};

const FIELD = 'w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none';
const H2 = 'mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500';

export function ProjectsSection({ initial, ...p }: ProjectsProps & { /** Open at this project (its id). */ initial?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(initial && p.repos.some((r) => r.id === initial) ? initial : null);
  const repo = p.repos.find((r) => r.id === openId);
  if (repo) return <ProjectSettings key={repo.id} repo={repo} {...p} onBack={() => setOpenId(null)} />;
  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
        <button type="button" onClick={p.onAdd} className="ml-auto rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white">Add project</button>
      </div>
      {p.repos.length === 0 ? (
        <p className="text-sm text-zinc-500">No projects in this workspace yet.</p>
      ) : (
        <ul aria-label="Projects" className="flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {p.repos.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpenId(r.id)} aria-label={`${r.name} settings`}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-200">{r.name}</span>
                  <span className="block truncate font-mono text-[11px] text-zinc-500">{r.path}</span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500">{p.worktrees.filter((w) => w.repoId === r.id && w.path !== r.path).length} worktrees</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="shrink-0 text-zinc-600"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectSettings({ repo, worktrees, onBack, onPatch, onSaveRunCommands, onRemove, onDeleteWorktree }: ProjectsProps & { repo: RepoConfig; onBack: () => void }) {
  const [name, setName] = useState(repo.name);
  const [port, setPort] = useState(String(repo.defaultPort ?? ''));
  const [openUrl, setOpenUrl] = useState(repo.openUrl ?? '');
  const [subdir, setSubdir] = useState(repo.projectSubdir ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const portN = Number(port);
  const portOk = port.trim() !== '' && Number.isInteger(portN) && portN > 0 && portN < 65536;
  const dirty = name.trim() !== repo.name || portN !== repo.defaultPort || openUrl.trim() !== (repo.openUrl ?? '') || subdir.trim() !== (repo.projectSubdir ?? '');
  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      await onPatch(repo, { name: name.trim(), defaultPort: portN, openUrl: openUrl.trim() || null, projectSubdir: subdir.trim() || null });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message || 'Couldn’t save.');
    } finally {
      setSaving(false);
    }
  };
  const remove = () => {
    if (!confirm(`Remove "${repo.name}" from this workspace? Its worktrees on disk are left untouched.`)) return;
    void onRemove(repo).then(onBack, (err: Error) => setError(err.message));
  };
  const wts = worktrees.filter((w) => w.repoId === repo.id && w.path !== repo.path);

  return (
    <div className="max-w-2xl" data-testid="project-settings">
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m15 18-6-6 6-6" /></svg>Projects
      </button>
      <h1 className="text-lg font-semibold text-zinc-100">{repo.name}</h1>
      <p className="mb-8 truncate font-mono text-xs text-zinc-500">{repo.path}{repo.cloneUrl ? ` · ${repo.cloneUrl}` : ''}</p>

      <section aria-label="General" className="mb-10">
        <h2 className={H2}>General</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">Name
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">Default port
            <input className={`${FIELD} font-mono`} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">Open URL (optional)
            <input className={`${FIELD} font-mono`} value={openUrl} placeholder="http://localhost:{port}" onChange={(e) => setOpenUrl(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">Project subfolder (optional)
            <input className={`${FIELD} font-mono`} value={subdir} placeholder="apps/web" onChange={(e) => setSubdir(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" disabled={!dirty || !portOk || !name.trim() || saving} onClick={() => void save()}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
          {!portOk && <span className="text-xs text-amber-400">Port must be 1–65535</span>}
          {saved && !dirty && <span role="status" className="text-xs text-zinc-500">Saved</span>}
          {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
        </div>
      </section>

      <section aria-label="Run commands" className="mb-10">
        <h2 className={H2}>Run commands</h2>
        <p className="mb-3 text-xs text-zinc-500">What Run starts in a worktree of this project. The default is the header’s main Run.</p>
        <RunCommandsEditor key={JSON.stringify(repo.runCommands ?? [])} commands={repo.runCommands ?? []} onSave={(list) => onSaveRunCommands(repo, list)} />
      </section>

      <section aria-label="Worktrees" className="mb-10">
        <h2 className={H2}>Worktrees</h2>
        {wts.length === 0 ? <p className="text-xs text-zinc-500">No worktrees.</p> : (
          <ul className="flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {wts.map((w) => (
              <li key={w.path} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{worktreeLabel(w)}</span>
                  <span className="block truncate font-mono text-[11px] text-zinc-500">{w.path}</span>
                </span>
                <button type="button" aria-label={`Delete ${worktreeLabel(w)}`} onClick={() => onDeleteWorktree(w)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-red-300">Delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Remove project">
        <h2 className={H2}>Remove project</h2>
        <p className="mb-3 text-xs text-zinc-500">Takes it out of this workspace. Nothing on disk is deleted.</p>
        <button type="button" onClick={remove} className="rounded-md border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40">Remove project</button>
      </section>
    </div>
  );
}
