import { effectiveValue, emptyToUndefined, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// `enabledPlugins` in Claude's settings.json: { "name@marketplace": true }.
type Plugins = Record<string, boolean>;

function normalize(value: unknown): Plugins {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Plugins) : {};
}

export function PluginList({ surface, onChange }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const plugins = normalize(effectiveValue(surface, overridden));
  const entries = Object.entries(plugins);

  return (
    <div className="flex flex-col gap-2">
      <InheritedBadge
        surface={surface}
        overridden={overridden}
        onOverride={activate}
        onReset={() => void onChange(undefined)}
      />
      {entries.length === 0 && <p className="text-xs text-zinc-500">No plugins enabled.</p>}
      {entries.map(([id, enabled]) => (
        <div
          key={id}
          className="flex items-center justify-between gap-2 min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-3 text-xs"
        >
          <label className="flex min-w-0 items-center gap-2 break-all text-zinc-200">
            <input
              type="checkbox"
              checked={Boolean(enabled)}
              disabled={readOnly}
              onChange={(e) => void onChange({ ...plugins, [id]: e.target.checked })}
              className="h-3.5 w-3.5 shrink-0 accent-sky-500 rounded border-zinc-700 bg-zinc-900"
            />
            {id}
          </label>
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${id}`}
              onClick={() => {
                const next = { ...plugins };
                delete next[id];
                void onChange(emptyToUndefined(next));
              }}
              className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-800 hover:text-red-300"
            >
              Remove
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
