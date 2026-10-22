import { useEffect, useRef, type ReactNode } from 'react';

/** Mission Control's column, top to bottom: approvals waiting for you, then
 * the agent strip. In flow (never floating), so none
 * of them can land on another; the box sits right below. It never hides: the
 * bar's popover opens above it instead (`onHeight` tells the bar how far). */
export function MissionStack({ approvals, strip, onHeight }: {
  approvals: ReactNode; strip: ReactNode;
  onHeight?: (px: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h !== undefined) onHeightRef.current?.(Math.ceil(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} data-testid="mission-stack" className="flex min-w-0 flex-col gap-1">
      {approvals}
      {strip}
    </div>
  );
}
