// A bare terminal for one server-owned pty: no tab, no session, no agent.
// "Add over SSH" uses it for the steps a person must answer (a password, a
// host key, sudo). The server speaks JSON frames only — {type:'data'},
// {type:'exit', code} — so what the remote box prints can never pass for the
// exit. The same xterm look as XtermPane, without its tab machinery.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { activeTerminalFont, activeTerminalTheme } from './XtermPane';

type Frame = { type: 'data'; data: string } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

/** `url`: a ws path on this server (e.g. /ws/ssh-setup-terminal?key=…). */
export function CommandTerminal({ url, onExit, className = '' }: {
  url: string;
  /** Once, when the pty ends (null when the server could not say). */
  onExit?: (code: number | null) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: activeTerminalFont(), theme: activeTerminalTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const fitNow = () => { if (el.clientWidth > 0 && el.clientHeight > 0) { try { fit.fit(); } catch { /* not laid out */ } } };
    fitNow();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sep = url.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${proto}://${location.host}${url}${sep}cols=${term.cols}&rows=${term.rows}`);
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      exitRef.current?.(code);
    };
    const send = (msg: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    ws.onmessage = (e) => {
      let f: Frame;
      try { f = JSON.parse(String(e.data)) as Frame; } catch { return; }
      if (f.type === 'data') term.write(f.data);
      else if (f.type === 'exit') exit(f.code);
      else if (f.type === 'error') term.write(`\r\n\x1b[2m${f.message}\x1b[0m\r\n`);
    };
    // A socket that drops without an exit frame is an unknown ending, not a success.
    ws.onclose = () => exit(null);
    const input = term.onData((data) => send({ type: 'data', data }));
    const ro = new ResizeObserver(() => { fitNow(); send({ type: 'resize', cols: term.cols, rows: term.rows }); });
    ro.observe(el);
    term.focus();
    return () => {
      exited = true; // unmount is not an exit the caller should act on
      ro.disconnect();
      input.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [url]);

  return <div ref={box} data-testid="command-terminal" className={`h-full w-full ${className}`} />;
}
