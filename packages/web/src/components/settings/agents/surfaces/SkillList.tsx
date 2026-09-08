import { effectiveValue, InheritedBadge, isLocked, useOverride } from './common';
import type { SurfaceProps } from './types';

// Mirrors `dirDriver.list`'s contract on the server (formats/dir.ts): one
// entry per subdirectory, flagging whether it has a SKILL.md.
type SkillEntry = { name: string; hasSkillMd: boolean };

function normalize(value: unknown): SkillEntry[] {
  return Array.isArray(value) ? (value as SkillEntry[]) : [];
}

export function SkillList({ surface, onRemoveSkill }: SurfaceProps) {
  const [overridden, activate] = useOverride(surface);
  const locked = isLocked(surface, overridden);
  const readOnly = surface.readOnly || locked;
  const entries = normalize(effectiveValue(surface, overridden));

  return (
    <div className="flex flex-col gap-2">
      {/*
        No `onReset` here: an "inherited" skill-list entry is shown from the
        OTHER scope's directory (this scope's own doesn't exist yet), so
        there is no local key to remove — only "Override here" applies,
        and it starts truly empty (skill install/`DirectoryDriver.add` is a
        separate, out-of-scope slice).
      */}
      <InheritedBadge surface={surface} overridden={overridden} onOverride={activate} />
      {entries.length === 0 && <p className="text-xs text-zinc-500">No skills installed.</p>}
      {entries.map((entry) => (
        <div
          key={entry.name}
          className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-200">{entry.name}</span>
            {!entry.hasSkillMd && (
              <span className="rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300">no SKILL.md</span>
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${entry.name}`}
              onClick={() => void onRemoveSkill?.(entry.name)}
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
