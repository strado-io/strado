// The Files tab: a light, read-only look at a worktree — its folders on the
// left (loaded as they open), one file on the right. The same for a runner's
// worktree, read through the runner's own API. Instead of VS Code for "what's
// in this file / what changed here"; VS Code stays one click away.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RemoteFilesTarget } from '../../api';
import type { FileAskContext } from '../../types';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';

export type FilesTabProps = {
  wsId: string;
  worktreePath: string;
  remote?: { runnerId: string; remoteWsId: string };
  /** Open this file (and line); a new nonce opens it again. */
  openPath?: { path: string; line?: number; nonce: number };
  onAskAgent?: (ctx: FileAskContext) => void;
  onOpenInVsCode?: (path: string, line: number) => void;
};

export function FilesTab({ wsId, worktreePath, remote, openPath, onAskAgent, onOpenInVsCode }: FilesTabProps) {
  const [changedOnly, setChangedOnly] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [selected, setSelected] = useState<string | null>(openPath?.path ?? null);
  const [target, setTarget] = useState<{ line?: number; nonce: number }>({ line: openPath?.line, nonce: openPath?.nonce ?? 0 });
  // Refresh: agents change files all the time; re-list the open folders and re-read the open file.
  const [reloadKey, setReloadKey] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  // No polling: re-check when the person comes back — the tab shown again (it
  // was hidden in the hub), the window refocused, or the app visible again.
  // At most once every 2s, so a burst of those is one reload.
  useEffect(() => {
    let last = Date.now();
    let shown = true;
    const refresh = () => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      setReloadKey((k) => k + 1);
    };
    const onVisible = () => { if (document.visibilityState === 'visible' && shown) refresh(); };
    const onFocus = () => { if (shown) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    let io: IntersectionObserver | null = null;
    if (root.current && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        const now = entries.some((e) => e.isIntersecting);
        if (now && !shown) refresh();
        shown = now;
      });
      io.observe(root.current);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      io?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!openPath) return;
    setSelected(openPath.path);
    setTarget({ line: openPath.line, nonce: openPath.nonce });
  }, [openPath?.path, openPath?.line, openPath?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const runnerId = remote?.runnerId;
  const remoteWsId = remote?.remoteWsId;
  const where: RemoteFilesTarget | undefined = runnerId && remoteWsId ? { runnerId, remoteWsId } : undefined;
  // Stable per worktree and toggle, so the tree reloads only when one changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadDir = useCallback((dir: string) => api.files.tree(wsId, worktreePath, dir, { ignored: showIgnored }, where), [wsId, worktreePath, showIgnored, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useCallback((p: string) => api.files.read(wsId, worktreePath, p, where), [wsId, worktreePath, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useCallback((p: string) => api.files.marks(wsId, worktreePath, p, where), [wsId, worktreePath, runnerId, remoteWsId]);

  const toggle = 'flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200';
  return (
    <div ref={root} className="flex h-full min-h-0 gap-2 p-2" data-testid="files-tab">
      <aside className="glass pane-card flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border">
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-zinc-800/80 px-3">
          <label className={toggle}>
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} className="accent-sky-600" />
            Changed only
          </label>
          <label className={toggle}>
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="accent-sky-600" />
            Show ignored
          </label>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh files" title="Refresh"
            className="ml-auto rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">↻</button>
        </div>
        <FileTree load={loadDir} changedOnly={changedOnly} selected={selected} reloadKey={reloadKey}
          reveal={openPath ? { path: openPath.path, nonce: openPath.nonce } : null}
          onSelect={(p) => { setSelected(p); setTarget((t) => ({ line: undefined, nonce: t.nonce })); }} />
      </aside>
      <main className="glass pane-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        {selected ? (
          <FileViewer key={`${worktreePath}\0${selected}`} worktreePath={worktreePath} path={selected} line={target.line} nonce={target.nonce} reloadKey={reloadKey}
            read={read} marks={marks} onAskAgent={onAskAgent} onOpenInVsCode={onOpenInVsCode} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-zinc-500">Pick a file to read it here.</div>
        )}
      </main>
    </div>
  );
}
