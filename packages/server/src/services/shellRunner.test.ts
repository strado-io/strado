import { beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, type BusEvent } from '../events/bus.js';
import { RUN_MARKER_PREFIX, RUN_OUTPUT_MAX, RUN_TRUNCATED_MARKER } from './intercomSchema.js';
import { INTERCOM_CHANNEL } from './intercomStore.js';
import { ShellRunError, createShellRunner, type ShellRunner } from './shellRunner.js';
import { shellKey } from './terminalManager.js';

type Timer = { fn: () => void; ms: number; cancelled: boolean };
let timers: Timer[];
let writes: [string, string][];
let subs: Map<string, Set<(data: string) => void>>;
let running: boolean;
let writeThrows: boolean;
let input: number;
let clock: number;
let events: BusEvent[];
let runner: ShellRunner;
let bus: ReturnType<typeof createEventBus>;
const KEY = shellKey('/wt', '1');
const OTHER = shellKey('/wt', '2');
const CAP = 15000;
// Fixed through the `marker` seam so the tests can type the sentinel out.
const M = '__strado_done_abcd1234__';

beforeEach(() => {
  timers = []; writes = []; subs = new Map(); running = true; writeThrows = false; input = Infinity; clock = 0; events = [];
  bus = createEventBus();
  bus.on(INTERCOM_CHANNEL, (e) => events.push(e));
  runner = createShellRunner({
    terminal: () => ({
      write: (key, data) => { if (writeThrows) throw new Error('gone'); writes.push([key, data]); },
      status: () => ({ status: running ? 'running' : 'exited', pid: running ? 1 : null, exitCode: null }),
      subscribe: (key, cb) => {
        const set = subs.get(key) ?? new Set();
        set.add(cb); subs.set(key, set);
        return () => { set.delete(cb); };
      },
    }),
    activity: { quiet: () => ({ input, output: Infinity }) },
    bus,
    now: () => clock,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    marker: () => M,
  });
});

const output = (data: string, key = KEY) => { for (const cb of subs.get(key) ?? []) cb(data); };
const live = (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms);
const fire = (ms: number) => { const t = live(ms).at(-1); if (!t) throw new Error(`no live timer for ${ms}`); t.cancelled = true; t.fn(); };
const subscribers = (key = KEY) => subs.get(key)?.size ?? 0;
/** Watch a run without awaiting it, so "still pending" is assertable. */
const track = (p: Promise<unknown>): { settled: boolean } => {
  const state = { settled: false };
  const mark = (): void => { state.settled = true; };
  void p.then(mark, mark);
  return state;
};
const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });
/** The sentinel the shell echoes: at the start of its own line. */
const markerLine = (marker = M) => `${marker}\r\n`;

