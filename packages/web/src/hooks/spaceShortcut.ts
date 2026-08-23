import { useEffect, useRef } from 'react';

/**
 * Cmd/Ctrl+Shift+Arrow moves between spaces. Plain Cmd+Arrow belongs to the
 * tab switcher, so shift is what separates the two.
 *
 * A hook rather than an effect in the sidebar because two places need it: the
 * sidebar, which animates its carousel, and the dashboard, which is all that
 * is left when the sidebar is collapsed — and the shell keeps intercepting the
 * chord inside embeds either way, so without the second one it would be a
 * swallowed no-op.
 */
export function useSpaceShortcut(move: (dir: -1 | 1) => void, enabled = true) {
  // Read through a ref: the handler closes over the current render's state,
  // and rebinding per render would drop the shell's hotkey subscription every
  // time the sidebar re-renders.
  const latest = useRef(move);
  latest.current = move;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = e.target as HTMLElement | null;
      // In a text field this same chord extends the selection — leave it be.
      // A terminal is the exception: xterm takes its keys through a hidden
      // <textarea class="xterm-helper-textarea">, so a tagName check kills the
      // chord in the surface the app is mostly used through.
      if (!el?.closest?.('.xterm')) {
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      }
      e.preventDefault();
      latest.current(e.key === 'ArrowRight' ? 1 : -1);
    };
    // Capture, not bubble: xterm.js binds its own keydown handler on a hidden
    // helper textarea and only lets Meta+Arrow through untouched — Ctrl+Shift
    // +Arrow (the Linux/Windows chord) it turns into an escape sequence and
    // writes to the pty before a bubble-phase listener here would ever run.
    // Capturing puts preventDefault() ahead of that handler on the way down.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    // The same chord pressed inside the Browser or VS Code embeds arrives from
    // the main process instead — the embed's webContents swallows the real key.
    const offHotkey = window.strado?.onHotkey?.((combo) => {
      if (combo === 'space-next') latest.current(1);
      else if (combo === 'space-prev') latest.current(-1);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      offHotkey?.();
    };
  }, [enabled]);
}
