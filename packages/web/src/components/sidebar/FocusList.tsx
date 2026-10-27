// Every Focus, as an accordion. Making a Focus active (a click on its row,
// ⌘1–9, any switch) opens its Jarvis chat, expands it and folds every other
// one. A click on the active row shows its chat, or, once the chat shows,
// folds or expands it. The chevron toggles just that Focus without activating
// it, to peek at another one's worktrees. What is expanded is remembered per window.
// The active row is its Jarvis, with its status, selected while the chat
// shows. The others are flat one-line headings with their
// live badges — headings, not cards, so they never read as worktrees. They
// keep one stable order, creation (byCreated), so using a Focus never moves
// it. All of them show, no cap. No
// header: New focus is the + in the workspace row.
import { useEffect, useRef, useState } from 'react';
import type { Focus } from '../../api';
import { shortRelativeTime } from '../../lib/relativeTime';
import { byCreated } from './FocusSwitcher';
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
  /** A pulsing dot while it works, ⚠ amber while an approval waits, nothing at rest. */
  status: React.ReactNode;
  /** The chat is what the main area shows: the header reads as selected. */
  selected: boolean;
  /** The header row was clicked: open the chat. */
  onOpen: () => void;
};

const EXPANDED_KEY = 'strado:focus-expanded';
const EXPANDED_FOR_KEY = 'strado:focus-expanded-for';

