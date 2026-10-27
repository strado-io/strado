// The sidebar's open/close control, and the room the macOS traffic lights
// need. The desktop shell hides the native title bar on macOS (hiddenInset),
// so the lights float over the top-left of the app: whatever sits there —
// the sidebar's top row, or a page toolbar when the sidebar is closed — pads
// past them and lets that strip drag the window.
import { useEffect, useState } from 'react';

/**
 * True while the macOS traffic lights sit inside the app: the desktop shell on
 * macOS, except in full screen, where macOS hides them (and the room for them
 * would be a blank gap).
 */
export function useInsetTitleBar(): boolean {
  const bridge = typeof window !== 'undefined' ? window.strado : undefined;
  const [fullScreen, setFullScreen] = useState(() => bridge?.isFullScreen?.() ?? false);
  useEffect(() => bridge?.onFullScreen?.(setFullScreen), [bridge]);
  return !!bridge?.insetTitleBar && !fullScreen;
}

/** Room for the three traffic lights (shell places them at x=16). */
const LIGHTS_WIDTH = 72;
/**
 * Height of the row the lights sit in; centred on them. Keep in step with
 * trafficLightPosition in the desktop shell's main.cjs (y=16, measured to sit
 * the lights on this row's centre line).
 */
export const TITLE_BAR_HEIGHT = 46;

// Electron-only CSS: a strip that moves the window, and the controls inside it
// that must stay clickable.
export const DRAG = '[-webkit-app-region:drag]';
export const NO_DRAG = '[-webkit-app-region:no-drag]';

/** Lucide "panel-left". */
function PanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}
// Lucide "panel-left-close": the same panel, with an arrow pointing it shut.
function PanelCloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  );
}

/** Open sidebar: « to fold it away. Closed: the panel icon to bring it back. */
export function SidebarToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const label = open ? 'Collapse sidebar' : 'Open sidebar';
  return (
    <button type="button" aria-label={label} title={`${label} (⌘B)`} onClick={onClick}
      className={`${NO_DRAG} flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200`}>
      {open ? <PanelCloseIcon /> : <PanelIcon />}
    </button>
  );
}

/** A blank, draggable slot under the traffic lights; nothing outside the macOS shell. */
export function TrafficLightsSpacer() {
  if (!useInsetTitleBar()) return null;
  return <span aria-hidden className={`${DRAG} shrink-0 self-stretch`} style={{ width: LIGHTS_WIDTH }} />;
}

/**
 * For a page toolbar: while the sidebar is closed, clear the lights, then the
 * open button. Always the toolbar's first item, in a row with gap-2. The room
 * it takes opens and shuts on the sidebar's own slide (.open-sidebar-slot in
 * index.css), so what follows it moves with the sidebar's edge instead of
 * jumping the whole width at once; shutting, its contents stay drawn until
 * the room is gone.
 */
export function OpenSidebarButton({ shown, onClick }: { shown: boolean; onClick: () => void }) {
  const [wasShown, setWasShown] = useState(shown);
  const [leaving, setLeaving] = useState(false);
  if (wasShown !== shown) {
    setWasShown(shown);
    setLeaving(!shown && motionAllowed());
  }
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(false), SLOT_SHUT_MS + 40);
    return () => clearTimeout(t);
  }, [leaving]);
  return (
    <span data-testid="open-sidebar-slot" data-shown={shown || undefined} className="open-sidebar-slot">
      {/* The padding sits inside the clip, so the room shuts all the way to 0. */}
      <span className="min-w-0 overflow-hidden">
        <span className="flex items-center gap-2 pr-2">
          {(shown || leaving) && (
            <>
              <TrafficLightsSpacer />
              <SidebarToggleButton open={false} onClick={onClick} />
            </>
          )}
        </span>
      </span>
    </span>
  );
}
// The sidebar's slide in (.sidebar-slide), which is when this slot shuts.
const SLOT_SHUT_MS = 260;
const motionAllowed = () => {
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
