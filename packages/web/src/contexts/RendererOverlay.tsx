import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react';

/**
 * Renderer overlays that float over the hub — the sidebar's worktree hover
 * card, say — sit UNDER any native WebContentsView (Browser preview, DevTools),
 * which paints above the whole DOM. Whoever owns those views has to be told
 * while such an overlay is up so it can park them; this is that channel.
 *
 * Owners mount a registry and fold `anyOpen` into their native-view suppression;
 * overlays call `useRendererOverlay(open)` from anywhere below the provider.
 */
type Report = (id: string, open: boolean) => void;

export const RendererOverlayContext = createContext<Report | null>(null);

export function useRendererOverlayRegistry(): { anyOpen: boolean; report: Report } {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>((id, isOpen) => {
    setOpen((current) => {
      if (current.has(id) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  return useMemo(() => ({ anyOpen: open.size > 0, report }), [open, report]);
}

/** Reports this overlay's visibility to the nearest registry; a no-op without one. */
export function useRendererOverlay(open: boolean): void {
  const report = useContext(RendererOverlayContext);
  const id = useId();
  useEffect(() => {
    if (!report) return;
    report(id, open);
    return () => { if (open) report(id, false); };
  }, [report, id, open]);
}
