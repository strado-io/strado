// Bridge exposed by the desktop shell's preload (absent in plain browsers).
// Browser previews and docked DevTools both live in main-process
// WebContentsView overlays; the renderer reserves space with placeholder
// divs and streams their bounds.

type StradoBounds = { x: number; y: number; width: number; height: number };

type StradoPreviewEvent =
  | { key: string; type: 'load'; loading: boolean }
  | { key: string; type: 'error'; error: string }
  | { key: string; type: 'url'; url: string; canBack?: boolean; canForward?: boolean }
  | { key: string; type: 'title'; title: string }
  | { key: string; type: 'favicon'; favicon: string | null }
  | { key: string; type: 'focus' };

// Talk to Strado: the native on-device speech helper's events (one session at a time).
type StradoVoiceEvent =
  | { type: 'ready' }
  /** `text`: everything heard so far; `stable`: its committed prefix (ElevenLabs Scribe; Apple sends none). */
  | { type: 'partial'; text: string; stable?: string }
  | { type: 'final'; text: string }
  | { type: 'level'; rms: number }
  | { type: 'error'; code: string; message?: string };

interface Window {
  strado?: {
    // host OS; absent on older shells and in a plain browser
    platform?: NodeJS.Platform;
    // self-update capability; absent on older shells (fall back to platform)
    updateMode?: 'swap' | 'link' | 'none';
    // macOS: no native title bar — the renderer clears the traffic lights and
    // supplies the window drag strip; absent on older shells and elsewhere
    insetTitleBar?: boolean;
    // full screen hides the traffic lights; absent on older shells
    isFullScreen?: () => boolean;
    onFullScreen?: (cb: (on: boolean) => void) => () => void;
    // Opens a self-hosted runner's dashboard in its own window; absent on
    // older shells (the panel falls back to window.open).
    openRunner?: (url: string) => Promise<boolean>;
    devtools: (
      action: 'dock' | 'bounds' | 'hide' | 'show' | 'thumb' | 'undock' | 'window' | 'close',
      targetId: number,
      bounds?: StradoBounds,
    ) => Promise<boolean | string>;
    // absent on older shells — feature-detect before rendering previews
    preview?: (
      action:
        | 'open' | 'bounds' | 'hide' | 'navigate' | 'reload' | 'close'
        | 'back' | 'forward' | 'hard-reload' | 'screenshot' | 'thumb'
        | 'open-external' | 'clear-history' | 'clear-cookies' | 'clear-data',
      key: string,
      payload?: { url?: string; bounds?: StradoBounds } | StradoBounds,
    ) => Promise<number | boolean | string>;
    onPreviewEvent?: (cb: (ev: StradoPreviewEvent) => void) => () => void;
    // live DevTools resize driven from main (cursor crosses the native views);
    // absent on older shells
    devtoolsResizeStart?: (targetId: number, previewKey: string, side: 'bottom' | 'right') => void;
    devtoolsResizeStop?: () => void;
    onDevtoolsResize?: (
      cb: (ev: { type: 'move'; fraction: number } | { type: 'end' }) => void,
    ) => () => void;
    // app shortcuts intercepted inside embeds, forwarded by the shell
    onHotkey?: (
      cb: (combo: 'tab-next' | 'tab-prev' | 'space-next' | 'space-prev' | 'palette' | 'settings' | 'meta-up' | 'devtools' | 'close-tab' | 'new-shell' | 'changes' | 'focus-next' | 'focus-prev' | 'new-focus' | 'files-search') => void,
    ) => () => void;
    // Electron's own process metrics (main/renderer/gpu/utility) for the
    // Settings → Sessions view; absent on older shells and in a browser
    // `preview` = the Browser preview key when that renderer is a preview view
    appMetrics?: () => Promise<Array<{ pid: number; type: string; name?: string; cpu: number; memoryKb: number; preview?: string }>>;
    // native folder picker for "Add repo" — absent on older shells;
    // resolves to the chosen absolute path or null if cancelled
    pickDirectory?: () => Promise<string | null>;
    // While on, a Browser preview taking focus without a click in it hands the
    // keyboard straight back to this page (the command box is holding it);
    // absent on older shells
    // push-to-talk speech (macOS, on device); absent elsewhere — hide the mic
    voice?: {
      available: boolean | (() => boolean | Promise<boolean>);
      start: (contextual: string[]) => Promise<unknown> | void;
      stop: () => Promise<unknown> | void;
      cancel: () => Promise<unknown> | void;
      onEvent: (cb: (e: StradoVoiceEvent) => void) => () => void;
    };
    // self-update download/install — absent on older shells
    update?: (action: 'download' | 'install', payload?: { url: string; sha256: string }) => Promise<{ ok: boolean }>;
    onUpdateEvent?: (
      cb: (e: { type: 'progress'; pct: number } | { type: 'ready'; version: string } | { type: 'error'; message: string }) => void,
    ) => () => void;
  };
}
