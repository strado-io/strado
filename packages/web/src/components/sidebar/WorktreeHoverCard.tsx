import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MergeRequest, Worktree } from '../../types';
import { chipStatus, displayLabel, type SessionChip } from '../../hooks/sessions';
import { WORKFLOW_STATUSES } from '../WorkflowStatusSelect';
import { SESSION_COLOR, SessionAvatarIcon } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { worktreeLabel, worktreeTitle } from './labels';
import { BranchIcon } from './rowBits';

const icon = { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
// Lucide "laptop", "file-diff", "square-terminal", "settings".
const LaptopIcon = () => <svg {...icon}><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" /><path d="M20.054 15.987H3.946" /></svg>;
const DiffIcon = () => <svg {...icon}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M9 10h6" /><path d="M12 13V7" /><path d="M9 17h6" /></svg>;
const ShellIcon = () => <svg {...icon}><path d="m7 11 2-2-2-2" /><path d="M11 13h4" /><rect width="18" height="18" x="3" y="3" rx="2" /></svg>;
const GearIcon = () => <svg {...icon}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>;

/** One line of the card: a 16px icon slot, then the text (the reference look: Claude's session card). */
function Line({ glyph, children, className = 'text-zinc-300', testId }: { glyph: React.ReactNode; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <div data-testid={testId} className={`flex min-h-5 min-w-0 items-center gap-2.5 text-[12px] leading-5 ${className}`}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500">{glyph}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">{children}</span>
    </div>
  );
}

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

  // The card's name once: the human title when there is one, else the label;
  // every line below says something the lines above didn't.
  const label = worktreeLabel(worktree);
  const name = title || label;
  const shown = new Set([name.toLowerCase()]);
  const fresh = (v: string | null | undefined) => {
    if (!v || shown.has(v.toLowerCase())) return null;
    shown.add(v.toLowerCase());
    return v;
  };
  const sub = fresh(label);
  const branch = fresh(worktree.branch);

  const iconButton = 'flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100';

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
      className="surface-pop fixed z-30 flex flex-col gap-1.5 rounded-xl px-3 py-2 text-left"
      style={{ left: x, top: y, width: HOVER_CARD_WIDTH }}
    >
      {/* Title, then the quick actions as quiet icons (no footer row). */}
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100" title={name}>{name}</span>
        {status && <span className="mr-1 shrink-0 text-[11px] text-zinc-500">{status}</span>}
        {onOpenDiff && <button type="button" aria-label="Changes" title="Changes" className={iconButton} onClick={onOpenDiff}><DiffIcon /></button>}
        {onOpenShell && <button type="button" aria-label="New shell" title="New shell" className={iconButton} onClick={onOpenShell}><ShellIcon /></button>}
        {onOpenSettings && <button type="button" aria-label="Settings" title="Settings" className={iconButton} onClick={onOpenSettings}><GearIcon /></button>}
      </div>

      <div className="flex flex-col gap-0.5">
        {sub && <Line glyph={<span className="text-[11px] font-semibold">#</span>}>{sub}</Line>}
        <Line glyph={<LaptopIcon />}>{runnerName ?? 'This Mac'}</Line>
        {branch && <Line glyph={<BranchIcon />} className="text-zinc-400"><span className="truncate font-mono text-[11px]" title={branch}>{branch}</span></Line>}
        {dirty && (
          <Line glyph={<DiffIcon />} testId="hover-card-diff" className="text-zinc-400">
            <span className="font-mono text-[11px]">
              {diff!.files} file{diff!.files === 1 ? '' : 's'}
              <span className="ml-1.5 text-emerald-500/80">+{diff!.additions}</span>
              <span className="ml-1 text-red-400/80">-{diff!.deletions}</span>
            </span>
          </Line>
        )}
        {running && (
          <Line glyph={<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />} testId="hover-card-running" className="text-emerald-400">
            <span className="font-mono text-[11px]">running{process?.port ? ` :${process.port}` : ''}</span>
          </Line>
        )}
        {mr && pr && (
          <button
            type="button"
            data-testid="hover-card-pr"
            aria-label={`Open ${pr.kind} ${mr.number}, ${mr.state}${pipeline ? `, ${pipeline.label.toLowerCase()}` : ''}`}
            onClick={onOpenMr}
            className="-mx-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-zinc-800"
          >
            <Line glyph={<span style={{ color: MR_STATE_COLOR[mr.state] }}><PrStateIcon state={mr.state} /></span>}>
              <span className="font-mono text-zinc-400">{pr.prefix}{mr.number}</span>
              <span className="truncate text-zinc-200">{mr.title}</span>
            </Line>
            <div className="ml-[26px] flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span style={{ color: MR_STATE_COLOR[mr.state] }}>{mr.state.charAt(0).toUpperCase() + mr.state.slice(1)}</span>
              {pipeline && <span className={pipeline.cls}>{pipeline.glyph} {pipeline.label}</span>}
              <span className="min-w-0 truncate font-mono">{mr.sourceBranch}{mr.targetBranch ? ` → ${mr.targetBranch}` : ''}</span>
            </div>
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="border-t border-zinc-800 pt-1.5 text-[11px] text-zinc-500">No open sessions</div>
      ) : (
        <div className="-mx-1.5 max-h-52 overflow-y-auto border-t border-zinc-800 pt-1">
          {sessions.map((chip) => {
            const state = chipStatus(chip);
            const live = state === 'working' || state === 'waiting';
            return (
              <button
                type="button"
                key={`${chip.mode}:${chip.sessionId}`}
                onClick={() => onOpenSession(chip.mode, chip.sessionId)}
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-0.5 text-left text-[12px] leading-5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
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
