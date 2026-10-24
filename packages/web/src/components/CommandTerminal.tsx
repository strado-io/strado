// One terminal for a whole server-owned run: a transcript the caller appends
// lines to, plus whichever pty the run attaches at the moment. "Add over SSH"
// uses it for every step: step output arrives as lines, and the steps a person
// must answer (a password, a host key, sudo) attach a pty whose output lands
// in the same xterm. Nothing is ever cleared; only a remount (a new run) starts
// fresh. The server speaks JSON frames only — {type:'data'}, {type:'exit',
// code} — so what the remote box prints can never pass for the exit.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { activeTerminalFont, activeTerminalTheme } from './XtermPane';

type Frame = { type: 'data'; data: string } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

/** What a pty may send that would wipe or hide the transcript above it: a full
 * reset (ESC c), erase display/scrollback (CSI 2J / 3J) and the alternate
 * screen (CSI ?47 / ?1047 / ?1049 h|l). Dropped; everything else passes. */
const WIPES = /\x1bc|\x1b\[[23]J|\x1b\[\?(?:47|1047|1049)[hl]/g;
export const keepTranscript = (data: string) => data.replace(WIPES, '');

/** A line for the transcript: xterm wants CRLF. */
const asLine = (text: string) => `${text.replace(/\r?\n/g, '\r\n')}\r\n`;

export function CommandTerminal({ lines, attach, onExit, className = '' }: {
  /** Append-only: lines already written are never rewritten. */
  lines: string[];
  /** The pty to show and type into now (a ws path on this server, e.g.
   *  /ws/ssh-setup-terminal?key=…); a new `seq` is a fresh attach. */
  attach: { url: string; seq: number } | null;
  /** When the attached pty ends (null when the server could not say). */
  onExit?: (code: number | null) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const written = useRef(0);
  const sendRef = useRef<(msg: object) => void>(() => {});
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new Terminal({ cursorBlink: true, convertEol: false, fontSize: 13, fontFamily: activeTerminalFont(), theme: activeTerminalTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const fitNow = () => { if (el.clientWidth > 0 && el.clientHeight > 0) { try { fit.fit(); } catch { /* not laid out */ } } };
    fitNow();
    termRef.current = term;
    written.current = 0;
    const ro = new ResizeObserver(() => { fitNow(); sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows }); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      termRef.current = null;
      term.dispose();
    };
  }, []);

  // Transcript lines, in order, each once.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    for (; written.current < lines.length; written.current++) term.write(asLine(lines[written.current]!));
  }, [lines]);

  // The live pty: its output appends; keystrokes go to it until it exits.
  const seq = attach?.seq;
  const url = attach?.url;
  useEffect(() => {
    const term = termRef.current;
    if (!term || !url) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sep = url.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${proto}://${location.host}${url}${sep}cols=${term.cols}&rows=${term.rows}`);
    let ended = false;
    const send = (msg: object) => { if (!ended && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    sendRef.current = send;
    const input = term.onData((data) => send({ type: 'data', data }));
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      input.dispose(); // detach the keyboard; the text stays
      exitRef.current?.(code);
    };
    ws.onmessage = (e) => {
      let f: Frame;
      try { f = JSON.parse(String(e.data)) as Frame; } catch { return; }
      if (f.type === 'data') term.write(keepTranscript(f.data));
      else if (f.type === 'exit') end(f.code);
      else if (f.type === 'error') term.write(`\r\n\x1b[2m${f.message}\x1b[0m\r\n`);
    };
    // A socket that drops without an exit frame is an unknown ending, not a success.
    ws.onclose = () => end(null);
    term.focus();
    return () => {
      ended = true; // a newer attach or unmount is not an exit the caller acts on
      input.dispose();
      sendRef.current = () => {};
      ws.onclose = null;
      ws.close();
    };
  }, [url, seq]);

  return <div ref={box} data-testid="command-terminal" className={`h-full w-full ${className}`} />;
}
