import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../types';

/**
 * The space rail: one dot per workspace, the active one widened into a pill,
 * plus the actions that used to hang off the workspace dropdown. With a single
 * workspace the dots are pointless but the menu is not — it is the only route
 * left to workspace settings.
 */
export function SpaceDots({
  spaces,
  activeId,
  onSelect,
  onOpenSettings,
  onOpenManage,
}: {
  spaces: Workspace[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onOpenManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The name of the dot under the pointer (or holding focus). Rendered by us
  // rather than left to `title`: a 6px dot is a poor target for the browser's
  // tooltip, which needs a still, sustained hover and does not re-arm when the
  // element re-renders under the cursor.
  const [hovered, setHovered] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const item = 'block w-full rounded-md px-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200';

  return (
    <div ref={ref} className="relative flex items-center gap-1 px-1">
      {hovered && (
        <span
          data-testid="space-hover-label"
          aria-hidden
          className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-300 shadow-lg"
        >
          {hovered}
        </span>
      )}
      {/* Belt-and-braces: the sidebar re-renders on every poll, and a dot that
          re-renders under the cursor can miss its own pointerleave — leaving
          the name label stranded. Leaving the whole row always clears it. */}
      <div className="flex flex-1 items-center justify-center gap-0.5" onPointerLeave={() => setHovered(null)}>
        {spaces.length > 1 &&
          spaces.map((s) => {
            const active = s.id === activeId;
            return (
              // The visible dot is 6px — demanding the cursor TIP be inside
              // those 6px is why hover used to register only once you were
              // halfway across it. The button is a 16px zone centered on the
              // dot and hover binds HERE: the dot lights up and magnifies the
              // moment the pointer reaches it, not after crossing it.
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                onPointerEnter={() => setHovered(s.name)}
                onPointerLeave={() => setHovered((n) => (n === s.name ? null : n))}
                onFocus={() => setHovered(s.name)}
                onBlur={() => setHovered((n) => (n === s.name ? null : n))}
                aria-label={`Switch to ${s.name}`}
                {...(active ? { 'aria-current': 'true' as const } : {})}
                className={`group flex h-4 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500 ${
                  active ? 'w-6' : 'w-4'
                }`}
              >
                <span
                  aria-hidden
                  data-testid={`space-dot-${s.id}`}
                  className={`h-1.5 rounded-full transition-all duration-150 ease-out ${
                    active
                      ? 'w-4 bg-zinc-300 group-hover:bg-zinc-200'
                      : 'w-1.5 bg-zinc-700 group-hover:scale-150 group-hover:bg-zinc-400'
                  }`}
                />
              </button>
            );
          })}
      </div>
      <button
        type="button"
        aria-label="Space actions"
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="4" cy="8" r="0.9" />
          <circle cx="8" cy="8" r="0.9" />
          <circle cx="12" cy="8" r="0.9" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-1 min-w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
        >
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onOpenSettings(); }}>
            Workspace settings
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onOpenManage(); }}>
            Manage workspaces
          </button>
        </div>
      )}
    </div>
  );
}
