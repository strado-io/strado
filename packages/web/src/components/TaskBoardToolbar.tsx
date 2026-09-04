import type { GroupBy, SortBy } from '../hooks/attention';

const select = 'h-7 rounded border border-zinc-800 bg-zinc-950 px-1.5 text-[11px] uppercase tracking-wide text-zinc-400 hover:border-zinc-600 hover:text-zinc-200';

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
    <div className="flex flex-wrap items-center gap-2 px-4 py-2">
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
        Group
        <select aria-label="Group by" value={groupBy} onChange={(e) => onGroupBy(e.target.value as GroupBy)} className={select}>
          <option value="state">State</option>
          <option value="repo">Repo</option>
          <option value="none">None</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
        Sort
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
        className="h-7 w-44 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
      />
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
