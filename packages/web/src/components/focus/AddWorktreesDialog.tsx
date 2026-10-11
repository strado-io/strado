// "Add worktrees to <Focus>": the picker, with the current members already checked.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Focus, RemoteWorktree } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { useRendererOverlay } from '../../contexts/RendererOverlay';
import { WorktreePicker } from './WorktreePicker';

export function AddWorktreesDialog({ focus, repos, worktrees, remoteWorktrees, onAdd, onClose }: {
  focus: Focus;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  onAdd: (pinIds: string[]) => void;
  onClose: () => void;
}) {
  useRendererOverlay(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(focus.members));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const added = [...selected].filter((id) => !focus.members.includes(id));
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-label={`Add worktrees to ${focus.name}`} onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
        <h2 className="text-sm font-medium text-zinc-100">Add worktrees to {focus.name}</h2>
        <WorktreePicker repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees} selected={selected} autoFocus
          onToggle={(pinId, on) => setSelected((prev) => { const next = new Set(prev); on ? next.add(pinId) : next.delete(pinId); return next; })} />
        <div className="flex items-center gap-2">
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">Cancel</button>
          <button type="button" disabled={added.length === 0} onClick={() => { onAdd(added); onClose(); }}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
            Add{added.length > 0 ? ` ${added.length}` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
