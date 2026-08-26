import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createEventBus, EventBus } from './events/bus.js';
import { createJobQueue, JobQueue } from './services/jobs.js';
import { createGitWorktreeService, GitWorktreeService } from './services/gitWorktree.js';
import { createNodeModulesLinkService, NodeModulesLinkService } from './services/nodeModulesLink.js';
import { createProcessManager, ProcessManager } from './services/processManager.js';
import { createDebugLog, DebugLog } from './services/debugLog.js';
import { createTerminalManager, parseSessionKey, sessionsPayload, TerminalManager } from './services/terminalManager.js';
import { createDaemonTerminalManager } from './services/ptyDaemon/manager.js';
import { createGitStatusService, GitStatusService } from './services/gitStatus.js';
import { createAgentStatusStore, ClaudeStatusStore } from './services/claudeStatusStore.js';
import { createGitChangesService, GitChangesService } from './services/gitChanges.js';
import { createActivityTracker, createAgentOutputBeats, ActivityTracker } from './services/activityTracker.js';
import { createWorktreeWatcher, WorktreeWatcher } from './services/activityWatcher.js';
import { ZodError } from 'zod';
import { toResponse, AppError } from './errors.js';
import { runMigration } from './migration.js';
import { createWorkspaceConfigStore, WorkspaceConfigStore } from './workspaceConfig.js';
import { createWorkspaceStoreRegistry, WorkspaceStoreRegistry } from './workspaceRegistry.js';
import { closeAll as closeVsCodeWeb } from './services/vscodeWeb.js';
import { detectRuntime, sandboxEnabled, type SandboxRuntime } from './services/sandbox/runtime.js';
import { createSandboxService, type SandboxService } from './services/sandbox/sandboxes.js';
import { createSandboxSlugMap, hydrateSandboxSlugs, type SandboxSlugMap } from './services/sandbox/slugMap.js';
import { sandboxSpecWrapper } from './services/sandbox/spec.js';
import { startHookSocket } from './services/sandbox/hookSocket.js';
import { createLastActivityTracker, startParkSweep } from './services/sandbox/park.js';
import { resolveProfile } from './profile.js';

