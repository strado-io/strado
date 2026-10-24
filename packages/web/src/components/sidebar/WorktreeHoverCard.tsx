import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MergeRequest, Worktree } from '../../types';
import { chipStatus, displayLabel, type SessionChip } from '../../hooks/sessions';
import { WORKFLOW_STATUSES } from '../WorkflowStatusSelect';
import { SESSION_COLOR, SessionAvatarIcon } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { worktreeLabel, worktreeTitle } from './labels';

export const HOVER_CARD_WIDTH = 280;
const GAP = 8;

// Sessions that need someone come first: working, then waiting, then everything
// else — so "which one is running right now" is the top of the list, not a hunt.
const URGENCY: Record<string, number> = { working: 0, waiting: 1, idle: 2 };

export function sortSessions(chips: SessionChip[]): SessionChip[] {
  const rank = (c: SessionChip) => URGENCY[chipStatus(c) ?? ''] ?? 3;
  // decorate/sort/undecorate keeps ties in their original order on every engine
  return chips
    .map((chip, index) => ({ chip, index }))
    .sort((a, b) => rank(a.chip) - rank(b.chip) || a.index - b.index)
    .map((entry) => entry.chip);
}

const STATUS_TEXT: Record<string, string> = {
  working: 'text-emerald-400',
  waiting: 'text-amber-400',
  idle: 'text-zinc-500',
};

function workflowLabel(w: Worktree): string | null {
  const status = w.meta?.workflowStatus;
  return WORKFLOW_STATUSES.find((s) => s.value === status)?.label ?? null;
}

export type HoverCardMode = SessionChip['mode'];

