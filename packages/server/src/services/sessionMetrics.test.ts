import { describe, expect, it } from 'vitest';
import { buildSessionMetrics, parsePsOutput, sessionKeyOf, subtreeTotals } from './sessionMetrics.js';

// `ps -Ao pid=,ppid=,%cpu=,rss=` — rss in KB, columns right-aligned.
const PS = `
    1     0   0.0  15000
  100     1   0.5  50000
  200   100   3.2  80000
  201   200   1.0  20000
  300     1   0.1   4000
  400   100  10.0 120000
`;

describe('parsePsOutput', () => {
  it('parses pid, ppid, cpu and rss, skipping blank and malformed lines', () => {
    const procs = parsePsOutput(PS + '\ngarbage line here\n');
    expect(procs).toHaveLength(6);
    expect(procs[2]).toEqual({ pid: 200, ppid: 100, cpu: 3.2, rssKb: 80000 });
  });
});

describe('subtreeTotals', () => {
  it('sums the root and every descendant, not siblings', () => {
    const procs = parsePsOutput(PS);
    // 200 → 201 only; 400 is a sibling under 100.
    expect(subtreeTotals(procs, 200)).toEqual({ cpu: 4.2, rssBytes: 100000 * 1024, processes: 2 });
    // 100 → 200 → 201, plus 400.
    expect(subtreeTotals(procs, 100)).toEqual({ cpu: 14.7, rssBytes: 270000 * 1024, processes: 4 });
  });
  it('reports zeros for a pid that is not in the sample', () => {
    expect(subtreeTotals(parsePsOutput(PS), 999)).toEqual({ cpu: 0, rssBytes: 0, processes: 0 });
  });
});

describe('sessionKeyOf', () => {
  it('rebuilds the manager key for legacy id-1 and suffixed sessions', () => {
    expect(sessionKeyOf({ path: '/wt/a', mode: 'claude', id: '1' })).toBe('/wt/a');
    expect(sessionKeyOf({ path: '/wt/a', mode: 'shell', id: '1' })).toBe('/wt/a\0shell');
    expect(sessionKeyOf({ path: '/wt/a', mode: 'shell', id: '2' })).toBe('/wt/a\0shell:2');
    expect(sessionKeyOf({ path: '/wt/a', mode: 'codex', id: '3' })).toBe('/wt/a\0codex:3');
  });
});

describe('buildSessionMetrics', () => {
  it('rolls up each live session by its pty pid and reports the server and daemon', () => {
    const procs = parsePsOutput(PS);
    const live = [
      { path: '/wt/a', mode: 'claude' as const, id: '1' },
      { path: '/wt/a', mode: 'shell' as const, id: '1' },
    ];
    const pids: Record<string, number | null> = { '/wt/a': 200, '/wt/a\0shell': 400 };
    const out = buildSessionMetrics({
      live,
      pidOf: (key) => pids[key] ?? null,
      procs,
      serverPid: 100,
      daemonPid: 300,
      now: 1234,
    });
    expect(out.sampledAt).toBe(1234);
    expect(out.app.server).toEqual({ pid: 100, cpu: 0.5, rssBytes: 50000 * 1024 });
    expect(out.app.daemon).toEqual({ pid: 300, cpu: 0.1, rssBytes: 4000 * 1024 });
    expect(out.sessions).toEqual([
      { key: '/wt/a', path: '/wt/a', mode: 'claude', id: '1', pid: 200, cpu: 4.2, rssBytes: 100000 * 1024, processes: 2 },
      { key: '/wt/a\0shell', path: '/wt/a', mode: 'shell', id: '1', pid: 400, cpu: 10, rssBytes: 120000 * 1024, processes: 1 },
    ]);
  });
  it('keeps a session with no pid or no matching process, at zero', () => {
    const out = buildSessionMetrics({
      live: [{ path: '/wt/b', mode: 'pi', id: '1' }],
      pidOf: () => null,
      procs: [],
      serverPid: 1,
      daemonPid: null,
      now: 0,
    });
    expect(out.app.daemon).toBeNull();
    expect(out.sessions[0]).toMatchObject({ pid: null, cpu: 0, rssBytes: 0, processes: 0 });
  });

  it('reports the shared VS Code serve-web tree under app.vscode, null when not running', () => {
    const procs = parsePsOutput(PS);
    const withIt = buildSessionMetrics({
      live: [], pidOf: () => null, procs, serverPid: 1, daemonPid: null, vscodePid: 100, now: 0,
    });
    // 100 → 200 → 201, plus 400
    expect(withIt.app.vscode).toEqual({ pid: 100, cpu: 14.7, rssBytes: 270000 * 1024, processes: 4 });
    const without = buildSessionMetrics({ live: [], pidOf: () => null, procs, serverPid: 1, daemonPid: null, vscodePid: null, now: 0 });
    expect(without.app.vscode).toBeNull();
  });
});
