import { useEffect, useState } from 'react';
import type { SurfaceValue } from '../../../../api';

// A surface with `source === 'inherited'` has no value of its own at this
// scope — what's in effect is whatever the parent (global) scope set.
//
// Final review fix #4: every widget used to display (and, worse, let the
// user directly EDIT) that inherited value — so a single keystroke plus Save
// on, say, MarkdownFile silently copied the user's whole global CLAUDE.md
// into the project's checked-in one, and removing one inherited MCP server
// from McpList rewrote every OTHER inherited server back at this scope. An
// inherited value must render READ-ONLY until the user deliberately clicks
// "Override here" (see `useOverride` below) — and once they do, editing
// starts from EMPTY, never pre-filled with what was merely being shown.
// `overridden` defaults to `false` so every existing call site (which hasn't
// been updated to opt into overriding yet) keeps the old inherited-value
// display — this parameter only ever narrows what's shown, never widens it.
export function effectiveValue(surface: SurfaceValue, overridden = false): unknown {
  if (surface.source !== 'inherited') return surface.value;
  return overridden ? undefined : surface.inheritedValue;
}

// Tracks whether the user has clicked "Override here" on an inherited
// surface — `false` (locked, read-only) until they do. Resets whenever the
// surface identity or source changes underneath it (switching tabs/scope, a
// fresh load, or a save that turned this surface's own `source` into 'set')
// so a stale override flag from a different surface, or from before the
// override was actually saved, can never leak forward.
export function useOverride(surface: SurfaceValue): [boolean, () => void] {
  const [overridden, setOverridden] = useState(false);
  useEffect(() => {
    setOverridden(false);
  }, [surface.id, surface.source]);
  return [overridden, () => setOverridden(true)];
}

// True while an inherited surface must be shown read-only — i.e. it has no
// value of its own at this scope AND the user hasn't clicked "Override here"
// yet. Combine with `surface.readOnly` (a surface that's read-only for a
// different reason, e.g. `mcp-approved`) at each call site — this function
// only knows about the inheritance lock, not every reason a surface might be
// uneditable.
export function isLocked(surface: SurfaceValue, overridden: boolean): boolean {
  return surface.source === 'inherited' && !overridden;
}

// Shared "inherited"/"set here" indicator plus, depending on state, either a
// "Reset" (drop the local override, reverting to whatever's inherited) or
// "Override here" (start a local override, empty) control.
//
// Final review fix #5: the badge used to render — and Reset was only ever
// offered — for `source === 'inherited'`, the one case where there is
// nothing TO reset; the promised "set here" badge for `source === 'set'`
// (the case that actually has something to reset) didn't exist at all. Reset
// now stages/commits `undefined` (letting the write path's `jsonDriver.remove`
// delete the key) rather than `surface.inheritedValue`, which used to
// convert an inherited value into an explicitly-set identical copy instead
// of actually reverting.
export function InheritedBadge({
  surface,
  overridden,
  onReset,
  onOverride,
}: {
  surface: SurfaceValue;
  overridden?: boolean;
  onReset?: () => void;
  onOverride?: () => void;
}) {
  if (surface.source === 'set') {
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 uppercase tracking-wide text-zinc-400">set here</span>
        {onReset && !surface.readOnly && (
          <button type="button" onClick={onReset} className="text-sky-400 hover:underline">
            Reset
          </button>
        )}
      </span>
    );
  }
  if (surface.source === 'inherited' && !overridden) {
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 uppercase tracking-wide text-zinc-400">inherited</span>
        {onOverride && !surface.readOnly && (
          <button type="button" onClick={onOverride} className="text-sky-400 hover:underline">
            Override here
          </button>
        )}
      </span>
    );
  }
  return null;
}

// A JSON object surface (mcp-list, plugin-list, kv, ...) whose last entry was
// just removed must write `undefined` — so the write path's
// `jsonDriver.remove` deletes the key entirely — rather than `{}`, which
// leaves an explicitly-empty object sitting at this scope forever (and, for
// an inherited surface, would have silently materialized a "no servers"
// override no one asked for).
export function emptyToUndefined<T extends object>(value: T): T | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}
