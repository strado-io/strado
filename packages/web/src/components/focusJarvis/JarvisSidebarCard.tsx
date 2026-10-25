import type { ChatEntry, JarvisMeta } from '../../types';

/** The chat's latest line for the card: Jarvis's last reply, else the person's
 * last message; its first line only. */
export function latestLine(entries: ChatEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if ((e.type === 'jarvis' || e.type === 'user') && e.text.trim()) return e.text.trim().split('\n')[0]!.trim();
  }
  return '';
}

/** ✦ Jarvis, first in the Focus: the same glass card as a worktree's. Line two
 * is the agent and the latest line; amber "needs approval" while one waits, a
 * pulsing dot while a turn runs. */
export function JarvisSidebarCard({ meta, latest, active, onOpen }: { meta: JarvisMeta | null; latest: string; active: boolean; onOpen: () => void }) {
  const needs = (meta?.pendingApprovals ?? 0) > 0;
  return (
    <div data-testid="jarvis-card" data-active={active || undefined} onClick={onOpen}
      className={`cursor-pointer rounded-xl border transition-colors ${active
        ? 'glass-pill !border-[rgb(var(--pane-edge)/0.22)] !bg-[rgb(var(--pane-edge)/0.08)]'
        : 'glass pane-card hover:border-[rgb(var(--pane-edge)/0.12)]'}`}>
      <div className="flex min-w-0 flex-col gap-1 py-2 pl-3 pr-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-[#d97757]/15 text-[11px] text-[#e8906f] ring-1 ring-inset ring-[#d97757]/25">✦</span>
          <button type="button" aria-label="Jarvis" className={`min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-5 ${active ? 'text-zinc-100' : 'text-zinc-200'}`}>Jarvis</button>
          {meta?.running && <span aria-label="working" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />}
          {needs && <span className="shrink-0 text-[11px] text-amber-300">needs approval</span>}
        </div>
        <div className="truncate pl-7 text-[11px] text-zinc-500">Claude{latest ? ` · ${latest}` : ''}</div>
      </div>
    </div>
  );
}
