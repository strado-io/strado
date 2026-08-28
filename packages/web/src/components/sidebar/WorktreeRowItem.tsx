import { useEffect, useRef, useState } from 'react';
import type { MergeRequest, Worktree } from '../../types';
import type { SessionChip } from '../../hooks/sessions';
import { WorktreeHoverCard, useHoverCard, type HoverCardMode } from './WorktreeHoverCard';

export type OpenWorktree = (w: Worktree, mode?: HoverCardMode, sessionId?: string) => void;

type Rects = { anchor: DOMRect; sidebarLeft?: number; sidebarRight?: number };

/**
 * One hover surface per row. The row's own icons (PR state, session avatars)
 * stay glanceable; everything readable — PR detail, the session list, changes,
 * run state — lives in a single card that opens on row hover and can be walked
 * into with the cursor.
 */
export function useRowHoverCard() {
  const hover = useHoverCard();
  const ref = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<Rects | null>(null);

  useEffect(() => {
    if (!hover.open || !ref.current) { setRects(null); return; }
    const sidebar = ref.current.closest('aside')?.getBoundingClientRect();
    setRects({
      anchor: ref.current.getBoundingClientRect(),
      sidebarLeft: sidebar?.left,
      sidebarRight: sidebar?.right,
    });
  }, [hover.open]);

  return { ...hover, ref, rects };
}

export type WorktreeRowItemProps = {
  worktree: Worktree;
  chips: SessionChip[];
  mr: MergeRequest | null | undefined;
  onOpen: OpenWorktree;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  onOpenDiff?: (w: Worktree) => void;
  onSettings?: (w: Worktree) => void;
  /** The row markup itself — rendered inside the hover-tracked container. */
  children: React.ReactNode;
  className: string;
  runnerName?: string;
};

export function WorktreeRowItem({
  worktree, chips, mr, onOpen, onOpenMr, onOpenDiff, onSettings, children, className, runnerName,
}: WorktreeRowItemProps) {
  const hover = useRowHoverCard();
  return (
    <div ref={hover.ref} className={className} {...hover.triggerProps}>
      {children}
      {hover.open && hover.rects && (
        <WorktreeHoverCard
          worktree={worktree}
          chips={chips}
          mr={mr ?? null}
          anchor={hover.rects.anchor}
          sidebarLeft={hover.rects.sidebarLeft}
          sidebarRight={hover.rects.sidebarRight}
          runnerName={runnerName}
          onOpenSession={(mode, sessionId) => { hover.close(); onOpen(worktree, mode, sessionId); }}
          onOpenMr={mr && onOpenMr ? () => { hover.close(); onOpenMr(worktree, mr); } : undefined}
          onOpenDiff={onOpenDiff ? () => { hover.close(); onOpenDiff(worktree); } : undefined}
          onOpenShell={() => { hover.close(); onOpen(worktree, 'shell', undefined); }}
          onOpenSettings={onSettings ? () => { hover.close(); onSettings!(worktree); } : undefined}
          onClose={hover.close}
          {...hover.cardProps}
        />
      )}
    </div>
  );
}