// A Focus row is a heading: flat, a hover tint only (the theme's edge colour,
// so white on dark and black on light). The open Focus's contents sit in one
// very quiet panel under it.
const ROW = 'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-[rgb(var(--pane-edge)/0.05)]';
// The open Focus's header: the same row, one line.
const HEADER = 'flex min-w-0 flex-col rounded-md px-2 py-1';
const GROUP = 'flex flex-col gap-1.5 rounded-xl bg-[rgb(var(--pane-edge)/0.02)] p-1.5 ring-1 ring-[rgb(var(--pane-edge)/0.05)]';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const Chevron = ({ open }: { open: boolean }) => (
  <svg {...icon} width={12} height={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><path d="m9 18 6-6-6-6" /></svg>
);

/** The sidebar's search: the Focuses that match, and those to show expanded (a worktree in them matched). */
export type FocusFilter = { ids: ReadonlySet<string>; expand: ReadonlySet<string> };

export function FocusList({ focuses, activeId, badges, onOpen, activeMenu, onRename, jarvis, filter, children }: {
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
  /** While searching: only these, uncapped. */
  filter?: FocusFilter | null;
  /** An expanded Focus's contents: its worktree cards (or a blank Focus's Add/New rows). */
  children: (f: Focus) => React.ReactNode;
}) {
  const [expanded, toggle, only] = useExpanded();
  // A Focus becoming active is the accordion: it alone is expanded. Compared
  // with the Focus the stored state was made for, so a switch while the
  // sidebar was hidden still applies, and a reload keeps what was left.
  const lastActive = useRef(readExpandedFor());
  useEffect(() => {
    if (activeId && activeId !== lastActive.current) only(activeId);
    lastActive.current = activeId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sorted = [...focuses].sort(byCreated);
  const shown = filter ? sorted.filter((f) => filter.ids.has(f.id)) : sorted;

  return (
    <section aria-label="Focuses" className="mt-1 flex flex-col">
      <div className="flex flex-col gap-0.5">
        {shown.map((f, i) => {
          const n = sorted.indexOf(f) + 1;
          const hint = n <= 9 ? ` (⌘${n})` : '';
          const isActive = f.id === activeId;
          const open = expanded.has(f.id) || !!filter?.expand.has(f.id);
          const chevron = (
            <button type="button" aria-label={open ? `Fold ${f.name}` : `Show ${f.name}`} aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); toggle(f.id); }}
              className="-ml-0.5 flex h-5 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"><Chevron open={open} /></button>
          );
          const b = badges.get(f.id) ?? {};
          return (
            // Its spacing is the same folded or not: the panel carries its own gaps, so
            // expanding never moves this row or any above it.
            <div key={f.id} data-testid={isActive ? 'focus-open' : 'focus-row'} data-focus-item data-expanded={open || undefined}
              className="flex flex-col">
              {isActive ? (
                // The active Focus's header is its Jarvis. A click anywhere on it (but ⋯)
                // shows the chat; once the chat shows, it folds or expands the Focus.
                <div data-testid="focus-header" data-selected={jarvis?.selected || undefined}
                  onClick={renaming !== f.id ? () => { if (jarvis && !jarvis.selected) jarvis.onOpen(); else toggle(f.id); } : undefined}
                  className={`${HEADER} group cursor-pointer ${jarvis?.selected ? 'bg-[rgb(var(--pane-edge)/0.08)]' : 'hover:bg-[rgb(var(--pane-edge)/0.05)]'}`}>
                  <div className="flex h-6 min-w-0 items-center gap-1.5">
                    {chevron}
                    {renaming === f.id ? (
                      <RenameField name={f.name} onDone={(name) => { setRenaming(null); if (name && name !== f.name) onRename(f.id, name); }} />
                    ) : (
                      <h3 aria-current="true" title={`${f.name}${hint}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
                        {/* The row's keyboard handle: Enter/Space click it, and the click is the row's. */}
                        <button type="button" aria-expanded={open} className="max-w-full truncate text-left">{f.name}</button>
                      </h3>
                    )}
                    {b.agents}
                    {jarvis?.status}
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
                    <Menu label={`${f.name} actions`} alwaysVisible
                      items={[{ text: 'Rename', onClick: () => setRenaming(f.id) }, ...activeMenu]} />
                  </div>
                </div>
              ) : (
                <div className={ROW}>
                  {chevron}
                  <button type="button" onClick={() => onOpen(f.id)} title={`Switch to ${f.name}${hint}`} aria-label={`Switch to ${f.name}`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-400">{f.name}</span>
                    {b.agents}
                    {(b.pendingApprovals ?? 0) > 0 && (
                      <span role="img" aria-label={`${b.pendingApprovals} waiting for approval`} title="Jarvis is waiting for your approval" className="shrink-0 text-[11px] text-amber-400">⚠</span>
                    )}
                    {b.unread && (
                      <span role="img" aria-label="new reply from Jarvis" title="Jarvis replied" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e8906f]" />
                    )}
                    <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
                  </button>
                </div>
              )}
              {/* What belongs to this Focus, grouped under its heading (no accent line). */}
              <FocusPanel open={open} last={i === shown.length - 1}>{() => children(f)}</FocusPanel>
            </div>
          );
        })}
        {filter && shown.length === 0 && <p className="flex h-8 items-center px-2 text-[12px] text-zinc-500">No match</p>}
      </div>
    </section>
  );
}

// A Focus's panel, under its heading. It grows open and shrinks shut (grid rows
// 0fr↔1fr, .focus-panel in index.css: no measuring); shutting, it stays drawn,
// hidden from clicks, until the shrink ends. Its gaps sit inside the part that grows, so only
// the panel's own height changes.
const SHUT_MS = 220;
function FocusPanel({ open, last, children }: { open: boolean; last: boolean; children: () => React.ReactNode }) {
  const [wasOpen, setWasOpen] = useState(open);
  const [shutting, setShutting] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setShutting(!open && animates());
  }
  useEffect(() => {
    if (!shutting) return;
    const t = setTimeout(() => setShutting(false), SHUT_MS + 50);
    return () => clearTimeout(t);
  }, [shutting]);
  if (!open && !shutting) return null;
  return (
    <div className="focus-panel" data-open={open || undefined} onTransitionEnd={(e) => { if (e.target === e.currentTarget && !open) setShutting(false); }}>
      {/* px-px leaves room for the group's ring, which the clip would cut. The
          vertical gaps sit inside the clip, so it can shut all the way to 0. */}
      <div className="min-h-0 overflow-hidden px-px">
        <div className={`pt-0.5 ${last ? 'pb-px' : 'pb-2'}`}>
          <div data-testid={open ? 'focus-group' : undefined} aria-hidden={!open || undefined}
            className={`${GROUP} ${open ? '' : 'pointer-events-none'}`}>{children()}</div>
        </div>
      </div>
    </div>
  );
}
const animates = () => {
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// Which Focuses are expanded, per window (sessionStorage): another window keeps its own.
function readExpanded(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(EXPANDED_KEY) || '[]') as string[]); } catch { return new Set(); }
}
function readExpandedFor(): string | null {
  try { return sessionStorage.getItem(EXPANDED_FOR_KEY); } catch { return null; }
}
function useExpanded(): [Set<string>, (id: string) => void, (id: string) => void] {
  const [expanded, setExpanded] = useState(readExpanded);
  const save = (next: Set<string>) => {
    try { sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* storage off: this render only */ }
    return next;
  };
  const toggle = (id: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    return save(next);
  });
  // The accordion: this one expanded, every other folded.
  const only = (id: string) => {
    try { sessionStorage.setItem(EXPANDED_FOR_KEY, id); } catch { /* storage off */ }
    setExpanded(() => save(new Set([id])));
  };
  return [expanded, toggle, only];
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
