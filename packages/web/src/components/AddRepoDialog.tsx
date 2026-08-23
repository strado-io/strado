import { useState } from 'react';
import { api } from '../api';
import type { RepoConfig, Editor } from '../types';
import { useWorkspace } from '../hooks/useWorkspace';

const EMPTY: RepoConfig = {
  id: '',
  name: '',
  path: '',
  projectSubdir: null,
  startCommand: 'npm start',
  defaultPort: 8080,
  editor: 'code',
  openUrl: null,
};

const EDITORS: Editor[] = ['code', 'cursor', 'subl', 'webstorm'];

function Field({
  label,
  hint,
  children,
  full,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-zinc-600">{hint}</span>}
    </label>
  );
}

const INPUT =
  'w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none';

export function AddRepoDialog({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [draft, setDraft] = useState<RepoConfig>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detectPath, setDetectPath] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectWarnings, setDetectWarnings] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneNote, setCloneNote] = useState<string | null>(null);

  const canAdd = !!draft.id.trim() && !!draft.name.trim() && !!draft.path.trim();

  async function detect(pathArg?: string) {
    const p = (pathArg ?? detectPath).trim();
    if (!p) return;
    setDetecting(true);
    setError(null);
    setDetectWarnings([]);
    try {
      const { warnings, ...repo } = await api.repos.detect(wsId, p);
      setDraft({ ...EMPTY, ...repo });
      setDetectWarnings(warnings);
      setShowAdvanced(true); // reveal the prefilled derived fields for review
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  // Clone onto whichever machine runs this server, then register it. This is
  // how a repo gets onto a runner without SSHing in: a filesystem path means
  // nothing on another box, a clone URL means the same thing everywhere.
  async function cloneAndAdd() {
    const url = cloneUrl.trim();
    if (!url) return;
    setCloning(true);
    setError(null);
    setCloneNote(null);
    setDetectWarnings([]);
    try {
      const res = await api.repos.clone(wsId, url);
      setDetectWarnings(res.warnings);
      setCloneNote(
        res.alreadyRegistered
          ? `Already registered at ${res.path}.`
          : `Cloned to ${res.path} and registered.`,
      );
      setCloneUrl('');
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCloning(false);
    }
  }

  // Native folder picker — only in the desktop shell (feature-detected).
  const canPickFolder = typeof window !== 'undefined' && typeof window.strado?.pickDirectory === 'function';
  async function pickFolder() {
    const dir = await window.strado?.pickDirectory?.();
    if (!dir) return;
    setDetectPath(dir);
    detect(dir);
  }

  async function addRepo(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.repos.add(wsId, {
        ...draft,
        projectSubdir: draft.projectSubdir?.trim() ? draft.projectSubdir.trim() : null,
        openUrl: draft.openUrl?.trim() ? draft.openUrl.trim() : null,
      });
      setDraft(EMPTY);
      onAdded();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Add repo</h2>
          <button
            className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field
              label="Clone from a git URL"
              hint="Clones onto the machine running Strado (use this to add a repo to a runner) — that machine needs its own git access"
            >
              <input
                className={INPUT}
                placeholder="git@github.com:you/your-repo.git"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void cloneAndAdd();
                  }
                }}
              />
            </Field>
          </div>
          <button
            type="button"
            className="mb-5 shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            onClick={() => void cloneAndAdd()}
            disabled={cloning || !cloneUrl.trim()}
          >
            {cloning ? 'Cloning…' : 'Clone & add'}
          </button>
        </div>

        {cloneNote && (
          <p className="mb-4 rounded border border-emerald-900/60 bg-emerald-950/30 px-2.5 py-2 text-xs text-emerald-200">
            {cloneNote}
          </p>
        )}

        <div className="mb-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
          <Field
            label="Detect from folder"
            hint={canPickFolder
              ? 'Choose a folder (or paste a path) — everything else is filled in for you'
              : 'Paste a repo (or monorepo app) path — everything else is filled in for you'}
          >
            <input
              className={INPUT}
              placeholder="/Users/you/code/my-app"
              value={detectPath}
              onChange={(e) => setDetectPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  detect();
                }
              }}
            />
          </Field>
          </div>
          {canPickFolder && (
            <button
              type="button"
              className="mb-5 shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              onClick={pickFolder}
              disabled={detecting}
            >
              Choose folder…
            </button>
          )}
          <button
            type="button"
            className="mb-5 shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            onClick={() => detect()}
            disabled={detecting || !detectPath.trim()}
          >
            {detecting ? 'Detecting…' : 'Detect'}
          </button>
        </div>
        {detectWarnings.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1">
            {detectWarnings.map((w) => (
              <li key={w} className="rounded bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200">
                {w}
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-col gap-4" onSubmit={addRepo} id="add-repo-form">
          {/* Essentials — the two fields worth reviewing on every add */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Shown in the sidebar and tabs">
              <input
                className={INPUT}
                placeholder="My React App"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="ID" hint="Stable slug used in URLs and config">
              <input
                className={INPUT}
                placeholder="my-react-app"
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </Field>
          </div>

          {/* Advanced — auto-filled by detect; collapsed so the modal stays calm */}
          <div className="rounded-lg border border-zinc-900">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-300 hover:text-zinc-100"
              aria-expanded={showAdvanced}
            >
              <span>Advanced settings</span>
              <span className="text-zinc-500">{showAdvanced ? '▾' : '▸'}</span>
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-1 gap-3 border-t border-zinc-900 p-3 sm:grid-cols-2">
                <Field label="Path" hint="Main worktree (root of the git repo)" full>
                  <input
                    className={INPUT}
                    placeholder="/Users/you/code/my-app"
                    value={draft.path}
                    onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                  />
                </Field>
                <Field label="Project subfolder" hint="Optional — run commands inside this subfolder (e.g. dashboard)">
                  <input
                    className={INPUT}
                    placeholder="dashboard"
                    value={draft.projectSubdir ?? ''}
                    onChange={(e) => setDraft({ ...draft, projectSubdir: e.target.value })}
                  />
                </Field>
                <Field label="Start command" hint="Shell command run on Start">
                  <input
                    className={INPUT}
                    placeholder="npm run dev"
                    value={draft.startCommand}
                    onChange={(e) => setDraft({ ...draft, startCommand: e.target.value })}
                  />
                </Field>
                <Field label="Default port">
                  <input
                    className={INPUT}
                    type="number"
                    placeholder="3000"
                    value={draft.defaultPort}
                    onChange={(e) => setDraft({ ...draft, defaultPort: Number(e.target.value) || 0 })}
                  />
                </Field>
                <Field label="Editor">
                  <select
                    className={INPUT}
                    value={draft.editor}
                    onChange={(e) => setDraft({ ...draft, editor: e.target.value as Editor })}
                  >
                    {EDITORS.map((ed) => (
                      <option key={ed} value={ed}>
                        {ed}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Open URL" hint="Optional — URL opened by the 'open running app' button" full>
                  <input
                    className={INPUT}
                    placeholder="http://localhost:3000"
                    value={draft.openUrl ?? ''}
                    onChange={(e) => setDraft({ ...draft, openUrl: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>
          )}
        </form>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          <button
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="add-repo-form"
            disabled={submitting || !canAdd}
            title={canAdd ? undefined : 'Detect a folder (or fill in name, id, path and worktrees folder) first'}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add repo'}
          </button>
        </div>
      </div>
    </div>
  );
}
