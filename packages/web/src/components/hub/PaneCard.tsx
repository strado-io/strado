import type React from 'react';
import { CloseIcon } from './icons';

// One leaf of the pane tree, drawn as its own card: a header (the tab's icon,
// title, branch, quiet actions) over a body. The tab's live surface (xterm,
// iframe, browser view) is not a child: TerminalView's persistent layer
// positions it over the body element, so moving panes never remounts it.
export function PaneCard({
  paneKey, title, icon, subtitle, focused, docked, hostRef, bodyRef, onActivate,
  onSplitRight, onSplitDown, onFullTab, onClose, children,
}: {
  paneKey: string;
  title: string;
  icon: React.ReactNode;
  subtitle?: string | null;
  focused: boolean;
  /** In a split (not the lone full tab): only then is focus drawn. */
  docked: boolean;
  /** The whole card (drop targets measure it). */
  hostRef: (el: HTMLDivElement | null) => void;
  /** The body under the header (the live surface is placed over it). */
  bodyRef: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
  /** Each split gets the button it was asked from (its menu anchors there). */
  onSplitRight?: (anchor: HTMLElement) => void;
  onSplitDown?: (anchor: HTMLElement) => void;
  onFullTab?: () => void;
  onClose?: () => void;
  /** Drawn in the body, for a pane with no live surface (the empty "New pane"). */
  children?: React.ReactNode;
}) {
  return (
    <div
      ref={hostRef}
      data-testid="pane-host"
      data-pane-key={paneKey}
      data-focused={docked && focused ? 'true' : undefined}
      className="glass pane-card group flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div
        data-testid="pane-header"
        onPointerDown={onActivate}
        className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-1.5"
      >
        <span className="flex shrink-0 items-center">{icon}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-200">{title}</span>
        {subtitle && <span className="min-w-0 truncate text-xs text-zinc-500">{subtitle}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {onSplitRight && <PaneButton label={`Split ${title} right`} onClick={onSplitRight}><SplitRightIcon /></PaneButton>}
          {onSplitDown && <PaneButton label={`Split ${title} down`} onClick={onSplitDown}><SplitDownIcon /></PaneButton>}
          {onFullTab && <PaneButton label={`Open ${title} as full tab`} onClick={onFullTab}><MaximizeIcon /></PaneButton>}
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
