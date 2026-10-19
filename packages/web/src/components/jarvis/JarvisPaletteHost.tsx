import { useEffect, useRef, useState, type ComponentProps, type MutableRefObject } from 'react';
import { CommandPalette, type JarvisPaletteProps } from '../CommandPalette';
import { api } from '../../api';
import { useUiHub } from '../../contexts/UiControlContext';
import { useIntercom } from '../../contexts/IntercomContext';
import { parse } from '../../lib/jarvis/parse';
import { jarvisServerPort } from '../../lib/jarvis/serverPort';
import { buildParseContext } from './jarvisContext';
import { buildModelContext, planFromModel } from '../../lib/jarvis/model';
import { askModel } from '../../lib/jarvis/modelClient';
import { openWorktreeAndWait } from '../../lib/jarvis/openWorktree';
import { voiceBridge } from '../../hooks/voice';
import { readWorktreeLru } from '../../lib/worktreeLru';
import { runUndo, type JarvisAppPort, type JarvisNavPort, type UndoOp } from '../../lib/jarvis/execute';
import type { ParseContext, TabRef } from '../../lib/jarvis/types';

/** `notice`: a success that still has news the screen doesn't show (a message queued for a busy agent). */
export type JarvisRun = { ok: boolean; summary: string; undo: UndoOp[]; undoable: boolean; notice?: boolean;
  /** A button beside the summary (an agent's answer: Show brings it up in the box). */
  action?: { label: string; run: () => void } };

/** The ⌘K palette with Jarvis wired to this window: the hub (when one is
 * open) for layout, the human /jarvis routes for resources, the board for
 * navigation. Lives inside UiControlProvider so it can reach the hub. */