describe('shellRunner.run', () => {
  it('subscribes before writing command + sentinel + CR, then resolves settled on the sentinel line', async () => {
    const p = runner.run(KEY, 'ls', { timeoutMs: CAP });
    expect(subscribers()).toBe(1);
    expect(writes).toEqual([[KEY, `ls; echo ${M}\r`]]);
    output(`ls; echo ${M}\r\n`);
    output('a  b\r\n');
    clock = 1200;
    output(markerLine());
    output('$ ');                                              // the prompt after it is dropped
    await expect(p).resolves.toEqual({ output: 'ls\na  b\n', settled: true, durationMs: 1200 });
    expect(subscribers()).toBe(0);
    expect(live(CAP)).toEqual([]);
    expect(events).toEqual([{ type: 'shell.run', data: { key: KEY, settled: true, durationMs: 1200, outputBytes: 8 } }]);
  });

  it('finds the sentinel when it is split across two chunks', async () => {
    const p = runner.run(KEY, 'ls', { timeoutMs: CAP });
    output(`ls; echo ${M}\r\n`);
    output('a\r\n');
    output('__strado_do');
    const t = track(p);
    await flush();
    expect(t.settled).toBe(false);
    output('ne_abcd1234__\r\n');
    await expect(p).resolves.toEqual({ output: 'ls\na\n', settled: true, durationMs: 0 });
  });

  it('the sentinel inside the echoed command line does not settle the run; the cap does', async () => {
    const p = runner.run(KEY, 'ls', { timeoutMs: CAP });
    output(`ls; echo ${M}\r\n`);
    const t = track(p);
    await flush();
    expect(t.settled).toBe(false);
    clock = CAP;
    fire(CAP);
    await expect(p).resolves.toEqual({ output: 'ls\n', settled: false, durationMs: CAP });
    expect(subscribers()).toBe(0);
  });

  it('the cap ends the run unsettled with whatever arrived, sentinel stripped from the echo', async () => {
    const p = runner.run(KEY, 'tail -f x', { timeoutMs: 2000 });
    output(`tail -f x; echo ${M}\r\n`);
    output('1\r\n'); output('2\r\n');
    clock = 2000;
    fire(2000);
    await expect(p).resolves.toEqual({ output: 'tail -f x\n1\n2\n', settled: false, durationMs: 2000 });
    expect(subscribers()).toBe(0);
  });

  it('another run\'s nonce does not settle this one', async () => {
    const p = runner.run(KEY, 'grep x', { timeoutMs: CAP });
    output(`grep x; echo ${M}\r\n`);
    output(markerLine('__strado_done_deadbeef__'));            // another run's nonce
    const t = track(p);
    await flush();
    expect(t.settled).toBe(false);
    output(markerLine());
    await expect(p).resolves.toMatchObject({
      output: 'grep x\n__strado_done_deadbeef__\n',
      settled: true,
    });
  });

  it('settles on a sentinel mid-line, and returns output that ended without a newline', async () => {
    const p = runner.run(KEY, 'printf abc', { timeoutMs: CAP });
    output(`printf abc; echo ${M}\r\n`);
    output(`abc${M}\r\n$ `);                                  // no trailing newline before the sentinel
    // The echoed command line is kept, as in every other run; what matters is
    // that the tail is `abc` with nothing after it.
    await expect(p).resolves.toMatchObject({ output: 'printf abc\nabc', settled: true });
  });

  it('does not lose the sentinel when a chunk boundary splits its CRLF', async () => {
    const p = runner.run(KEY, 'ls', { timeoutMs: CAP });
    output(`ls; echo ${M}\r\n`);
    output(`a  b\r\n${M}\r`);                                  // the LF has not arrived yet
    output('\n$ ');
    await expect(p).resolves.toMatchObject({ output: 'ls\na  b\n', settled: true });
  });

  it('settles after a chunk that ended on a bare carriage return', async () => {
    const p = runner.run(KEY, 'dl', { timeoutMs: CAP });
    output(`dl; echo ${M}\r\n`);
    output('12%\r');                                            // a progress line, overwritten below
    output(`45%\r\n${M}\r\n`);
    await expect(p).resolves.toMatchObject({ output: 'dl\n45%\n', settled: true });
  });

  it('ignores the echoed sentinel even when the command line wrapped across a break', async () => {
    const p = runner.run(KEY, 'printf abc', { timeoutMs: CAP });
    output('printf abc; ec');
    output(`\r\nho ${M}\r\n`);                                // the line editor wrapped mid-`echo`
    const t = track(p);
    await flush();
    expect(t.settled).toBe(false);
    output(`abc${M}\r\n$ `);
    const r = await p;
    expect(r.settled).toBe(true);
    // Best effort on the cleanup: the `; echo <marker>` removal cannot span the
    // break, so the wrapped echo stays visible. The settle rule is what matters.
    expect(r.output).toBe(`printf abc; ec\nho ${M}\nabc`);
  });

  it('settles when escapes are interleaved inside the sentinel', async () => {
    const p = runner.run(KEY, 'ls', { timeoutMs: CAP });
    output(`ls; echo ${M}\r\n`);
    output('\x1b[0m__strado_');
    const t = track(p);
    await flush();
    expect(t.settled).toBe(false);
    output('\x1b[0mdone_abcd1234__\r\n');
    await expect(p).resolves.toMatchObject({ settled: true });
  });

  it('finds a sentinel that arrives in the same chunk that trips the in-flight bound', async () => {
    const p = runner.run(KEY, 'a', { timeoutMs: CAP });
    output(`${'x'.repeat(2 * RUN_OUTPUT_MAX)}\r\n${M}\r\n`);   // past the bound, sentinel at the end
    await expect(p).resolves.toMatchObject({ settled: true });
    expect(subscribers()).toBe(0);
  });

  it('BUSY for a second run on the same key; another key runs independently', async () => {
    const first = runner.run(KEY, 'a', { timeoutMs: CAP });
    await expect(runner.run(KEY, 'b', { timeoutMs: CAP })).rejects.toMatchObject({ code: 'BUSY' });
    expect(writes).toEqual([[KEY, `a; echo ${M}\r`]]);
    const other = runner.run(OTHER, 'c', { timeoutMs: CAP });
    expect(writes).toEqual([[KEY, `a; echo ${M}\r`], [OTHER, `c; echo ${M}\r`]]);
    output(`a; echo ${M}\r\n`); output(markerLine());
    output(`c; echo ${M}\r\n`, OTHER); output(markerLine(), OTHER);
    await Promise.all([first, other]);
    // and the key is free again
    void runner.run(KEY, 'd', { timeoutMs: CAP });
    expect(writes.at(-1)).toEqual([KEY, `d; echo ${M}\r`]);
  });

  it('INPUT_BUSY when the user typed recently: no write, no subscription', async () => {
    input = 100;
    await expect(runner.run(KEY, 'a', { timeoutMs: CAP })).rejects.toMatchObject({ code: 'INPUT_BUSY' });
    expect(writes).toEqual([]);
    expect(subscribers()).toBe(0);
  });

  it('NOT_RUNNING when the tab is not running, and when the write itself throws', async () => {
    running = false;
    await expect(runner.run(KEY, 'a', { timeoutMs: CAP })).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    running = true; writeThrows = true;
    await expect(runner.run(KEY, 'a', { timeoutMs: CAP })).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    expect(subscribers()).toBe(0);
    expect(live(CAP)).toEqual([]);
  });

  it('forget(key) mid-run rejects NOT_RUNNING, cleans up, and frees the key', async () => {
    const p = runner.run(KEY, 'a', { timeoutMs: CAP });
    output('partial');
    runner.forget(KEY);
    await expect(p).rejects.toBeInstanceOf(ShellRunError);
    await expect(p).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    expect(subscribers()).toBe(0);
    expect(live(CAP)).toEqual([]);
    expect(events).toEqual([]);
    void runner.run(KEY, 'b', { timeoutMs: CAP });
    expect(writes.at(-1)).toEqual([KEY, `b; echo ${M}\r`]);
  });

  it('forget on an idle key is a no-op', () => {
    expect(() => runner.forget(KEY)).not.toThrow();
  });

  it('strips ANSI and keeps only the last RUN_OUTPUT_MAX bytes behind the marker', async () => {
    const p = runner.run(KEY, 'a', { timeoutMs: CAP });
    output('\x1b[31mred\x1b[0m\r\n');
    output('x'.repeat(RUN_OUTPUT_MAX + 10));
    output(`\r\n${M}\r\n`);
    const r = await p;
    expect(r.settled).toBe(true);
    expect(r.output.startsWith(RUN_TRUNCATED_MARKER)).toBe(true);
    expect(Buffer.byteLength(r.output.slice(RUN_TRUNCATED_MARKER.length))).toBe(RUN_OUTPUT_MAX);
    expect(r.output).not.toContain('\x1b');
    expect(r.output).not.toContain('red');                    // the cut fell after it
    expect(r.output).not.toContain(RUN_MARKER_PREFIX);        // the sentinel line is never returned
    expect((events[0]!.data as { outputBytes: number }).outputBytes).toBe(Buffer.byteLength(r.output));
  });

  it('bounds the buffer while the run is in flight and still returns the byte-exact tail', async () => {
    const p = runner.run(KEY, 'yes', { timeoutMs: CAP });
    const flood = 'y\n'.repeat(RUN_OUTPUT_MAX);                // 2 × RUN_OUTPUT_MAX chars per feed
    output(flood); output(flood); output(flood);
    fire(CAP);
    const r = await p;
    expect(r.settled).toBe(false);
    expect(r.output.startsWith(RUN_TRUNCATED_MARKER)).toBe(true);
    expect(Buffer.byteLength(r.output) - Buffer.byteLength(RUN_TRUNCATED_MARKER)).toBeLessThanOrEqual(RUN_OUTPUT_MAX);
    expect(r.output.endsWith('y\n')).toBe(true);
  });

  it('marks output truncated when the in-flight slice dropped text the final tail would have fit', async () => {
    const p = runner.run(KEY, 'a', { timeoutMs: CAP });
    output(`${'x'.repeat(2 * RUN_OUTPUT_MAX)}\r\n`);           // two chars past the in-flight bound
    output(markerLine());
    const r = await p;
    expect(r.settled).toBe(true);
    expect(r.output.startsWith(RUN_TRUNCATED_MARKER)).toBe(true);
    // The retained text alone is under RUN_OUTPUT_MAX bytes, so tailBytes would
    // not have marked it: the `cut` flag is what says something was lost.
    expect(Buffer.byteLength(r.output.slice(RUN_TRUNCATED_MARKER.length))).toBe(RUN_OUTPUT_MAX - 1);
  });

  it('a throwing bus listener does not break the run', async () => {
    bus.on(INTERCOM_CHANNEL, () => { throw new Error('listener boom'); });
    const p = runner.run(KEY, 'a', { timeoutMs: CAP });
    output(`a; echo ${M}\r\n`);
    output(markerLine());
    await expect(p).resolves.toMatchObject({ settled: true });
  });

  it('generates a fresh sentinel per run when no seam is given', async () => {
    const seen: string[] = [];
    const r = createShellRunner({
      terminal: () => ({
        write: (_key, data) => { seen.push(data); },
        status: () => ({ status: 'running', pid: 1, exitCode: null }),
        subscribe: () => () => {},
      }),
      activity: { quiet: () => ({ input: Infinity, output: Infinity }) },
      bus,
      schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    });
    void r.run(KEY, 'a', { timeoutMs: CAP });
    void r.run(OTHER, 'a', { timeoutMs: CAP });
    const markers = seen.map((w) => w.match(/; echo (\S+)\r$/)?.[1]);
    expect(markers).toHaveLength(2);
    for (const m of markers) expect(m).toMatch(new RegExp(`^${RUN_MARKER_PREFIX}[0-9a-f]{8}__$`));
    expect(markers[0]).not.toBe(markers[1]);
  });
});
