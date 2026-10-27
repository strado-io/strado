// "Save changes to X?" — Save / Don't save / Cancel, before closing files with
// unsaved edits (a file tab, a side pane, the Files tab in the hub). Asked from
// anywhere with askSaveChanges(); shown by the nearest SavePromptHost (the
// hub's, else the Files tab's own), inside the overlay registry so a native
// Browser preview steps aside for it.
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRendererOverlay } from '../../contexts/RendererOverlay';

export type SaveChoice = 'save' | 'discard' | 'cancel';
type Pending = { paths: string[]; resolve: (c: SaveChoice) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Ask once; a newer ask cancels an older one still up. */
export function askSaveChanges(paths: string[]): Promise<SaveChoice> {
  pending?.resolve('cancel');
  return new Promise((resolve) => {
    const p: Pending = { paths, resolve: (c) => { if (pending === p) { pending = null; emit(); } resolve(c); } };
    pending = p;
    emit();
  });
}

/** Set by a host above: Files tabs below it show no host of their own. */
export const SavePromptProvided = createContext(false);

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function SavePromptHost() {
  const p = useSyncExternalStore(subscribe, () => pending);
  useRendererOverlay(!!p);
  const save = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (p) save.current?.focus(); }, [p]);
  if (!p) return null;
  const name = (path: string) => path.split('/').pop() || path;
  const one = p.paths.length === 1;
  const btn = 'rounded-md px-3 py-1 text-[13px]';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[18vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) p.resolve('cancel'); }}>
      <div role="alertdialog" aria-modal="true" aria-label="Save changes" aria-describedby="save-changes-body"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.resolve('cancel'); } }}
        className="surface-pop flex w-[min(420px,calc(100vw-32px))] flex-col gap-3 rounded-xl p-4">
        <p className="text-[13px] font-medium text-zinc-100">
          {one ? `Save changes to ${name(p.paths[0]!)}?` : `Save changes to ${p.paths.length} files?`}
        </p>
        <div id="save-changes-body" className="flex flex-col gap-1 text-[11px] text-zinc-400">
          {!one && (
            <ul className="max-h-32 overflow-y-auto font-mono text-zinc-300">
              {p.paths.map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
            </ul>
          )}
          <span>Your changes are lost if you don’t save them.</span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => p.resolve('cancel')} className={`${btn} text-zinc-400 hover:bg-[rgb(var(--pane-edge)/0.06)] hover:text-zinc-100`}>Cancel</button>
          <button type="button" onClick={() => p.resolve('discard')} className={`${btn} text-zinc-300 hover:bg-[rgb(var(--pane-edge)/0.06)] hover:text-zinc-100`}>Don’t save</button>
          <button ref={save} type="button" onClick={() => p.resolve('save')} className={`${btn} bg-sky-600 font-medium text-white hover:bg-sky-500`}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** A Files tab with no host above it shows its own. */
export function useOwnSavePromptHost(): boolean {
  return !useContext(SavePromptProvided);
}

/** Tests: drop a prompt left up. */
export function __resetSavePrompt(): void {
  pending?.resolve('cancel');
}
