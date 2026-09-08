import { effectiveValue, emptyToUndefined, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// `services/claudeHooks.ts` installs Strado's own idle/status hook into
// `.claude/settings.local.json` under this marker. Editing it from this
// panel would fight the code that installs it, so it renders read-only with
// a badge instead of controls — regardless of the surface's own `readOnly`.
const STRADO_HOOK_MARKER = 'claude-status-hook.mjs';

type HookEntry = { type: string; command: string };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type HooksValue = Record<string, HookGroup[]>;

function normalize(value: unknown): HooksValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as HooksValue) : {};
}

function isStradoManaged(hook: HookEntry): boolean {
  return hook.command.includes(STRADO_HOOK_MARKER);
}

export function HookList({ surface, onChange }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const value = normalize(effectiveValue(surface, overridden));
  const events = Object.entries(value);

  function removeHook(event: string, groupIndex: number, hookIndex: number) {
    const groups = [...(value[event] ?? [])];
    const group = groups[groupIndex];
    if (!group) return;
    const hooks = group.hooks.filter((_, i) => i !== hookIndex);
    if (hooks.length === 0) {
      groups.splice(groupIndex, 1);
    } else {
      groups[groupIndex] = { ...group, hooks };
    }
    const next: HooksValue = { ...value };
    if (groups.length === 0) {
      delete next[event];
    } else {
      next[event] = groups;
    }
    void onChange(emptyToUndefined(next));
  }

  return (
    <div className="flex flex-col gap-3">
      <InheritedBadge
        surface={surface}
        overridden={overridden}
        onOverride={activate}
        onReset={() => void onChange(undefined)}
      />
      {events.length === 0 && <p className="text-xs text-zinc-500">No hooks configured.</p>}
      {events.map(([event, groups]) => (
        <div key={event} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{event}</span>
          {groups.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-1">
              {group.matcher && (
                <span className="font-mono text-[11px] text-zinc-500">matcher: {group.matcher}</span>
              )}
              {group.hooks.map((hook, hi) => {
                const managed = isStradoManaged(hook);
                return (
                  <div
                    key={hi}
                    className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
                  >
                    <span className="truncate font-mono text-zinc-300">{hook.command}</span>
                    {managed ? (
                      <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        managed by Strado
                      </span>
                    ) : (
                      !readOnly && (
                        <button
                          type="button"
                          aria-label={`Remove hook ${hook.command}`}
                          onClick={() => removeHook(event, gi, hi)}
                          className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-800 hover:text-red-300"
                        >
                          Remove
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
