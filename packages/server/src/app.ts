import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createEventBus, EventBus } from './events/bus.js';
import { createJobQueue, JobQueue } from './services/jobs.js';
import { createGitWorktreeService, GitWorktreeService } from './services/gitWorktree.js';
import { createNodeModulesLinkService, NodeModulesLinkService } from './services/nodeModulesLink.js';
import { createProcessManager, ProcessManager } from './services/processManager.js';
import { createDevProxy, type DevProxy } from './services/devProxy.js';
import { createDebugLog, DebugLog } from './services/debugLog.js';
import { createTerminalManager, isRunKey, isSetupKey, parseSessionKey, sessionsPayload, TerminalManager } from './services/terminalManager.js';
import { createDaemonTerminalManager } from './services/ptyDaemon/manager.js';
import { createGitStatusService, GitStatusService } from './services/gitStatus.js';
import { createAgentStatusStore, ClaudeStatusStore } from './services/claudeStatusStore.js';
import { createGitChangesService, GitChangesService } from './services/gitChanges.js';
import { createLspManager, type LspManager } from './services/lsp/manager.js';
import { createDetect } from './services/lsp/detect.js';
import { createLspEnabledStore } from './services/lsp/store.js';
import { createEditors, type Editors } from './services/editors/open.js';
import { createEditorStore } from './services/editors/store.js';
import type { FocusJarvisRunner } from './routes/focusJarvis.js';
import { createActivityTracker, createAgentOutputBeats, ActivityTracker } from './services/activityTracker.js';
import { createWorktreeWatcher, WorktreeWatcher } from './services/activityWatcher.js';
import { createDiffStatsCache, DiffStatsCache } from './services/diffStatsCache.js';
import { ZodError } from 'zod';
import { toResponse, AppError } from './errors.js';
import { runMigration } from './migration.js';
import { createWorkspaceConfigStore, WorkspaceConfigStore } from './workspaceConfig.js';
import { createWorkspaceStoreRegistry, WorkspaceStoreRegistry } from './workspaceRegistry.js';
import { detectRuntime, sandboxEnabled, type SandboxRuntime } from './services/sandbox/runtime.js';
import { createSandboxService, type SandboxService } from './services/sandbox/sandboxes.js';
import { createSandboxSlugMap, hydrateSandboxSlugs, type SandboxSlugMap } from './services/sandbox/slugMap.js';
import { sandboxProcessWrapper, sandboxSpecWrapper } from './services/sandbox/spec.js';
import { startHookSocket } from './services/sandbox/hookSocket.js';
import { createLastActivityTracker, portAccepts, startParkSweep } from './services/sandbox/park.js';
import { resolveProfile } from './profile.js';
import { createAgentSessionRegistry, type AgentSessionRegistry } from './services/agentSessionRegistry.js';
import { createAgentRegistry, type AgentRegistry } from './services/agentRegistry.js';
import { createDisabledIntercomStore, createIntercomStore, INTERCOM_CHANNEL, type IntercomStore } from './services/intercomStore.js';
import { createTurnDiary, type TurnDiary } from './services/turnDiary.js';
import { createPtyActivity, type PtyActivity } from './services/ptyActivity.js';
import { createAgentControl, type AgentControl } from './services/agentControl.js';
import { createIntercomPush, type IntercomPush } from './services/intercomPush.js';
import { createShellRunner, type ShellRunner } from './services/shellRunner.js';
import { createUiClients, type UiClients } from './services/uiClients.js';
import { createSpawnGuard, type SpawnGuard } from './services/spawnGuard.js';
import { createJarvisModel, type JarvisModel } from './services/jarvisModel.js';
import { createJevRouter, type JevRouter } from './services/jevRouter.js';
import { PUSH_ENV } from './services/intercomSchema.js';
import { claudeProjectDir, createParkStore, hasBackgroundJobs, noTranscriptSince, parkMinutesFromEnv, processStartMs, startClaudeParkSweep, type ParkStore } from './services/claudePark.js';

