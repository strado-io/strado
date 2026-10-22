import { useState } from 'react';
import type { OrphanCallDto } from '../../api';

/** Calls whose asker has no tab any more: no pill to select, so each is one
 * muted line above the strip, with Dismiss (a human click) to clear it. */
export function OrphanCalls({ calls, onDismiss }: {
  calls: OrphanCallDto[];
  onDismiss: (callId: string) => Promise<unknown>;
}) {
  // Dismissed here: hidden at once, before the feed catches up.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const open = calls.filter((c) => !dismissed.has(c.id));
  if (open.length === 0) return null;
  const dismiss = async (id: string) => {
    setError(null);
    try {
      await onDismiss(id);
      setDismissed((s) => new Set(s).add(id));
    } catch (err) {
      setError({ id, text: `Couldn't dismiss: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const btn = 'flex shrink-0 items-center rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200';
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2">
      {open.map((c) => (
        <div key={c.id} data-testid="orphan-call" className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-zinc-500">
          <span className="min-w-0 truncate text-zinc-400" title={c.body ? `${c.title}\n${c.body}` : c.title}>
            {`${c.name} · tab closed · asked: ${c.title}`}
          </span>
          {error?.id === c.id && <span className="shrink-0 text-red-400">{error.text}</span>}
          <button type="button" className={btn} aria-label={`Dismiss ${c.name}’s call`} onClick={() => { void dismiss(c.id); }}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
