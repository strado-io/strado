import { useEffect, useState } from 'react';
import { api } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';

type Step = 'choose' | 'open' | 'clone' | 'create';
export type AddRepoAnchor = { left: number; right: number; bottom: number };

const INPUT =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500';

function ActionIcon({ kind }: { kind: 'open' | 'clone' | 'create' }) {
  if (kind === 'clone') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="9" r="6.5" /><path d="M2.7 7h12.6M2.7 11h12.6M9 2.5c2 2 2 11 0 13M9 2.5c-2 2-2 11 0 13" />
      </svg>
    );
  }
  if (kind === 'create') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 4.5h5l1.5 2h6.5v8H2.5z" /><path d="M12 9v4M10 11h4" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 5h5l1.5 2h6.5l-2 7H3.5z" /><path d="M2.5 5V3.5h5l1.5 1.5" />
    </svg>
  );
}

export function AddRepoDialog({
  onAdded,
  onClose,
  anchor,
}: {
  onAdded: () => void | Promise<void>;
  onClose: () => void;
  anchor?: AddRepoAnchor | null;
}) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [step, setStep] = useState<Step>('choose');
  const [path, setPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneParent, setCloneParent] = useState('');
  const [projectName, setProjectName] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPickFolder = typeof window !== 'undefined' && typeof window.strado?.pickDirectory === 'function';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (step === 'choose') onClose();
      else {
        setStep('choose');
        setError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, step]);

  async function registerPath(selectedPath: string) {
    setBusy(true);
    setError(null);
    try {
      const { warnings: _warnings, ...repo } = await api.repos.detect(wsId, selectedPath.trim());
      await api.repos.add(wsId, repo);
      await onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openProject() {
    if (!canPickFolder) {
      setStep('open');
      return;
    }
    try {
      const selected = await window.strado?.pickDirectory?.();
      if (selected) await registerPath(selected);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cloneProject(event: React.FormEvent) {
    event.preventDefault();
    if (!cloneUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.repos.clone(wsId, cloneUrl.trim(), cloneParent.trim() || undefined);
      await onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.repos.create(wsId, projectName.trim(), parentFolder.trim() || undefined);
      await onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder(onSelected: (selected: string) => void) {
    try {
      const selected = await window.strado?.pickDirectory?.();
      if (selected) onSelected(selected);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const menuPosition = anchor
    ? {
        left: Math.max(8, Math.min(anchor.right - 288, viewportWidth - 296)),
        top: Math.min(anchor.bottom + 6, viewportHeight - 190),
      }
    : undefined;

  if (step === 'choose') {
    return (
      <div className="fixed inset-0 z-50" onMouseDown={onClose}>
        <div
          role="menu"
          aria-label="Add repository"
          style={menuPosition}
          className={`w-72 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl ${anchor ? 'fixed' : 'absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2'}`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 className="sr-only">Add repo</h2>
          <button type="button" aria-label="Close" className="sr-only" onClick={onClose}>Close</button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            autoFocus
            onClick={() => void openProject()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
          >
            <ActionIcon kind="open" />
            <span>{busy ? 'Opening…' : 'Open project'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setStep('clone'); setError(null); }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-900"
          >
            <ActionIcon kind="clone" />
            <span>Clone from URL</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setStep('create'); setError(null); }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-900"
          >
            <ActionIcon kind="create" />
            <span>Create new project</span>
          </button>
          {error && <div className="mx-2 mb-1 mt-1 rounded bg-red-950/60 px-2.5 py-2 text-xs text-red-200">{error}</div>}
        </div>
      </div>
    );
  }

  const title = step === 'open' ? 'Open project' : step === 'clone' ? 'Clone a repository' : 'Create a new project';
  const submit = step === 'open'
    ? (event: React.FormEvent) => { event.preventDefault(); void registerPath(path); }
    : step === 'clone' ? cloneProject : createProject;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <form
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
            <p className="mt-1 text-sm text-zinc-500">
              {step === 'open'
                ? 'Choose an existing Git repository on this machine.'
                : step === 'clone'
                  ? 'Clone and add a repository to this workspace.'
                  : 'Create a local folder and initialize it as a Git repository.'}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">✕</button>
        </div>

        <div className="mt-5 space-y-4">
          {step === 'open' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-300">Repository path</span>
              <input autoFocus aria-label="Repository path" className={INPUT} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/you/code/project" />
            </label>
          )}

          {step === 'clone' && (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-300">Repository URL</span>
                <input autoFocus aria-label="Repository URL" className={INPUT} value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-300">Location <span className="font-normal text-zinc-600">(optional)</span></span>
                <span className="flex gap-2">
                  <input aria-label="Clone location" className={INPUT} value={cloneParent} onChange={(event) => setCloneParent(event.target.value)} placeholder="Default repositories folder" />
                  {canPickFolder && (
                    <button type="button" onClick={() => void chooseFolder(setCloneParent)} className="shrink-0 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900">Browse</button>
                  )}
                </span>
              </label>
            </>
          )}

          {step === 'create' && (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-300">Project name</span>
                <input autoFocus aria-label="Project name" className={INPUT} value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="my-project" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-300">Parent folder <span className="font-normal text-zinc-600">(optional)</span></span>
                <span className="flex gap-2">
                  <input aria-label="Parent folder" className={INPUT} value={parentFolder} onChange={(event) => setParentFolder(event.target.value)} placeholder="Default repositories folder" />
                  {canPickFolder && (
                    <button type="button" onClick={() => void chooseFolder(setParentFolder)} className="shrink-0 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900">Browse</button>
                  )}
                </span>
              </label>
            </>
          )}
        </div>

        {error && <div className="mt-4 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" onClick={() => { setStep('choose'); setError(null); }} className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">Back</button>
          <button
            type="submit"
            disabled={busy || (step === 'open' ? !path.trim() : step === 'clone' ? !cloneUrl.trim() : !projectName.trim())}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (step === 'clone' ? 'Cloning…' : step === 'create' ? 'Creating…' : 'Opening…') : step === 'clone' ? 'Clone' : step === 'create' ? 'Create project' : 'Open'}
          </button>
        </div>
      </form>
    </div>
  );
}
