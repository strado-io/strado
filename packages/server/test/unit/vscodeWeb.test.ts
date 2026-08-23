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
    reapable: [...reapable],
    cleared: false,
    record(e: { pid: number; port: number }) { this.recorded.push(e); },
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
