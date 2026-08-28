import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { attachDroppedImages } from '../hooks/terminalDrop';
import { APPEARANCE_CHANGE_EVENT } from '../hooks/useAppearance';
import { ClaudeIcon, CodexIcon, OpencodeIcon, ShellIcon } from './hub/icons';

const TRUE_BLACK_TERMINAL_THEME: ITheme = {
  background: '#000000', foreground: '#e5e5e5', cursor: '#f97f1b', cursorAccent: '#000000',
  selectionBackground: '#333333', selectionInactiveBackground: '#202020',
  black: '#000000', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e5e5e5',
  brightBlack: '#737373', brightRed: '#f87171', brightGreen: '#4ade80', brightYellow: '#facc15',
  brightBlue: '#60a5fa', brightMagenta: '#c084fc', brightCyan: '#22d3ee', brightWhite: '#ffffff',
};

const GRAPHITE_TERMINAL_THEME: ITheme = {
  background: '#0b0c0f', foreground: '#dde0e6', cursor: '#f97f1b', cursorAccent: '#0b0c0f',
  selectionBackground: '#4b505c80', selectionInactiveBackground: '#2c303966',
  black: '#0b0c0f', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#dde0e6',
  brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f7f8fa',
};

const AYU_DARK_TERMINAL_THEME: ITheme = {
  background: '#0f1419', foreground: '#bfbdb6', cursor: '#e6b450', cursorAccent: '#0f1419',
  selectionBackground: '#253340', selectionInactiveBackground: '#1b273380',
  black: '#0f1419', red: '#f07178', green: '#aad94c', yellow: '#e6b450',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#dde0e6',
  brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f7f8fa',
};

const GITHUB_LIGHT_TERMINAL_THEME: ITheme = {
  background: '#fafafa', foreground: '#27272a', cursor: '#18181b', cursorAccent: '#fafafa',
  selectionBackground: '#f97f1b40', selectionInactiveBackground: '#a1a1aa40',
  black: '#18181b', red: '#dc2626', green: '#059669', yellow: '#a16207',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#f4f4f5',
  brightBlack: '#71717a', brightRed: '#ef4444', brightGreen: '#10b981', brightYellow: '#ca8a04',
  brightBlue: '#3b82f6', brightMagenta: '#a855f7', brightCyan: '#06b6d4', brightWhite: '#ffffff',
};

const DRACULA_TERMINAL_THEME: ITheme = {
  background: '#191a21', foreground: '#f8f8f2', cursor: '#bd93f9', cursorAccent: '#191a21',
  selectionBackground: '#44475a', selectionInactiveBackground: '#44475a80',
  black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
  blue: '#6272a4', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
  brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
  brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
};

const NORD_TERMINAL_THEME: ITheme = {
  background: '#242933', foreground: '#d8dee9', cursor: '#88c0d0', cursorAccent: '#242933',
  selectionBackground: '#434c5e', selectionInactiveBackground: '#3b425280',
  black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
  blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
  brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
};

function activeTerminalTheme(): ITheme {
  switch (document.documentElement.dataset.appTheme) {
    case 'true-black': return TRUE_BLACK_TERMINAL_THEME;
    case 'ayu-dark': return AYU_DARK_TERMINAL_THEME;
    case 'dracula': return DRACULA_TERMINAL_THEME;
    case 'nord': return NORD_TERMINAL_THEME;
    case 'github-light': return GITHUB_LIGHT_TERMINAL_THEME;
    default: return GRAPHITE_TERMINAL_THEME;
  }
}

function terminalUsesLightTheme(): boolean {
  return document.documentElement.dataset.theme === 'light';
}

