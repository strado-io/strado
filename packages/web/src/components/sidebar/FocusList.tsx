// Every Focus, as an accordion. Each row's chevron, and only it, shows or
// folds that Focus's worktree cards; any number can be open, remembered per
// window, and a Focus never toggled starts folded. Clicking a row anywhere
// else makes it the active Focus and opens its Jarvis chat, folded or not.
// The active row is its Jarvis: two lines (status, latest reply), selected
// while the chat shows. The others are flat one-line headings with their
// live badges — headings, not cards, so they never read as worktrees. The
// six most recent show, the active one always, then "Show all (N)". No
// header: New focus is the + in the workspace row.
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

/** The open Focus's Jarvis, shown in its header: Jarvis is the Focus itself. */
export type FocusJarvisHeader = {
  /** ✦ (dim idle, pulsing while it works) or ⚠ amber while an approval waits. */
  status: React.ReactNode;
  /** Line two, Jarvis's latest reply: an element that renders FOCUS_LATEST_CLASS's line, or nothing. */
  latest: React.ReactNode;
  /** The chat is what the main area shows: the header reads as selected. */
  selected: boolean;
  /** The header row was clicked: open the chat. */
  onOpen: () => void;
};

export const FOCUS_LIST_CAP = 6;
const EXPANDED_KEY = 'strado:focus-expanded';
/** The header's second line, aligned under the name. */
export const FOCUS_LATEST_CLASS = 'truncate pl-[2.4rem] pr-1 text-[11px] leading-4 text-zinc-500';

// A Focus row is a heading: flat, a hover tint only (the theme's edge colour,
// so white on dark and black on light). The open Focus's contents sit in one
// very quiet panel under it.
const ROW = 'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-[rgb(var(--pane-edge)/0.05)]';
// The open Focus's header: the same row, two lines (the second, Jarvis's latest reply).
const HEADER = 'flex min-w-0 flex-col rounded-md px-2 py-1';
const GROUP = 'flex flex-col gap-1.5 rounded-xl bg-[rgb(var(--pane-edge)/0.02)] p-1.5 ring-1 ring-[rgb(var(--pane-edge)/0.05)]';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const Chevron = ({ open }: { open: boolean }) => (
  <svg {...icon} width={12} height={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><path d="m9 18 6-6-6-6" /></svg>
);

export function FocusList({ focuses, activeId, badges, onOpen, activeMenu, onRename, jarvis, children }: {
  focuses: Focus[];
  activeId: string | null;
  badges: Map<string, FocusBadges>;
  /** An inactive row was clicked: make that Focus the active one. */
  onOpen: (id: string) => void;
  /** The active Focus's ⋯ menu (Rename is added here). */
  activeMenu: MenuItem[];
  onRename: (id: string, name: string) => void;
  /** The active Focus's Jarvis, for its header. */
  jarvis?: FocusJarvisHeader;
  /** An expanded Focus's contents: its worktree cards (or a blank Focus's Add/New rows). */
  children: (f: Focus) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, toggle] = useExpanded();
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
          const isActive = f.id === activeId;
          const open = expanded.has(f.id);
          const chevron = (
            <button type="button" aria-label={open ? `Fold ${f.name}` : `Show ${f.name}`} aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); toggle(f.id); }}
              className="-ml-0.5 flex h-5 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"><Chevron open={open} /></button>
          );
          const b = badges.get(f.id) ?? {};
          return (
            <div key={f.id} data-testid={isActive ? 'focus-open' : 'focus-row'} data-expanded={open || undefined}
              className={`flex flex-col gap-0.5 ${open && i > 0 ? 'mt-2' : ''} ${open && i < shown.length - 1 ? 'mb-2' : ''}`}>
              {isActive ? (
                // The active Focus's header is its Jarvis: clicking it (outside the chevron and ⋯) opens the chat.
                <div data-testid="focus-header" data-selected={jarvis?.selected || undefined}
                  onClick={jarvis && renaming !== f.id ? jarvis.onOpen : undefined}
                  className={`${HEADER} group ${jarvis ? 'cursor-pointer' : ''} ${jarvis?.selected ? 'bg-[rgb(var(--pane-edge)/0.08)]' : 'hover:bg-[rgb(var(--pane-edge)/0.05)]'}`}>
                  <div className="flex h-6 min-w-0 items-center gap-1.5">
                    {chevron}
                    <span className="shrink-0 text-zinc-300"><FocusIcon size={15} /></span>
                    {renaming === f.id ? (
                      <RenameField name={f.name} onDone={(name) => { setRenaming(null); if (name && name !== f.name) onRename(f.id, name); }} />
                    ) : (
                      <h3 aria-current="true" title={`${f.name}${hint}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
                        {jarvis ? <button type="button" aria-label={`Open Jarvis for ${f.name}`} className="max-w-full truncate text-left">{f.name}</button> : f.name}
                      </h3>
                    )}
                    {b.agents}
                    {jarvis?.status}
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
                    <Menu label={`${f.name} actions`} alwaysVisible
                      items={[{ text: 'Rename', onClick: () => setRenaming(f.id) }, ...activeMenu]} />
                  </div>
                  {/* Line two: Jarvis's latest reply, aligned under the name (renders nothing when there is none). */}
                  {jarvis?.latest}
                </div>
              ) : (
                <div className={ROW}>
                  {chevron}
                  <button type="button" onClick={() => onOpen(f.id)} title={`Switch to ${f.name}${hint}`} aria-label={`Switch to ${f.name}`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left">
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
                </div>
              )}
              {/* What belongs to this Focus, grouped under its heading (no accent line). */}
              {open && <div data-testid="focus-group" className={GROUP}>{children(f)}</div>}
            </div>
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

// Which Focuses are expanded, per window (sessionStorage): another window keeps its own.
function readExpanded(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(EXPANDED_KEY) || '[]') as string[]); } catch { return new Set(); }
}
function useExpanded(): [Set<string>, (id: string) => void] {
  const [expanded, setExpanded] = useState(readExpanded);
  const toggle = (id: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    try { sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* storage off: this render only */ }
    return next;
  });
  return [expanded, toggle];
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
