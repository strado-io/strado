import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribeLogs } from '../eventStream';
import type { Worktree } from '../types';
import { useWorkspace } from '../hooks/useWorkspace';
import { useResizableHeight } from '../hooks/resizableHeight';

export function LogPanel({ worktree, onClose }: { worktree: Worktree; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  // Drag the top edge to resize; persisted so the height survives restarts.
  // 288 = the old fixed h-72.
  const { height, resizing, handleProps } = useResizableHeight({
    storageKey: 'strado.logsHeight', min: 140, max: 800, fallback: 288, edge: 'top',
  });

  useEffect(() => {
    let alive = true;
    api.worktrees.logs(wsId, worktree.path, 500).then((r) => {
      if (alive) setLines(r.lines);
    });
    const unsub = subscribeLogs(worktree.path, (evt) => {
      setLines((prev) => {
        const next = [...prev, evt.line];
        if (next.length > 5000) next.shift();
        return next;
      });
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [worktree.path]);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);

  return (
    <div
      className="fixed bottom-0 left-0 right-0 border-t border-zinc-800 bg-zinc-950"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize logs"
        className={`absolute inset-x-0 -top-0.5 z-20 h-1.5 cursor-row-resize ${resizing ? 'bg-sky-500/50' : 'hover:bg-sky-500/30'}`}
        {...handleProps}
      />
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm">
        <div>
          Logs: <span className="font-mono text-zinc-200">{worktree.meta?.ticketId ?? worktree.path.split('/').pop()}</span>
          {worktree.process.detectedUrl && (
            <a className="ml-3 text-sky-400 underline" href={worktree.process.detectedUrl} target="_blank" rel="noreferrer">
              {worktree.process.detectedUrl}
            </a>
          )}
        </div>
        <button className="rounded bg-zinc-800 px-3 py-1" onClick={onClose}>Close</button>
      </div>
      <div ref={ref} className="h-[calc(100%-2.5rem)] overflow-auto px-4 py-2 font-mono text-xs text-zinc-200">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">{l}</div>
        ))}
      </div>
    </div>
  );
}
