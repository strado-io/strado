import { useState } from 'react';
import type { RepoConfig, Worktree } from '../types';
import type { Density } from './WorktreeRow';
import { WorktreeRow, type Props as WorktreeRowProps } from './WorktreeRow';
import { isRowSettled } from '../hooks/tasks';
import { useTickets } from '../hooks/tickets';
import { sortByOrder, dropPlace } from '../hooks/rowOrder';
import { WorktreeTableHeader } from './WorktreeTableHeader';
import type { ColumnId } from '../hooks/useColumnWidths';
import { useMrSummaries } from '../hooks/mrSummaries';

export type RowHandlers = Pick<
  WorktreeRowProps,
  'onOpenShellTerminal' | 'onSetWorkflowStatus' | 'onOpenNote' | 'onOpenDiff' | 'onStart' | 'onStop' | 'onKillExternal' | 'onOpenSettings' | 'onOpenMr'
>;

export type Props = {
  wsId: string;
  worktrees: Worktree[];
  repoById: Map<string, RepoConfig>;
  gridTemplate: string;
  totalWidth: number;
  onStartResize: (col: ColumnId, e: React.MouseEvent) => void;
  density: Density;
  onReorder?: (contextRows: Worktree[], draggedPath: string, targetPath: string, place: 'before' | 'after') => void;
  handlers: RowHandlers;
};

// Every task (worktree) in one flat list — no grouping.
export function TaskBoard({
  wsId, worktrees, repoById, gridTemplate, totalWidth, onStartResize, density, handlers, onReorder,
}: Props) {
  const [dropHint, setDropHint] = useState<{ path: string; place: 'before' | 'after' } | null>(null);
  const { issues } = useTickets();
  const ordered = sortByOrder(worktrees);
  // attention first: work still moving stays on top, settled rows sink
  // (manual drag order is preserved within each half)
  const rows = [...ordered.filter((w) => !isRowSettled(w, issues)), ...ordered.filter((w) => isRowSettled(w, issues))];
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));

  return (
    <div style={{ minWidth: totalWidth }}>
      <WorktreeTableHeader gridTemplate={gridTemplate} onStartResize={onStartResize} />
      {rows.length === 0 ? (
        <div className="px-6 py-3 text-xs text-zinc-600">No tasks yet. Create a worktree to see it here.</div>
      ) : (
        rows.map((w, i) => {
          const repo = w.repoId ? repoById.get(w.repoId) : undefined;
          // the chip repeats down the column otherwise — show it only
          // where the repo changes from the row above
          const repoChanged = i === 0 || rows[i - 1]!.repoId !== w.repoId;
          const showHint = dropHint?.path === w.path;
          return (
            <div
              key={w.path}
              data-testid={`task-row-${w.path}`}
              onDragOver={onReorder ? (e) => {
                if (![...e.dataTransfer.types].includes('text/reorder-path')) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropHint({ path: w.path, place: dropPlace(e.clientY, rect) });
              } : undefined}
              onDragLeave={onReorder ? () => setDropHint(null) : undefined}
              onDrop={onReorder ? (e) => {
                const dragged = e.dataTransfer.getData('text/reorder-path');
                if (!dragged) return;
                e.preventDefault();
                setDropHint(null);
                if (dragged === w.path) return;
                if (!rows.some((x) => x.path === dragged)) return;
                const rect = e.currentTarget.getBoundingClientRect();
                onReorder(rows, dragged, w.path, dropPlace(e.clientY, rect));
              } : undefined}
              className={
                showHint
                  ? dropHint!.place === 'before'
                    ? 'border-t-2 border-sky-500'
                    : 'border-b-2 border-sky-500'
                  : undefined
              }
            >
              <WorktreeRow
                worktree={w}
                gridTemplate={gridTemplate}
                density={density}
                repoLabel={repoChanged ? repo?.name ?? null : null}
                reorderable={!!onReorder}
                mr={mrByPath.get(w.path) ?? null}
                {...handlers}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
