import type { ColumnId } from '../hooks/useColumnWidths';

function ResizeHandle({
  col,
  onStartResize,
}: {
  col: ColumnId;
  onStartResize: (col: ColumnId, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="absolute right-[-6px] top-1 bottom-1 z-10 w-[12px] cursor-col-resize select-none"
      onMouseDown={(e) => onStartResize(col, e)}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${col}`}
    />
  );
}

export function WorktreeTableHeader({
  gridTemplate,
  onStartResize,
}: {
  gridTemplate: string;
  onStartResize: (col: ColumnId, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b border-zinc-900 bg-zinc-950 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-zinc-500"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div className="group relative">Ticket<ResizeHandle col="ticket" onStartResize={onStartResize} /></div>
      <div className="group relative">Time spent<ResizeHandle col="spent" onStartResize={onStartResize} /></div>
      <div className="group relative">Status<ResizeHandle col="workflow" onStartResize={onStartResize} /></div>
      <div className="group relative">Branch<ResizeHandle col="branch" onStartResize={onStartResize} /></div>
      <div className="group relative">Changes<ResizeHandle col="changes" onStartResize={onStartResize} /></div>
      <div className="group relative justify-self-center" title="Dev-server run state">●</div>
    </div>
  );
}
