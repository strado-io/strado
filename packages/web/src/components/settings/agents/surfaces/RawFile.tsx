import { useEffect, useState } from 'react';
import { effectiveValue, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// Catch-all for surfaces we don't have a dedicated editor for (e.g. plugin
// marketplaces, the status-line config) — arbitrary JSON, edited as text and
// staged behind the group's Save button once it parses.
function stringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

export function RawFile({ surface, onStage }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const [text, setText] = useState(() => stringify(effectiveValue(surface, overridden)));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(stringify(effectiveValue(surface, overridden)));
    setInvalid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, surface.source, surface.value, surface.inheritedValue, overridden]);

  function onEdit(next: string) {
    setText(next);
    if (next.trim() === '') {
      setInvalid(false);
      onStage?.(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(next);
      setInvalid(false);
      onStage?.(parsed);
    } catch {
      // Leave the previously staged value alone — an in-progress edit that
      // doesn't parse yet must not clobber the last valid staged value.
      setInvalid(true);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <InheritedBadge
        surface={surface}
        overridden={overridden}
        onOverride={activate}
        onReset={() => {
          setText(stringify(surface.inheritedValue));
          setInvalid(false);
          onStage?.(undefined);
        }}
      />
      <textarea
        aria-label={surface.label}
        value={text}
        readOnly={readOnly}
        onChange={(e) => {
          // Defense in depth alongside the `readOnly` attribute above — see
          // MarkdownFile's identical guard.
          if (readOnly) return;
          onEdit(e.target.value);
        }}
        rows={6}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
      />
      {invalid && <span className="text-xs text-red-400">Invalid JSON — not staged until fixed.</span>}
    </div>
  );
}
