import { useEffect } from 'react';
import { api } from '../api';

const BEAT_MS = 30_000;

// Focus heartbeat: while a worktree-scoped view (terminal, Files, diff) is
// mounted and the window has focus, beat that worktree's activity clock.
export function useActivityBeacon(path: string | null | undefined) {
  useEffect(() => {
    if (!path) return;
    const beat = () => {
      if (!document.hasFocus()) return;
      api.activity.beat(path).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => clearInterval(timer);
  }, [path]);
}
