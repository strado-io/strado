// Minimal, explicit bridge — the renderer is our own dashboard, but it still
// only gets the specific capabilities it needs, nothing generic.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strado', {
  // Host OS ('darwin' | 'linux' | 'win32'); lets the renderer hide
  // macOS-only affordances (e.g. the in-app self-updater) off darwin.
  platform: process.platform,
  // Self-update capability: 'swap' (full in-app update), 'link' (open the
  // download URL externally — .deb installs), 'none'. Absent on older shells;
  // the renderer falls back to platform sniffing.
  updateMode: ipcRenderer.sendSync('strado:update-mode'),
  // Open a runner's dashboard in its own window (single-use attach URL).
  openRunner: (url) => ipcRenderer.invoke('strado:open-runner', url),

  // action: 'dock' | 'bounds' | 'hide' | 'show' (payload = {x,y,width,height})
  //         | 'undock' | 'window' | 'close'
  devtools: (action, targetId, payload) =>
    ipcRenderer.invoke('strado:devtools', action, targetId, payload),
  // Browser previews live in main-process WebContentsViews (see main.cjs).
  // action: 'open' ({url, bounds}) -> webContents id | 'bounds' | 'hide' |
  //         'navigate' ({url}) | 'reload' | 'close'
  preview: (action, key, payload) =>
    ipcRenderer.invoke('strado:preview', action, key, payload),
  // load/error/navigation state for all previews; returns unsubscribe.
  onPreviewEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('strado:preview-event', handler);
    return () => ipcRenderer.removeListener('strado:preview-event', handler);
  },
  // Live DevTools resize: main tracks the global cursor (the drag crosses the
  // native views, so the renderer can't) and streams back a size fraction.
  devtoolsResizeStart: (targetId, previewKey, side) =>
    ipcRenderer.send('strado:devtools-resize-start', { targetId, previewKey, side }),
  devtoolsResizeStop: () => ipcRenderer.send('strado:devtools-resize-stop'),
  onDevtoolsResize: (cb) => {
    const move = (_e, fraction) => cb({ type: 'move', fraction });
    const end = () => cb({ type: 'end' });
    ipcRenderer.on('strado:devtools-resize-move', move);
    ipcRenderer.on('strado:devtools-resize-end', end);
    return () => {
      ipcRenderer.removeListener('strado:devtools-resize-move', move);
      ipcRenderer.removeListener('strado:devtools-resize-end', end);
    };
  },
  // Trackpad two-finger gesture phase ('begin' | 'end'), from Chromium's
  // gesture stream. 'end' fires the moment the fingers lift (before/at momentum
  // start) — the space carousel uses it to commit a swipe exactly on release,
  // and to hold instead of settling while the fingers are still down. On older
  // shells that don't send it, the renderer falls back to a wheel-idle heuristic.
  onScrollTouch: (cb) => {
    const handler = (_e, phase) => cb(phase);
    ipcRenderer.on('strado:scroll-touch', handler);
    return () => ipcRenderer.removeListener('strado:scroll-touch', handler);
  },
  // App shortcuts intercepted inside embedded surfaces (Browser preview,
  // VS Code iframe) and forwarded to the renderer.
  onHotkey: (cb) => {
    const handler = (_e, combo) => cb(combo);
    ipcRenderer.on('strado:hotkey', handler);
    return () => ipcRenderer.removeListener('strado:hotkey', handler);
  },
  // While the VS Code iframe is the active tab, main must intercept the
  // window's own key events (the cross-origin iframe swallows them).
  hotkeyScope: (enabled) => ipcRenderer.send('strado:hotkey-scope', enabled),
  // Register the exact localhost VS Code origin before mounting its iframe.
  // Main then relaxes only that origin's frame-blocking response headers.
  vscodeOrigin: (url) => ipcRenderer.invoke('strado:vscode-origin', url),
  // Native folder picker for "Add repo"; resolves to the chosen absolute
  // path, or null if the user cancels.
  pickDirectory: () => ipcRenderer.invoke('strado:pick-directory'),
  // Self-update: 'download' ({url, sha256}) stages the new build; 'install'
  // swaps it in and relaunches. Progress/stage arrive via onUpdateEvent.
  update: (action, payload) => ipcRenderer.invoke('strado:update', action, payload),
  onUpdateEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('strado:update-event', handler);
    return () => ipcRenderer.removeListener('strado:update-event', handler);
  },
});
