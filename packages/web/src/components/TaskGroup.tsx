export function TaskGroup({
  label, count, collapsed, onToggle, emptyText, children,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown instead of rows when the group is empty (the quiet Needs-you state). */
  emptyText?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={`task-group-${label || 'all'}`}>
      {label && (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex w-full items-center gap-1.5 border-b border-zinc-900 px-3 py-1 text-left text-xs text-zinc-500 hover:text-zinc-300"
        >
          <svg
            width="10" height="10" viewBox="0 0 10 10" aria-hidden
            className={`shrink-0 fill-current transition-transform ${collapsed ? '' : 'rotate-90'}`}
          ><path d="M3 1.5 7 5 3 8.5z" /></svg>
          <span>{label}</span>
          <span className="font-mono tabular-nums text-zinc-700">{count}</span>
        </button>
      )}
      {!collapsed && (count === 0 && emptyText
        ? <div className="px-6 py-3 text-xs text-zinc-600">{emptyText}</div>
        : children)}
    </section>
  );
}