// Claude marks user-message rows with SGR 7 (reverse video). With a light
// terminal that literally swaps the dark foreground into the background,
// producing a nearly-black bar. Translate only that semantic highlight to the
// GitHub Light neutral selection colors; SGR 27 restores the defaults. Other
// agents and ordinary ANSI colors pass through unchanged.
export function renderClaudeLight(data: string): string {
  return data.replace(/\x1b\[([0-9;]*)m/g, (sequence, raw: string) => {
    const params = (raw || '0').split(';');
    if (!params.includes('7') && !params.includes('27')) return sequence;
    const translated = params.flatMap((param) => {
      if (param === '7') return ['48', '2', '228', '228', '231', '38', '2', '39', '39', '42'];
      if (param === '27') return ['49', '39'];
      return [param];
    });
    return `\x1b[${translated.join(';')}m`;
  });
}

function activeTerminalFont(): string {
  const setting = document.documentElement.dataset.terminalFont;
  if (setting === 'jetbrains') {
    return '"JetBrains Mono Variable", Menlo, Monaco, "Courier New", monospace';
  }
  if (setting === 'system-mono') {
    return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  }
  return '"FiraCode Nerd Font", "Symbols Nerd Font", Menlo, Monaco, "Courier New", ' +
    '"Kohinoor Devanagari", "Devanagari Sangam MN", "Noto Sans Devanagari", monospace';
}

/**
 * Where a pane's pty actually lives, when it isn't this machine.
 *
 * `wsId`/`path` belong to the RUNNER and are opaque here — never validate or
 * rewrite them against local state. The socket goes straight to the relay:
 * routing terminal bytes through the local server would put every keystroke and
 * every token of agent output through the same process that enumerates every
 * worktree.
 */
export type RemoteTarget = {
  runnerId: string;
  /** `wss://<runnerId>.<relay domain>`, handed over by the server so nothing here hardcodes the domain. */
  wsBase: string;
  wsId: string;
  path: string;
};

export type PtyTab = {
  path: string;
  mode: 'claude' | 'codex' | 'opencode' | 'shell';
  id: string;
  remote?: RemoteTarget | null;
};

// opencode's "opentui" renderer probes the terminal for capabilities on
// startup and stalls on a blank frame until every probe is answered. xterm.js
// has no handler for these three, so it drops them silently and the TUI never
// finishes its handshake (renders blank in the app, fine in Warp which answers
// them). Reply here, back down the same pty socket the terminal writes to —
// negative/minimal replies are enough to unblock it, and no other TUI is harmed
// by receiving a "not supported" answer to a capability it queried.
// opencode's opentui measures the terminal's cell size at startup by emitting
// a Kitty "sized text" glyph (OSC 66: `\e]66;<meta>;<text>\e\\`) and then asking
// where the cursor landed (`\e[6n`). xterm.js 6.0 has no OSC 66 handler, so it
// drops the glyph, the cursor never advances, and opentui reads a zero-width
// cell — it then computes a degenerate grid and paints nothing (blank in the
// app, fine in Warp which implements OSC 66). We can't answer this with a
// parser OSC handler: writing the glyph from inside the handler queues it
// asynchronously, so it wouldn't have advanced the cursor by the time the
// `\e[6n` later in the SAME chunk is answered. Instead rewrite the probe in the
// byte stream into its plain-text payload, which xterm renders inline and which
// advances the cursor synchronously. opentui only uses OSC 66 for this startup
// measurement (its actual UI is drawn with ordinary cursor+SGR escapes), and
// the whole probe burst arrives in one pty message, so a stream rewrite is
// exact here. Terminator is BEL or ST; metadata carries no bare ';'.
function renderSizedText(data: string): string {
  return data.replace(/\x1b\]66;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x07|\x1b\\)/g, '$1');
}

