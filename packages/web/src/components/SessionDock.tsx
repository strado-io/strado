import { useState } from 'react';
import type { Worktree } from '../types';
import type { SessionChip } from '../hooks/sessions';
import { useResizableWidth } from '../hooks/resizableWidth';
import { SessionList } from './SessionList';

type Mode = SessionChip['mode'];

export function SessionDock({
  worktrees, onOpen, onClose, open, onToggle, count, machineLabel, wsId, repoName, activeTab,
}: {
  worktrees: Worktree[];
  onOpen: (path: string, mode: Mode, id?: string) => void;
  onClose?: (path: string, mode: Mode, id?: string) => void;
  open: boolean;
  onToggle: () => void;
  count: number;
  machineLabel?: (path: string) => string | null;
  wsId: string;
  /** repoId → display name; groups the list by repo. Omit for a flat list. */
  repoName?: Map<string, string>;
  /** The open hub's active tab, highlighted in the list. */
  activeTab?: { path: string; mode: string; id: string } | null;
}) {
  const [filter, setFilter] = useState('');
  // Drag the left edge to resize; mirrors the sidebar's handle, persisted so
  // the width survives restarts.
  const { width, resizing, handleProps } = useResizableWidth({
    storageKey: 'strado.sessionDockWidth', min: 220, max: 560, fallback: 288, edge: 'left',
  });
  if (!open) return null;
  return (
    <aside className="relative flex shrink-0 flex-col border-l border-zinc-800 bg-zinc-950" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sessions"
        className={`absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize ${resizing ? 'bg-sky-500/50' : 'hover:bg-sky-500/30'}`}
        {...handleProps}
      />
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">Sessions</span>
          <span className="rounded-full bg-zinc-800 px-2 text-[11px] tabular-nums text-zinc-300">{count}</span>
        </div>
        <button className="rounded px-1.5 text-zinc-500 hover:text-zinc-200" onClick={onToggle} aria-label="Collapse sessions">✕</button>
      </div>
      <div className="px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
        />
      </div>
      <div className="flex-1 overflow-auto px-3 pb-2">
        <SessionList
          wsId={wsId}
          worktrees={worktrees}
          onOpen={onOpen}
          onClose={onClose}
          machineLabel={machineLabel}
          filter={filter}
          repoName={repoName}
          activeTab={activeTab}
          emptyText="No open sessions"
        />
      </div>
    </aside>
  );
}
