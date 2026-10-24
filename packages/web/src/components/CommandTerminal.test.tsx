import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xt = vi.hoisted(() => ({ terms: [] as FakeTerm[] }));
type FakeTerm = { out: string[]; disposed: boolean; inputs: Set<(d: string) => void>; type(d: string): void };
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    out: string[] = [];
    disposed = false;
    inputs = new Set<(d: string) => void>();
    cols = 80;
    rows = 24;
    constructor() { xt.terms.push(this as unknown as FakeTerm); }
    loadAddon() {}
    open() {}
    focus() {}
    write(s: string) { this.out.push(s); }
    onData(cb: (d: string) => void) { this.inputs.add(cb); return { dispose: () => this.inputs.delete(cb) }; }
    type(d: string) { for (const cb of this.inputs) cb(d); }
    dispose() { this.disposed = true; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('./XtermPane', () => ({ activeTerminalFont: () => 'mono', activeTerminalTheme: () => ({}) }));

class FakeWs {
  static OPEN = 1;
  static all: FakeWs[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(m: string) { this.sent.push(m); }
  close() { this.closed = true; }
  frame(f: object) { act(() => this.onmessage?.({ data: JSON.stringify(f) })); }
}

import { CommandTerminal, keepTranscript } from './CommandTerminal';

beforeEach(() => {
  xt.terms.length = 0;
  FakeWs.all = [];
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

const term = () => xt.terms[0]!;
const typed = (ws: FakeWs) => ws.sent.map((m) => JSON.parse(m) as { type: string; data?: string }).filter((m) => m.type === 'data').map((m) => m.data);

describe('CommandTerminal (one transcript for a whole run)', () => {
  it('writes each line once, in order, as it is appended', () => {
    const { rerender } = render(<CommandTerminal lines={['▸ Connect']} attach={null} />);
    rerender(<CommandTerminal lines={['▸ Connect', 'a\nb']} attach={null} />);
    rerender(<CommandTerminal lines={['▸ Connect', 'a\nb']} attach={null} />);
    expect(term().out).toEqual(['▸ Connect\r\n', 'a\r\nb\r\n']);
  });

  it('a pty attaches to the same xterm: its output appends, keys go to it, and its exit detaches input but keeps the text', () => {
    const onExit = vi.fn();
    const { rerender } = render(<CommandTerminal lines={['▸ Connect']} attach={{ url: '/ws/t?key=k', seq: 1 }} onExit={onExit} />);
    const ws = FakeWs.all[0]!;
    expect(ws.url).toMatch(/\/ws\/t\?key=k&cols=80&rows=24$/);
    ws.frame({ type: 'data', data: 'password: ' });
    term().type('hunter2\r');
    expect(typed(ws)).toEqual(['hunter2\r']);
    ws.frame({ type: 'exit', code: 0 });
    expect(onExit).toHaveBeenCalledWith(0);
    term().type('ignored');
    expect(typed(ws)).toEqual(['hunter2\r']);
    rerender(<CommandTerminal lines={['▸ Connect', '▸ Check machine']} attach={{ url: '/ws/t?key=k', seq: 1 }} onExit={onExit} />);
    expect(term().out).toEqual(['▸ Connect\r\n', 'password: ', '▸ Check machine\r\n']);
    expect(term().disposed).toBe(false);
  });

  it('a second attach (same key, new seq) reuses the xterm: the old socket closes, nothing is cleared', () => {
    const { rerender } = render(<CommandTerminal lines={['one']} attach={{ url: '/ws/t?key=k', seq: 1 }} />);
    FakeWs.all[0]!.frame({ type: 'data', data: 'first pty' });
    rerender(<CommandTerminal lines={['one', 'two']} attach={{ url: '/ws/t?key=k', seq: 2 }} />);
    expect(FakeWs.all[0]!.closed).toBe(true);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.frame({ type: 'data', data: 'second pty' });
    expect(xt.terms).toHaveLength(1);
    expect(term().out).toEqual(['one\r\n', 'first pty', 'two\r\n', 'second pty']);
    term().type('y');
    expect(typed(FakeWs.all[1]!)).toEqual(['y']);
    expect(typed(FakeWs.all[0]!)).toEqual([]);
  });

  it('detaching (attach → null) closes the socket and keeps the text', () => {
    const { rerender } = render(<CommandTerminal lines={['one']} attach={{ url: '/ws/t?key=k', seq: 1 }} />);
    rerender(<CommandTerminal lines={['one']} attach={null} />);
    expect(FakeWs.all[0]!.closed).toBe(true);
    expect(term().disposed).toBe(false);
    expect(term().out).toEqual(['one\r\n']);
  });

  it('pty output can\'t wipe or hide the transcript: resets, screen erases and the alternate screen are dropped', () => {
    expect(keepTranscript('\x1bcA\x1b[2JB\x1b[3JC\x1b[?1049hD\x1b[?1049lE\x1b[?47hF\x1b[?1047lG')).toBe('ABCDEFG');
    expect(keepTranscript('\x1b[1;31mred\x1b[0m \x1b[K \x1b[2K')).toBe('\x1b[1;31mred\x1b[0m \x1b[K \x1b[2K');
    render(<CommandTerminal lines={['▸ Connect']} attach={{ url: '/ws/t?key=k', seq: 1 }} />);
    FakeWs.all[0]!.frame({ type: 'data', data: '\x1b[?1049h\x1b[2Jpassword: ' });
    expect(term().out).toEqual(['▸ Connect\r\n', 'password: ']);
  });
});
