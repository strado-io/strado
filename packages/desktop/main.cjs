// Strado desktop shell.
//
// Deliberately thin: the Fastify server (packages/server/dist) runs as a
// plain Node CHILD process, never inside Electron. That keeps node-pty on
// the system Node ABI — no @electron/rebuild, no native-module drift — and
// the same server keeps serving plain browser tabs in parallel.
const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, screen, session, shell, webContents } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { resolveProfile } = require('./profile.cjs');
const { vscodeOrigin, headersForRequest } = require('./vscode-frame-security.cjs');
// Which instance is this? Packaged builds get `stable`; the repo's npm scripts
// set STRADO_PROFILE=dev. See profile.cjs.
const PROFILE = resolveProfile();
const PORT = PROFILE.port;
const URL = `http://127.0.0.1:${PORT}`;
// The Dock, menu bar and window title must say which one you are looking at.
// setName also moves userData and logs (~/Library/.../Strado Dev), which is
// intentional: the two instances should not share Electron state either.
if (PROFILE.name === 'dev') app.setName('Strado Dev');

// Present as plain Chrome. Google (and Okta/MS) refuse OAuth in "embedded
// browsers" by sniffing the UA for the Electron/app tokens
// (403 disallowed_useragent) — previews must be able to run sign-in flows.
{
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  app.userAgentFallback = app.userAgentFallback
    .replace(new RegExp(`\\s${esc(app.getName())}/\\S+`, 'i'), '')
    .replace(/\sElectron\/\S+/, '');
}
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Packaged builds ship the server bundle, web dist, a pinned Node runtime,
// and the cmdwatch binary under Resources/ (see scripts/package-mac.mjs).
const RESOURCES = process.resourcesPath ?? REPO_ROOT;

// The user's real PATH as seen by an interactive login shell (Homebrew, nvm,
// npm global bin, etc.). A Finder-launched app only inherits a bare system
// PATH, so without this the server can't find claude/codex/code. Resolved
// once via the login shell; memoized. macOS/Linux only — Windows GUI apps
// already inherit the user PATH.
let _shellPath;
function userShellPath() {
  if (_shellPath !== undefined) return _shellPath;
  _shellPath = null;
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      // -l -i sources login (.zprofile → path_helper) and interactive (.zshrc)
      // configs; a sentinel isolates $PATH from any rc-file chatter.
      const res = spawnSync(shell, ['-lic', 'printf "__STRADO_PATH__%s__END__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const m = res.stdout && res.stdout.match(/__STRADO_PATH__(.*?)__END__/s);
      if (m && m[1]) _shellPath = m[1];
    } catch {
      // fall back to the inherited PATH
    }
  }
  return _shellPath;
}

// CDP endpoint: agents attach to the Browser-preview pages (strado-preview
// MCP) and share the user's live, signed-in session. The port comes from the
// profile (stable 9222, dev 9322) so two running instances never collide —
// whichever bound first would otherwise win and the other would silently get
// no CDP at all. STRADO_CDP_PORT=0 disables it.
const CDP_PORT = PROFILE.cdpPort;
if (Number.isInteger(CDP_PORT) && CDP_PORT > 0) {
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
}

/** @type {import('node:child_process').ChildProcess | null} */
let serverChild = null;

async function serverAlive() {
  try {
    // /api/health, NOT a data route. Since the license is enforced on every
    // route except a short sign-in allow-list, probing something like
    // /api/workspaces answers 401 for anyone not signed in — and this loop
    // reads that as "the server never started", so the app dies with
    // "server did not come up" instead of showing the sign-in screen. That is
    // every packaged install of a signed-out user, because packaged builds
    // always set STRADO_LICENSE_REQUIRED=1. Liveness must ask a question that
    // does not depend on who is asking.
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// A quarantined app launched in place (from ~/Downloads or a mounted DMG)
// runs "translocated" from a read-only random path, which breaks the
// bundled server's on-disk state. The bundle is notarized, so the fix is
// simply installing it properly — no xattr surgery needed anymore.
function translocationDialog() {
  if (!app.getAppPath().includes('/AppTranslocation/')) return false;
  dialog.showErrorBox(
    'Strado — one-time setup needed',
    'macOS is running Strado from a temporary location.\n\n' +
      'Drag Strado.app into /Applications (replace any existing copy),\n' +
      'then launch it again from there.',
  );
  return true;
}

let serverLogPath = null;
function serverLogTail(lines = 12) {
  try {
    const text = fs.readFileSync(serverLogPath, 'utf8');
    return text.trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no server log written)';
  }
}

async function ensureServer() {
  // A server the user already runs (npm start / node dist) is reused as-is;
  // two instances would race each other on the JSON stores.
  if (await serverAlive()) return 'external';

  // Packaged: the bundled Node runtime runs the bundled server (system Node
  // cannot be assumed on tester machines, and node-pty is prebuilt against
  // this exact runtime). Dev: system node + workspace layout, as always.
  const spawnSpec = app.isPackaged
    ? {
        command: path.join(RESOURCES, 'bin', 'node'),
        args: [path.join(RESOURCES, 'server', 'server.js')],
        cwd: path.join(RESOURCES, 'server'),
        env: {
          // A Finder-launched macOS app inherits a minimal PATH
          // (/usr/bin:/bin:/usr/sbin:/sbin) — missing Homebrew, nvm, and the
          // npm global bin where claude/codex/code live. Resolve the user's
          // real login-shell PATH so everything the server spawns (agent
          // ptys, dev servers, `code serve-web`) can actually find them.
          ...(userShellPath() ? { PATH: userShellPath() } : {}),
          STRADO_WEB_DIST: path.join(RESOURCES, 'web'),
          STRADO_HOOKS_DIR: path.join(RESOURCES, 'server', 'hooks'),
          // config must NOT default to cwd/config — that's inside the bundle;
          // still overridable per-launch for throwaway test homes. The profile
          // leaves configDir null for stable (so a runner keeps cwd/config);
          // a packaged app has no usable cwd, so fall back to <home>/config.
          STRADO_CONFIG_DIR:
            process.env.STRADO_CONFIG_DIR ?? PROFILE.configDir ?? path.join(PROFILE.homeDir, 'config'),
          // invite-code gate is enforced only in shipped builds; the cloud
          // API base can be overridden per-launch (STRADO_LICENSE_API)
          STRADO_LICENSE_REQUIRED: '1',
          // surfaced in feedback diagnostics — server-side only, never from
          // the renderer
          STRADO_APP_VERSION: app.getVersion(),
        },
      }
    : {
        command: process.platform === 'win32' ? 'node.exe' : 'node',
        args: ['packages/server/dist/index.js'],
        cwd: REPO_ROOT,
        env: {},
      };
  // Server output goes to ~/Library/Logs/Strado/server.log — a tester's
  // "did not come up" report is undebuggable without it.
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  serverLogPath = path.join(logDir, 'server.log');
  const logFd = fs.openSync(serverLogPath, 'a');
  fs.writeSync(logFd, `\n--- strado server spawn ${new Date().toISOString()} ---\n`);
  serverChild = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
    env: {
      ...process.env,
      ...spawnSpec.env,
      PORT: String(PORT),
      // The child resolves the same profile rather than inferring one.
      STRADO_PROFILE: PROFILE.name,
      // /api/capabilities reports embeds:true only for a server hosted by this
      // shell — the VS Code embed and preview browser are WebContentsView
      // features. A headless runner leaves it unset and its UI hides those
      // tabs. Applies to dev runs too, or the local app would hide its own.
      STRADO_EMBEDS: '1',
    },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });
  serverChild.on('error', (err) => {
    fs.writeSync(logFd, `[spawn error] ${String(err?.message ?? err)}\n`);
  });
  serverChild.on('exit', (code, signal) => {
    fs.writeSync(logFd, `[server exited] code=${code} signal=${signal}\n`);
    serverChild = null;
    if (code !== 0 && !app.isReady()) return;
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serverAlive()) return 'spawned';
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `server did not come up on :${PORT} within 15s.\n\nLog: ${serverLogPath}\n\n${serverLogTail()}`,
  );
}