export type Deps = {
  workspaces: WorkspaceConfigStore;
  registry: WorkspaceStoreRegistry;
  bus: EventBus;
  jobs: JobQueue;
  git: GitWorktreeService;
  link: NodeModulesLinkService;
  proc: ProcessManager;
  terminal: TerminalManager;
  status: GitStatusService;
  claudeStatus: ClaudeStatusStore;
  codexStatus: ClaudeStatusStore;
  opencodeStatus: ClaudeStatusStore;
  gitChanges: GitChangesService;
  activity: ActivityTracker;
  activityWatch: WorktreeWatcher;
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
  const activity = createActivityTracker(path.join(homeStateDir, 'activity.json'));
  const debugLog = createDebugLog(process.env.STRADO_LOG_DIR || path.join(homeStateDir, 'logs'));
  // Declared ahead of the callbacks below: onTerminalExit closes over
  // `terminal`, which isn't assigned until after createDaemonTerminalManager
  // resolves. That callback CAN fire before the assignment — a boot-time
  // daemon upgrade/resync runs inside the constructor and may report exits —
  // so the binding is optional and onTerminalExit bails out while it's unset
  // (reading it before assignment would be a TDZ ReferenceError).
  let terminal: TerminalManager | undefined;
  const onTerminalData = createAgentOutputBeats({
    touch: (p) => activity.touch(p),
    agentStatus: (mode, p) =>
      (mode === 'claude' ? claudeStatus : mode === 'codex' ? codexStatus : opencodeStatus).get(p),
    shellAgentWorking: (p, id) => {
      const key = `shell:${id}`;
      return [claudeStatus, codexStatus, opencodeStatus]
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
  const onData = (key: string) => {
    sandboxActivity.touch(parseSessionKey(key).path);
    onTerminalData(key);
  };
  // Any session exit (crash, or a force-kill that lands after the client's
  // WS already closed) must refresh that worktree's session badges, so the
  // palette/dashboard don't keep showing a dead agent as live.
  const onTerminalExit = (key: string) => {
    if (!terminal) return; // manager still constructing — sessions can't have UI subscribers yet
    const { path: p } = parseSessionKey(key);
    const live = terminal.liveSessions().filter((s) => s.path === p);
    bus.emit('worktrees', {
      type: 'worktree.updated',
      data: { path: p, ...sessionsPayload(live) },
    });
  };
  // Probed once, at boot: /api/capabilities advertises it and worktree
  // creation branches on it. Never installs anything — a missing binary just
  // leaves this null, which is the desktop's normal state.
  //
  // Ahead of the terminal manager, which needs the runtime to route sessions
  // into containers.
  const sandboxRuntime = await detectRuntime();
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
    const socketPath = path.join(homeStateDir, 'strado-api.sock');
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
      ? createTerminalManager(undefined, onData, onTerminalExit, wrapSpec)
      : await createDaemonTerminalManager({
          stateDir: homeStateDir,
          daemonScript: resolvePtydScript(),
          onData,
          onExit: onTerminalExit,
          wrapSpec,
        });
  return {
    workspaces,
    registry,
    bus,
    jobs: createJobQueue(bus),
    git: createGitWorktreeService(),
    link: createNodeModulesLinkService(),
    proc: createProcessManager(bus, debugLog),
    terminal,
    status: createGitStatusService(),
    claudeStatus,
    codexStatus,
    opencodeStatus,
    gitChanges: createGitChangesService(),
    activity,
    // File saves (any editor) beat the activity clock; worktree paths are
    // registered as the /worktrees listing discovers them.
    activityWatch: createWorktreeWatcher({ touch: (p) => activity.touch(p) }),
    debugLog,
    homeStateDir,
    sandboxRuntime,
    sandbox,
    sandboxSlugs,
    sandboxSocketPath,
    closeSandboxSocket,
    sandboxLastActivity,
    forgetSandboxActivity,
  };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'info' }, maxParamLength: 4096 });

  app.setErrorHandler((err, _req, reply) => {
    const mapped =
      err instanceof ZodError
        ? new AppError('VALIDATION', 'invalid request body', err.issues)
        : err;
    const status = mapped instanceof AppError ? mapped.httpStatus : 500;
    reply.code(status).send(toResponse(mapped));
  });

  app.decorate('deps', deps);

  // Idle parking: only on a runner with a working sandbox runtime — a
  // desktop has no containers to park. A worktree with any live terminal
  // session is never a parking candidate, regardless of how stale its
  // recorded activity looks (see park.ts).
  const stopParkSweep = deps.sandbox
    ? startParkSweep({
        sandbox: deps.sandbox,
        lastActivity: deps.sandboxLastActivity,
        hasLiveSession: (worktreePath) => deps.terminal.liveSessions().some((s) => s.path === worktreePath),
      })
    : null;

  // FSWatchers keep the event loop alive; close them with the app and flush
  // any activity accrued since the last debounced write.
  app.addHook('onClose', async () => {
    stopParkSweep?.();
    deps.activityWatch.close();
    await deps.activity.flush();
    await closeVsCodeWeb();
    // Leaves no socket file behind for the next boot to trip over.
    await deps.closeSandboxSocket?.();
  });

  // The license gate. Registered before every route below, so nothing
  // registered later can accidentally escape it — see OPEN_PATHS for the
  // short, exact list of routes a signed-out install must still reach.
  const { registerLicenseEnforcement } = await import('./hooks/requireLicense.js');
  registerLicenseEnforcement(app);

  // Liveness + capability advertisement (runner CLI, remote clients)
  const { registerHealthRoutes } = await import('./routes/health.js');
  await registerHealthRoutes(app);

  // Self-hosted runner management (proxies strado-api with the stored token)
  const { registerRunnerRoutes } = await import('./routes/runners.js');
  await registerRunnerRoutes(app);

  // Org membership (proxies strado-api with the stored token)
  const { registerOrgRoutes } = await import('./routes/org.js');
  await registerOrgRoutes(app);

  // Workspace CRUD at root — must be registered BEFORE the prefix scope
  const { registerWorkspaceRoutes } = await import('./routes/workspaces.js');
  await registerWorkspaceRoutes(app);

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
    const { registerWorktreesRoutes } = await import('./routes/worktrees.js');
    await registerWorktreesRoutes(scoped);
    const { registerGitChangesRoutes } = await import('./routes/gitChanges.js');
    await registerGitChangesRoutes(scoped);
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
    const { registerGitProviderWorktreeRoutes } = await import('./routes/gitProvider.js');
    await registerGitProviderWorktreeRoutes(scoped);
  }, { prefix: '/api/w/:wsId' });

  // Events routes stay outside the prefix scope
  const { registerEventRoutes } = await import('./routes/events.js');
  await registerEventRoutes(app);

  // VS Code web server control — workspace-agnostic, outside the prefix scope
  const { registerVsCodeRoutes } = await import('./routes/vscode.js');
  await registerVsCodeRoutes(app);

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

  const { registerClaudeStatusRoutes } = await import('./routes/claudeStatus.js');
  await registerClaudeStatusRoutes(app);
  const { registerActivityRoutes } = await import('./routes/activity.js');
  await registerActivityRoutes(app);
  const { registerEnvCheckRoutes } = await import('./routes/envCheck.js');
  await registerEnvCheckRoutes(app);
  const { registerCodexStatusRoutes } = await import('./routes/codexStatus.js');
  await registerCodexStatusRoutes(app);
  const { registerOpencodeStatusRoutes } = await import('./routes/opencodeStatus.js');
  await registerOpencodeStatusRoutes(app);
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
