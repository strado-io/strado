// The sidebar's open/close control, and the room the macOS traffic lights
// need. The desktop shell hides the native title bar on macOS (hiddenInset),
// so the lights float over the top-left of the app: whatever sits there —
// the sidebar's top row, or a page toolbar when the sidebar is closed — pads
// past them and lets that strip drag the window.

/** True in the macOS desktop shell, where the traffic lights sit inside the app. */
export const insetTitleBar = (): boolean => typeof window !== 'undefined' && !!window.strado?.insetTitleBar;

/** Room for the three traffic lights (shell places them at x=16). */
const LIGHTS_WIDTH = 72;

// Electron-only CSS: a strip that moves the window, and the controls inside it
// that must stay clickable.
export const DRAG = '[-webkit-app-region:drag]';
export const NO_DRAG = '[-webkit-app-region:no-drag]';

/** Lucide "panel-left". */
function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

export function SidebarToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const label = open ? 'Collapse sidebar' : 'Open sidebar';
  return (
    <button type="button" aria-label={label} title={`${label} (⌘B)`} onClick={onClick}
      className={`${NO_DRAG} flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200`}>
      <PanelIcon />
    </button>
  );
}

/** A blank, draggable slot under the traffic lights; nothing outside the macOS shell. */
export function TrafficLightsSpacer() {
  if (!insetTitleBar()) return null;
  return <span aria-hidden className={`${DRAG} -my-2 shrink-0 self-stretch`} style={{ width: LIGHTS_WIDTH }} />;
}

/** For a page toolbar while the sidebar is closed: clear the lights, then the open button. */
export function OpenSidebarButton({ onClick }: { onClick: () => void }) {
  return (
    <>
      <TrafficLightsSpacer />
      <SidebarToggleButton open={false} onClick={onClick} />
    </>
  );
}
