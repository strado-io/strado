import { useEffect, useRef } from 'react';

/**
 * Cmd+Opt+Arrow moves between the active focus group's worktrees (Cmd+Arrow
 * is the tab switcher, Cmd+Shift+Arrow the spaces). Same capture/xterm rules
 * as useSpaceShortcut; the desktop shell forwards the chord from embeds as
 * group-next / group-prev. `move` returns whether it moved: when it didn't (no
 * active group), the chord is left to the browser — Chrome uses it for tabs.
 */
export function useFocusShortcut(move: (dir: 1 | -1) => boolean) {
  const latest = useRef(move);
  latest.current = move;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.('.xterm')) {
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      }
      if (!latest.current(e.key === 'ArrowRight' ? 1 : -1)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    const offHotkey = window.strado?.onHotkey?.((combo) => {
      if (combo === 'group-next') latest.current(1);
      else if (combo === 'group-prev') latest.current(-1);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      offHotkey?.();
    };
  }, []);
}
