import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../api';
import type { Workspace } from '../types';
import { NewWorkspaceDialog } from '../components/NewWorkspaceDialog';
import { WorkspaceRows } from '../components/WorkspaceRows';
import { useWorkspace } from '../hooks/useWorkspace';

export function WorkspaceManagementSection({ onClose }: { onClose?: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const { refresh: refreshSidebar } = useWorkspace();

  async function refresh() {
    setLoading(true);
    try {
      const result = await api.workspaces.list();
      setWorkspaces(result.workspaces);
      setActiveId(result.activeWorkspaceId);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleDelete(w: Workspace) {
    // A delete that lands between a drop's optimistic apply and its POST makes
    // the order the server receives no longer a permutation: it 400s, and the
    // revert below puts back a list still containing the workspace that was
    // just deleted, under an error blaming the drag. The rows are already
    // frozen while a save is in flight; the actions have to be too.
    if (savingOrder) return;
    if (!confirm(`Delete workspace '${w.name}' (${w.id})? Removes its config + state on disk.`)) return;
    setError(null);
    try {
      await api.workspaces.remove(w.id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'WORKSPACE_HAS_RUNNING_PROCESSES') {
        const paths = (e.details as { runningPaths?: string[] })?.runningPaths ?? [];
        setError(`Stop these worktrees first:\n${paths.join('\n')}`);
      } else {
        setError((e as Error).message);
      }
    }
  }

  async function handleReorder(ids: string[]) {
    const before = workspaces;
    const byId = new Map(before.map((w) => [w.id, w]));
    setWorkspaces(ids.map((id) => byId.get(id)!)); // optimistic: the drag already looks done
    setError(null);
    setSavingOrder(true);
    try {
      // What the server stored, not what the drag hoped for — the optimistic
      // copy is only ever a stand-in until this lands.
      setWorkspaces(await api.workspaces.reorder(ids));
    } catch (e) {
      // Only a failed save reverts: the rows go back to `before` and the
      // banner explains why. A refresh failure below must never land here —
      // by then the server already holds the new order, so undoing it and
      // blaming the save would contradict what reopening the dialog shows.
      setWorkspaces(before);
      setError((e as Error).message);
      setSavingOrder(false);
      return;
    }
    setSavingOrder(false);
    // The dots and the swipe order live in the sidebar, which reads the
    // workspace context — pull it forward rather than waiting for a reload.
    // Best-effort: a transient failure here just means the sidebar catches
    // up on its next load, not that anything needs to be undone.
    try {
      await refreshSidebar();
    } catch {
      /* ignored — see above */
    }
  }

  return (
    <div className="text-zinc-200">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Workspaces</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowNew(true)}
            // Same reason as Delete: a create landing mid-save turns the
            // order being written into something the server can't apply.
            disabled={savingOrder}
            className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New workspace
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
            >
              Close
            </button>
          )}
        </div>
      </header>

      {error && (
        <pre className="mb-3 whitespace-pre-wrap rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">
          {error}
        </pre>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="px-2 py-2"></th>
                <th className="px-2 py-2">Icon</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">ID</th>
                <th className="px-2 py-2">Color</th>
                <th className="px-2 py-2">Editor</th>
                <th className="px-2 py-2">Port base</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <WorkspaceRows
              workspaces={workspaces}
              activeId={activeId}
              onReorder={handleReorder}
              onDelete={handleDelete}
              disabled={savingOrder}
            />
          </table>
        </div>
      )}

      {showNew && (
        <NewWorkspaceDialog
          onClose={() => setShowNew(false)}
          onCreate={async (ws) => {
            try {
              await api.workspaces.create(ws);
              setShowNew(false);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

// Kept as a wrapper for callers that still need the workspace manager as a
// standalone dialog. The primary route now embeds the section in Settings.
export default function WorkspacesPage({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <WorkspaceManagementSection onClose={onClose} />
      </div>
    </div>
  );
}
