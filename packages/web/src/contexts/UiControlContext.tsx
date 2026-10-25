import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { UiCommandAck, UiTabRef } from '../api';
import type { UiCommand } from '../eventStream';
import { applyStoredBrowserOpen, applyStoredPlace, parseUiCommand, type ParsedUiCommand } from '../lib/uiCommands';
import { startUiControl, type UiControlHandle } from '../lib/uiControl';
import type { JarvisHubPort } from '../lib/jarvis/execute';
import type { TabInfo, TabRef } from '../lib/jarvis/types';
import { JARVIS_UI_OP, type JarvisUiActionArgs, type JarvisUiActionResult } from '../types';

/** Runs a Focus Jarvis action in this window (FocusJarvisProvider registers it). */
export type JarvisActionHandler = (args: JarvisUiActionArgs) => Promise<JarvisUiActionResult>;

/** What the mounted hub exposes to app control: the worktree it shows, the
 * PTY panes on screen, and how to apply a command there. */
/** What the hub knows for the Jarvis parser: its strip, the focused tab, and a
 * counter bumped on every layout/focus change (safety binds previews to it). */
export type JarvisHubContext = { tabs: TabInfo[]; focused: TabRef | null };

export type UiHubBridge = {
  path: string;
  /** The human's ⌘K box drives the hub through this (no human_active guard). */
  jarvis?: JarvisHubPort & { context(): JarvisHubContext };
  visible(): UiTabRef[];
  layout(): unknown;
  /** `deadline` (epoch ms) bounds every wait inside, so the ack lands while the server still listens. */
  apply(cmd: ParsedUiCommand, deadline: number): Promise<UiCommandAck>;
};

type Registry = {
  register(bridge: UiHubBridge): () => void; notify(): void; hub(): UiHubBridge | null;
  /** The window's Focus Jarvis action runner; the latest registration wins. */
  setJarvisAction(handler: JarvisActionHandler): () => void;
};
const UiControlContext = createContext<Registry | null>(null);

// One budget per command, from receipt to ack, covering the hub remount on a
// focus switch AND the wait for a just-spawned tab: the server stops
// listening at 3 s, so an ack after that is wasted while the layout changes.
export const UI_COMMAND_BUDGET_MS = 2_500;

/**
 * Registers this window with the server for agent-driven layout commands
 * (`place`, `browser.open`). Commands for the worktree the hub shows go to
 * the hub; `focus:true` switches the window there first; anything else is
 * written to the stored layout so it is in place when the user opens it.
 */