function answerCapabilityProbes(data: string, ws: WebSocket | null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const send = (s: string) => ws.send(JSON.stringify({ type: 'data', data: s }));
  // XTGETTCAP (DCS + q <hex-caps> ST): answer "unsupported" for the request.
  const xtgettcap = /\x1bP\+q([0-9A-Fa-f;]*)\x1b\\/g;
  let m: RegExpExecArray | null;
  while ((m = xtgettcap.exec(data))) send(`\x1bP0+q${m[1]}\x1b\\`);
  // XTVERSION (CSI > q): report a name so version-gated code paths degrade.
  if (/\x1b\[>0?q/.test(data)) send('\x1bP>|Strado\x1b\\');
  // Kitty keyboard protocol query (CSI ? u): report "no flags / unsupported".
  if (/\x1b\[\?u/.test(data)) send('\x1b[?0u');
}

// One live pty surface: its own xterm instance + terminal WebSocket, with
// reconnect, fit, drop-to-attach and the "Starting…" overlay. Extracted from
// TerminalView so a split layout can mount several at once — each pane owns
// its session for the pane's lifetime.
export function XtermPane({ wsId, tab, focused, onFocus }: {
  wsId: string;
  tab: PtyTab;
  /** the focused pane receives keyboard focus when it (re)connects */
  focused: boolean;
  /** pointer went down inside this pane — make it the active one */
  onFocus?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // "Starting zsh…" while the pty comes up — only when it takes longer than
  // a blink, so switching between live tabs doesn't flash it.
  const [connecting, setConnecting] = useState<PtyTab['mode'] | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const startMode = tab.mode;
    const connectTimer = window.setTimeout(() => setConnecting(startMode), 250);
    let sawOutput = false;
    const settled = () => {
      if (sawOutput) return;
      sawOutput = true;
      window.clearTimeout(connectTimer);
      setConnecting(null);
      term.write('\x1b[?25h'); // cursor back; the pty's own state overrides
    };

    // Connection state, declared before buildTerm() so the per-terminal input
    // handler it wires can read the live socket at keystroke time.
    let ws: WebSocket | null = null;
    let disposed = false;
    // The pty process ended (server sent "[process exited]" then closed): a
    // deliberate end, so we do NOT reconnect — reconnecting would respawn it.
    let processExited = false;
    let attempts = 0;
    let reconnectTimer: number | undefined;
    // Relay credential for a remote pane. Reusable until it expires, so one
    // ticket normally covers the pane's whole life including reconnects.
    let ticket: { value: string; expiresAt: number } | null = null;
    let authFailures = 0;

    // Per-terminal setup lives in buildTerm() so the ws handlers and fit
    // helpers can be defined against these bindings before the terminal exists.
    let term!: Terminal;
    let fit!: FitAddon;
    let dataSub: { dispose(): void } | undefined;

    const buildTerm = () => {
      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        // term.unicode is proposed API in xterm 6; without this the graphemes
        // addon below throws from activate() and takes the whole render with it.
        allowProposedApi: true,
        // Nerd Font first so devicons/powerline glyphs render; falls back to
        // plain monospace when it isn't installed. Devanagari/CJK families sit
        // AFTER the Latin monospaces on purpose — they also cover ASCII and would
        // otherwise win Latin glyphs and break the monospace grid.
        fontFamily: activeTerminalFont(),
        theme: activeTerminalTheme(),
        // opencode's opentui probes the terminal's pixel/char size (CSI 14t/16t/
        // 18t) at startup; xterm leaves these window-ops off by default. Report-
        // only, safe to enable.
        windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
      });
      termRef.current = term;
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      // Grapheme clustering (Unicode 15) so Devanagari spacing matras stay in one
      // cell. Guarded: experimental upstream, and a throw here runs inside render.
      try {
        term.loadAddon(new UnicodeGraphemesAddon());
      } catch (err) {
        console.warn('[terminal] grapheme clustering unavailable', err);
      }
      // Swallow synchronized-output mode 2026 at the parser so a continuously
      // redrawing TUI can never get xterm stuck buffering paints (blank until a
      // resize). Returning true stops the built-in handler for 2026 only; every
      // other private mode (1049 alt-screen, 25 cursor, 2004 paste, 2027
      // graphemes) returns false and is handled as usual.
      const isSyncMode = (params: (number | number[])[]) => params[0] === 2026;
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => isSyncMode(params));
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => isSyncMode(params));
      // Answer DECRQM (CSI [?] Ps $ p) ourselves and stop xterm's own handler.
      // opencode's opentui probes mode 2026 (synchronized output) at startup
      // with DECRQM; xterm 6.0's requestMode() crashes in our production
      // bundle (a minifier defect leaves the DecRequestModeReportStatus enum's
      // backing variable undeclared → "ReferenceError: r is not defined"), and
      // that uncaught throw aborts the parser mid-write, so the rest of
      // opencode's startup burst never parses and the pane stays blank until a
      // remount. Returning true here means xterm's broken requestMode never
      // runs. Reply per DECRPM: 0=not recognized, 2=reset (supported, off).
      // 2026 is the mode opentui gates its renderer on — report it supported;
      // everything else is "not recognized", a safe answer no TUI treats as
      // fatal. The reply goes back down the pty the terminal writes to.
      const answerDecrqm = (params: (number | number[])[], ansi: boolean) => {
        const raw = params[0];
        const mode = Array.isArray(raw) ? raw[0] : raw;
        const value = mode === 2026 ? 2 : 0;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: `\x1b[${ansi ? '' : '?'}${mode};${value}$y` }));
        }
        return true;
      };
      term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, (p) => answerDecrqm(p, true));
      term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (p) => answerDecrqm(p, false));
      // Ctrl+Shift+C copies the selection (plain Ctrl+C stays SIGINT).
      term.attachCustomKeyEventHandler((e) => {
        if (
          e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
          e.key.toLowerCase() === 'c' && term.hasSelection()
        ) {
          void navigator.clipboard.writeText(term.getSelection());
          e.preventDefault();
          return false;
        }
        return true;
      });
      // Copy-on-select, the Linux terminal convention (Linux only).
      if (window.strado?.platform === 'linux') {
        term.onSelectionChange(() => {
          const sel = term.getSelection();
          if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        });
      }
      term.open(container);
      // Reads `ws` at keystroke time, so input forwarding follows reconnects.
      dataSub = term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });
    };

    buildTerm();
    fit.fit();
    // no lone blinking cursor while the pty starts; settled() shows it again
    term.write('\x1b[?25l');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const remote = tab.remote ?? null;
    // Every pty mode is multi-session; the server defaults a missing session
    // to '1', so sending it is compatible with old servers too.
    const session = `&session=${encodeURIComponent(tab.id)}`;
    // Fitted dims ride the URL so a NEW pty spawns at the right size (resize
    // messages during the server's connection setup are lost); rebuilt per
    // attempt so a reconnect after a resize sizes correctly.
    const buildUrl = (ticket: string | null) => {
      const target = remote ? { wsId: remote.wsId, path: remote.path } : { wsId, path: tab.path };
      const query =
        `ws=${encodeURIComponent(target.wsId)}&path=${encodeURIComponent(target.path)}` +
        `&mode=${tab.mode}${session}&cols=${term.cols}&rows=${term.rows}`;
      return remote
        ? `${remote.wsBase}/ws/terminal?${query}&ticket=${encodeURIComponent(ticket ?? '')}`
        : `${proto}://${location.host}/ws/terminal?${query}`;
    };

    const ensureTicket = async (): Promise<string> => {
      // Re-mint a minute early: a socket that opens and is then rejected costs
      // a whole backoff cycle.
      if (ticket && ticket.expiresAt - Date.now() > 60_000) return ticket.value;
      const minted = await api.runners.socketTicket(remote!.runnerId);
      ticket = { value: minted.ticket, expiresAt: Date.parse(minted.expiresAt) };
      return minted.ticket;
    };

    // Zero-size guard: while an embed tab (VS Code/Browser/KB) is active the
    // split stays mounted but display:none — fitting against a 0×0 box would
    // resize the user's live pty down to minimum dimensions.
    const fitIfVisible = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return false;
      fit.fit();
      return true;
    };

    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    const connect = () => {
      if (!remote) {
        open(null);
        return;
      }
      void (async () => {
        let value: string;
        try {
          value = await ensureTicket();
        } catch (err) {
          // No credential means no socket. That is not a transport blip, so say
          // it plainly instead of spinning in the reconnect loop.
          term.write(`\r\n[cannot get access to ${remote.runnerId}: ${(err as Error).message}]\r\n`);
          settled();
          return;
        }
        if (disposed) return;
        open(value);
      })();
    };

    const open = (ticketValue: string | null) => {
      ws = new WebSocket(buildUrl(ticketValue));
      wsRef.current = ws;
      // The first server message means connection setup finished and resize
      // messages are safe — anything sent earlier (even in onopen) can be
      // dropped while the server handler is still wiring up. Re-announce the
      // fitted size then, covering reattach to a pty another client resized.
      let announced = false;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          // opencode/opentui only: rewrite its OSC 66 cell-measurement probe
          // into plain text so the cursor advances and it reads a real cell
          // width, and answer the capability probes it blocks on. Other modes
          // pass through untouched (2026 is swallowed at the parser for all).
          if (tab.mode === 'opencode') {
            term.write(renderSizedText(ev.data));
            answerCapabilityProbes(ev.data, ws);
          } else if (tab.mode === 'claude' && terminalUsesLightTheme()) {
            term.write(renderClaudeLight(ev.data));
          } else {
            term.write(ev.data);
          }
          // Server prints exactly this right before closing on pty exit; it's
          // our signal that the close is a real end, not a transport drop.
          if (ev.data.includes('[process exited')) processExited = true;
          if (ev.data) settled(); // first real output: pty is up
        }
        if (!announced) {
          announced = true;
          if (fitIfVisible()) sendResize();
        }
      };
      ws.onopen = () => {
        if (attempts > 0) { term.write('\r\n[reconnected]\r\n'); attempts = 0; }
        authFailures = 0;
        if (fitIfVisible()) sendResize();
        // Never steal focus into a background pane of a split.
        if (focusedRef.current) term.focus();
      };
      ws.onclose = (ev) => {
        settled();
        if (disposed) return;
        if (processExited) { term.write('\r\n[disconnected]\r\n'); return; }
        // 1008 from the relay means the ticket was rejected — a credential
        // problem, which backing off cannot fix. Re-mint once; a second refusal
        // is real (revoked runner, clock skew) and looping would only hammer
        // the API. 1011 means the runner is away, which IS worth retrying.
        if (remote && ev.code === 1008) {
          ticket = null;
          authFailures += 1;
          if (authFailures > 1) {
            term.write(`\r\n[not authorized for ${remote.runnerId} — close and reopen this tab]\r\n`);
            return;
          }
          connect();
          return;
        }
        // Unexpected drop (server restart, network blip): retry with capped
        // exponential backoff, indefinitely while this pane stays mounted.
        attempts += 1;
        if (attempts === 1) {
          // Naming the machine matters: a bare "[disconnected]" on a remote tab
          // reads as "my agent died", when the session is sitting safely on the
          // runner waiting to be reattached.
          term.write(
            remote
              ? `\r\n[${remote.runnerId} unreachable — reconnecting… the session is still running there]\r\n`
              : '\r\n[disconnected — reconnecting…]\r\n',
          );
        }
        const delay = Math.min(1000 * 2 ** (attempts - 1), 10000);
        reconnectTimer = window.setTimeout(() => { if (!disposed) connect(); }, delay);
      };
      // A ws error is always followed by a close, which drives reconnect —
      // just clear the connecting overlay here.
      ws.onerror = () => { settled(); };
    };

    connect();

    const ro = new ResizeObserver(() => { if (fitIfVisible()) sendResize(); });
    ro.observe(container);
    // rAF and fonts.ready are the "layout settled" signals: re-fit and push the
    // size once the font has loaded and the box has its final dimensions, so a
    // pty that spawned against an early measurement gets corrected.
    const raf = requestAnimationFrame(() => {
      if (fitIfVisible()) sendResize();
    });
    document.fonts?.ready.then(() => {
      if (disposed) return;
      if (fitIfVisible()) sendResize();
    });

    return () => {
      disposed = true;
      settled();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataSub?.dispose();
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, tab.path, tab.mode, tab.id, tab.remote?.runnerId, tab.remote?.path]);

  // xterm paints into its own canvas, so CSS variables cannot recolor or
  // remeasure it. Keep mounted panes in sync without reconnecting their PTYs
  // or losing terminal history.
  useEffect(() => {
    const updateAppearance = () => {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = activeTerminalTheme();
      term.options.fontFamily = activeTerminalFont();
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, updateAppearance);
  }, []);

  // Becoming the focused pane moves keyboard focus into this terminal.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div
      data-testid="pane-leaf"
      className="relative h-full w-full min-h-0 min-w-0 bg-zinc-950"
      onPointerDownCapture={onFocus}
      // Drop-to-attach uploads into the LOCAL worktree and types that path, so
      // on a remote pane it would hand the agent a path its machine cannot see.
      // Better to not offer it than to offer a broken version.
      onDragOver={(e) => { if (tab.remote) return; e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
      onDrop={(e) => {
        if (tab.remote) return;
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        void attachDroppedImages(files, {
          upload: (name, dataBase64) => api.worktrees.upload(wsId, tab.path, { name, dataBase64 }),
          sendPath: (p) => wsRef.current?.send(JSON.stringify({ type: 'data', data: p + ' ' })),
        });
      }}
    >
      <div className="h-full w-full p-2">
        {/* padding lives on the wrapper: FitAddon measures the parent's
            border-box height, so padding on the xterm container itself
            over-counts rows and clips the bottom line */}
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {connecting && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4">
          <span className="animate-pulse text-zinc-400">
            {connecting === 'claude' ? <ClaudeIcon size={36} />
            : connecting === 'codex' ? <CodexIcon size={36} />
            : connecting === 'opencode' ? <OpencodeIcon size={36} />
            : <ShellIcon size={36} />}
          </span>
          <span className="text-sm text-zinc-500">
            {connecting === 'claude' ? 'Starting Claude…'
            : connecting === 'codex' ? 'Starting Codex…'
            : connecting === 'opencode' ? 'Starting OpenCode…'
            : 'Starting zsh…'}
          </span>
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded border-2 border-dashed border-sky-500 bg-sky-950/40 text-sm text-sky-200">
          Drop image to attach
        </div>
      )}
    </div>
  );
}
