import { useEffect, useRef } from 'react';
import type { Focus } from '../api';
import { byLastActive } from '../components/sidebar/FocusSwitcher';

// Keyboard for Focuses: ⌘1–⌘9 activate the nth (popover order, by last use),
// ⌘⌥← / ⌘⌥→ step to the previous / next one, wrapping, and ⇧⌘N asks the
// sidebar to open its switcher ready for a new name (NEW_FOCUS_EVENT). Text
// fields keep their keys, except the terminal's hidden textarea; the Browser
// and VS Code embeds swallow the real keys, so the shell forwards the arrow
// and ⇧⌘N chords over IPC (⌘digit stays with the embed: VS Code uses it).
export const NEW_FOCUS_EVENT = 'strado:new-focus';

export function useFocusShortcut({ focuses, activeId, activate, enabled = true }: {
  focuses: Focus[];
  activeId: string | null;
  activate: (id: string) => void;
  enabled?: boolean;
}) {
  // Read through a ref: rebinding per render would drop the shell's hotkey subscription.
  const latest = useRef({ focuses, activeId, activate });
  latest.current = { focuses, activeId, activate };

  useEffect(() => {
    if (!enabled) return;
    const sorted = () => [...latest.current.focuses].sort(byLastActive);
    const nth = (n: number) => { const f = sorted()[n - 1]; if (f) latest.current.activate(f.id); };
    const step = (dir: -1 | 1) => {
      const list = sorted();
      if (list.length === 0) return;
      const i = list.findIndex((f) => f.id === latest.current.activeId);
      const next = i === -1 ? (dir === 1 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
      latest.current.activate(list[next]!.id);
    };
    const newFocus = () => window.dispatchEvent(new Event(NEW_FOCUS_EVENT));

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.('.xterm')) {
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      }
      if (e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        step(e.key === 'ArrowRight' ? 1 : -1);
      } else if (!e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        nth(Number(e.key));
      } else if (!e.altKey && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newFocus();
      }
    };
    // Capture, ahead of xterm's own keydown handler (see spaceShortcut).
    window.addEventListener('keydown', onKeyDown, { capture: true });
    const offHotkey = window.strado?.onHotkey?.((combo) => {
      if (combo === 'focus-next') step(1);
      else if (combo === 'focus-prev') step(-1);
      else if (combo === 'new-focus') newFocus();
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      offHotkey?.();
    };
  }, [enabled]);
}
