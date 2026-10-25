// Every Focus, as an accordion: the active one open (its header, then its ✦
// Jarvis card and worktree cards in one quiet group), every other one a flat
// heading row with its name, live badges and when it was last active —
// headings, not cards, so they never read as worktrees. Clicking a row makes
// that Focus the active one; at most one is ever open, and it is always the
// active one. The six most recent show, the active one always, then
// "Show all (N)". No header: New focus is the + in the workspace row.
import { useState } from 'react';
import type { Focus } from '../../api';
import { shortRelativeTime } from '../../lib/relativeTime';
import { FocusIcon, byLastActive } from './FocusSwitcher';
import { Menu, type MenuItem } from './rowBits';

/** What a collapsed row says about its Focus, beyond its name. */
export type FocusBadges = {
  /** Agents busy (or waiting) in its worktrees: their faces, as on the cards. */
  agents?: React.ReactNode;
  /** Its Jarvis is waiting on the person (meta.pendingApprovals). */
  pendingApprovals?: number;
  /** Jarvis replied since this window last had that chat open. */
  unread?: boolean;
};

export const FOCUS_LIST_CAP = 6;

// A Focus row is a heading: flat, a hover tint only (the theme's edge colour,
// so white on dark and black on light). The open Focus's contents sit in one
// very quiet panel under it.
const ROW = 'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-[rgb(var(--pane-edge)/0.05)]';
const GROUP = 'flex flex-col gap-1.5 rounded-xl bg-[rgb(var(--pane-edge)/0.02)] p-1.5 ring-1 ring-[rgb(var(--pane-edge)/0.05)]';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const Chevron = ({ open }: { open: boolean }) => (
  <svg {...icon} width={12} height={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><path d="m9 18 6-6-6-6" /></svg>
);

export function FocusList({ focuses, activeId, badges, onOpen, activeMenu, onRename, children }: {
  focuses: Focus[];
  activeId: string | null;
  badges: Map<string, FocusBadges>;
  /** A collapsed row was clicked: make that Focus the active one. */
  onOpen: (id: string) => void;
  /** The open Focus's ⋯ menu (Rename is added here). */
  activeMenu: MenuItem[];
  onRename: (id: string, name: string) => void;
  /** The open Focus's contents: its Jarvis card and worktree cards. */
  children: React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sorted = [...focuses].sort(byLastActive);
  const capped = sorted.slice(0, FOCUS_LIST_CAP);
  // The active Focus always shows, however long ago it was used.
  const shown = showAll ? sorted : sorted.filter((f) => capped.includes(f) || f.id === activeId);
  const hidden = sorted.length - shown.length;

  return (
    <section aria-label="Focuses" className="mt-1 flex flex-col">
      <div className="flex flex-col gap-0.5">
        {shown.map((f, i) => {
          const n = sorted.indexOf(f) + 1;
          const hint = n <= 9 ? ` (⌘${n})` : '';
          if (f.id === activeId) {
            return (
              <div key={f.id} data-testid="focus-open" className={`flex flex-col gap-0.5 ${i > 0 ? 'mt-2' : ''} ${i < shown.length - 1 ? 'mb-2' : ''}`}>
                <div className={`${ROW} group`}>
                  <span className="text-zinc-400"><Chevron open /></span>
                  <span className="shrink-0 text-zinc-300"><FocusIcon size={15} /></span>
                  {renaming === f.id ? (
                    <RenameField name={f.name} onDone={(name) => { setRenaming(null); if (name && name !== f.name) onRename(f.id, name); }} />
                  ) : (
                    <h3 aria-current="true" title={`${f.name}${hint}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">{f.name}</h3>
                  )}
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
                  <Menu label={`${f.name} actions`} alwaysVisible
                    items={[{ text: 'Rename', onClick: () => setRenaming(f.id) }, ...activeMenu]} />
                </div>
                {/* What belongs to this Focus, grouped under its heading (no accent line). */}
                <div data-testid="focus-group" className={GROUP}>{children}</div>
              </div>
            );
          }
          const b = badges.get(f.id) ?? {};
          return (
            <button key={f.id} type="button" onClick={() => onOpen(f.id)} title={`Switch to ${f.name}${hint}`} aria-label={`Switch to ${f.name}`}
              className={`${ROW} text-left`}>
              <span className="text-zinc-500"><Chevron open={false} /></span>
              <span className="shrink-0 text-zinc-500"><FocusIcon size={15} /></span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-400">{f.name}</span>
              {b.agents}
              {(b.pendingApprovals ?? 0) > 0 && (
                <span role="img" aria-label={`${b.pendingApprovals} waiting for approval`} title="Jarvis is waiting for your approval" className="shrink-0 text-[11px] text-amber-400">⚠</span>
              )}
              {b.unread && (
                <span role="img" aria-label="new reply from Jarvis" title="Jarvis replied" className="shrink-0 text-[11px] text-[#e8906f]">✦</span>
              )}
              <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
            </button>
          );
        })}
        {(hidden > 0 || (showAll && sorted.length > FOCUS_LIST_CAP)) && (
          <button type="button" onClick={() => setShowAll((s) => !s)}
            className="self-start rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300">
            {showAll ? 'Show fewer' : `Show all (${sorted.length})`}
          </button>
        )}
      </div>
    </section>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  return (
    <form className="min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); onDone(value.trim()); }}>
      <input autoFocus aria-label={`Rename ${name}`} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } }}
        onBlur={() => onDone(null)}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[13px] text-zinc-100 focus:outline-none" />
    </form>
  );
}
