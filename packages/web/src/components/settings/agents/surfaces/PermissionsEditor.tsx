import { useEffect, useState } from 'react';
import { effectiveValue, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// Claude's `permissions` block: rule lists keyed by disposition, e.g.
// { allow: ["Bash(tmux show-option:*)"], deny: ["WebFetch"], ask: [...] }.
type Permissions = { allow?: string[]; deny?: string[]; ask?: string[] };
type RuleKey = 'allow' | 'deny' | 'ask';

function normalize(value: unknown): Permissions {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Permissions) : {};
}

const SECTIONS: Array<{ key: RuleKey; label: string }> = [
  { key: 'allow', label: 'Allow' },
  { key: 'deny', label: 'Deny' },
  { key: 'ask', label: 'Ask' },
];

export function PermissionsEditor({ surface, onStage }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const [perms, setPerms] = useState<Permissions>(() => normalize(effectiveValue(surface, overridden)));
  const [drafts, setDrafts] = useState<Record<RuleKey, string>>({ allow: '', deny: '', ask: '' });

  useEffect(() => {
    setPerms(normalize(effectiveValue(surface, overridden)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, surface.source, surface.value, surface.inheritedValue, overridden]);

  function stage(next: Permissions) {
    setPerms(next);
    onStage?.(next);
  }

  function reset() {
    setPerms(normalize(surface.inheritedValue));
    onStage?.(undefined);
  }

  return (
    <div className="flex flex-col gap-3">
      <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} onReset={reset} />
      {SECTIONS.map(({ key, label }) => {
        const rules = perms[key] ?? [];
        return (
          <div key={key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-300">{label}</span>
            <div className="flex flex-wrap gap-1.5">
              {rules.length === 0 && <span className="text-xs text-zinc-600">None</span>}
              {rules.map((rule) => (
                <span
                  key={rule}
                  className="flex min-w-0 items-center gap-1 break-all rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-300"
                >
                  {rule}
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${rule} from ${label}`}
                      onClick={() => stage({ ...perms, [key]: rules.filter((r) => r !== rule) })}
                      className="text-zinc-500 hover:text-red-300"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!readOnly && (
              <div className="flex gap-2">
                <input
                  aria-label={`New ${label} rule`}
                  value={drafts[key]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  placeholder="Tool(pattern)"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!drafts[key]}
                  onClick={() => {
                    const rule = drafts[key];
                    if (!rule) return;
                    stage({ ...perms, [key]: [...rules, rule] });
                    setDrafts((d) => ({ ...d, [key]: '' }));
                  }}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
