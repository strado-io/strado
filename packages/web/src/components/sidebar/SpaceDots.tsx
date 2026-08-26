import { useState } from 'react';
import type { Workspace } from '../../types';

/**
 * The space rail: one dot per workspace, with the active one widened into a
 * pill. Workspace management lives in the single Settings entry point.
 */
export function SpaceDots({
  spaces,
  activeId,
  onSelect,
}: {
  spaces: Workspace[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  // The name of the dot under the pointer (or holding focus). Rendered by us
  // rather than left to `title`: a 6px dot is a poor target for the browser's
  // tooltip, which needs a still, sustained hover and does not re-arm when the
  // element re-renders under the cursor.
  const [hovered, setHovered] = useState<string | null>(null);

  if (spaces.length <= 1) return null;

  return (
    <div className="relative flex items-center gap-1 px-1">
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
        {spaces.map((s) => {
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
    </div>
  );
}
