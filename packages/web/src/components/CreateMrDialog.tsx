// Create a merge/pull request from a worktree's branch into `target`, in the
// app: title, optional description, Create. Opened from the top bar's Git pill
// (GitPill) — no Changes tab needed. A host the server can't create on falls
// back to opening the provider's new-MR page in the browser.
import { useState } from 'react';
import { api, ApiClientError } from '../api';
import type { MergeRequest } from '../types';
import { invalidateMrPath } from '../hooks/mrSummaries';

const errMessage = (e: unknown) => (e instanceof ApiClientError || e instanceof Error ? e.message : String(e));

export function CreateMrDialog({ wsId, worktreePath, branch, target, initialTitle, onClose, onCreated }: {
  wsId: string;
  worktreePath: string;
  branch: string | null;
  target: string;
  initialTitle: string;
  onClose: () => void;
  onCreated: (mr: MergeRequest) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [descOpen, setDescOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState<'gitlab' | 'github' | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setNeedsAuth(null);
    try {
      const res = await api.worktrees.createMergeRequest(wsId, worktreePath, { target, title, description: description || undefined });
      if (res.kind === 'created') {
        invalidateMrPath(worktreePath);
        onCreated(res.mergeRequest);
        window.dispatchEvent(new Event('strado:code-reviews-changed'));
        onClose();
      } else if (res.kind === 'needsAuth') {
        setNeedsAuth(res.provider);
        setError(`Connect ${res.provider === 'github' ? 'GitHub' : 'GitLab'} first`);
      } else {
        // No in-app create for this host: its own page, in the browser.
        const { url } = await api.worktrees.git.mrUrl(wsId, worktreePath, target);
        window.open(url, '_blank', 'noopener');
        onClose();
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div role="dialog" aria-label="Create merge request" className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
        <div className="mb-2 text-sm text-zinc-200">
          Create MR: {branch} → {target}
        </div>
        <input
          autoFocus
          aria-label="MR title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && !submitting) void submit(); }}
          placeholder="Title"
          className="mb-2 w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
        />
        {descOpen ? (
          <textarea
            autoFocus
            aria-label="MR description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="mb-2 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
          />
        ) : (
          <button onClick={() => setDescOpen(true)} className="mb-2 text-[11px] text-zinc-500 hover:text-zinc-300">
            + Add description
          </button>
        )}
        {error && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded bg-red-950/60 px-2 py-1 text-xs text-red-200">
            <span>{error}</span>
            {needsAuth && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('strado:open-settings', { detail: { section: needsAuth } }))}
                className="shrink-0 rounded bg-red-900/60 px-2 py-0.5 text-red-100 hover:bg-red-800/60"
              >
                Connect {needsAuth === 'github' ? 'GitHub' : 'GitLab'}
              </button>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting || !title.trim()}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
