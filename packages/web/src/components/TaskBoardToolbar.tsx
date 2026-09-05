import type { GroupBy, SortBy } from '../hooks/attention';

// Ghost selects: no box until hovered, so the controls sit on the same line as
// the summary chips without competing with them.
const select = 'h-6 cursor-pointer rounded bg-transparent px-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600';

export function TaskBoardToolbar({
  groupBy, sort, query, onGroupBy, onSort, onQuery, trailing,
}: {
  groupBy: GroupBy;
  sort: SortBy;
  query: string;
  onGroupBy: (g: GroupBy) => void;
  onSort: (s: SortBy) => void;
  onQuery: (q: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1 text-zinc-600">
        Group by
        <select aria-label="Group by" value={groupBy} onChange={(e) => onGroupBy(e.target.value as GroupBy)} className={select}>
          <option value="state">State</option>
          <option value="repo">Repo</option>
          <option value="none">None</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-zinc-600">
        Sort by
        <select aria-label="Sort by" value={sort} onChange={(e) => onSort(e.target.value as SortBy)} className={select}>
          <option value="activity">Last activity</option>
          <option value="ticket">Ticket</option>
          {/* Drag order only means something over the whole list. */}
          <option value="manual" disabled={groupBy !== 'none'}>Manual</option>
        </select>
      </label>
      <input
        aria-label="Filter tasks"
        placeholder="Filter…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        className="h-6 w-36 rounded border border-transparent bg-zinc-900/60 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700 focus:bg-zinc-900"
      />
      {trailing && <div className="flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
