import type React from 'react';
import { CloseIcon } from './icons';

// One leaf of the pane tree, drawn as its own card: a header (the tab's icon,
// title, branch, quiet actions) over a body. The tab's live surface (xterm,
// iframe, browser view) is not a child: TerminalView's persistent layer
// positions it over the body element, so moving panes never remounts it.
export function PaneCard({
  paneKey, title, icon, subtitle, focused, docked, floating = false, hostRef, bodyRef, onActivate, onHeaderPointerDown,
  onSplitRight, onSplitDown, onFullTab, onFloat, onDock, onMinimize, onZoom, zoomed = false, onClose, children,
}: {
  paneKey: string;
  title: string;
  icon: React.ReactNode;
  subtitle?: string | null;
  focused: boolean;
  /** In a split (not the lone full tab): only then is focus drawn. */
  docked: boolean;
  /** Lifted out of the layout into a card over it: a raised look, and the header drags it. */
  floating?: boolean;
  /** The whole card (drop targets measure it). */
  hostRef: (el: HTMLDivElement | null) => void;
  /** The body under the header (the live surface is placed over it). */
  bodyRef: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
  /** A floating pane moves by its header. */
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Each split gets the button it was asked from (its menu anchors there). */
  onSplitRight?: (anchor: HTMLElement) => void;
  onSplitDown?: (anchor: HTMLElement) => void;
  onFullTab?: () => void;
  /** Lift this pane out into a floating card. */
  onFloat?: () => void;
  /** Put a floating pane back as a tab. */
  onDock?: () => void;
  /** Tuck a floating pane away into a pill in the corner. */
  onMinimize?: () => void;
  /** Fill the whole pane area for now (the layout stays as it is); again to go back. */
  onZoom?: () => void;
  zoomed?: boolean;
  onClose?: () => void;
  /** Drawn in the body, for a pane with no live surface (the empty "New pane"). */
  children?: React.ReactNode;
}) {
  return (
    <div
      ref={hostRef}
      data-testid="pane-host"
      data-pane-key={paneKey}
      data-focused={(docked || floating) && focused ? 'true' : undefined}
      data-floating={floating || undefined}
      className={`glass pane-card group flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden ${floating ? 'pane-floating' : ''}`}
    >
      <div
        data-testid="pane-header"
        onPointerDown={(e) => { onActivate(); onHeaderPointerDown?.(e); }}
        className={`flex h-9 shrink-0 items-center gap-2 pl-3 pr-1.5 ${floating ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        {floating ? (
          // A floating pane's name is its dock handle: drag it onto a pane to
          // dock there. The rest of the header just moves the card.
          <span data-dock-handle title={`Drag ${title} onto a pane to dock it`}
            className="group/handle -ml-1.5 flex min-w-0 cursor-grab items-center gap-2 rounded-md py-1 pl-1.5 pr-2 hover:bg-white/[0.06] active:cursor-grabbing">
            {/* On hover the icon turns into a move glyph: this part docks, the rest of the header moves. */}
            <span className="relative flex shrink-0 items-center">
              <span className="flex items-center transition-opacity group-hover/handle:opacity-0">{icon}</span>
              <span data-move-glyph className="absolute inset-0 flex items-center justify-center text-zinc-200 opacity-0 transition-opacity group-hover/handle:opacity-100"><MoveIcon /></span>
            </span>
            <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-200">{title}</span>
          </span>
        ) : (
          <>
            <span className="flex shrink-0 items-center">{icon}</span>
            <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-200">{title}</span>
          </>
        )}
        {subtitle && <span className="min-w-0 truncate text-xs text-zinc-500">{subtitle}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {onZoom && <PaneButton label={zoomed ? `Unzoom ${title}` : `Zoom ${title}`} onClick={onZoom}>{zoomed ? <ZoomOutIcon /> : <ZoomInIcon />}</PaneButton>}
          {onSplitRight && <PaneButton label={`Split ${title} right`} onClick={onSplitRight}><SplitRightIcon /></PaneButton>}
          {onSplitDown && <PaneButton label={`Split ${title} down`} onClick={onSplitDown}><SplitDownIcon /></PaneButton>}
          {onFullTab && <PaneButton label={`Open ${title} as full tab`} onClick={onFullTab}><MaximizeIcon /></PaneButton>}
          {onFloat && <PaneButton label={`Float ${title}`} onClick={onFloat}><FloatIcon /></PaneButton>}
          {onMinimize && <PaneButton label={`Minimize ${title}`} onClick={onMinimize}><MinimizeIcon /></PaneButton>}
          {onDock && <PaneButton label={`Dock ${title}`} onClick={onDock}><DockIcon /></PaneButton>}
          {onClose && <PaneButton label={`Close ${title}`} onClick={onClose}><CloseIcon size={13} /></PaneButton>}
        </span>
      </div>
      <div className="min-h-0 flex-1 px-1 pb-1">
        <div ref={bodyRef} data-testid="pane-body" className="h-full w-full">{children}</div>
      </div>
    </div>
  );
}

function PaneButton({ label, onClick, children }: { label: string; onClick: (el: HTMLElement) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onClick(e.currentTarget)}
      className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

const ICON = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true } as const;
function SplitRightIcon() {
  return <svg {...ICON}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M8 3v10" /></svg>;
}
function SplitDownIcon() {
  return <svg {...ICON}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 8h12" /></svg>;
}
function MaximizeIcon() {
  return <svg {...ICON} strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
}
// Picture-in-picture, on the split icons' frame: a small window in the corner.
function FloatIcon() {
  return <svg {...ICON} strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5" /><rect x="7.5" y="7.5" width="5" height="3.75" rx="0.75" fill="currentColor" stroke="none" /></svg>;
}
// The same frame, the small window drawn back in: an arrow from the corner into the frame.
function DockIcon() {
  return <svg {...ICON} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M11.5 10.5 6.5 5.5M6.5 8.5v-3h3" /></svg>;
}
function MinimizeIcon() {
  return <svg {...ICON} strokeLinecap="round"><path d="M4 11.5h8" /></svg>;
}
function MoveIcon() {
  return <svg {...ICON} strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.75v12.5M1.75 8h12.5M6.25 3.5 8 1.75 9.75 3.5M6.25 12.5 8 14.25l1.75-1.75M3.5 6.25 1.75 8 3.5 9.75M12.5 6.25 14.25 8 12.5 9.75" /></svg>;
}
function ZoomInIcon() {
  return <svg {...ICON} strokeLinecap="round"><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5M5.25 7h3.5M7 5.25v3.5" /></svg>;
}
function ZoomOutIcon() {
  return <svg {...ICON} strokeLinecap="round"><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5M5.25 7h3.5" /></svg>;
}