export type Deps = {
  workspaces: WorkspaceConfigStore;
  registry: WorkspaceStoreRegistry;
  bus: EventBus;
  jobs: JobQueue;
  git: GitWorktreeService;
  link: NodeModulesLinkService;
  proc: ProcessManager;
  devProxy: DevProxy;
  terminal: TerminalManager;
  status: GitStatusService;
  claudeStatus: ClaudeStatusStore;
  codexStatus: ClaudeStatusStore;
  opencodeStatus: ClaudeStatusStore;
  piStatus: ClaudeStatusStore;
  agentSessions: AgentSessionRegistry;
  // Intercom step 1: agent identity, executions, tokens, aliases. Built before the
  // terminal managers so it can hand them an env record at spawn.
  agents: AgentRegistry;
  // Intercom step 3: the durable inbox. Fail-soft — a Node without
  // node:sqlite, or an unopenable file, yields a disabled store whose routes
  // answer 503 while everything else in the server keeps working.
  intercom: IntercomStore;
  // Intercom step 4b: per-turn diary extracted from harness transcripts on the
  // status posts. Read-only for peers; never pushed into a context.
  turnDiary: TurnDiary;
  // Intercom step 5: per-PTY quiet clocks and the push-a-nudge service. The
  // pusher writes ONE line into an idle Claude tab; the hook path delivers.
  ptyActivity: PtyActivity;
  // Mission control: agents' live tool lines and the permission requests they hold for the human.
  agentControl: AgentControl;
  intercomPush: IntercomPush;
  shellRunner: ShellRunner;
  // App control: the server → window command channel (splits, focus, Browser
  // tabs are client-only state) and the guard every agent_spawn passes.
  uiClients: UiClients;
  spawnGuard: SpawnGuard;
  // Jarvis (the hub's command box) acts as the human through unauthenticated
  // /api/w routes; this per-boot secret, handed only to a loopback hub, is
  // what those routes check on top of the Origin/Host guard.
  hubToken: string;
  // Jarvis natural language: the box's free text → a plan of registry actions,
  // through the user's own Anthropic key. Injectable so tests never call out.
  jarvisModel: JarvisModel;
  /** Fast single-action decisions (Jev on OpenRouter) tried before the model. */
  jevRouter: JevRouter;
  // Provider-native conversation stores live under the user's home. Kept
  // separate from homeStateDir (~/.strado) and overridable in tests.
  agentHomeDir: string;
  gitChanges: GitChangesService;
  /** Language servers for the Files tab; built in buildApp unless a test injects one. */
  lsp?: LspManager;
  /** Open in editor; built in buildApp unless a test injects one. */
  editors?: Editors;
  /** Focus Jarvis turn runner; tests inject a fake. */
  jarvis?: FocusJarvisRunner;
  activity: ActivityTracker;
  activityWatch: WorktreeWatcher;
  // Worktree-list diff badges, cached on file/git changes (see diffStatsCache).
  diffStats: DiffStatsCache;
  // Idle Claude tabs whose process was stopped to free memory (claudePark.ts).
  // Their idle clock is ptyActivity's last input/output per session.
  parked: ParkStore;
  debugLog: DebugLog;
  // Per-machine state root (~/.strado). Routes need it for state that is NOT
  // per-workspace — the sandbox bare clones live under it.
  homeStateDir: string;
  // Probed once at boot; null on the desktop and on runners without
  // podman/docker installed.
  sandboxRuntime: SandboxRuntime | null;
  // Non-null ONLY on a runner (STRADO_RUNNER=1) that has a runtime. Every
  // sandbox-aware code path branches on this one field, so a desktop keeps
  // exactly the behavior it has always had.
  sandbox: SandboxService | null;
  // Which worktrees have a container, synchronously — terminals spawn from a
  // sync BuildSpec and cannot read state.json. Hydrated at boot, maintained
  // by the worktree create/delete routes. Stays empty on a desktop, where
  // nothing consults it.
  sandboxSlugs: SandboxSlugMap;
  // Host path of the hook socket bind-mounted into each sandbox — non-null
  // only when `sandbox` is, and only if the socket actually came up.
  sandboxSocketPath: string | null;
  // Shuts that socket down and unlinks it. Owned here because the socket is
  // built with the deps; called from the app's onClose hook.
  closeSandboxSocket: (() => Promise<void>) | null;
  // Last real terminal activity (keystroke/output) per worktree, for the
  // idle-parking sweep. Independent of `activity` above: that tracker only
  // counts time while an agent is 'working' and throttles to one beat per
  // 30s — too coarse to know whether a worktree has been touched at all.
  // Always non-null so buildApp doesn't need a separate null check; the
  // sweep itself only starts when `sandbox` is non-null.
  sandboxLastActivity: (worktreePath: string) => number | null;
  // Clears a worktree's recorded activity. Worktree paths are deterministic
  // (worktreesDir + buildWorktreeSlug(ticketId, title)), so deleting a
  // worktree and recreating one for the same ticket/title lands at the
  // IDENTICAL path — the delete route MUST call this alongside its other
  // per-worktree cleanup (state.remove, sandboxSlugs.delete, activity.remove,
  // activityWatch.remove), or the new sandbox inherits a stale timestamp and
  // can be parked on its very first sweep tick.
  forgetSandboxActivity: (worktreePath: string) => void;
};

export type AppOptions = {
  configDir?: string;
  homeStateDir?: string;
  agentHomeDir?: string;
};

// The built daemon bundle. Packaged app: next to the server bundle
// (scripts/package-mac.mjs copies it there). Dev/repo: the ptyd workspace's
// dist. STRADO_PTYD_SCRIPT overrides both.
function resolvePtydScript(): string {
  if (process.env.STRADO_PTYD_SCRIPT) return process.env.STRADO_PTYD_SCRIPT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Both dev (packages/server/src) and built (packages/server/dist) sit one
  // level under packages/server, so a single ../../ candidate covers both.
  const candidates = [
    path.join(here, 'ptyd.cjs'), // packaged: same dir as server bundle
    path.resolve(here, '../../ptyd/dist/ptyd.cjs'), // repo: packages/ptyd/dist
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`ptyd bundle not found; run: npm run build -w packages/ptyd (looked at ${candidates.join(', ')})`);
}

