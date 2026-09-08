import { useEffect, useState } from 'react';
import { effectiveValue, emptyToUndefined, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// Flat string-to-string maps (e.g. Claude's `env` settings block). Stages
// behind the group's Save button.
type Kv = Record<string, string>;

function normalize(value: unknown): Kv {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Kv) : {};
}

export function KvTable({ surface, onStage }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const [pairs, setPairs] = useState<Kv>(() => normalize(effectiveValue(surface, overridden)));
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    setPairs(normalize(effectiveValue(surface, overridden)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, surface.source, surface.value, surface.inheritedValue, overridden]);

  function stage(next: Kv) {
    setPairs(next);
    // Removing the last entry must delete the key entirely on Save, not
    // write back an explicit `{}` — `emptyToUndefined` only changes anything
    // for that one case; every other edit here is already non-empty.
    onStage?.(emptyToUndefined(next));
  }

  function reset() {
    setPairs(normalize(surface.inheritedValue));
    onStage?.(undefined);
  }

  const entries = Object.entries(pairs);

  return (
    <div className="flex flex-col gap-2">
      <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} onReset={reset} />
      {entries.length === 0 && <p className="text-xs text-zinc-500">No entries.</p>}
      {entries.map(([key, val]) => (
        <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <span className="col-span-2 break-all font-mono text-[11px] text-zinc-400">{key}</span>
          {readOnly ? (
            <span className="break-all font-mono text-zinc-500">{val}</span>
          ) : (
            <input
              aria-label={`Value for ${key}`}
              value={val}
              onChange={(e) => stage({ ...pairs, [key]: e.target.value })}
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none"
            />
          )}
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${key}`}
              onClick={() => {
                const next = { ...pairs };
                delete next[key];
                stage(next);
              }}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-800 hover:text-red-300"
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <input
            aria-label={`New ${surface.label} key`}
            placeholder="KEY"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="col-span-2 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none"
          />
          <input
            aria-label={`New ${surface.label} value`}
            placeholder="value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={!newKey}
            onClick={() => {
              if (!newKey) return;
              stage({ ...pairs, [newKey]: newValue });
              setNewKey('');
              setNewValue('');
            }}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