function buildMenu({ onReload, onToggleDevtools }) {
  // Stock menus minus the Cmd+W "close window" accelerator: with no browser
  // tab strip in the way, Cmd+W flows to the page — i.e. to the embedded
  // VS Code editor — which is the whole reason this shell exists.
  // Closing the window moved to Shift+Cmd+W.
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Context-aware: reloads the visible Browser preview when one is on
        // screen, the app otherwise. Shift+Cmd+R always reloads the app.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_i, win) => win && onReload(win) },
        { role: 'forceReload' },
        // Context-aware: on a Browser preview tab this toggles OUR docked
        // DevTools for that page (the renderer owns the dock); anywhere else it
        // toggles the app's own DevTools.
        //
        // NO accelerator here: Cmd+Opt+I is owned solely by the
        // before-input-event intercept in wireEmbedHotkeys. A menu accelerator
        // ALSO firing double-toggles (open then close = nothing happens),
        // because a child WebContentsView's preventDefault doesn't suppress the
        // window-level menu accel. The label alone keeps the item clickable.
        {
          label: 'Toggle DevTools',
          click: (_i, win) => win && onToggleDevtools(win),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: (_i, win) => win?.close() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: PROFILE.name === 'dev' ? 'Strado Dev' : 'Strado',
    backgroundColor: '#0b0c0f', // zinc-950 (graphite) — no white flash on load
    webPreferences: {
      // The renderer is our own dashboard talking HTTP to localhost; it
      // needs no Node access.
      nodeIntegration: false,
      contextIsolation: true,
      // Browser preview tabs render as <webview> (own process, real DevTools).
      webviewTag: true,
      // Chromium throttles a window's requestAnimationFrame/timers when it deems
      // the window occluded — and we overlay WebContentsViews (browser/VS Code/
      // preview) on this one. xterm's DOM renderer paints on rAF, so a throttled
      // window silently stops repainting: a full-screen TUI (opencode) that
      // redraws in a burst then goes quiet paints nothing until a resize or tab
      // switch forces a synchronous relayout. Keep the render loop alive so the
      // terminal repaints as output arrives.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.loadURL(URL);
  // The dashboard sets document.title; keep the app name instead.
  win.on('page-title-updated', (e) => e.preventDefault());

  // Trackpad gesture phase. A wheel stream carries no "fingers lifted" event, so
  // the renderer's space-swipe can't tell a paused-but-held drag from a released
  // one — and would otherwise settle on any pause. Chromium's gesture stream
  // can tell them apart: 'gestureScrollBegin' when the fingers land,
  // 'gestureScrollEnd'/'gestureFlingStart' the instant they LIFT (the latter
  // when the lift carries momentum). The sidebar carousel holds the drag until
  // it hears an end, then snaps and commits. (The older BrowserWindow
  // 'scroll-touch-*' events were removed in Electron 33.)
  win.webContents.on('input-event', (_e, input) => {
    if (win.isDestroyed()) return;
    if (input.type === 'gestureScrollBegin') win.webContents.send('strado:scroll-touch', 'begin');
    else if (input.type === 'gestureScrollEnd' || input.type === 'gestureFlingStart')
      win.webContents.send('strado:scroll-touch', 'end');
  });
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // VS Code 1.136+ refuses cross-origin framing with both X-Frame-Options and
  // CSP frame-ancestors. Keep an allowlist per dashboard webContents so only
  // the localhost workbench origins returned by Strado get that restriction
  // relaxed; Browser previews and arbitrary localhost pages remain untouched.
  const vscodeOrigins = new Map(); // dashboard wc id -> Set<origin>
  ipcMain.handle('strado:vscode-origin', (e, value) => {
    // The preload belongs only to the local dashboard. Refuse registrations
    // after an unexpected main-window navigation so external content can
    // never use this bridge to weaken framing on a localhost service.
    let senderOrigin = null;
    try { senderOrigin = new globalThis.URL(e.sender.getURL()).origin; } catch { /* invalid/empty URL */ }
    if (senderOrigin !== URL) return false;
    const origin = vscodeOrigin(value);
    if (!origin) return false;
    const senderId = e.sender.id;
    if (!vscodeOrigins.has(senderId)) {
      e.sender.once('destroyed', () => vscodeOrigins.delete(senderId));
    }
    // There is one shared serve-web instance per Strado process. Replacing
    // the prior origin prevents a dead port from remaining allowlisted if the
    // daemon restarts on a different port.
    vscodeOrigins.set(senderId, new Set([origin]));
    return true;
  });

  // Local dev servers often run HTTPS with self-signed certs (hosts-mapped
  // domains like dev.example.io) — Chrome lets you click through, an embed
  // silently blanks. Accept certificate errors ONLY for Browser previews;
  // the app window itself (plain localhost HTTP) keeps strict TLS.
  app.on('certificate-error', (event, wc, _url, _error, _cert, callback) => {
    if (wc?.getType?.() === 'webview' || previewWcIds.has(wc?.id)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Docked DevTools for Browser-preview webviews. A <webview> CANNOT host
  // the DevTools frontend — Electron never injects the embedder binding into
  // a webview guest, so the UI loads on a "stub connection" with permanently
  // empty panels. Docked mode therefore renders into a main-process
  // WebContentsView overlaid on the window; the renderer keeps a placeholder
  // div and streams its bounds here.
  const dtPanes = new Map(); // target wc id -> { view, win }
  const removePane = (id) => {
    const entry = dtPanes.get(id);
    if (!entry) return null;
    dtPanes.delete(id);
    if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view);
    return entry.view.webContents;
  };
  // App shortcuts pressed inside an embedded surface (Browser preview view,
  // cross-origin VS Code iframe) never reach the dashboard's window listeners.
  // Intercept them here and forward them. For switcher chords, opening the
  // switcher parks the preview and hands focus back to the renderer, so the
  // rest of the hold (arrows, Cmd release) lands on the native path. Meta
  // keyups are forwarded too (no preventDefault) as a commit fallback for
  // releases that happen before the focus handoff.
  const hotkeyCombo = (input, opts = {}) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return null;
    if (input.key === ',' && !input.alt && !input.shift && input.meta !== input.control) return 'settings';
    if (!input.meta || input.control) return null;
    // Cmd+Arrow = tabs, Cmd+Opt+Arrow = tab groups, Cmd+Shift+Arrow = spaces.
    // Shift used to fall through to the tab move, which silently ate the space
    // chord inside the Browser and VS Code embeds.
    if (input.key === 'ArrowRight')
      return input.alt ? 'group-next' : input.shift ? 'space-next' : 'tab-next';
    if (input.key === 'ArrowLeft')
      return input.alt ? 'group-prev' : input.shift ? 'space-prev' : 'tab-prev';
    if (input.key.toLowerCase() === 'k' && !input.alt && !input.shift) return 'palette';
    if (input.key.toLowerCase() === 'l' && !input.alt && !input.shift) return 'changes';
    // Cmd+W inside a Browser preview: the renderer closes the active tab
    // (mirrors a browser). NOT inside VS Code (editorKeys) — the workbench
    // owns Cmd+W (close editor file); the menu deliberately keeps Close
    // Window on Shift+Cmd+W so the chord reaches the iframe untouched.
    // Renderer-focused tabs handle Cmd+W via their own keydown.
    if (input.key.toLowerCase() === 'w' && !input.alt && !input.shift)
      return opts.editorKeys ? null : 'close-tab';
    // Cmd+T inside an embed opens a new shell in the active worktree.
    if (input.key.toLowerCase() === 't' && !input.alt && !input.shift) return 'new-shell';
    return null;
  };
  const wireEmbedHotkeys = (wc, win, isActive = () => true, opts = {}) => {
    wc.on('before-input-event', (ev, input) => {
      if (win.isDestroyed()) return;
      // NOTE: Cmd+Opt+I is NOT handled here. Chromium reserves it as the
      // DevTools shortcut and never delivers it to before-input-event, so the
      // chord is owned by a focus-scoped globalShortcut (see wireDevtoolsShortcut).
      if (!isActive()) return;
      if (input.type === 'keyUp' && input.key === 'Meta') {
        win.webContents.send('strado:hotkey', 'meta-up');
        return;
      }
      const combo = hotkeyCombo(input, opts);
      if (!combo) return;
      ev.preventDefault();
      win.webContents.send('strado:hotkey', combo);
    });
  };
  // renderer wc ids where the window's own keys should be intercepted
  // (active tab is the VS Code iframe — toggled by the renderer)
  const hotkeyScopes = new Set();
  ipcMain.on('strado:hotkey-scope', (e, enabled) => {
    if (enabled) hotkeyScopes.add(e.sender.id);
    else hotkeyScopes.delete(e.sender.id);
  });
  // Reliable Cmd-release signal. macOS never delivers the Meta keyup to a
  // webContents after one of its own Cmd-chords was consumed via
  // before-input-event (verified live: the release vanishes for the rest of
  // that hold — natively AND at before-input). cmdwatch polls
  // CGEventSourceFlagsState, a global state query outside event routing, so
  // commit-on-release works no matter which surface ate the chord.
  let cmdWatchStarted = false;
  let cmdWatchStopping = false;
  const startCmdWatch = () => {
    // cmdwatch is a macOS-only helper (CGEventSourceFlagsState works around a
    // macOS Meta-keyup quirk). Nothing to do on other platforms.
    if (process.platform !== 'darwin') return;
    if (cmdWatchStarted) return;
    cmdWatchStarted = true;
    // packaged builds ship the compiled binary (no cc on tester machines);
    // dev compiles it once from source into userData
    let bin = path.join(RESOURCES, 'bin', 'strado-cmdwatch');
    if (!fs.existsSync(bin)) {
      bin = path.join(app.getPath('userData'), 'strado-cmdwatch');
      const src = path.join(__dirname, 'cmdwatch.c');
      try {
        if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
          const cc = spawnSync('cc', ['-O2', '-framework', 'ApplicationServices', src, '-o', bin]);
          if (cc.status !== 0) throw new Error(String(cc.stderr || cc.error));
        }
      } catch (err) {
        console.warn('[strado] cmdwatch unavailable, switcher release falls back to Enter/click:', String(err?.message ?? err));
        return;
      }
    }
    let child = null;
    let lastSpawn = 0;
    let fastExits = 0;
    const run = () => {
      lastSpawn = Date.now();
      child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line !== 'up') continue;
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('strado:hotkey', 'meta-up');
          }
        }
      });
      child.on('exit', () => {
        child = null;
        if (cmdWatchStopping) return;
        fastExits = Date.now() - lastSpawn < 5000 ? fastExits + 1 : 0;
        if (fastExits < 3) setTimeout(run, 1000);
      });
    };
    run();
    app.on('will-quit', () => {
      cmdWatchStopping = true;
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    });
  };

  // "Hidden" native views are parked offscreen instead of detached:
  // removeChildView drops the compositor surface, and a re-added view can
  // stay a blank white sheet (invalidate() is not reliable). Offscreen keeps
  // the surface alive, so re-showing is instant and never blank.
  const OFFSCREEN_Y = 100000;
  // Renderer bounds arrive in CSS pixels; native views take DIPs. They only
  // match at zoom 1 — Cmd +/- zoom (persisted by Electron) scales every CSS
  // pixel by the zoom factor, so scale by the sender's factor.
  const paneBounds = (b, scale = 1) => ({
    x: Math.max(0, Math.round((b?.x ?? 0) * scale)),
    y: Math.max(0, Math.round((b?.y ?? 0) * scale)),
    width: Math.max(0, Math.round((b?.width ?? 0) * scale)),
    height: Math.max(0, Math.round((b?.height ?? 0) * scale)),
  });
  // Native folder picker for "Add repo" — returns the chosen absolute path,
  // or null on cancel.
  ipcMain.handle('strado:pick-directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  ipcMain.handle('strado:devtools', (e, action, targetId, bounds) => {
    const id = Number(targetId);
    const target = webContents.fromId(id);
    const zoom = e.sender.getZoomFactor?.() ?? 1;
    if (action === 'dock') {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!target || !win || !bounds) return false;
      const existing = dtPanes.get(id);
      if (existing) {
        existing.view.setBounds(paneBounds(bounds, zoom));
        return true;
      }
      const view = new WebContentsView();
      dtPanes.set(id, { view, win });
      win.contentView.addChildView(view);
      view.setBounds(paneBounds(bounds, zoom));
      target.closeDevTools();
      target.setDevToolsWebContents(view.webContents);
      target.openDevTools({ mode: 'detach' });
      return true;
    }
    if (action === 'bounds') {
      const entry = dtPanes.get(id);
      if (entry) {
        const b = paneBounds(bounds, zoom);
        if (entry.hidden) b.y += OFFSCREEN_Y;
        entry.view.setBounds(b);
      }
      return true;
    }
    if (action === 'thumb') {
      // frozen frame for the placeholder while the pane is parked offscreen
      const entry = dtPanes.get(id);
      if (!entry || entry.view.webContents.isDestroyed()) return false;
      const capture = entry.view.webContents
        .capturePage()
        .then((img) => (img.isEmpty() ? false : img.toDataURL()))
        .catch(() => false);
      return Promise.race([
        capture,
        new Promise((resolve) => setTimeout(() => resolve(false), 800)),
      ]);
    }
    if (action === 'hide') {
      // renderer overlay (menu/dialog) needs to paint over the pane region:
      // park the view offscreen, keep the devtools webContents composited.
      const entry = dtPanes.get(id);
      if (entry && !entry.win.isDestroyed() && !entry.hidden) {
        if (entry.view.webContents.isFocused()) entry.win.webContents.focus();
        const b = entry.view.getBounds();
        entry.view.setBounds({ ...b, y: b.y + OFFSCREEN_Y });
        entry.hidden = true;
      }
      return true;
    }
    if (action === 'show') {
      const entry = dtPanes.get(id);
      if (entry && !entry.win.isDestroyed()) {
        entry.hidden = false;
        if (bounds) entry.view.setBounds(paneBounds(bounds, zoom));
      }
      return true;
    }
    if (action === 'undock') {
      // Placeholder unmounted after an explicit dock/browser close or hub
      // teardown: tear down the docked pane only — never touch a native
      // devtools window. Ordinary tab switches use hide/show so panel state
      // and Network history survive.
      const wc = removePane(id);
      if (wc) {
        if (target && !target.isDestroyed()) target.closeDevTools();
        wc.close();
      }
      return true;
    }
    if (action === 'close') {
      const wc = removePane(id);
      if (target && !target.isDestroyed()) target.closeDevTools();
      if (wc) wc.close();
      return true;
    }
    if (action === 'window') {
      if (!target) return false;
      target.closeDevTools();
      const wc = removePane(id);
      let opened = false;
      const open = () => {
        if (opened || target.isDestroyed()) return;
        opened = true;
        target.openDevTools({ mode: 'detach' });
      };
      if (wc && !wc.isDestroyed()) {
        // NEVER reopen synchronously inside 'destroyed' — openDevTools mid-
        // teardown of the previous custom devtools SIGTRAPs the whole app.
        wc.once('destroyed', () => setTimeout(open, 50));
        wc.close();
        setTimeout(open, 1200); // safety: teardown event never fired
      } else {
        open();
      }
      return true;
    }
    return false;
  });

  // Browser previews. The preview page renders in a main-process
  // WebContentsView overlay, NOT a <webview>: webview guests never get the
  // DevTools embedder binding and Chromium drops CDP-injected input events
  // for them (agents attached over STRADO_CDP_PORT could read but not click
  // or type). As a first-class webContents the preview is a normal CDP
  // 'page' target with working input. The renderer owns a placeholder div,
  // streams its bounds, and mirrors load/navigation state from events.
  const previews = new Map(); // key (worktree path) -> { view, win }
  const previewWcIds = new Set(); // for the certificate-error override

  // Cmd+Opt+I: on a Browser-preview tab, toggle OUR docked DevTools for that
  // page (hand off to the renderer); anywhere else, the app's own DevTools.
  function toggleDevtoolsFor(win) {
    if (!win || win.isDestroyed()) return;
    const hasPreview = [...previews.values()].some(
      (e) => e.win === win && e.shown && !e.view.webContents.isDestroyed(),
    );
    if (hasPreview) win.webContents.send('strado:hotkey', 'devtools');
    else win.webContents.toggleDevTools();
  }

  // Cmd+Opt+I is a Chromium-reserved DevTools shortcut: before-input-event never
  // sees it and a menu accelerator loses to Chromium's built-in (which opens the
  // wrong webContents' devtools). A globalShortcut intercepts the chord at the
  // app level and wins. Scope it to window focus so we don't hold the accelerator
  // hostage from other apps while Strado runs in the background.
  const DEVTOOLS_ACCEL = 'CommandOrControl+Alt+I';
  const registerDevtoolsShortcut = () => {
    if (globalShortcut.isRegistered(DEVTOOLS_ACCEL)) return;
    globalShortcut.register(DEVTOOLS_ACCEL, () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win) toggleDevtoolsFor(win);
    });
  };
  app.on('browser-window-focus', registerDevtoolsShortcut);
  app.on('browser-window-blur', () => globalShortcut.unregister(DEVTOOLS_ACCEL));
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Live DevTools/preview resize. The panes are native views layered above the
  // DOM, so a renderer drag stops seeing pointer moves the moment the cursor is
  // over a view. Main tracks the cursor globally instead: on 'start' it listens
  // for input-events on the window + both views, converts the cursor to a size
  // fraction, and streams it back so the renderer resizes the live panes.
  let dtResize = null;
  function endDtResize() {
    if (!dtResize) return;
    for (const wc of dtResize.wcs) {
      if (!wc.isDestroyed()) wc.off('input-event', dtResize.onInput);
    }
    const { win } = dtResize;
    dtResize = null;
    if (win && !win.isDestroyed()) win.webContents.send('strado:devtools-resize-end');
  }
  ipcMain.on('strado:devtools-resize-start', (e, opts) => {
    endDtResize(); // one drag at a time
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const side = opts?.side === 'bottom' ? 'bottom' : 'right';
    const dt = dtPanes.get(Number(opts?.targetId));
    const pv = previews.get(opts?.previewKey);
    if (!dt || !pv || dt.view.webContents.isDestroyed() || pv.view.webContents.isDestroyed()) return;
    const pvB = pv.view.getBounds();
    const dtB = dt.view.getBounds();
    // Container spans from the preview's near edge to the devtools' far edge;
    // the fraction is the devtools portion of it. Those outer edges don't move
    // during the drag, so capture the span once.
    const near = side === 'right' ? pvB.x : pvB.y;
    const far = side === 'right' ? dtB.x + dtB.width : dtB.y + dtB.height;
    const size = far - near;
    if (size <= 0) return;
    const onInput = (_ev, input) => {
      if (!dtResize) return;
      if (input.type === 'mouseUp') return endDtResize();
      if (input.type !== 'mouseMove' && input.type !== 'mouseDown') return;
      const p = screen.getCursorScreenPoint();
      const cb = win.getContentBounds();
      const cursor = side === 'right' ? p.x - cb.x : p.y - cb.y;
      let frac = (far - cursor) / size;
      frac = Math.min(0.85, Math.max(0.15, frac));
      if (!win.isDestroyed()) win.webContents.send('strado:devtools-resize-move', frac);
    };
    const wcs = [win.webContents, dt.view.webContents, pv.view.webContents];
    for (const wc of wcs) if (!wc.isDestroyed()) wc.on('input-event', onInput);
    dtResize = { win, onInput, wcs };
  });
  ipcMain.on('strado:devtools-resize-stop', () => endDtResize());

  // Preview keys from the renderer: the worktree path for Browser tab 1
  // (historical), `<path>\0browser:<id>` for extra tabs. Everything in this
  // file treats the key as opaque; only the CDP registry needs the split.
  const parsePreviewKey = (key) => {
    const nul = key.indexOf('\0');
    if (nul === -1) return { path: key, tabId: '1' };
    const sub = key.slice(nul + 1);
    return {
      path: key.slice(0, nul),
      tabId: sub.startsWith('browser:') ? sub.slice('browser:'.length) : '1',
    };
  };
  // Publish worktree/tab -> CDP-target mapping to the server so the
  // per-worktree preview MCP can scope agents to their own tabs. Best-effort:
  // if the server is down or the debugger is busy, the scoped MCP just won't
  // see it.
  async function registerPreviewTarget(key, wc) {
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const { targetInfo } = await dbg.sendCommand('Target.getTargetInfo');
      dbg.detach();
      const { path: wtPath, tabId } = parsePreviewKey(key);
      await fetch(`${URL}/api/preview-targets`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: wtPath,
          tabId,
          targetId: targetInfo.targetId,
          wcId: wc.id,
          cdpPort: Number.isInteger(CDP_PORT) && CDP_PORT > 0 ? CDP_PORT : null,
        }),
      });
    } catch {
      /* ignore */
    }
  }
  function unregisterPreviewTarget(key) {
    const body = key ? parsePreviewKey(key) : {};
    fetch(`${URL}/api/preview-targets`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(key ? { path: body.path, tabId: body.tabId } : {}),
    }).catch(() => undefined);
  }
  // Open a self-hosted runner's dashboard in its own window. The URL is a
  // single-use attach link: loading it sets the session cookie on the runner's
  // relay origin and redirects into that machine's Strado UI.
  //
  // A separate BrowserWindow (not a tab in the main shell) because it IS a
  // different machine: its own cookies, its own files, and no Electron embeds.
  // No preload is attached — that window runs a remote origin and must not get
  // the desktop bridge.
  ipcMain.handle('strado:open-runner', (_e, url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    const runnerWin = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 560,
      title: 'Strado runner',
      backgroundColor: '#0b0c0f',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    // Remote content must never spawn more Electron windows; hand off to the
    // real browser instead.
    runnerWin.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    void runnerWin.loadURL(url);
    return true;
  });

  ipcMain.handle('strado:preview', (e, action, key, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const zoom = e.sender.getZoomFactor?.() ?? 1;
    if (action === 'open') {
      if (!win || !payload?.bounds) return false;
      let entry = previews.get(key);
      if (!entry) {
        const view = new WebContentsView();
        entry = { view, win };
        previews.set(key, entry);
        previewWcIds.add(view.webContents.id);
        const wc = view.webContents;
        const send = (data) => {
          if (!win.isDestroyed()) win.webContents.send('strado:preview-event', { key, ...data });
        };
        wc.on('did-start-loading', () => send({ type: 'load', loading: true }));
        wc.on('did-stop-loading', () => send({ type: 'load', loading: false }));
        wc.on('did-fail-load', (_ev, code, desc, failedUrl, isMainFrame) => {
          if (!isMainFrame || code === -3) return; // -3 ERR_ABORTED: redirects
          send({ type: 'error', error: `${desc || 'load failed'} (${code}) — ${failedUrl}` });
        });
        const sendUrl = (url) => send({
          type: 'url',
          url,
          canBack: wc.navigationHistory?.canGoBack() ?? wc.canGoBack(),
          canForward: wc.navigationHistory?.canGoForward() ?? wc.canGoForward(),
        });
        wc.on('did-navigate', (_ev, url) => sendUrl(url));
        wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
          if (isMainFrame) sendUrl(url);
        });
        // Live tab identity: the renderer labels Browser tabs with the page
        // title + favicon, like a real browser.
        wc.on('page-title-updated', (_ev, title) => send({ type: 'title', title }));
        wc.on('page-favicon-updated', (_ev, favicons) =>
          send({ type: 'favicon', favicon: favicons?.[0] ?? null }));
        // Native Browser panes sit above the renderer, so clicks inside their
        // page do not bubble to React. Forward focus to keep the split's active
        // tab highlight and keyboard actions pointed at the pane the user
        // actually clicked.
        wc.on('focus', () => send({ type: 'focus' }));
        // Scripted popups (window.open with features — OAuth/Google Sign-In)
        // must be REAL child windows: the popup delivers its result through
        // window.opener/postMessage and closes itself. Navigating the preview
        // to the popup URL severs that channel and leaves a dead white page.
        // Plain target=_blank links keep navigating the preview in place.
        wc.setWindowOpenHandler(({ url, disposition }) => {
          if (disposition === 'new-window') {
            return {
              action: 'allow',
              overrideBrowserWindowOptions: { autoHideMenuBar: true },
            };
          }
          wc.loadURL(url);
          return { action: 'deny' };
        });
        wc.once('destroyed', () => {
          unregisterPreviewTarget(key);
          if (entry.thumbTimer) clearInterval(entry.thumbTimer);
        });
        // rolling thumbnail while visible: a hidden view renders no frames,
        // so the tab switcher shows the last frame captured before hiding
        entry.snap = () => {
          if (!entry.shown || wc.isDestroyed()) return;
          wc.capturePage()
            .then((img) => {
              if (!img.isEmpty()) entry.lastThumb = img.resize({ width: 900 }).toDataURL();
            })
            .catch(() => undefined);
        };
        entry.thumbTimer = setInterval(entry.snap, 5000);
        setTimeout(entry.snap, 700);
        // hidden previews keep ticking: agents observe them (console,
        // network, screenshots) while the user is on another hub tab
        wc.setBackgroundThrottling(false);
        wireEmbedHotkeys(wc, win);
        win.contentView.addChildView(view);
        entry.shown = true;
        view.setBounds(paneBounds(payload.bounds, zoom));
        if (payload.url) wc.loadURL(payload.url);
        void registerPreviewTarget(key, wc);
      } else {
        // re-show after a hide: re-attach without touching navigation state.
        // The renderer heartbeats this action to self-heal stray detaches,
        // so repaint/snapshot work only runs on a real hidden->shown edge.
        const wasShown = entry.shown === true;
        win.contentView.addChildView(entry.view);
        entry.shown = true;
        entry.view.setBounds(paneBounds(payload.bounds, zoom));
        // A reloaded renderer (Cmd+R) lost its title state; replay it so the
        // tab label doesn't fall back to "Browser N" until the next navigation.
        if (!win.isDestroyed()) {
          win.webContents.send('strado:preview-event', {
            key, type: 'title', title: entry.view.webContents.getTitle(),
          });
        }
        if (!wasShown) {
          // a re-attached view can come back as a blank sheet (page
          // background only) until the compositor repaints — force it
          entry.view.webContents.invalidate();
          if (entry.snap) setTimeout(entry.snap, 600);
        }
      }
      return entry.view.webContents.id;
    }
    // open-external with an explicit url doesn't need a preview view (a rail
    // MR row passes the MR's webUrl); fall through to the current-page variant
    // below only when no url is supplied.
    if (action === 'open-external' && payload?.url && /^https?:\/\//.test(payload.url)) {
      void shell.openExternal(payload.url);
      return true;
    }
    const entry = previews.get(key);
    if (!entry) return action === 'hide' || action === 'close'; // idempotent teardown
    if (action === 'bounds') {
      const b = paneBounds(payload, zoom);
      if (!entry.shown) b.y += OFFSCREEN_Y;
      entry.view.setBounds(b);
      return true;
    }
    if (action === 'hide') {
      if (!entry.win.isDestroyed()) {
        // keep the keyboard: a focused hidden view strands held-chord
        // keyups (the tab switcher would stick open)
        if (entry.view.webContents.isFocused()) entry.win.webContents.focus();
        if (entry.shown) {
          const b = entry.view.getBounds();
          entry.view.setBounds({ ...b, y: b.y + OFFSCREEN_Y });
        }
      }
      entry.shown = false;
      return true;
    }
    if (action === 'navigate') {
      if (payload?.url) entry.view.webContents.loadURL(payload.url);
      return true;
    }
    if (action === 'reload') {
      entry.view.webContents.reload();
      return true;
    }
    if (action === 'back') {
      const wc = entry.view.webContents;
      if (wc.navigationHistory?.canGoBack() ?? wc.canGoBack()) {
        (wc.navigationHistory ?? wc).goBack();
      }
      return true;
    }
    if (action === 'forward') {
      const wc = entry.view.webContents;
      if (wc.navigationHistory?.canGoForward() ?? wc.canGoForward()) {
        (wc.navigationHistory ?? wc).goForward();
      }
      return true;
    }
    if (action === 'hard-reload') {
      entry.view.webContents.reloadIgnoringCache();
      return true;
    }
    if (action === 'screenshot') {
      return entry.view.webContents.capturePage().then((img) => {
        const file = path.join(app.getPath('downloads'), `strado-preview-${Date.now()}.png`);
        fs.writeFileSync(file, img.toPNG());
        clipboard.writeImage(img);
        return file;
      });
    }
    if (action === 'thumb') {
      // live capture when visible; the rolling cache when hidden (hidden
      // views render no frames, capturePage would hang or come back empty)
      const cached = entry.lastThumb ?? false;
      if (!entry.shown) return cached;
      const cap = entry.view.webContents
        .capturePage()
        .then((img) => (img.isEmpty() ? cached : img.resize({ width: 900 }).toDataURL()))
        .catch(() => cached);
      return Promise.race([cap, new Promise((r) => setTimeout(() => r(cached), 800))]);
    }
    if (action === 'open-external') {
      const u = entry.view.webContents.getURL();
      if (/^https?:\/\//.test(u)) void shell.openExternal(u);
      return true;
    }
    if (action === 'clear-history') {
      entry.view.webContents.navigationHistory?.clear();
      return true;
    }
    // Data clearing is scoped to the CURRENT page's origin: previews share
    // the app's default session, and an unscoped clear would wipe the Strado
    // dashboard's own localStorage (tab persistence, layout state).
    if (action === 'clear-cookies' || action === 'clear-data') {
      const wc = entry.view.webContents;
      let origin;
      try {
        origin = new URL(wc.getURL()).origin;
      } catch {
        return false;
      }
      const opts = action === 'clear-cookies' ? { origin, storages: ['cookies'] } : { origin };
      return wc.session.clearStorageData(opts).then(() => {
        wc.reload();
        return true;
      });
    }
    if (action === 'close') {
      previews.delete(key);
      unregisterPreviewTarget(key);
      if (entry.thumbTimer) clearInterval(entry.thumbTimer);
      const wcId = entry.view.webContents.id;
      previewWcIds.delete(wcId);
      const dtWc = removePane(wcId); // tear down any docked devtools with it
      if (dtWc && !dtWc.isDestroyed()) dtWc.close();
      if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view);
      entry.view.webContents.close();
      return true;
    }
    return false;
  });

  // --- Self-update (we stage + swap the .app ourselves; staged bundles
  // must pass the codesign/TeamIdentifier gate below) ---
  const crypto = require('node:crypto');
  const https = require('node:https');
  const httpMod = require('node:http');
  const os = require('node:os');

  // The running bundle's .app root, derived from the executable path:
  // …/Strado.app/Contents/MacOS/Strado -> …/Strado.app
  function installBundlePath() {
    const exe = process.execPath; // .../Strado.app/Contents/MacOS/Strado
    const macos = path.dirname(exe);        // .../Contents/MacOS
    const contents = path.dirname(macos);   // .../Contents
    const appRoot = path.dirname(contents); // .../Strado.app
    return appRoot.endsWith('.app') ? appRoot : null;
  }

  let pendingApp = null; // staged .app path once a download succeeds

  // One staging at a time, across ALL windows. Each workspace window has its
  // own update banner; two concurrent downloads share the staging dir, and
  // the second's `rm -rf pending` shreds the first's half-written copy —
  // which install then faithfully swaps over the live app (bricked 0.1.14).
  let updateBusy = false;

  // Async exec for the staging pipeline. spawnSync here used to freeze the
  // main process for the whole ~200MB copy + codesign walk — every window
  // beachballed right after the download finished. Resolves (never rejects)
  // with the exit status, mirroring spawnSync's no-throw contract.
  function run(cmd, cmdArgs, { timeout } = {}) {
    return new Promise((resolve) => {
      let stderr = '';
      let timer = null;
      const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (d) => { stderr += d; });
      const settle = (status) => {
        if (timer) clearTimeout(timer);
        resolve({ status, stderr });
      };
      if (timeout) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
      child.on('error', () => settle(-1));
      child.on('close', (code) => settle(code === null ? -1 : code));
    });
  }

  // The TeamIdentifier baked into a bundle's signature, or null for ad-hoc/
  // unsigned bundles ("not set") and any codesign failure.
  async function teamIdentifierOf(appPath) {
    const res = await run('codesign', ['-dv', appPath], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const m = /TeamIdentifier=([A-Z0-9]+)/.exec(res.stderr || '');
    return m && m[1] !== 'not' ? m[1] : null; // "TeamIdentifier=not set" → ad-hoc
  }

  // Signature gate for staged updates. Once THIS install is Developer-ID
  // signed, an update must verify cleanly AND carry the same TeamIdentifier —
  // otherwise a compromised feed could swap a signed install for an unsigned
  // or foreign-signed bundle and the structural check would wave it through.
  // While this install is ad-hoc (pre-signing betas, dev builds), the gate is
  // open on purpose: that is exactly how existing installs take the FIRST
  // signed release.
  async function stagedAppSignatureOk(staged) {
    const runningTeam = await teamIdentifierOf(installBundlePath());
    if (!runningTeam) return true; // ad-hoc install: structural check only
    const verify = await run('codesign', ['--verify', '--deep', '--strict', staged], { timeout: 60_000 });
    if (verify.status !== 0) return false;
    return (await teamIdentifierOf(staged)) === runningTeam;
  }

  // A staged .app must be structurally sound before it is ever announced
  // 'ready' — existence of the top directory says nothing about a copy that
  // died midway. Check the three files a hollow bundle is missing.
  function stagedAppLooksSane(staged) {
    try {
      return (
        fs.statSync(path.join(staged, 'Contents', 'MacOS', 'Strado')).size > 0 &&
        // Electron Framework is ~150MB; it's the payload a broken copy loses.
        fs.statSync(path.join(
          staged, 'Contents', 'Frameworks', 'Electron Framework.framework',
          'Versions', 'A', 'Electron Framework',
        )).size > 10 * 1024 * 1024 &&
        // app.asar: presence only. Electron main's asar patch makes statSync
        // report ANY app.asar as a zero-size directory, so a size gate here
        // fails every genuine bundle (0.1.15 shipped that bug — every update
        // ended in 'staging failed'). Same family as the rmSync/ENOTDIR
        // gotcha: never stat/rm asar paths from Electron main.
        fs.existsSync(path.join(staged, 'Contents', 'Resources', 'app.asar'))
      );
    } catch {
      return false;
    }
  }

  function download(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : httpMod;
      const file = fs.createWriteStream(dest);
      let settled = false;
      // A mid-download connection drop or a write error (disk full, EACCES)
      // fires an async 'error' on `res` or `file` — without these handlers
      // it would be an unhandled error event, crashing the main process.
      const fail = (err) => {
        if (settled) return;
        settled = true;
        file.close(() => {
          try { fs.rmSync(dest, { force: true }); } catch { /* best-effort cleanup */ }
          reject(err);
        });
      };
      file.on('error', fail);
      mod.get(url, (res) => {
        res.on('error', fail);
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`download HTTP ${res.statusCode}`)); return; }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) onProgress(Math.min(100, Math.round((got / total) * 100)));
        });
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          file.close(() => resolve());
        });
      }).on('error', fail);
    });
  }

  // Streamed on purpose: readFileSync pulled the whole ~200MB DMG into
  // memory and hashed it on the main process — part of the post-download
  // beachball.
  function sha256File(p) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('error', reject);
      s.on('data', (chunk) => h.update(chunk));
      s.on('end', () => resolve(h.digest('hex')));
    });
  }

  // What kind of self-update this install supports. The renderer branches its
  // UI on this instead of guessing from the platform:
  //   swap — full download/verify/swap/relaunch (mac .app, linux AppImage)
  //   link — can only open the download URL externally (.deb: files are
  //          root-owned under /usr, no self-swap without sudo prompts)
  //   none — no channel (win32, unknown)
  // $APPIMAGE is set by the AppImage runtime to the absolute path of the
  // running .AppImage file — its presence is what distinguishes AppImage from
  // deb installs. Darwin stays 'swap' even unpackaged to preserve existing
  // dev behavior (install already rejects unpackaged runs).
  const updateMode =
    process.platform === 'darwin' ? 'swap'
    : process.platform === 'linux' && process.env.APPIMAGE && app.isPackaged ? 'swap'
    : process.platform === 'linux' ? 'link'
    : 'none';
  ipcMain.on('strado:update-mode', (e) => { e.returnValue = updateMode; });

  let pendingAppImage = null; // staged ${APPIMAGE}.download once verified

  ipcMain.handle('strado:update', async (e, action, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (data) => { if (win && !win.isDestroyed()) win.webContents.send('strado:update-event', data); };

    // linux AppImage: download to a SIBLING of $APPIMAGE (same filesystem →
    // the final rename is atomic; /tmp is often tmpfs and rename would fail
    // EXDEV), verify, chmod, then swap on install. The running process keeps
    // the old inode alive, so renaming over it mid-run is safe. .deb installs
    // never reach here (renderer shows a download link in 'link' mode).
    if (process.platform === 'linux') {
      const target = process.env.APPIMAGE;
      if (!target || !app.isPackaged) {
        send({ type: 'error', message: 'self-update is only available in the packaged AppImage' });
        return { ok: false };
      }
      if (action === 'download') {
        if (updateBusy) {
          send({ type: 'error', message: 'an update download is already in progress (maybe in another window)' });
          return { ok: false };
        }
        updateBusy = true;
        const tmp = `${target}.download`;
        try {
          await download(payload.url, tmp, (pct) => send({ type: 'progress', pct }));
          if ((await sha256File(tmp)) !== payload.sha256) {
            fs.rmSync(tmp, { force: true });
            send({ type: 'error', message: 'download verification failed' });
            return { ok: false };
          }
          fs.chmodSync(tmp, 0o755);
          pendingAppImage = tmp;
          send({ type: 'ready', version: payload.version || '' });
          return { ok: true };
        } catch (err) {
          try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
          send({ type: 'error', message: String((err && err.message) || err) });
          return { ok: false };
        } finally {
          updateBusy = false;
        }
      }
      if (action === 'install') {
        if (!pendingAppImage || !fs.existsSync(pendingAppImage)) {
          send({ type: 'error', message: 'no staged update — download it first' });
          return { ok: false };
        }
        try {
          fs.renameSync(pendingAppImage, target);
        } catch (err) {
          send({ type: 'error', message: String((err && err.message) || err) });
          return { ok: false };
        }
        pendingAppImage = null;
        // Relaunch the swapped file directly. app.relaunch() would re-exec the
        // OLD extracted runtime, not the new AppImage. Strip the AppImage
        // runtime's env so the new runtime sets its own values instead of
        // inheriting stale paths from the old mount.
        const env = { ...process.env };
        delete env.APPIMAGE;
        delete env.APPDIR;
        delete env.OWD;
        // Wait for THIS process to fully die before launching the new build
        // (mirrors the mac swap.sh). Launching immediately races the teardown:
        // the new instance can lose the single-instance lock to the dying one
        // and silently quit, or adopt the old instance's server child seconds
        // before it exits.
        const child = spawn('/bin/sh', [
          '-c',
          'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"',
          'sh',
          String(process.pid),
          target,
        ], { detached: true, stdio: 'ignore', env });
        child.unref();
        app.quit();
        return { ok: true };
      }
      return { ok: false };
    }

    if (process.platform !== 'darwin') {
      send({ type: 'error', message: 'self-update is not available on this platform' });
      return { ok: false };
    }

    if (action === 'download') {
      if (updateBusy) {
        send({ type: 'error', message: 'an update download is already in progress (maybe in another window)' });
        return { ok: false };
      }
      updateBusy = true;
      try {
        const dir = path.join(os.tmpdir(), 'strado-update');
        fs.mkdirSync(dir, { recursive: true });
        const dmg = path.join(dir, 'Strado.dmg');
        await download(payload.url, dmg, (pct) => send({ type: 'progress', pct }));
        if ((await sha256File(dmg)) !== payload.sha256) {
          fs.rmSync(dmg, { force: true });
          send({ type: 'error', message: 'download verification failed' });
          return { ok: false };
        }
        // Unique mountpoint per attempt: a stale mount left by a crashed run
        // makes a fixed-path attach fail 'Resource busy'.
        const mount = fs.mkdtempSync(path.join(dir, 'mnt-'));
        const attachResult = await run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 60_000 });
        if (attachResult.status !== 0) {
          try { fs.rmdirSync(mount); } catch { /* best-effort */ }
          send({ type: 'error', message: 'could not mount the update image' });
          return { ok: false };
        }
        const staged = path.join(app.getPath('userData'), 'pending', 'Strado.app');
        let copyOk = false;
        try {
          // Use a shell rm, NOT fs.rmSync: Electron's asar patch makes fs treat
          // a bundled app.asar as a directory, so fs.rmSync(recursive) tries to
          // rmdir the asar file and throws ENOTDIR when a prior .app is staged.
          await run('rm', ['-rf', path.dirname(staged)], { timeout: 30_000 });
          fs.mkdirSync(path.dirname(staged), { recursive: true });
          const cpResult = await run('cp', ['-R', path.join(mount, 'Strado.app'), staged], { timeout: 300_000 });
          copyOk = cpResult.status === 0;
        } finally {
          // Always try to unmount the DMG, even if staging above threw —
          // otherwise it stays mounted and breaks the next update's attach.
          try { await run('hdiutil', ['detach', mount], { timeout: 30_000 }); } catch { /* best-effort */ }
          try { fs.rmdirSync(mount); } catch { /* best-effort */ }
        }
        if (!copyOk || !stagedAppLooksSane(staged) || !(await stagedAppSignatureOk(staged))) {
          // Never leave a bad copy where a later install could swap it in.
          await run('rm', ['-rf', path.dirname(staged)], { timeout: 30_000 });
          send({ type: 'error', message: 'staging failed' });
          return { ok: false };
        }
        pendingApp = staged;
        send({ type: 'ready', version: payload.version || '' });
        return { ok: true };
      } catch (err) {
        send({ type: 'error', message: String((err && err.message) || err) });
        return { ok: false };
      } finally {
        updateBusy = false;
      }
    }

    if (action === 'install') {
      if (!app.isPackaged) {
        send({ type: 'error', message: 'update install is only available in the packaged app' });
        return { ok: false };
      }
      if (!pendingApp) {
        send({ type: 'error', message: 'no staged update — download it first' });
        return { ok: false };
      }
      const dest = installBundlePath();
      if (!dest) { send({ type: 'error', message: 'not an installed .app (dev run)' }); return { ok: false }; }
      // Verify-then-swap: copy the staged app BESIDE the live one, check the
      // copy is structurally sound, and only then move it into place. The old
      // app is never deleted until the new one has fully landed — a failed or
      // partial copy leaves the existing install running (a plain
      // rm-then-cp bricked an install when it copied a hollow bundle).
      const script = path.join(os.tmpdir(), 'strado-update', 'swap.sh');
      fs.writeFileSync(script, [
        '#!/bin/bash',
        'PID="$1"; STAGED="$2"; DEST="$3"',
        'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
        'NEW="$DEST.new"; OLD="$DEST.old"',
        'DESTDIR="$(dirname "$DEST")"',
        'CHECK="Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"',
        'ok=0',
        'if [ -w "$DESTDIR" ]; then',
        '  rm -rf "$NEW" "$OLD"',
        '  if cp -R "$STAGED" "$NEW" && [ -f "$NEW/$CHECK" ] && [ -f "$NEW/Contents/MacOS/Strado" ]; then',
        '    if mv "$DEST" "$OLD"; then',
        '      if mv "$NEW" "$DEST"; then ok=1; rm -rf "$OLD"; else mv "$OLD" "$DEST"; fi',
        '    fi',
        '  fi',
        '  rm -rf "$NEW"',
        'else',
        '  /usr/bin/osascript -e "do shell script \\"rm -rf \'$NEW\' \'$OLD\' && cp -R \'$STAGED\' \'$NEW\' && [ -f \'$NEW/$CHECK\' ] && mv \'$DEST\' \'$OLD\' && mv \'$NEW\' \'$DEST\' && rm -rf \'$OLD\'\\" with administrator privileges" && ok=1',
        'fi',
        '[ "$ok" = 1 ] && rm -rf "$(dirname "$STAGED")"',
        'open "$DEST"',
        '',
      ].join('\n'), { mode: 0o755 });
      const child = spawn('/bin/bash', [script, String(process.pid), pendingApp, dest], { detached: true, stdio: 'ignore' });
      child.unref();
      app.quit();
      return { ok: true };
    }

    return { ok: false };
  });

  // A page reload (Cmd+R) tears the renderer down WITHOUT React cleanup —
  // overlays would stay glued to the window over the fresh page. Hide the
  // previews (kept alive: the rebooted renderer re-opens them with state)
  // and fully drop docked devtools (the renderer forgets dock state).
  const wireWindow = (win) => {
    // VS Code iframe keys route through the window's webContents; intercept
    // only while the renderer says the VS Code tab is active — otherwise
    // Cmd+Arrow keeps its native meaning in dashboard text fields.
    // editorKeys: this scope is only ever active for the VS Code iframe,
    // where Cmd+W must stay VS Code's close-editor-file, not close-tab.
    wireEmbedHotkeys(win.webContents, win, () => hotkeyScopes.has(win.webContents.id), { editorKeys: true });
    // window.open from the dashboard goes to the default browser — never a
    // child BrowserWindow (a bare window.open would spawn a blank Electron
    // window; the deb "Download update" link relies on this).
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-start-navigation', (e, _url, isInPlace, legacyMainFrame) => {
      const isMainFrame = typeof e?.isMainFrame === 'boolean' ? e.isMainFrame : legacyMainFrame;
      const isSameDocument = typeof e?.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace;
      if (isMainFrame === false || isSameDocument) return;
      hotkeyScopes.delete(win.webContents.id); // fresh renderer re-announces
      for (const entry of previews.values()) {
        if (entry.win !== win) continue;
        // park offscreen, don't detach — the surface stays alive so the
        // rebooted renderer's re-open shows instantly instead of a blank sheet
        if (!win.isDestroyed() && entry.shown) {
          const b = entry.view.getBounds();
          entry.view.setBounds({ ...b, y: b.y + OFFSCREEN_Y });
        }
        entry.shown = false;
      }
      for (const [id, entry] of [...dtPanes.entries()]) {
        if (entry.win !== win) continue;
        dtPanes.delete(id);
        const target = webContents.fromId(id);
        if (target && !target.isDestroyed()) target.closeDevTools();
        if (!win.isDestroyed()) win.contentView.removeChildView(entry.view);
        entry.view.webContents.close();
      }
    });
  };

  app.whenReady().then(async () => {
    if (translocationDialog()) {
      app.quit();
      return;
    }
    startCmdWatch();
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: ['http://127.0.0.1:*/*'] },
      (details, callback) => callback({
        responseHeaders: headersForRequest(details, vscodeOrigins),
      }),
    );
    buildMenu({
      onReload: (win) => {
        const visible = [...previews.values()].filter(
          (e) => e.win === win && e.shown && !e.view.webContents.isDestroyed(),
        );
        if (visible.length === 1) visible[0].view.webContents.reload();
        else win.webContents.reload();
      },
      onToggleDevtools: (win) => toggleDevtoolsFor(win),
    });
    try {
      await ensureServer();
    } catch (err) {
      dialog.showErrorBox('Strado', String(err instanceof Error ? err.message : err));
      app.quit();
      return;
    }
    // entries from a previous shell run are stale the moment it died
    unregisterPreviewTarget(null);
    wireWindow(createWindow());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) wireWindow(createWindow());
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('quit', () => {
    // Only kill a server we spawned; an external one belongs to the user.
    serverChild?.kill();
  });
}
