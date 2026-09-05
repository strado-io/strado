import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MergeRequest, Worktree } from '../../types';
import type { SessionChip } from '../../hooks/sessions';
import { WorktreeHoverCard, useHoverCard, type HoverCardMode } from './WorktreeHoverCard';
import { useRendererOverlay } from '../../contexts/RendererOverlay';

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

/**
 * Lets controls rendered inside a row (its ⋯ menu, say) dismiss the row's hover
 * card. The card is a preview; once a control takes over — a menu, a modal —
 * it has to go, and a modal's backdrop means no pointer event will do it later.
 */
const RowHoverCardContext = createContext<{ close: () => void } | null>(null);

const noop = () => {};

export function useRowHoverCardDismiss(): () => void {
  const ctx = useContext(RowHoverCardContext);
  return ctx?.close ?? noop;
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
  const dismiss = useMemo(() => ({ close: hover.close }), [hover.close]);
  // The card floats over the hub, where a native Browser view would otherwise
  // paint straight over it; the hub parks that view while the card is up.
  useRendererOverlay(hover.open);
  return (
    <div ref={hover.ref} className={className} {...hover.triggerProps}>
      <RowHoverCardContext.Provider value={dismiss}>{children}</RowHoverCardContext.Provider>
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
