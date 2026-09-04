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
          className="flex w-full items-center gap-2 border-b border-zinc-900 bg-zinc-950/80 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
        >
          <span className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden>›</span>
          <span>{label}</span>
          <span className="font-mono tabular-nums text-zinc-600">{count}</span>
        </button>
      )}
      {!collapsed && (count === 0 && emptyText
        ? <div className="px-6 py-3 text-xs text-zinc-600">{emptyText}</div>
        : children)}
    </section>
  );
}
