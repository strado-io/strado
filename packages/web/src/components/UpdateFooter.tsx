import type { UpdateInfo, UpdatePhase } from '../hooks/useUpdate';

export type UpdateFooterProps = {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number;
  error: string | null;
  mode: 'swap' | 'link';
  onUpdate: () => void;
  onInstall: () => void;
  onDismiss: () => void;
};

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  strokeLinecap: 'round', strokeLinejoin: 'round',
} as const;

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0 animate-spin text-zinc-400" {...stroke}>
      <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" />
    </svg>
  );
}

// Compact update control that lives in the sidebar footer (above Feedback)
// rather than the old full-width top banner. Deliberately does NOT show the
// release notes/changelog — just the action + progress, to stay unobtrusive.
export function UpdateFooter({
  phase, info, progress, error, mode, onUpdate, onInstall, onDismiss,
}: UpdateFooterProps) {
  if (phase === 'idle' || !info?.updateAvailable) return null;

  const row = 'group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm';

  if (phase === 'downloading') {
    return (
      <div className={`${row} text-zinc-400`} role="status" aria-live="polite">
        <Spinner />
        <span className="min-w-0 flex-1 truncate">Downloading… {progress}%</span>
      </div>
    );
  }

  if (phase === 'ready') {
    return (
      <button onClick={onInstall} aria-label="Restart to update"
        className={`${row} w-full text-emerald-300 hover:bg-emerald-950/40`}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden className="shrink-0" {...stroke}>
          <path d="M8 1.5v9M4.5 7l3.5 3.5L11.5 7M3 13.5h10" />
        </svg>
        <span className="min-w-0 flex-1 truncate">Restart to update</span>
      </button>
    );
  }

  if (phase === 'error') {
    return (
      <button onClick={onUpdate} title={error ?? "Couldn't update"} aria-label="Retry update"
        className={`${row} w-full text-red-300 hover:bg-red-950/40`}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden className="shrink-0" {...stroke}>
          <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" />
        </svg>
        <span className="min-w-0 flex-1 truncate">Update failed — retry</span>
      </button>
    );
  }

  // available
  return (
    <div className="flex items-center gap-1">
      <button onClick={onUpdate} aria-label={mode === 'link' ? `Download ${info.version}` : `Update to ${info.version}`}
        className={`${row} min-w-0 flex-1 text-sky-300 hover:bg-sky-950/40`}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden className="shrink-0" {...stroke}>
          <circle cx="8" cy="8" r="6" /><path d="M8 11V5M5.5 7.5L8 5l2.5 2.5" />
        </svg>
        <span className="min-w-0 flex-1 truncate">
          {mode === 'link' ? `Download ${info.version}` : `Update to ${info.version}`}
        </span>
      </button>
      {!info.mandatory && (
        <button onClick={onDismiss} title="Later" aria-label="Dismiss update"
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden {...stroke}><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      )}
    </div>
  );
}