export function UiControlProvider({ wsId, openWorktree, children }: {
  wsId: string;
  /** Show this worktree's hub; false when the window doesn't know it. */
  openWorktree: (path: string) => boolean;
  children: ReactNode;
}) {
  const bridgeRef = useRef<UiHubBridge | null>(null);
  const jarvisRef = useRef<JarvisActionHandler | null>(null);
  const setJarvisAction = useCallback((handler: JarvisActionHandler) => {
    jarvisRef.current = handler;
    return () => { if (jarvisRef.current === handler) jarvisRef.current = null; };
  }, []);
  const waiters = useRef(new Set<() => void>());
  const handleRef = useRef<UiControlHandle | null>(null);
  const openRef = useRef(openWorktree);
  openRef.current = openWorktree;

  const notify = useCallback(() => handleRef.current?.notify(), []);
  const register = useCallback((bridge: UiHubBridge) => {
    bridgeRef.current = bridge;
    for (const wake of waiters.current) wake();
    notify();
    return () => {
      if (bridgeRef.current !== bridge) return;
      bridgeRef.current = null;
      notify();
    };
  }, [notify]);

  const waitForHub = (path: string, deadline: number): Promise<UiHubBridge | null> => new Promise((resolve) => {
    if (bridgeRef.current?.path === path) return resolve(bridgeRef.current);
    const done = (b: UiHubBridge | null) => { clearTimeout(timer); waiters.current.delete(wake); resolve(b); };
    const wake = () => { if (bridgeRef.current?.path === path) done(bridgeRef.current); };
    const timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()));
    waiters.current.add(wake);
  });

  const onCommand = async (raw: UiCommand): Promise<UiCommandAck> => {
    // A Focus Jarvis action does real work under the server's own, longer
    // wait, in the background: it never needs the hub on screen.
    if (raw.op === JARVIS_UI_OP) {
      const run = jarvisRef.current;
      const a = raw.args as Partial<JarvisUiActionArgs>;
      if (!run) return { applied: false, reason: 'no_jarvis' };
      if (typeof a.action !== 'string' || !a.args || typeof a.args !== 'object') return { applied: false, reason: 'bad_args' };
      return { applied: true, result: await run({ action: a.action, args: a.args as Record<string, unknown> }) };
    }
    const deadline = Date.now() + UI_COMMAND_BUDGET_MS;
    const parsed = parseUiCommand(raw);
    if (!parsed.ok) return { applied: false, reason: parsed.reason };
    const cmd = parsed.cmd;
    // Browser tabs are desktop webviews; a plain browser window has none.
    if (cmd.op === 'browser.open' && !window.strado) return { applied: false, reason: 'no_browser' };
    const bridge = bridgeRef.current;
    if (bridge?.path === cmd.worktreePath) return bridge.apply(cmd, deadline);
    const focus = cmd.op === 'place' ? cmd.focus : !!cmd.place?.focus;
    if (focus) {
      if (!openRef.current(cmd.worktreePath)) return { applied: false, reason: 'unknown_worktree' };
      const hub = await waitForHub(cmd.worktreePath, deadline);
      return hub ? hub.apply(cmd, deadline) : { applied: false, reason: 'hub_not_ready' };
    }
    return cmd.op === 'place' ? applyStoredPlace(cmd) : applyStoredBrowserOpen(cmd);
  };
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    const handle = startUiControl({
      wsId,
      getState: () => {
        const b = bridgeRef.current;
        return {
          focused: document.hasFocus() && document.visibilityState === 'visible',
          worktreePath: b?.path ?? null,
          visible: b?.visible() ?? [],
          layout: b?.layout() ?? null,
        };
      },
      onCommand: (cmd) => onCommandRef.current(cmd),
    });
    handleRef.current = handle;
    return () => { handle(); handleRef.current = null; };
  }, [wsId]);

  const value = useRef<Registry>({ register, notify, hub: () => bridgeRef.current, setJarvisAction }).current;
  return <UiControlContext.Provider value={value}>{children}</UiControlContext.Provider>;
}

/** The hub registers itself while mounted (null = nothing to register, e.g. a
 * runner's worktree, which this server can't address). Returns `notify` for
 * reporting a layout/focus change right away. */
export function useUiHubBridge(bridge: UiHubBridge | null): () => void {
  const ctx = useContext(UiControlContext);
  const path = bridge?.path ?? null;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  useEffect(() => {
    if (!ctx || path === null) return;
    // A stable facade so per-render closures in the hub stay current.
    return ctx.register({
      path,
      visible: () => bridgeRef.current?.visible() ?? [],
      layout: () => bridgeRef.current?.layout() ?? null,
      apply: (cmd, deadline) => bridgeRef.current?.apply(cmd, deadline) ?? Promise.resolve({ applied: false, reason: 'hub_gone' }),
      get jarvis() { return bridgeRef.current?.jarvis; },
    });
  }, [ctx, path]);
  return ctx?.notify ?? noop;
}
const noop = () => undefined;

/** Registers this window's Focus Jarvis action runner while mounted (read at call time, so it may change every render). */
export function useJarvisActionHandler(handler: JarvisActionHandler): void {
  const ctx = useContext(UiControlContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => ctx?.setJarvisAction((args) => ref.current(args)), [ctx]);
}

/** The hub currently registered in this window (for the ⌘K box), read at call time. */
export function useUiHub(): () => UiHubBridge | null {
  const ctx = useContext(UiControlContext);
  return ctx?.hub ?? noHub;
}
const noHub = () => null;
