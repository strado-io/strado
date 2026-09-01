/**
 * The Usage page's waiting state, in the same shape the code-reviews page uses:
 * one pulsing subject icon over its label, centred in the pane. A cold read
 * walks months of session logs, so this is on screen long enough to be worth
 * being calm rather than busy.
 */
export function UsageLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label.replace(/…$/, '')}
      className="flex h-full min-h-[20rem] flex-col items-center justify-center gap-4 py-16"
    >
      <span className="animate-pulse text-zinc-400" aria-hidden>
        {/* The gauge from the sidebar's Usage entry, at page scale. */}
        <svg width="36" height="36" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M2.2 11.5a6.5 6.5 0 1 1 11.6 0" />
          <path d="M8 8.5 11 5.8" />
        </svg>
      </span>
      <span className="text-sm text-zinc-500">{label}</span>
    </div>
  );
}
