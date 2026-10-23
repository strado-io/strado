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

  // A small card in the tab bar's look; the phase is a coloured accent dot, the text stays quiet.
  const card = 'tab-bar flex items-center gap-1 rounded-[10px] p-[3px]';
  const row = 'group flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors';
  const accent = (color: string) => <span aria-hidden data-testid="update-accent" className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;

  if (phase === 'downloading') {
    return (
      <div data-testid="update-card" className={card}>
        <div className={`${row} min-w-0 flex-1 text-zinc-400`} role="status" aria-live="polite">
          <Spinner />
          <span className="min-w-0 flex-1 truncate">Downloading… {progress}%</span>
        </div>
      </div>
    );
  }

  if (phase === 'ready') {
    return (
      <div data-testid="update-card" className={card}>
        <button onClick={onInstall} aria-label="Restart to update"
          className={`${row} w-full text-zinc-200 hover:bg-white/[0.06]`}>
          {accent('bg-emerald-400')}
          <span className="min-w-0 flex-1 truncate">Restart to update</span>
        </button>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div data-testid="update-card" className={card}>
        <button onClick={onUpdate} title={error ?? "Couldn't update"} aria-label="Retry update"
          className={`${row} w-full text-zinc-300 hover:bg-white/[0.06]`}>
          {accent('bg-red-400')}
          <span className="min-w-0 flex-1 truncate">Update failed — retry</span>
        </button>
      </div>
    );
  }

  // available
  return (
    <div data-testid="update-card" className={card}>
      <button onClick={onUpdate} aria-label={mode === 'link' ? `Download ${info.version}` : `Update to ${info.version}`}
        className={`${row} min-w-0 flex-1 text-zinc-200 hover:bg-white/[0.06]`}>
        {accent('bg-amber-400')}
        <span className="min-w-0 flex-1 truncate">
          {mode === 'link' ? `Download ${info.version}` : `Update to ${info.version}`}
        </span>
      </button>
      {!info.mandatory && (
        <button onClick={onDismiss} title="Later" aria-label="Dismiss update"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden {...stroke}><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      )}
    </div>
  );
}