export async function buildDeps(options: AppOptions = {}): Promise<Deps> {
  const configDir = options.configDir ?? path.join(process.cwd(), 'config');
  const defaultHome = path.join(os.homedir(), '.strado');
  const homeStateDir = options.homeStateDir ?? defaultHome;
  await runMigration({ configDir, homeStateDir });
  const workspaces = createWorkspaceConfigStore(path.join(configDir, 'workspaces.json'));
  const registry = createWorkspaceStoreRegistry(workspaces, configDir);
  const bus = createEventBus();
  const claudeStatus = createAgentStatusStore(bus, 'claudeStatus');
  const codexStatus = createAgentStatusStore(bus, 'codexStatus');
  const opencodeStatus = createAgentStatusStore(bus, 'opencodeStatus');
  const piStatus = createAgentStatusStore(bus, 'piStatus');
  const agentSessions = createAgentSessionRegistry(path.join(homeStateDir, 'agent-sessions.json'));
  const activity = createActivityTracker(path.join(homeStateDir, 'activity.json'));
  const gitChanges = createGitChangesService();
  // File saves (any editor) beat the activity clock; worktree paths are
  // registered as the /worktrees listing discovers them.
  const activityWatch = createWorktreeWatcher({ touch: (p) => activity.touch(p) });
  const debugLog = createDebugLog(process.env.STRADO_LOG_DIR || path.join(homeStateDir, 'logs'));
  // Declared ahead of the callbacks below: onTerminalExit closes over
  // `terminal`, which isn't assigned until after createDaemonTerminalManager
  // resolves. That callback CAN fire before the assignment — a boot-time
  // daemon upgrade/resync runs inside the constructor and may report exits —
  // so the binding is optional and onTerminalExit bails out while it's unset
  // (reading it before assignment would be a TDZ ReferenceError).
  let terminal: TerminalManager | undefined;
  // Assigned once the intercom pusher is created below, further down than
  // onTerminalExit is defined — same reason `terminal` above is optional.
  let intercomPush: IntercomPush | undefined;
  let shellRunner: ShellRunner | undefined;
  // Built right away — it only needs homeStateDir and bus — and specifically
  // BEFORE agents.reconcile() below: reconcile can drop executions whose
  // session died while the server was down, and the onDropped callback must
  // have a real store to release their task claims into, or those claims
  // never get released (the sweep does not release claims, only expire rows).
  let intercom: IntercomStore | undefined;
  const intercomFile = path.join(homeStateDir, 'intercom.sqlite');
  try {
    intercom = await createIntercomStore({ file: intercomFile, bus });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[intercom] disabled: could not open ${intercomFile}: ${reason}`);
    intercom = createDisabledIntercomStore(reason);
  }
  const liveIntercom: IntercomStore = intercom;
  // `terminal` is assigned further down; the registry reads it lazily so it
  // can be constructed first and handed to the managers.
  const agents = await createAgentRegistry({
    executionsFile: path.join(homeStateDir, 'agent-executions.json'),
    namesFile: path.join(homeStateDir, 'agent-names.json'),
    terminal: () => terminal ?? null,
    statuses: () => ({ claude: claudeStatus, codex: codexStatus, opencode: opencodeStatus, pi: piStatus }),
    bus,
    // Declared below (a const); only ever called from list(), long after boot.
    quiet: (key) => ptyActivity.quiet(key),
    onDropped: (dropped) => {
      const store = intercom;
      if (!store) return;
      for (const { execution, agentStillLive } of dropped) {
        try {
          store.releaseClaimsOf(execution.executionId);
          if (!agentStillLive) store.retargetOpenAsksTo(execution.scopeId, execution.agentId);
        } catch (err) {
          debugLog.log('intercom', `release on drop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  });
  const onTerminalData = createAgentOutputBeats({
    touch: (p) => activity.touch(p),
    agentStatus: (mode, p) =>
      (mode === 'claude' ? claudeStatus
      : mode === 'codex' ? codexStatus
      : mode === 'opencode' ? opencodeStatus
      : piStatus).get(p),
    shellAgentWorking: (p, id) => {
      const key = `shell:${id}`;
      return [claudeStatus, codexStatus, opencodeStatus, piStatus]
        .some((store) => store.sessions(p)[key] === 'working');
    },
  });
  // Idle-parking's own activity clock: every pty data event counts, for
  // every session mode, with no throttle or 'working'-state gate — a plain
  // shell filling the screen with output is real use even though it never
  // beats the hands-on-time tracker above.
  const sandboxActivity = createLastActivityTracker();
  const sandboxLastActivity = (worktreePath: string): number | null => sandboxActivity.get(worktreePath);
  const forgetSandboxActivity = (worktreePath: string): void => sandboxActivity.forget(worktreePath);
  const ptyActivity = createPtyActivity();
  const parked = createParkStore(path.join(homeStateDir, 'parked-sessions.json'));
  const onData = (key: string) => {
    // An "Add over SSH" pty belongs to its setup job: no worktree, no agent.
    if (isSetupKey(key)) return;
    ptyActivity.noteOutput(key);
    sandboxActivity.touch(parseSessionKey(key).path);
    onTerminalData(key);
  };
  // Any session exit (crash, or a force-kill that lands after the client's
  // WS already closed) must refresh that worktree's session badges, so the
  // palette/dashboard don't keep showing a dead agent as live.
  const onTerminalExit = (key: string) => {
    // The Run terminal is the process manager's, not a tab or an agent.
    if (isRunKey(key)) return;
    if (isSetupKey(key)) return;
    // Idempotent; the terminal route's own exit handler may also call it.
    void agents.release(key);
    ptyActivity.forget(key);
    intercomPush?.forget(key);
    shellRunner?.forget(key);
    const { path: p, mode, id } = parseSessionKey(key);
    // A Shell tab's hand-launched agents die with it. The terminal route clears
    // them too, but only while a socket is attached; a shell that exits after
    // its tab closed would otherwise leave e.g. `shell:1` marked as Pi, and the
    // next Shell 1 would open wearing the Pi icon.
    if (mode === 'shell') {
      for (const store of [claudeStatus, codexStatus, opencodeStatus, piStatus]) store.remove(p, `shell:${id}`);
    }
    if (!terminal) return; // manager still constructing — sessions can't have UI subscribers yet
    const live = terminal.liveSessions().filter((s) => s.path === p);
    bus.emit('worktrees', {
      type: 'worktree.updated',
      data: { path: p, ...sessionsPayload(live, parked.idsFor(p)) },
    });
  };
  // Probed once, at boot: /api/capabilities advertises it and worktree
  // creation branches on it. Never installs anything — a missing binary just
  // leaves this null, which is the desktop's normal state.
  //
  // Ahead of the terminal manager, which needs the runtime to route sessions
  // into containers.
  const sandboxRuntime = await detectRuntime(undefined, (line) => debugLog.log("server", line));
  if (sandboxRuntime && process.env.STRADO_RUNNER === "1" && process.env.STRADO_SANDBOX === "0") {
    debugLog.log("server", `sandboxing disabled by STRADO_SANDBOX=0 (${sandboxRuntime.bin} is available)`);
  }
  const sandbox =
    sandboxRuntime && sandboxEnabled(sandboxRuntime)
      ? createSandboxService(sandboxRuntime, { stateDir: homeStateDir })
      : null;
  const sandboxSlugs = createSandboxSlugMap();
  if (sandbox) {
    // Awaited: a client can attach a terminal within milliseconds of boot,
    // and a session that spawns before hydration would land on the host —
    // outside the sandbox that exists for it.
    await hydrateSandboxSlugs(sandboxSlugs, {
      workspaces,
      stores: (wsId) => registry.get(wsId),
      onError: (wsId, err) =>
        debugLog.log('server', `sandbox slug hydration skipped workspace ${wsId}: ${err.message}`),
    });
  }
  // The hook socket. Agent hooks inside a container cannot reach the host's
  // loopback, so they post to this instead — see hookSocket.ts for why it is a
  // narrow forwarder rather than a second listener on the app.
  //
  // Started only when sandboxing is on: a desktop never creates the file.
  let sandboxSocketPath: string | null = null;
  let closeSandboxSocket: (() => Promise<void>) | null = null;
  if (sandbox) {
    // Its own directory, holding nothing else: containers bind-mount the
    // DIRECTORY (sandboxes.ts), not the socket file. A file mount pins the
    // inode, and every restart here unlinks and recreates the socket — so a
    // running sandbox kept talking to a dead socket until it was restarted.
    // The basename is fixed by the in-container path (/run/strado/api.sock).
    const socketPath = path.join(homeStateDir, 'sandbox', 'sock', 'api.sock');
    try {
      // The port the app is about to listen on: index.ts resolved the profile
      // and normalised it onto the env before importing this module.
      closeSandboxSocket = await startHookSocket({ socketPath, targetPort: resolveProfile().port });
      sandboxSocketPath = socketPath;
    } catch (err) {
      // Never fatal. Without the socket, agents in sandboxes report no status;
      // with a failed boot, nothing runs at all.
      debugLog.log('server', `hook socket unavailable at ${socketPath}: ${(err as Error).message}`);
    }
  }
  // Sandboxed worktrees exec their sessions inside the container; everything
  // else spawns exactly as before. undefined on a desktop, so both managers
  // keep byte-for-byte today's behavior.
  const wrapSpec =
    sandbox && sandboxRuntime
      ? sandboxSpecWrapper({ rt: sandboxRuntime, isSandboxed: (cwd) => sandboxSlugs.slugOf(cwd) })
      : undefined;
  // Terminals live in the strado-ptyd daemon so they survive server
  // restarts and self-updates. STRADO_INPROC_PTY=1 keeps the old in-process
  // manager — used by the test suite and as a break-glass fallback.
  terminal =
    process.env.STRADO_INPROC_PTY === '1'
      ? createTerminalManager(undefined, onData, onTerminalExit, wrapSpec, agents.envFor)
      : await createDaemonTerminalManager({
          stateDir: homeStateDir,
          daemonScript: resolvePtydScript(),
          onData,
          onExit: onTerminalExit,
          wrapSpec,
          extraEnv: agents.envFor,
        });
  // ptyd kept sessions alive across our restart; align the registry with
  // what is actually running before any route can observe it. The intercom
  // store already exists (see above), so onDropped can release claims for
  // whatever reconcile() drops right here.
  await agents.reconcile();
  const agentHomeDir = options.agentHomeDir ?? os.homedir();
  const turnDiary = createTurnDiary({
    agents, agentSessions, intercom: liveIntercom, homeDir: agentHomeDir,
    log: (message, err) => debugLog.log('intercom', `${message}: ${err instanceof Error ? err.message : String(err)}`),
  });
  const liveTerminal: TerminalManager = terminal;
  intercomPush = createIntercomPush({
    agents,
    intercom: liveIntercom,
    terminal: () => liveTerminal,
    activity: ptyActivity,
    bus,
    enabled: () => process.env[PUSH_ENV] !== '0',
    log: (message, err) => debugLog.log('intercom', `${message}: ${err instanceof Error ? err.message : String(err)}`),
  });
  shellRunner = createShellRunner({
    terminal: () => liveTerminal,
    activity: ptyActivity,
    bus,
    log: (message, err) => debugLog.log('intercom', `${message}: ${err instanceof Error ? err.message : String(err)}`),
  });
  // Arrival trigger: a message queued for an idle Claude tab is pushed at once.
  bus.on(INTERCOM_CHANNEL, (evt) => {
    if (evt.type !== 'message.queued') return;
    const data = evt.data as { scopeId?: unknown; to?: unknown };
    if (typeof data.scopeId === 'string' && typeof data.to === 'string') void intercomPush.consider(data.scopeId, data.to, 'arrival');
  });
  const deps: Deps = {
    workspaces,
    registry,
    bus,
    jobs: createJobQueue(bus),
    git: createGitWorktreeService(),
    link: createNodeModulesLinkService(),
    proc: createProcessManager(
      bus,
      debugLog,
      // Dev servers of sandboxed worktrees run inside their container.
      sandbox && sandboxRuntime
        ? sandboxProcessWrapper({ rt: sandboxRuntime, isSandboxed: (cwd) => sandboxSlugs.slugOf(cwd) })
        : undefined,
      // Run in the worktree's Run terminal (a tab in the hub), not a piped child.
      // Read at start time: the routes' terminal is deps.terminal (tests swap it).
      () => deps.terminal,
    ),
    devProxy: createDevProxy(debugLog),
    terminal,
    status: createGitStatusService(),
    claudeStatus,
    codexStatus,
    opencodeStatus,
    piStatus,
    agentSessions,
    agents,
    intercom: liveIntercom,
    turnDiary,
    ptyActivity,
    agentControl: createAgentControl({
      // The hub's stations refetch on it (routes/events.ts forwards `station.changed`).
      onChange: (scopeId, agentId) => bus.emit(INTERCOM_CHANNEL, { type: 'station.changed', data: { scopeId, agentId } }),
    }),
    intercomPush,
    shellRunner,
    uiClients: createUiClients(),
    hubToken: randomBytes(32).toString('base64url'),
    jarvisModel: createJarvisModel({ log: (message) => debugLog.log('jarvis', message) }),
    jevRouter: createJevRouter({ log: (message) => debugLog.log('jarvis', message) }),
    spawnGuard: createSpawnGuard({
      isLive: async (scopeId, executionId) => (await agents.list(scopeId)).some((a) => a.executionId === executionId && a.live),
      file: path.join(homeStateDir, 'spawn-markers.json'),
      log: (message) => debugLog.log('app-control', message),
    }),
    agentHomeDir,
    gitChanges,
    activity,
    activityWatch,
    diffStats: createDiffStatsCache({
      shortStat: (p) => gitChanges.shortStat(p),
      version: (p) => activityWatch.version(p),
    }),
    debugLog,
    homeStateDir,
    sandboxRuntime,
    sandbox,
    sandboxSlugs,
    sandboxSocketPath,
    closeSandboxSocket,
    sandboxLastActivity,
    forgetSandboxActivity,
    parked,
  };
  return deps;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  // Two lines per request, at ~40 requests/min, is how server.log reached
  // 180 MB on a normal workstation — and none of it was ever read. App-level
  // logs (startup, errors) stay at info; set STRADO_LOG_REQUESTS=1 to get the
  // per-request trace back while debugging.
  const app = Fastify({
    logger: { level: 'info' },
    maxParamLength: 4096,
    disableRequestLogging: process.env.STRADO_LOG_REQUESTS !== '1',
  });

  app.setErrorHandler((err, _req, reply) => {
    const mapped =
      err instanceof ZodError
        ? new AppError('VALIDATION', 'invalid request body', err.issues)
        : err;
    const status = mapped instanceof AppError ? mapped.httpStatus : 500;
    reply.code(status).send(toResponse(mapped));
  });

  app.decorate('deps', deps);

  // Expiry + retention: once at boot, then hourly. unref'd so a test's or a
  // CLI's event loop is never held open by it.
  const runSweep = (): void => {
    try {
      deps.intercom.sweep();
    } catch (err) {
      app.log.warn({ err }, 'intercom sweep failed');
    }
  };
  runSweep();
  const sweepTimer = setInterval(runSweep, 60 * 60 * 1000);
  sweepTimer.unref();

  // Idle parking: only on a runner with a working sandbox runtime — a
  // desktop has no containers to park. A worktree with any live terminal
  // session is never a parking candidate, regardless of how stale its
  // recorded activity looks (see park.ts).
  const stopParkSweep = deps.sandbox
    ? startParkSweep({
        sandbox: deps.sandbox,
        lastActivity: deps.sandboxLastActivity,
        hasLiveSession: (worktreePath) => deps.terminal.liveSessions().some((s) => s.path === worktreePath),
        // The worktree's published port, from whichever workspace owns it.
        isServing: async (worktreePath) => {
          for (const ws of await deps.workspaces.list().catch(() => [])) {
            const port = await deps.registry
              .get(ws.id)
              .then((stores) => stores.state.get(worktreePath))
              .then((meta) => meta?.port ?? null, () => null);
            if (port) return portAccepts(port);
          }
          return false;
        },
      })
    : null;

  // Idle Claude tabs: stop the process, keep the tab, resume on the next
  // keystroke. STRADO_PARK_IDLE_MINUTES=0 turns it off.
  const parkIdleMinutes = parkMinutesFromEnv();
  const claudeParkSweep = parkIdleMinutes > 0
    ? startClaudeParkSweep({
        liveSessions: () => deps.terminal.liveSessions(),
        lastActivity: (key) => {
          // last keystroke or output, whichever is more recent
          const q = deps.ptyActivity.quiet(key);
          const quiet = Math.min(q.input, q.output);
          return Number.isFinite(quiet) ? Date.now() - quiet : null;
        },
        status: (p, id) => deps.claudeStatus.sessions(p)[id],
        backgroundJobs: async (key) => {
          const pid = deps.terminal.status(key).pid;
          return pid ? hasBackgroundJobs(pid) : true;
        },
        processStart: async (key) => {
          const pid = deps.terminal.status(key).pid;
          return pid ? processStartMs(pid) : null;
        },
        conversation: (p, id) => deps.agentSessions.get('claude', p, id),
        unusedSince: (p, since) => noTranscriptSince(claudeProjectDir(p), since),
        park: (key, entry) => {
          // Recorded BEFORE the kill: the exit handlers read it to keep the
          // tab listed and to tell an attached pane it was parked, not ended.
          deps.parked.add(entry);
          deps.terminal.kill(key);
        },
        idleMs: parkIdleMinutes * 60_000,
      })
    : null;

  // Started on demand by the Files tab; every one is stopped with the app.
  // One lookup of PATH and the common bin dirs, shared by language servers and editors.
  const detect = createDetect();
  const lsp =
    deps.lsp ?? createLspManager({ detect, store: createLspEnabledStore(), log: (line) => app.log.warn(line) });
  const editors = deps.editors ?? createEditors({ detect, store: createEditorStore() });

  // FSWatchers keep the event loop alive; close them with the app and flush
  // any activity accrued since the last debounced write.
  app.addHook('onClose', async () => {
    await lsp.closeAll();
    stopParkSweep?.();
    claudeParkSweep?.stop();
    deps.activityWatch.close();
    await deps.devProxy.close();
    await deps.activity.flush();
    // Leaves no socket file behind for the next boot to trip over.
    await deps.closeSandboxSocket?.();
    clearInterval(sweepTimer);
    try {
      deps.intercom.close();
    } catch (err) {
      app.log.warn({ err }, 'intercom close failed');
    }
    // Last: @fastify/websocket's own onClose (registered after this hook,
    // so it runs first) closes every open ws connection, which drives each
    // session's exit handler and a fire-and-forget agents.release(key) —
    // see onTerminalExit above and routes/terminal.ts's onExit. Those writes
    // land in the registry's serialize queue; wait for them here so nothing
    // still holds a handle into a caller's tmp dir after app.close() resolves.
    await deps.agents.flush();
  });

  // The license gate. Registered before every route below, so nothing
  // registered later can accidentally escape it — see OPEN_PATHS for the
  // short, exact list of routes a signed-out install must still reach.
  const { registerLicenseEnforcement } = await import('./hooks/requireLicense.js');
  registerLicenseEnforcement(app);

  // Liveness + capability advertisement (runner CLI, remote clients)
  const { registerHealthRoutes } = await import('./routes/health.js');
  await registerHealthRoutes(app);
  // Agent-login sync target: a runner with sandboxing on. A desktop never
  // exposes these — its agents use the user's own logins directly.
  if (process.env.STRADO_RUNNER === '1' && deps.sandbox && deps.sandboxRuntime) {
    const { registerAgentLoginsRunnerRoutes } = await import('./routes/agentLoginsRunner.js');
    await registerAgentLoginsRunnerRoutes(app, {
      sandbox: deps.sandbox,
      sandboxRuntime: deps.sandboxRuntime,
      log: (line) => deps.debugLog.log('server', line),
    });
    // A host's Connections tab: per-agent checks, device logins, disconnect.
    const { registerConnectionsRunnerRoutes } = await import('./routes/connectionsRunner.js');
    await registerConnectionsRunnerRoutes(app, {
      sandbox: deps.sandbox,
      sandboxRuntime: deps.sandboxRuntime,
      log: (line) => deps.debugLog.log('server', line),
    });
    // Printed once so the user can compare it with what the laptop pinned.
    const { loadOrCreateBoxKey } = await import('./services/agentLogins/runnerKey.js');
    await loadOrCreateBoxKey().then(
      ({ fingerprint }) => console.log(`[runner] login-sync key fingerprint ${fingerprint}`),
      () => deps.debugLog.log('server', 'agent-login sync failed: box key'),
    );
  }
  // A host's Sandboxes and Logs tabs. Logs on any runner; the container
  // routes only with a sandbox runtime (registered inside when there is one).
  if (process.env.STRADO_RUNNER === '1') {
    const { registerHostTabsRunnerRoutes, runnerHostTabsDeps } = await import('./routes/hostTabsRunner.js');
    await registerHostTabsRunnerRoutes(app, runnerHostTabsDeps(app));
  }
  // Machine-wide pty sessions, outside any workspace scope (see the module).
  const { registerSessionRoutes } = await import('./routes/sessions.js');
  await registerSessionRoutes(app, lsp);

  // Self-hosted runner management (proxies strado-api with the stored token).
  // Returns its runnerFetch client (ticket cache + relay fetch) so a later
  // route module can forward requests to a remote host's own API through the
  // same cache, instead of building a second one.
  const { registerRunnerRoutes } = await import('./routes/runners.js');
  const runnerFetch = await registerRunnerRoutes(app);
  // "Add over SSH": a job that takes a bare Linux box to a paired runner.
  const { registerSshSetupRoutes } = await import('./routes/sshSetup.js');
  await registerSshSetupRoutes(app);
  // A host's Connections tab: per-agent login state, Connect/Check/Disconnect.
  const { registerConnectionRoutes } = await import('./routes/connections.js');
  await registerConnectionRoutes(app, runnerFetch);
  // A host's Sandboxes and Logs tabs: forwards to the runner's own routes.
  const { registerHostTabRoutes } = await import('./routes/hostTabs.js');
  await registerHostTabRoutes(app, runnerFetch);

  // Org membership (proxies strado-api with the stored token)
  const { registerOrgRoutes } = await import('./routes/org.js');
  await registerOrgRoutes(app);

  // Workspace CRUD at root — must be registered BEFORE the prefix scope
  const { registerWorkspaceRoutes } = await import('./routes/workspaces.js');
  await registerWorkspaceRoutes(app);

  // Focus Jarvis: the turn runner (unless a test injects one), the tool
  // gateway its `strado` MCP server calls, and the wakes when its agents
  // finish or answer. Actions run in the turn's window; a new worktree is the
  // server's own job.
  {
    const { createJarvisExecutor, createJarvisWorktree, registerJarvisToolRoutes, trackAsks, trustWatcher, watchTrust } = await import('./routes/jarvisTools.js');
    const { createJarvisRunner } = await import('./services/jarvisChat/runner.js');
    const { runClaudeHeadless } = await import('./services/jarvisChat/claudeHeadless.js');
    const { appWakeSource, createJarvisWakes } = await import('./services/jarvisChat/wakes.js');
    const { readProfile } = await import('./services/profileStore.js');
    const stores = (ws: string) => deps.registry.get(ws);
    let wakes: ReturnType<typeof createJarvisWakes> | null = null;
    const execute = trackAsks(
      watchTrust(createJarvisExecutor({ uiClients: deps.uiClients, createWorktree: createJarvisWorktree(app, stores) }), trustWatcher(app)),
      (ws, focusId, askId) => wakes?.asked(ws, focusId, askId),
    );
    deps.jarvis ??= createJarvisRunner({
      stores,
      spawnHeadless: (o) => runClaudeHeadless(o),
      runApproved: execute,
    });
    const runner = deps.jarvis;
    // A test's runner may not wake.
    const wake = (runner as { wake?: (ws: string, focusId: string, text: string) => void }).wake?.bind(runner);
    if (wake) {
      wakes = createJarvisWakes({
        ...appWakeSource({ bus: deps.bus, agents: deps.agents, agentControl: deps.agentControl, intercom: deps.intercom }),
        focuses: async (ws) => (await deps.registry.get(ws)).focuses.list(),
        chat: async (ws) => (await deps.registry.get(ws)).jarvis,
        wakesOn: async () => (await readProfile()).jarvisWakes,
        runner: { wake },
        log: (m) => app.log.warn(m),
      });
      wakes.start();
      app.addHook('onClose', async () => wakes?.stop());
    }
    await registerJarvisToolRoutes(app, {
      runner: { byToken: (t) => ('byToken' in runner && typeof runner.byToken === 'function' ? runner.byToken(t) : null) },
      stores,
      execute,
    });
  }

  // Per-workspace routes scoped under /api/w/:wsId
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', async (req) => {
      const wsId = (req.params as { wsId?: string }).wsId;
      if (!wsId) throw new AppError('VALIDATION', 'wsId param missing');
      const meta = await app.deps.workspaces.get(wsId);
      if (!meta) throw new AppError('NOT_FOUND', `workspace ${wsId} not found`);
      const stores = await app.deps.registry.get(wsId);
      req.workspace = { id: wsId, meta, stores };
    });

    const { registerReposRoutes } = await import('./routes/repos.js');
    await registerReposRoutes(scoped);
    const { registerFocusesRoutes } = await import('./routes/focuses.js');
    await registerFocusesRoutes(scoped, deps.jarvis ?? null);
    const { registerFocusJarvisRoutes } = await import('./routes/focusJarvis.js');
    await registerFocusJarvisRoutes(scoped, deps.jarvis ?? null);
    const { registerWorktreesRoutes } = await import('./routes/worktrees.js');
    await registerWorktreesRoutes(scoped);
    const { registerGitChangesRoutes } = await import('./routes/gitChanges.js');
    await registerGitChangesRoutes(scoped);
    const { registerFilesRoutes } = await import('./routes/files.js');
    await registerFilesRoutes(scoped);
    const { registerLspRoutes } = await import('./routes/lsp.js');
    await registerLspRoutes(scoped, lsp);
    const { registerOpenInEditorRoute } = await import('./routes/editors.js');
    await registerOpenInEditorRoute(scoped, editors);
    const { registerKnowledgeBaseRoutes } = await import('./routes/knowledgeBase.js');
    await registerKnowledgeBaseRoutes(scoped);
    const { registerLinkingRoutes } = await import('./routes/linking.js');
    await registerLinkingRoutes(scoped);
    const { registerProcessRoutes } = await import('./routes/processes.js');
    await registerProcessRoutes(scoped);
    const { registerMiscRoutes } = await import('./routes/misc.js');
    await registerMiscRoutes(scoped);
    const { registerClaudeSessionsRoutes } = await import('./routes/claudeSessions.js');
    await registerClaudeSessionsRoutes(scoped);
    const { registerUsageRoutes } = await import('./routes/usage.js');
    await registerUsageRoutes(scoped);
    const { registerAgentScopedRoutes } = await import('./routes/agents.js');
    await registerAgentScopedRoutes(scoped);
    const { registerIntercomScopedRoutes } = await import('./routes/intercom.js');
    await registerIntercomScopedRoutes(scoped);
    const { registerAppControlScopedRoutes } = await import('./routes/appControl.js');
    await registerAppControlScopedRoutes(scoped);
    const { registerJarvisScopedRoutes } = await import('./routes/jarvis.js');
    await registerJarvisScopedRoutes(scoped);
    const { registerGitProviderWorktreeRoutes } = await import('./routes/gitProvider.js');
    await registerGitProviderWorktreeRoutes(scoped);
  }, { prefix: '/api/w/:wsId' });

  // Events routes stay outside the prefix scope
  const { registerEventRoutes } = await import('./routes/events.js');
  await registerEventRoutes(app);

  // Token-scoped agent routes stay outside the prefix scope — they resolve
  // their own scope from the bearer token, not a wsId path param.
  const { registerAgentRoutes } = await import('./routes/agents.js');
  await registerAgentRoutes(app);

  // Intercom routes: same token model as /api/agents/me, outside the prefix.
  const { registerIntercomRoutes } = await import('./routes/intercom.js');
  await registerIntercomRoutes(app);
  // App control (agent_spawn, ui_place, preview_open, ui_state) + /events/ui.
  const { registerAppControlRoutes } = await import('./routes/appControl.js');
  await registerAppControlRoutes(app);
  const { registerJarvisRoutes } = await import('./routes/jarvis.js');
  await registerJarvisRoutes(app);

  // Jira proxy — credentials are per machine (~/.strado/jira.json)
  const { registerJiraRoutes } = await import('./routes/jira.js');
  await registerJiraRoutes(app);

  // Generic ticket-provider routes (Jira + Linear) — provider-agnostic
  // batch/status endpoints the web app uses instead of the Jira-only proxy.
  const { registerTicketRoutes } = await import('./routes/tickets.js');
  await registerTicketRoutes(app);

  // Git provider config (GitLab + GitHub) — credentials are per machine
  // (~/.strado/gitlab.json, ~/.strado/github.json)
  const { registerGitProviderConfigRoutes } = await import('./routes/gitProvider.js');
  await registerGitProviderConfigRoutes(app);

  // WebSocket terminal — outside the /api prefix scope, like /events
  const { default: fastifyWebsocket } = await import('@fastify/websocket');
  await app.register(fastifyWebsocket);
  const { registerTerminalRoutes } = await import('./routes/terminal.js');
  await registerTerminalRoutes(app);
  // The "Add over SSH" terminal: attach-only, for the keys a running setup job
  // owns. After the websocket plugin — registered before it, the route is a
  // plain GET and every attach is a 500.
  const { registerSshSetupTerminalRoutes } = await import('./routes/sshSetupTerminal.js');
  await registerSshSetupTerminalRoutes(app, {});

  const { registerClaudeStatusRoutes } = await import('./routes/claudeStatus.js');
  await registerClaudeStatusRoutes(app);
  const { registerActivityRoutes } = await import('./routes/activity.js');
  await registerActivityRoutes(app);
  const { registerEnvCheckRoutes } = await import('./routes/envCheck.js');
  await registerEnvCheckRoutes(app);
  // Coding agent config (MCP, skills, model, permissions) per agent.
  // Device-global, like envCheck above. Reuses the runnerFetch instance
  // captured at registerRunnerRoutes above to forward requests naming a
  // remote host, rather than building a second relay client.
  const { registerAgentConfigRoutes } = await import('./routes/agentConfig.js');
  await registerAgentConfigRoutes(app, { runnerFetch });
  const { registerCodexStatusRoutes } = await import('./routes/codexStatus.js');
  await registerCodexStatusRoutes(app);
  const { registerOpencodeStatusRoutes } = await import('./routes/opencodeStatus.js');
  await registerOpencodeStatusRoutes(app);
  const { registerPiStatusRoutes } = await import('./routes/piStatus.js');
  await registerPiStatusRoutes(app);
  const { registerPreviewTargetRoutes } = await import('./routes/previewTargets.js');
  await registerPreviewTargetRoutes(app);
  const { registerLicenseRoutes } = await import('./routes/license.js');
  await registerLicenseRoutes(app);
  const { registerAuthRoutes } = await import('./routes/auth.js');
  await registerAuthRoutes(app);
  const { registerFeedbackRoutes } = await import('./routes/feedback.js');
  await registerFeedbackRoutes(app);
  const { registerUpdateCheckRoutes } = await import('./routes/updateCheck.js');
  await registerUpdateCheckRoutes(app);
  const { registerProfileRoutes } = await import('./routes/profile.js');
  await registerProfileRoutes(app);
  const { registerLspAdminRoutes } = await import('./routes/lsp.js');
  await registerLspAdminRoutes(app, lsp);
  const { registerEditorAdminRoutes } = await import('./routes/editors.js');
  await registerEditorAdminRoutes(app, editors);
  const { registerVoiceRoutes } = await import('./routes/voice.js');
  await registerVoiceRoutes(app);

  // packaged desktop builds ship the web bundle outside the repo layout
  const staticRoot = process.env.STRADO_WEB_DIST
    ? path.resolve(process.env.STRADO_WEB_DIST)
    : path.resolve(process.cwd(), 'packages/web/dist');
  try {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      decorateReply: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/events')) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
        return;
      }
      reply.sendFile('index.html');
    });
  } catch {
    // dist not built yet (dev mode) — leave default 404 handler
  }

  return app;
}

import type { WorkspaceStores } from './workspaceRegistry.js';
import type { Workspace } from './workspaceConfig.js';

declare module 'fastify' {
  interface FastifyInstance { deps: Deps; }
  interface FastifyRequest {
    workspace?: { id: string; meta: Workspace; stores: WorkspaceStores };
  }
}
