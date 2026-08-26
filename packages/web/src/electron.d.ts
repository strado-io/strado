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
  | { key: string; type: 'favicon'; favicon: string | null };

interface Window {
  strado?: {
    // host OS; absent on older shells and in a plain browser
    platform?: NodeJS.Platform;
    // self-update capability; absent on older shells (fall back to platform)
    updateMode?: 'swap' | 'link' | 'none';
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
      cb: (combo: 'tab-next' | 'tab-prev' | 'group-next' | 'group-prev' | 'space-next' | 'space-prev' | 'palette' | 'settings' | 'meta-up' | 'devtools' | 'close-tab' | 'new-shell') => void,
    ) => () => void;
    // true while the VS Code iframe is the active tab (shell then intercepts
    // the window's own Cmd+Arrow keys)
    hotkeyScope?: (enabled: boolean) => void;
    // native folder picker for "Add repo" — absent on older shells;
    // resolves to the chosen absolute path or null if cancelled
    pickDirectory?: () => Promise<string | null>;
    // self-update download/install — absent on older shells
    update?: (action: 'download' | 'install', payload?: { url: string; sha256: string }) => Promise<{ ok: boolean }>;
    onUpdateEvent?: (
      cb: (e: { type: 'progress'; pct: number } | { type: 'ready'; version: string } | { type: 'error'; message: string }) => void,
    ) => () => void;
  };
}
