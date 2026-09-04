import { useMemo, useState } from 'react';
import type { RepoConfig, Worktree } from '../types';
import type { Density } from './WorktreeRow';
import { WorktreeRow, type Props as WorktreeRowProps } from './WorktreeRow';
import { isRowSettled } from '../hooks/tasks';
import { useTickets } from '../hooks/tickets';
import { dropPlace } from '../hooks/rowOrder';
import { WorktreeTableHeader } from './WorktreeTableHeader';
import type { ColumnId } from '../hooks/useColumnWidths';
import { useMrSummaries } from '../hooks/mrSummaries';
import { ATTENTION_ORDER, attentionOf, groupRows, sortRows, type Attention } from '../hooks/attention';
import { DEFAULT_BOARD_PREFS, type BoardPrefs } from '../hooks/boardPrefs';
import { matchesQuery } from '../hooks/filters';
import { readWorktreeLru } from '../lib/worktreeLru';
import { TaskBoardSummary } from './TaskBoardSummary';
import { TaskBoardToolbar } from './TaskBoardToolbar';
import { TaskGroup } from './TaskGroup';

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
  prefs?: BoardPrefs;
  onPrefs?: (patch: Partial<BoardPrefs>) => void;
  /** Right-aligned toolbar content (the running-servers chip). */
  toolbarTrailing?: React.ReactNode;
};

/**
 * Every task (worktree) in the workspace, read top-down as "what needs me":
 * an attention strip, then rows grouped by state (or repo), each group sorted
 * by recency. Manual drag order survives only for the ungrouped, manually
 * sorted view — the only view where a hand-placed order means anything.
 */
export function TaskBoard({
  wsId, worktrees, repoById, gridTemplate, totalWidth, onStartResize, density, handlers, onReorder,
  prefs = DEFAULT_BOARD_PREFS, onPrefs, toolbarTrailing,
}: Props) {
  const [dropHint, setDropHint] = useState<{ path: string; place: 'before' | 'after' } | null>(null);
  const [query, setQuery] = useState('');
  const { issues } = useTickets();
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));

  const attention = useMemo(() => {
    const m = new Map<string, Attention>();
    for (const w of worktrees) m.set(w.path, attentionOf(w, mrByPath.get(w.path) ?? null));
    return m;
  }, [worktrees, mrByPath]);
  const attentionOfRow = (w: Worktree) => attention.get(w.path) ?? 'idle';

  const counts = useMemo(() => {
    const c = Object.fromEntries(ATTENTION_ORDER.map((a) => [a, 0])) as Record<Attention, number>;
    for (const a of attention.values()) c[a] += 1;
    return c;
  }, [attention]);

  const manual = prefs.groupBy === 'none' && prefs.sort === 'manual';
  const reorderable = manual && !!onReorder;

  // Filter → sort → settle → group. Settled rows (done/verified) still sink
  // inside their group, as they always did on the flat board.
  const visible = worktrees.filter((w) =>
    (prefs.tile === null || attentionOfRow(w) === prefs.tile) && matchesQuery(w, query.trim()));
  const sorted = sortRows(visible, prefs.sort, { lru: readWorktreeLru() });
  const settled = [...sorted.filter((w) => !isRowSettled(w, issues)), ...sorted.filter((w) => isRowSettled(w, issues))];
  const groups = groupRows(settled, prefs.groupBy, {
    attention: attentionOfRow,
    repoName: (w) => (w.repoId ? repoById.get(w.repoId)?.name : undefined) ?? '—',
  });
  // Rows in display order across every group — what a reorder drop reads.
  const flatRows = groups.flatMap((g) => g.rows);
  // A tile or text query narrows the board; "no rows" then means the SEARCH
  // found nothing, distinct from the unfiltered "nothing needs you" quiet
  // state that the needs-you group renders on its own (it's never empty —
  // groupRows always keeps it, even with 0 rows).
  const filtering = prefs.tile !== null || query.trim() !== '';

  const toggleTile = (a: Attention) => onPrefs?.({ tile: prefs.tile === a ? null : a });
  const toggleGroup = (key: string) =>
    onPrefs?.({ collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key] });

  const renderRow = (w: Worktree, i: number, rows: Worktree[]) => {
    const repo = w.repoId ? repoById.get(w.repoId) : undefined;
    // the chip repeats down the column otherwise — show it only where the
    // repo changes from the row above (never when the group IS the repo)
    const repoChanged = prefs.groupBy !== 'repo' && (i === 0 || rows[i - 1]!.repoId !== w.repoId);
    const showHint = dropHint?.path === w.path;
    return (
      <div
        key={w.path}
        data-testid={`task-row-${w.path}`}
        onDragOver={reorderable ? (e) => {
          if (![...e.dataTransfer.types].includes('text/reorder-path')) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setDropHint({ path: w.path, place: dropPlace(e.clientY, rect) });
        } : undefined}
        onDragLeave={reorderable ? () => setDropHint(null) : undefined}
        onDrop={reorderable ? (e) => {
          const dragged = e.dataTransfer.getData('text/reorder-path');
          if (!dragged) return;
          e.preventDefault();
          setDropHint(null);
          if (dragged === w.path) return;
          if (!flatRows.some((x) => x.path === dragged)) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onReorder!(flatRows, dragged, w.path, dropPlace(e.clientY, rect));
        } : undefined}
        className={showHint ? (dropHint!.place === 'before' ? 'border-t-2 border-sky-500' : 'border-b-2 border-sky-500') : undefined}
      >
        <WorktreeRow
          worktree={w}
          gridTemplate={gridTemplate}
          density={density}
          repoLabel={repoChanged ? repo?.name ?? null : null}
          reorderable={reorderable}
          mr={mrByPath.get(w.path) ?? null}
          attention={attentionOfRow(w)}
          {...handlers}
        />
      </div>
    );
  };

  return (
    <div>
      <TaskBoardSummary counts={counts} active={prefs.tile} onToggle={toggleTile} />
      <TaskBoardToolbar
        groupBy={prefs.groupBy}
        sort={prefs.sort}
        query={query}
        onGroupBy={(g) => onPrefs?.({ groupBy: g, ...(g !== 'none' && prefs.sort === 'manual' ? { sort: 'activity' } : {}) })}
        onSort={(s) => onPrefs?.({ sort: s })}
        onQuery={setQuery}
        trailing={toolbarTrailing}
      />
      <div style={{ minWidth: totalWidth }}>
        <WorktreeTableHeader gridTemplate={gridTemplate} onStartResize={onStartResize} />
        {worktrees.length === 0 ? (
          <div className="px-6 py-3 text-xs text-zinc-600">No tasks yet. Create a worktree to see it here.</div>
        ) : filtering && visible.length === 0 ? (
          <div className="px-6 py-3 text-xs text-zinc-600">Nothing matches.</div>
        ) : (
          groups.map((g) => (
            <TaskGroup
              key={g.key}
              label={g.label}
              count={g.rows.length}
              collapsed={prefs.collapsed.includes(g.key)}
              onToggle={() => toggleGroup(g.key)}
              emptyText={g.key === 'needs-you' ? 'Nothing waiting on you' : undefined}
            >
              {g.rows.map((w, i) => renderRow(w, i, g.rows))}
            </TaskGroup>
          ))
        )}
      </div>
    </div>
  );
}
