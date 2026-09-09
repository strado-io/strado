import { useEffect, useState } from 'react';
import { effectiveValue, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// CLAUDE.md / instructions files — plain text, staged behind the group's
// Save button.
export function MarkdownFile({ surface, onStage }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const [text, setText] = useState(() => {
    const v = effectiveValue(surface, overridden);
    return typeof v === 'string' ? v : '';
  });

  useEffect(() => {
    const v = effectiveValue(surface, overridden);
    setText(typeof v === 'string' ? v : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, surface.source, surface.value, surface.inheritedValue, overridden]);

  return (
    <div className="flex flex-col gap-1.5">
      {/*
        No `onReset` here, deliberately: `instructions` is the one surface
        bound to the 'text' format (a whole file, not a JSON key), and
        engine.ts's `writeSurface` refuses to "remove" a text-format surface
        outright (there's no key to delete — only a file whose bytes you
        must set to something). Offering a Reset button that always fails on
        Save is exactly the "always-400s" anti-pattern this same review pass
        fixed for the Skills panel — so only "Override here" applies here;
        "set here" still shows, just without a Reset action beside it.
      */}
      <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} />
      <textarea
        aria-label={surface.label}
        value={text}
        readOnly={readOnly}
        onChange={(e) => {
          // Defense in depth alongside the `readOnly` attribute above: a
          // change event that reaches here despite it (e.g. `fireEvent.change`
          // in a test, or anything else that doesn't go through a real
          // browser's own readonly enforcement) must not stage the inherited
          // global content plus an edit — the exact leak this widget exists
          // to prevent.
          if (readOnly) return;
          setText(e.target.value);
          onStage?.(e.target.value);
        }}
        rows={8}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
      />
    </div>
  );
}
