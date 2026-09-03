import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createVsCodeWebManager } from '../../src/services/vscodeWeb.js';

function fakeChild(pid: number) {
  const e = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null };
  e.pid = pid;
  e.exitCode = null;
  return e;
}

function makeStore(reapable: number[] = []) {
  return {
    recorded: [] as Array<{ pid: number; port: number }>,
    history: [] as Array<{ pid: number; port: number }>, // every record(), never pruned
    reapable: [...reapable],
    cleared: false,
    record(e: { pid: number; port: number }) { this.recorded.push(e); this.history.push(e); },
    forget(pid: number) {
      this.recorded = this.recorded.filter((e) => e.pid !== pid);
      this.reapable = this.reapable.filter((p) => p !== pid);
    },
    listReapable() { return this.reapable; },
    clear() { this.reapable = []; this.cleared = true; },
  };
}

function makePortStore(seed?: number) {
  let stored = seed;
  return {
    sets: [] as number[],
    get() { return stored; },
    set(port: number) { stored = port; this.sets.push(port); },
  };
}

function makeManager(overrides: Record<string, unknown> = {}) {
  const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const killed: number[] = [];
  let nextPid = 1000;
  const children: Record<number, ReturnType<typeof fakeChild>> = {};
  const store = ('daemonStore' in overrides ? overrides.daemonStore : makeStore([7777])) as ReturnType<typeof makeStore>;
  const portStore = ('portStore' in overrides ? overrides.portStore : makePortStore()) as ReturnType<typeof makePortStore>;
  const mgr = createVsCodeWebManager({
    findFreePort: async () => 5000 + spawned.length,
    portOpen: async () => true,             // pretend the port comes up instantly
    workbenchReady: async () => true,       // pretend the workbench is served instantly
    cliExists: async () => 'code-insiders', // first candidate wins
    portStore,
    preferredWaitMs: 0,                     // busy preferred port → immediate fallback
    spawn: (file, args, opts) => {
      const pid = ++nextPid;
      spawned.push({ file, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
      const c = fakeChild(pid);
      children[pid] = c;
      return c as unknown as import('node:child_process').ChildProcess;
    },
    killTree: (pid) => { killed.push(pid); },
    daemonStore: store,
    pruneDeadIdeLocks: () => {},
    ensureTsServerMemory: () => {},
    pinnedCommit: () => null,               // never read the real ~/.vscode*/cli cache
    warmDelayMs: 0,
    warmPollMs: 5,
    ...overrides,
  });
  return { mgr, spawned, killed, children, store, portStore };
}

describe('vscode web manager', () => {
  it('spawns ONE shared marked daemon and reuses it across folders', async () => {
    const { mgr, spawned } = makeManager();
    const a = await mgr.ensure('/wt/a');
    const a2 = await mgr.ensure('/wt/a');
    const b = await mgr.ensure('/wt/b');
    expect(spawned).toHaveLength(1);               // one workbench for the app
    expect(a.url).toBe(a2.url);
    expect(a.url).toBe(b.url);                     // same origin → shared user settings
    expect(spawned[0].env.STRADO_SERVE_WEB).toBe('1');
    expect(spawned[0].args).toContain('serve-web');
  });

  it('drop is a no-op — closing one tab must not kill the shared workbench', async () => {
    const { mgr, killed, spawned, store } = makeManager();
    const a = await mgr.ensure('/wt/a');
    await mgr.drop('/wt/a');
    expect(killed).toHaveLength(0);
    expect(store.recorded).toHaveLength(1);        // still tracked for shutdown reap
    const b = await mgr.ensure('/wt/b');           // other tabs keep working
    expect(b.url).toBe(a.url);
    expect(spawned).toHaveLength(1);
  });

  it('records each spawned daemon and forgets it when the child exits', async () => {
    const { mgr, children, store } = makeManager();
    await mgr.ensure('/wt/a');
    const pid = store.recorded[0].pid;
    expect(store.recorded).toHaveLength(1);
    children[pid].exitCode = 0;
    children[pid].emit('exit');
    expect(store.recorded).toHaveLength(0);      // exit handler forgot it
  });

  it('serializes concurrent ensure() calls — even across folders — into one spawn', async () => {
    const { mgr, spawned } = makeManager();
    const [a, b] = await Promise.all([mgr.ensure('/wt/a'), mgr.ensure('/wt/b')]);
    expect(spawned).toHaveLength(1);
    expect(a.url).toBe(b.url);
  });

  it('reapOrphans kills the store-listed reapable pids and clears the store', async () => {
    const { mgr, killed, store } = makeManager();
    await mgr.reapOrphans();
    expect(killed).toContain(7777);
    expect(store.cleared).toBe(true);
    expect(store.listReapable()).toHaveLength(0);
  });

  it('closeAll kills the shared daemon', async () => {
    const { mgr, killed, spawned } = makeManager();
    await mgr.ensure('/wt/a');
    await mgr.ensure('/wt/b');
    await mgr.closeAll();
    expect(killed).toHaveLength(1);                // one shared daemon to kill
    // after closeAll, ensure spawns fresh (not reused)
    await mgr.ensure('/wt/a');
    expect(spawned).toHaveLength(2);
  });

  it('reuses the persisted port when it is free (stable origin = stable user settings)', async () => {
    // serve-web user settings live in browser storage keyed by origin —
    // the port must survive restarts or the workbench starts blank.
    const portStore = makePortStore(6001);
    // portOpen serves two roles: the pre-spawn busy check (must say free) and
    // the post-spawn readiness poll (must say up) — sequence them.
    let calls = 0;
    const { mgr } = makeManager({
      portStore,
      portOpen: async () => calls++ > 0,
    });
    const { url } = await mgr.ensure('/wt/a');
    expect(url).toBe('http://127.0.0.1:6001/');
  });

  it('falls back to a fresh port when the persisted one is taken, and persists the new one', async () => {
    const portStore = makePortStore(6001);
    const { mgr } = makeManager({ portStore }); // harness portOpen => true (busy)
    const { url } = await mgr.ensure('/wt/a');
    expect(url).toBe('http://127.0.0.1:5000/'); // findFreePort's allocation
    expect(portStore.sets).toContain(5000);
  });

  it('persists the first allocated port', async () => {
    const { mgr, portStore } = makeManager();
    await mgr.ensure('/wt/new');
    expect(portStore.sets).toContain(5000);
  });

  it('pins serve-web to the cached commit so boot skips the update download', async () => {
    const sha = 'a'.repeat(40);
    const { mgr, spawned } = makeManager({ pinnedCommit: (cli: string) => (cli === 'code-insiders' ? sha : null) });
    await mgr.ensure('/wt/a');
    const args = spawned[0].args;
    expect(args[args.indexOf('--commit-id') + 1]).toBe(sha);
  });

  it('passes no --commit-id when nothing is cached or the CLI is code-server', async () => {
    const a = makeManager({ pinnedCommit: () => null });
    await a.mgr.ensure('/wt/a');
    expect(a.spawned[0].args).not.toContain('--commit-id');
    const b = makeManager({ cliExists: async () => 'code-server', pinnedCommit: () => 'b'.repeat(40) });
    await b.mgr.ensure('/wt/a');
    expect(b.spawned[0].args).not.toContain('--commit-id');
  });

  it('after a pinned boot, warms the cache with one unpinned throwaway serve-web and kills it once ready', async () => {
    const sha = 'a'.repeat(40);
    let warmProbes = 0;
    const { mgr, spawned, killed, store, children } = makeManager({
      pinnedCommit: () => sha,
      workbenchReady: async (url: string) => (url.includes(':5000/') ? true : ++warmProbes >= 2),
    });
    await mgr.ensure('/wt/a');
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    const warm = spawned[1];
    expect(warm.args).toContain('serve-web');
    expect(warm.args).not.toContain('--commit-id');       // unpinned → fetches the newest build
    expect(warm.args[warm.args.indexOf('--port') + 1]).not.toBe('5000');
    expect(store.history.map((e) => e.port)).toContain(5001);  // reapable if we crash mid-warm
    await vi.waitFor(() => expect(killed).toContain(1002));
    expect(store.recorded.map((e) => e.pid)).not.toContain(1002);
    expect(killed).not.toContain(1001);                   // main workbench untouched
    children[1001].exitCode = 0;                          // main dies → next ensure respawns it…
    children[1001].emit('exit');
    await mgr.ensure('/wt/b');
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(3);                      // …but does NOT warm again this session
  });

  it('closeAll kills a warm-up daemon that is still downloading', async () => {
    const { mgr, spawned, killed, store } = makeManager({
      pinnedCommit: () => 'a'.repeat(40),
      workbenchReady: async (url: string) => url.includes(':5000/'), // warm never turns ready
    });
    await mgr.ensure('/wt/a');
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    await mgr.closeAll();
    expect(killed).toEqual(expect.arrayContaining([1001, 1002]));
    expect(store.recorded).toHaveLength(0);
  });

  it('gives up on the warm-up at the cap and still reaps it', async () => {
    const { mgr, spawned, killed, store } = makeManager({
      pinnedCommit: () => 'a'.repeat(40),
      workbenchReady: async (url: string) => url.includes(':5000/'),
      warmWaitMs: 0,
    });
    await mgr.ensure('/wt/a');
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    await vi.waitFor(() => expect(killed).toContain(1002));
    expect(store.recorded.map((e) => e.pid)).not.toContain(1002);
  });

  it('a warm-up spawn error is contained: no crash, daemon forgotten, workbench untouched', async () => {
    const { mgr, spawned, killed, store, children } = makeManager({
      pinnedCommit: () => 'a'.repeat(40),
      workbenchReady: async (url: string) => url.includes(':5000/'),
      warmWaitMs: 60_000,
    });
    await mgr.ensure('/wt/a');
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    children[1002].emit('error', new Error('spawn EAGAIN'));   // unhandled → would kill the server
    await vi.waitFor(() => expect(store.recorded.map((e) => e.pid)).not.toContain(1002));
    expect(killed).not.toContain(1001);
  });

  it('does not warm when the boot was unpinned (that boot already fetched the newest build)', async () => {
    const { mgr, spawned } = makeManager({ pinnedCommit: () => null });
    await mgr.ensure('/wt/a');
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toHaveLength(1);
  });

  it('prewarm boots the shared workbench at app start and swallows a missing CLI', async () => {
    const ok = makeManager({ portStore: makePortStore(6100) });   // VS Code was opened before
    await ok.mgr.prewarm();
    expect(ok.spawned).toHaveLength(1);
    await ok.mgr.ensure('/wt/a');
    expect(ok.spawned).toHaveLength(1);                   // tab open reuses the prewarmed instance
    const none = makeManager({ cliExists: async () => null, portStore: makePortStore(6100) });
    await expect(none.mgr.prewarm()).resolves.toBeUndefined();
  });

  it('prewarm is a no-op until the user has opened VS Code in Strado at least once', async () => {
    // No persisted port = never opened. Booting serve-web here would pull a
    // 650MB build (and keep a daemon alive) for a feature this user may never use.
    const { mgr, spawned } = makeManager({ portStore: makePortStore() });
    await mgr.prewarm();
    expect(spawned).toHaveLength(0);
  });

  it('reports ready:false while serve-web serves the update placeholder, then re-probes to true', async () => {
    let workbenchUp = false;
    const { mgr } = makeManager({
      workbenchReady: async () => workbenchUp,
      readyWaitMs: 0, // don't sit in the first-boot wait loop
    });
    const first = await mgr.ensure('/wt/a');
    expect(first.ready).toBe(false); // placeholder still up — client keeps its overlay
    workbenchUp = true;
    const second = await mgr.ensure('/wt/a'); // reuse path re-probes readiness
    expect(second.ready).toBe(true);
    expect(second.url).toBe(first.url);
  });

  it('holds the URL back until the workbench stops serving the download placeholder', async () => {
    // serve-web answers on the port immediately but serves a "VS Code Server
    // is downloading…" page while it updates — ensure() must not resolve
    // until the real workbench responds.
    let probes = 0;
    const { mgr } = makeManager({
      workbenchReady: async () => ++probes >= 3, // placeholder twice, then ready
    });
    const { url } = await mgr.ensure('/wt/a');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(probes).toBe(3);
  }, 10_000);
});
