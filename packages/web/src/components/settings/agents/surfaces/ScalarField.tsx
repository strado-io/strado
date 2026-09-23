import { useEffect, useState } from 'react';
import { effectiveValue, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// Backs both `enum` (a <select> from `surface.options`, or a free-text input
// when no options are declared — see below) and `toggle` (a checkbox).
// Neither ever commits directly — both stage behind the group's Save button
// via `onStage`.
export function ScalarField({ surface, onStage }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const [value, setValue] = useState<unknown>(() => effectiveValue(surface, overridden));

  // Re-sync when the surface itself changes (a fresh load, a save elsewhere,
  // switching tabs) or when the user starts/reverts an override — but not on
  // every render, since staging keeps this component's value ahead of what
  // the server has confirmed.
  useEffect(() => {
    setValue(effectiveValue(surface, overridden));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, surface.source, surface.value, surface.inheritedValue, overridden]);

  function stage(next: unknown) {
    // Defense in depth alongside each control's `disabled` attribute below —
    // see MarkdownFile's identical guard.
    if (readOnly) return;
    setValue(next);
    onStage?.(next);
  }

  function reset() {
    // Show what this will revert TO (the inherited value) immediately,
    // while staging the actual removal — `undefined`, so the write path
    // deletes the key rather than re-writing an identical copy of it.
    setValue(surface.inheritedValue);
    onStage?.(undefined);
  }

  if (surface.kind === 'toggle') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="checkbox"
          aria-label={surface.label}
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => stage(e.target.checked)}
          className="h-4 w-4 accent-sky-500 rounded border-zinc-700 bg-zinc-900"
        />
        <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} onReset={reset} />
      </div>
    );
  }

  // `surface.options` is only ever populated for a fixed, known set of
  // values (e.g. `effortLevel`). A surface with no options declared (e.g.
  // `model` — identifiers change too often to bake a list in here) must
  // still be editable and must still show whatever's actually on disk, even
  // when that value matches none of a nonexistent option list — a <select>
  // can do neither, so it falls back to a plain text input instead of
  // silently rendering a blank, unusable dropdown.
  const options = surface.options ?? [];
  if (options.length === 0) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label={surface.label}
          value={typeof value === 'string' ? value : ''}
          disabled={readOnly}
          onChange={(e) => stage(e.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} onReset={reset} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <select
        aria-label={surface.label}
        value={typeof value === 'string' ? value : ''}
        disabled={readOnly}
        onChange={(e) => stage(e.target.value)}
        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
      >
        <option value="" disabled>
          Select…
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} onReset={reset} />
    </div>
  );
}