export function JarvisPaletteHost({ wsId, nav, app, lastActedOn, onRan, onOpenCommandSettings, ...palette }: ComponentProps<typeof CommandPalette> & {
  wsId: string;
  nav: JarvisNavPort;
  /** Pages, Settings and plain settings (the rest of the app). */
  app?: JarvisAppPort;
  lastActedOn: MutableRefObject<TabRef | null>;
  onRan: (r: JarvisRun) => void;
  /** Settings → Command box (the Anthropic key and "Local only"). */
  onOpenCommandSettings: () => void;
}) {
  // Natural language needs a key and must not be switched off; read both on
  // mount and every time the bar takes focus (the bar outlives a Settings
  // change). Until they arrive the box offers it and the server has the last word.
  const [modelStatus, setModelStatus] = useState<'ready' | 'no_key' | 'local_only'>('ready');
  const aliveRef = useRef(true);
  const readModelStatus = () => {
    // Deferred so a failure of any kind (even a missing client) just leaves the last status.
    const safe = <T,>(fn: () => Promise<T>) => Promise.resolve().then(fn).catch(() => null);
    void Promise.all([safe(() => api.modelCredential.get()), safe(() => api.profile.get())]).then(([cred, profile]) => {
      if (!aliveRef.current || (!cred && !profile)) return;
      setModelStatus(profile?.jarvisLocalOnly ? 'local_only' : cred && !cred.present ? 'no_key' : 'ready');
    });
  };
  useEffect(() => {
    aliveRef.current = true;
    readModelStatus();
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hub = useUiHub();
  const intercom = useIntercom();
  const peersRef = useRef(intercom.peers);
  peersRef.current = intercom.peers;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  // The shown worktree's scripts, refreshed whenever the bar takes focus
  // (package.json may have changed); parsing uses whatever is cached meanwhile.
  const refreshScripts = () => {
    const path = hub()?.path;
    if (path) void jarvisServerPort(wsId).loadScripts(path, { refresh: true }).catch(() => {});
  };
  const onOpen = () => {
    readModelStatus();
    refreshScripts();
    palette.onOpen?.();
  };

  const context = (): ParseContext => {
    const p = paletteRef.current;
    const h = hub();
    return buildParseContext({
      hub: h ? { path: h.path, context: h.jarvis?.context() ?? null } : null,
      peers: peersRef.current,
      lastActedOn: lastActedOn.current,
      worktrees: p.worktrees,
      lru: readWorktreeLru(),
      focuses: p.focuses ?? [],
      activeFocusId: p.activeFocusId ?? null,
      workspaces: p.workspaces,
      repos: p.repos,
      scripts: h ? jarvisServerPort(wsId).cachedScripts(h.path) : null,
      stations: p.stations,
    });
  };

  const jarvis: JarvisPaletteProps = {
    wsId,
    parse,
    context,
    ports: () => ({
      hub: hub()?.jarvis ?? null,
      server: jarvisServerPort(wsId),
      nav,
      ...(app ? { app } : {}),
      ensureWorktree: (path) => openWorktreeAndWait(path, () => { const h = hub(); return h ? { path: h.path, port: h.jarvis ?? null } : null; }, nav.worktree),
      shellIdle: async (ref) => !(await api.worktrees.sessionBusy(wsId, ref.worktreePath, 'shell', ref.sessionId)).busy,
    }),
    onRan,
    onActed: (ref) => { lastActedOn.current = ref; },
    isBusy: async (ref) => (await api.worktrees.sessionBusy(wsId, ref.worktreePath, 'shell', ref.sessionId)).busy,
    model: {
      status: modelStatus,
      ask: (text, thread, ctx, signal) => askModel(wsId, { text, context: buildModelContext(ctx), thread }, signal),
      toPlan: planFromModel,
      onOpenSettings: onOpenCommandSettings,
    },
  };
  // Push-to-talk where the desktop shell offers it (macOS); a browser has no mic.
  return <CommandPalette {...palette} activeWorkspaceId={palette.activeWorkspaceId} jarvis={jarvis} onOpen={onOpen} voice={palette.voice ?? voiceBridge()} />;
}

const TOAST_MS = 8_000;
const isTyping = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);

/** What the box just did. A plain success shows nothing (the result is on
 * screen) but ⌘Z still undoes it for a few seconds; a failure, or a success
 * with news (queued), shows a toast with Undo (button, or ⌘Z when no text field
 * has focus). */
export function JarvisToast({ wsId, run, onDone }: { wsId: string; run: JarvisRun; onDone: () => void }) {
  const hub = useUiHub();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const canUndo = run.undo.length > 0;
  // The layout right after the run (this mounts once it has rendered). If the
  // user rearranged anything since, Undo must not revert their changes.
  const afterRef = useRef<string | null>(null);
  useEffect(() => {
    afterRef.current = JSON.stringify(hub()?.jarvis?.snapshot() ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  const undo = () => {
    const h = hub()?.jarvis ?? null;
    const unchanged = JSON.stringify(h?.snapshot() ?? null) === afterRef.current;
    void runUndo(run.undo, { hub: h, server: jarvisServerPort(wsId) }, { restoreLayout: unchanged });
    doneRef.current();
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    const t = setTimeout(() => doneRef.current(), TOAST_MS);
    const onKey = (e: KeyboardEvent) => {
      if (canUndo && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !isTyping(document.activeElement)) {
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [run, canUndo]);
  if (run.ok && !run.notice) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-[70] flex max-w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 shadow-xl">
      <span className={`line-clamp-2 min-w-0 ${run.ok ? '' : 'text-amber-300'}`}>{run.ok ? run.summary : `Partly done: ${run.summary}`}</span>
      {!run.undoable && canUndo && <span className="text-zinc-500">(commands sent can’t be taken back)</span>}
      {canUndo && (
        <button type="button" onClick={undo} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-100 hover:bg-zinc-800">
          Undo <kbd className="ml-1 text-[10px] text-zinc-500">⌘Z</kbd>
        </button>
      )}
      {run.action && (
        <button type="button" onClick={() => { run.action!.run(); doneRef.current(); }} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-100 hover:bg-zinc-800">
          {run.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => doneRef.current()} className="text-zinc-500 hover:text-zinc-300">✕</button>
    </div>
  );
}
