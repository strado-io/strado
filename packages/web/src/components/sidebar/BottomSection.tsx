// A collapsible section pinned under Working on (Settled, All worktrees): a
// one-line header with a count and a chevron, then whatever rows it is given.
import { useState } from 'react';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function BottomSection({ label, count, defaultOpen, children }: {
  label: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={label} className="flex max-h-[40%] shrink-0 flex-col border-t border-zinc-900 px-2 pb-2 pt-2">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${label} (${count})`}
        className="group flex w-full items-center gap-2 rounded-md py-1 pl-2.5 pr-1 text-left text-xs text-zinc-500 hover:text-zinc-300">
        <span>{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-600">{count}</span>
        <span aria-hidden className="h-px flex-1 bg-zinc-800" />
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke}
          className={`shrink-0 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`}><path d="M6 4l4 4-4 4" /></svg>
      </button>
      {open && <div className="min-h-0 overflow-y-auto">{children}</div>}
    </section>
  );
}
