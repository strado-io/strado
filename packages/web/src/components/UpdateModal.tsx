import type { UpdateInfo, UpdatePhase } from '../hooks/useUpdate';

// Blocking, non-dismissible — shown only for a mandatory release.
export function UpdateModal({
  phase, info, progress, error, mode, onUpdate, onInstall,
}: {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number;
  error: string | null;
  mode: 'swap' | 'link';
  onUpdate: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="text-base font-medium text-zinc-100">Update required</div>
        <div className="text-sm text-zinc-400">
          Version {info?.version} is required to keep using Strado.{info?.notes ? ` ${info.notes}` : ''}
        </div>
        {mode === 'link' && (
          <div className="text-sm text-zinc-500">
            After downloading, install it manually (e.g. <code>sudo dpkg -i</code> for .deb), then reopen Strado.
          </div>
        )}
        {phase === 'downloading' && <div className="text-sm text-zinc-400">Downloading… {progress}%</div>}
        {phase === 'error' && <div className="text-sm text-red-400">{error ?? "Couldn't update"}</div>}
        <div className="flex justify-end">
          {phase === 'ready' ? (
            <button onClick={onInstall} className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600">Restart to update</button>
          ) : (
            <button
              onClick={onUpdate}
              disabled={phase === 'downloading'}
              className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40"
            >
              {phase === 'downloading' ? 'Downloading…' : phase === 'error' ? 'Retry' : mode === 'link' ? 'Download update' : 'Update now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