export type WorktreeHoverCardProps = {
  worktree: Worktree;
  chips: SessionChip[];
  mr?: MergeRequest | null;
  /** Bounding box of the row the card belongs to. */
  anchor: DOMRect;
  /** Sidebar edges, so every card lines up on one column instead of the row's own width. */
  sidebarLeft?: number;
  sidebarRight?: number;
  /** Set for a worktree that lives on a runner. */
  runnerName?: string;
  onOpenSession: (mode: HoverCardMode, sessionId: string) => void;
  onOpenMr?: () => void;
  onOpenDiff?: () => void;
  onOpenShell?: () => void;
  onOpenSettings?: () => void;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

export function WorktreeHoverCard({
  worktree, chips, mr = null, anchor, sidebarLeft, sidebarRight, runnerName,
  onOpenSession, onOpenMr, onOpenDiff, onOpenShell, onOpenSettings, onClose,
  onPointerEnter, onPointerLeave, onFocus, onBlur,
}: WorktreeHoverCardProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sessions = sortSessions(chips);
  const height = Math.min(420, 200 + sessions.length * 30);
  const right = sidebarRight ?? anchor.right;
  const left = sidebarLeft ?? anchor.left;
  const fitsRight = right + GAP + HOVER_CARD_WIDTH <= window.innerWidth - GAP;
  const x = fitsRight ? right + GAP : Math.max(GAP, left - GAP - HOVER_CARD_WIDTH);
  const y = Math.min(
    Math.max(GAP, anchor.top - GAP),
    Math.max(GAP, window.innerHeight - height - GAP),
  );

  const title = worktreeTitle(worktree);
  const status = workflowLabel(worktree);
  const diff = worktree.diffStats;
  const dirty = !!diff && (diff.additions > 0 || diff.deletions > 0);
  // A worktree on a runner carries no local process — the rail shows what the
  // runner reported, and nothing more.
  const process = worktree.process as Worktree['process'] | undefined;
  const running = process?.status === 'running' || process?.status === 'starting' || !!process?.external;
  const pipeline = mr?.pipeline ? PIPELINE_DETAIL[mr.pipeline] : null;
  const pr = mr ? prKind(mr) : null;

  // The card's name once: the human title when there is one, else the label.
  // The branch is a second line only when it says something the name doesn't.
  const label = worktreeLabel(worktree);
  const name = title || label;
  // One detail line, each part said once: the label and branch only where
  // they differ from what is already shown, then the runner, the changes and
  // a running dev server.
  const shown = new Set([name.toLowerCase()]);
  const fresh = (v: string | null | undefined) => {
    if (!v || shown.has(v.toLowerCase())) return null;
    shown.add(v.toLowerCase());
    return v;
  };
  const sub = fresh(label);
  const branch = fresh(worktree.branch);
  const meta = [
    sub && <span key="label" className="min-w-0 truncate">{sub}</span>,
    branch && <span key="branch" className="min-w-0 truncate font-mono" title={branch}>{branch}</span>,
    runnerName && <span key="runner" className="shrink-0 whitespace-nowrap">on {runnerName}</span>,
    dirty && (
      <span key="diff" data-testid="hover-card-diff" className="shrink-0 whitespace-nowrap font-mono">
        {diff!.files} file{diff!.files === 1 ? '' : 's'}
        <span className="ml-1 text-emerald-500/80">+{diff!.additions}</span>
        <span className="ml-1 text-red-400/80">-{diff!.deletions}</span>
      </span>
    ),
    running && (
      <span key="run" data-testid="hover-card-running" className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
        running{process?.port ? ` :${process.port}` : ''}
      </span>
    ),
  ].filter(Boolean);

  const action = 'whitespace-nowrap rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100';

  return createPortal(
    <div
      role="dialog"
      aria-label={`${label} details`}
      data-testid={`hover-card-${worktree.path}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={(e) => e.stopPropagation()}
      // z-30 keeps the card above the board and the sidebar it floats out of,
      // and below every dialog: a hover affordance must never cover a
      // confirm the user is trying to read.
      className="surface-pop fixed z-30 flex flex-col gap-2.5 rounded-xl p-3 text-left"
      style={{ left: x, top: y, width: HOVER_CARD_WIDTH }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100" title={name}>{name}</span>
          {status && <span className="shrink-0 text-[11px] text-zinc-500">{status}</span>}
        </div>
        {meta.length > 0 && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500">
            {meta.flatMap((m, i) => (i ? [<span key={`dot${i}`} aria-hidden className="text-zinc-700">·</span>, m] : [m]))}
          </div>
        )}
      </div>

      {mr && pr && (
        <button
          type="button"
          data-testid="hover-card-pr"
          aria-label={`Open ${pr.kind} ${mr.number}, ${mr.state}${pipeline ? `, ${pipeline.label.toLowerCase()}` : ''}`}
          onClick={onOpenMr}
          className="-mx-1.5 rounded-md px-1.5 py-1 text-left hover:bg-zinc-800"
        >
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="shrink-0" style={{ color: MR_STATE_COLOR[mr.state] }}>
              <PrStateIcon state={mr.state} />
            </span>
            <span className="font-mono text-zinc-400">{pr.prefix}{mr.number}</span>
            <span style={{ color: MR_STATE_COLOR[mr.state] }}>
              {mr.state.charAt(0).toUpperCase() + mr.state.slice(1)}
            </span>
            {pipeline && (
              <span className={`ml-auto shrink-0 ${pipeline.cls}`}>{pipeline.glyph} {pipeline.label}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[13px] text-zinc-200">{mr.title}</div>
          <div className="truncate font-mono text-[11px] text-zinc-500">
            {mr.sourceBranch}{mr.targetBranch ? ` → ${mr.targetBranch}` : ''}
          </div>
        </button>
      )}

      {sessions.length === 0 ? (
        <div className="text-[11px] text-zinc-500">No open sessions</div>
      ) : (
        <div className="-mx-1.5 max-h-52 space-y-px overflow-y-auto">
          {sessions.map((chip) => {
            const state = chipStatus(chip);
            const live = state === 'working' || state === 'waiting';
            return (
              <button
                type="button"
                key={`${chip.mode}:${chip.sessionId}`}
                onClick={() => onOpenSession(chip.mode, chip.sessionId)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${SESSION_COLOR[chip.mode]}`}>
                  <SessionAvatarIcon chip={chip} />
                </span>
                <span className="min-w-0 flex-1 truncate">{displayLabel(chip)}</span>
                {live && (
                  <span
                    data-testid="session-live-dot"
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      state === 'working' ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                )}
                {state && <span className={`shrink-0 text-[11px] ${STATUS_TEXT[state]}`}>{state}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* The actions, one quiet row. */}
      <div data-testid="hover-card-footer" className="-mx-1 flex items-center gap-1 border-t border-zinc-800 pt-2">
        {onOpenDiff && <button type="button" className={action} onClick={onOpenDiff}>Changes</button>}
        {onOpenShell && <button type="button" className={action} onClick={onOpenShell}>New shell</button>}
        <span className="flex-1" />
        {onOpenSettings && <button type="button" className={action} onClick={onOpenSettings}>Settings</button>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Hover intent for the row → card handoff: a delay before opening (so a cursor
 * crossing the list doesn't strobe cards) and a grace period before closing
 * (so the cursor can travel from the row into the card without losing it).
 */
export function useHoverCard({ openDelay = 250, closeDelay = 120 }: { openDelay?: number; closeDelay?: number } = {}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);

  const enter = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(true), openDelay);
  }, [openDelay]);
  const leave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(false), closeDelay);
  }, [closeDelay]);
  const close = useCallback(() => { clear(); setOpen(false); }, []);
  const hold = useCallback(() => { clear(); setOpen(true); }, []);
  // Keyboard users get the card the moment focus lands — a delay they can't
  // "hover through" would just feel broken. Focus leaving only starts the same
  // grace timer a cursor leaving does, so focus travelling on into the card
  // (or back onto the row) cancels it via onFocus.

  return {
    open,
    close,
    triggerProps: { onPointerEnter: enter, onPointerLeave: leave, onFocus: hold, onBlur: leave },
    cardProps: { onPointerEnter: hold, onPointerLeave: leave, onFocus: hold, onBlur: leave },
  };
}
