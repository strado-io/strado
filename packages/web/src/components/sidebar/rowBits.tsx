// The building blocks a sidebar worktree row is made of, shared by the
// Focus cards and the Worktrees page: status helpers, the small
// icons, the hover-only action slot, the PR badge, and the ⋯ menu.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MergeRequest, Worktree } from '../../types';
import { chipStatus } from '../../hooks/sessions';
import { SESSION_COLOR, SessionAvatarIcon } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { useRowHoverCardDismiss } from './WorktreeRowItem';

export function isRunning(w: Worktree): boolean {
  const s = w.process.status;
  return s === 'running' || s === 'starting' || s === 'stopping' || !!w.process.external;
}
export function agentWorking(w: Worktree): boolean {
  return w.claudeStatus === 'working' || w.codexStatus === 'working'
    || w.opencodeStatus === 'working' || w.piStatus === 'working';
}

// Terminal-style loader shown while an agent is working (frames via CSS).
export function BrailleSpinner({ small = false }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="agent working"
      className={`braille-spinner shrink-0 font-mono leading-none text-amber-400 ${small ? 'text-[13px]' : 'text-sm'}`}
    />
  );
}


// branch glyph (hand-tuned SVG, ships pre-flipped upside down) — marks
// each worktree row as a branch hanging off its repo.
export function BranchIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 48 48" aria-hidden data-worktree-icon="branch"
      className={`-scale-y-100 ${className}`}
      fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4"
    >
      <path clipRule="evenodd" d="M36 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm-22 0a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm0 32a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z" />
      <path d="M14 12v24v-3c0-8 22-9 22-17v-4" />
    </svg>
  );
}

export function HoverActions({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`absolute right-1 z-10 flex items-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
        active ? 'bg-zinc-800' : 'bg-zinc-900'
      }`}
    >
      {children}
    </span>
  );
}

// The row's leading glyph when a branch has an open/merged/closed PR. The
// detail (title, checks, branches) belongs to the row's hover card — the icon
// is the state at a glance and a click into the review.
export function MergeRequestBadge({ worktree, mr, onOpen, testIdSuffix = worktree.path }: {
  worktree: Worktree;
  mr: MergeRequest;
  onOpen?: (w: Worktree, mr: MergeRequest) => void;
  testIdSuffix?: string;
}) {
  const pipeline = mr.pipeline ? PIPELINE_DETAIL[mr.pipeline] : null;
  const { kind } = prKind(mr);
  return (
    <button
      type="button"
      data-testid={`pr-status-${testIdSuffix}`}
      aria-label={`Open ${kind} ${mr.number}, ${mr.state}${pipeline ? `, ${pipeline.label.toLowerCase()}` : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(worktree, mr);
      }}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm outline-none ring-offset-zinc-950 focus-visible:ring-1 focus-visible:ring-sky-400"
      style={{ color: MR_STATE_COLOR[mr.state] }}
    >
      <PrStateIcon state={mr.state} />
    </button>
  );
}

export function RepoIcon() {
  // book-with-bookmark repo glyph (hand-tuned SVG), always in the app's
  // primary orange (sky-* is remapped to Strado orange) — one color for every repo
  return (
    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-sky-400">
      {/* GitHub's repo Octicon — drawn on a 16px grid, stays crisp at icon sizes */}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
        <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
      </svg>
    </span>
  );
}

// small kebab (⋯) button + popover; closes on outside-click via a fixed backdrop
export type MenuItem = { text: string; danger?: boolean; onClick: () => void };

/**
 * A menu's floating list. `anchor: 'right'` hangs it left of the point (under
 * a ⋯ button); 'left' opens it rightwards from the point (a right-click).
 */
export function MenuPopover({ pos, items, anchor, onClose }: {
  pos: { x: number; y: number };
  items: MenuItem[];
  anchor: 'left' | 'right';
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // portal: the space carousel's transformed track would otherwise become
  // the containing block for these fixed elements, shoving the popover a
  // pane-width off-screen on every space but the first
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        role="menu"
        className={`fixed z-50 min-w-44 ${anchor === 'right' ? '-translate-x-full' : ''} rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl`}
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.text}
            onClick={() => { onClose(); it.onClick(); }}
            className={`block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${it.danger ? 'text-red-300' : 'text-zinc-200'}`}
          >
            {it.text}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

export function Menu({ label, items, alwaysVisible = false }: {
  label: string;
  items: MenuItem[];
  alwaysVisible?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Inside a worktree row this dismisses the row's hover card (a no-op for
  // repo and space menus): the menu, and whatever it opens, take over.
  const dismissHoverCard = useRowHoverCardDismiss();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          dismissHoverCard();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right, y: r.bottom });
        }}
        className={`${alwaysVisible ? 'inline-flex' : 'pointer-events-none inline-flex opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'} h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded p-[3px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="8" cy="3.5" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="8" cy="12.5" r="1.25" />
        </svg>
      </button>
      {pos && (
        <MenuPopover pos={pos} items={items} anchor="right"
          onClose={() => { setPos(null); dismissHoverCard(); }} />
      )}
    </>
  );
}

// Uncommitted work on a worktree row: +adds −dels, the same numbers the task
// table shows. Silent when the tree is clean, so a quiet row stays quiet.
export function diffBadge(w: Worktree, testIdSuffix = w.path) {
  const d = w.diffStats;
  if (!d || (d.additions === 0 && d.deletions === 0)) return null;
  return (
    <span
      data-testid={`diff-${testIdSuffix}`}
      title={`${d.files} file${d.files === 1 ? '' : 's'} changed · +${d.additions} -${d.deletions}`}
      className="shrink-0 font-mono text-[10px] tabular-nums"
    >
      <span className="text-emerald-500/80">+{d.additions}</span>
      <span className="ml-1 text-red-400/80">-{d.deletions}</span>
    </span>
  );
}
