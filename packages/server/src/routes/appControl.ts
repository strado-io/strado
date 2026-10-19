import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAgent } from '../hooks/requireAgent.js';
import { AppError } from '../errors.js';
import { parseSessionKey } from '../services/terminalManager.js';
import type { AgentSummary, Execution } from '../services/agentRegistry.js';
import type { UiClientState } from '../services/uiClients.js';
import { cleanLine, createTabOps, type CommandResult } from '../services/tabOps.js';

// App control: agents drive the Strado app itself — open agent/shell tabs,
// place them in splits, open Browser tabs. Spec:
// docs/specs/2026-10-16-strado-mcp-app-control-design.md (private repo).
// Tabs are server resources (spawned here, headless-safe); layout is the
// window's, reached through uiClients as a best-effort command.

export const APP_CONTROL_ENV = 'STRADO_MCP_APP_CONTROL';
export const PROMPT_MAX = 8 * 1024;
export { SPAWN_COMMAND_TIMEOUT_MS, SHELL_SETTLE_QUIET_MS, SHELL_SETTLE_MAX_MS, PROMPT_DELIVERY_WINDOW_MS, PROMPT_DELIVERY_RETRY_MS, PROMPT_CONFIRM_MS } from '../services/tabOps.js';

const assertEnabled = (): void => {
  if (process.env[APP_CONTROL_ENV] === '0') throw new AppError('UNAVAILABLE', 'app control is disabled');
};

const Split = z.enum(['right', 'down', 'tab']);
const Place = z.object({ split: Split.default('right'), anchor: z.string().min(1).max(200).optional(), focus: z.boolean().default(false) }).strict();
type PlaceInput = z.infer<typeof Place>;

const SpawnBody = z.object({
  mode: z.enum(['claude', 'codex', 'opencode', 'pi', 'shell']),
  worktreePath: z.string().min(1).max(4096).optional(),
  command: z.string().min(1).max(4096).refine((s) => !/[\r\n]/.test(s), { message: 'command must be a single line' }).optional(),
  prompt: z.string().min(1).max(PROMPT_MAX).optional(),
  place: Place.nullable().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();

const PlaceBody = Place.extend({ target: z.string().min(1).max(200) }).strict();

const BrowserBody = z.object({
  url: z.string().min(1).max(4096),
  worktreePath: z.string().min(1).max(4096).optional(),
  place: Place.nullable().optional(),
}).strict();

const StatusQuery = z.object({ request: z.string().min(1).max(64).optional() });

const TabRefSchema = z.object({
  worktreePath: z.string().min(1).max(4096),
  mode: z.enum(['claude', 'codex', 'opencode', 'pi', 'shell']),
  sessionId: z.string().min(1).max(64),
}).strict();

const ClientStateBody = z.object({
  focused: z.boolean(),
  worktreePath: z.string().max(4096).nullable(),
  visible: z.array(TabRefSchema).max(200),
  layout: z.unknown().optional(),
}).strict();

const AckBody = z.object({
  applied: z.boolean(),
  reason: z.string().max(200).optional(),
  result: z.record(z.unknown()).optional(),
}).strict();

const EventsQuery = z.object({
  ws: z.string().min(1).max(200),
  client: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
});

export { refKey, type TabRef } from '../services/tabOps.js';
import { keyOfRef, refKey, refOf, refOfKey, type TabRef } from '../services/tabOps.js';
import { HUMAN_AGENT_ID } from '../services/intercomSchema.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Header the relay client stamps on every request it forwards. Spoofing it
 * only makes a window *less* trusted, so its presence is taken at face value. */
export const VIA_RELAY_HEADER = 'x-strado-via';

/** Hostname of a Host/Origin value, lowercased; null when unparseable. */
function hostnameOf(value: string, withScheme: boolean): string | null {
  try { return new URL(withScheme ? value : `http://${value}`).hostname.toLowerCase(); } catch { return null; }
}

/** The window channel is unauthenticated like every hub route, so it must at
 * least only answer the hub itself: a loopback Host (DNS rebinding) and, when
 * the browser sends one, a loopback Origin (any web page can open an
 * EventSource to 127.0.0.1, or send Origin 'null' from a sandboxed iframe). */
export function assertHubRequest(headers: Record<string, string | string[] | undefined>): void {
  const host = typeof headers.host === 'string' ? hostnameOf(headers.host, false) : null;
  if (host !== null && !LOOPBACK_HOSTS.has(host)) throw new AppError('FORBIDDEN', 'the ui channel only answers the local hub');
  const origin = headers.origin;
  // 'null' is refused too: a sandboxed iframe on any web page sends it. The
  // hub (desktop or browser) is always served from http://127.0.0.1.
  if (typeof origin === 'string') {
    const o = hostnameOf(origin, true);
    if (o === null || !LOOPBACK_HOSTS.has(o)) throw new AppError('FORBIDDEN', 'the ui channel only answers the local hub');
  }
}

/** Only http(s) URLs; a bare host (`google.com`, `localhost:3000`) is read as
 * http(s). `blockedPorts`: loopback ports an agent may not open — Strado's own
 * server, whose unauthenticated hub routes are the human's. */
export function normaliseUrl(raw: string, blockedPorts: ReadonlySet<number> = new Set()): string {
  const s = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d/i.test(s) ? s
    : `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s) ? 'http' : 'https'}://${s}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new AppError('VALIDATION', 'url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError('VALIDATION', 'url must be http or https');
  const host = u.hostname.toLowerCase();
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if ((LOOPBACK_HOSTS.has(host) || host === '0.0.0.0') && blockedPorts.has(port)) {
    throw new AppError('FORBIDDEN', 'agents cannot open the Strado app itself in a Browser tab', { reason: 'strado_origin' });
  }
  return u.toString();
}

/** The first prompt for an agent-spawned tab: one clean line that names the asker. */
export function promptLine(prompt: string, from: string): string {
  return `${cleanLine(prompt)} (Asked by ${from} via Strado; when done, tell it with intercom_send to=${from}.)`;
}

const bodyHash = (b: unknown): string => createHash('sha256').update(JSON.stringify(b)).digest('hex');

export async function registerAppControlRoutes(app: FastifyInstance): Promise<void> {
  const callerPath = (ex: Execution): string => parseSessionKey(ex.key).path;
  const isSandboxed = (ex: Execution): boolean => app.deps.sandboxSlugs.slugOf(callerPath(ex)) !== null;
  const assertOwnWorktree = (ex: Execution, worktreePath: string, what: string): void => {
    if (isSandboxed(ex) && worktreePath !== callerPath(ex)) throw new AppError('FORBIDDEN', `a sandboxed tab can only ${what} in its own worktree`);
  };

  const tabOps = createTabOps(app);
  const { assertWorktree, spawnTab, shellSettled, runCommand, deliverPrompt } = tabOps;

  /** Resolve `place` into a dispatchable command. The anchor defaults to the
   * caller's own tab — unless the tab lives in another worktree, where the
   * caller's tab is not on screen: then null, and the window uses that
   * worktree's active pane. */
  async function placeArgs(ex: Execution, p: PlaceInput, tabWorktree: string): Promise<{ anchor: TabRef | null; split: string; focus: boolean }> {
    if (p.anchor === undefined) {
      return { anchor: tabWorktree === callerPath(ex) ? refOfKey(ex.key) : null, split: p.split, focus: p.focus };
    }
    const anchor = await app.deps.agents.resolve(ex.scopeId, p.anchor);
    assertOwnWorktree(ex, anchor.worktreePath, 'place tabs');
    return { anchor: refOf(anchor), split: p.split, focus: p.focus };
  }

  async function place(ex: Execution, tab: TabRef, p: PlaceInput) {
    const args = await placeArgs(ex, p, tab.worktreePath);
    // No anchor: nothing on screen to match, so let the worktree pick the window.
    return app.deps.uiClients.dispatch(ex.scopeId, 'place', { tab, ...args }, args.anchor ? refKey(args.anchor) : null, tab.worktreePath);
  }

  /** Loopback ports an agent may not open in a Browser tab: this server. */
  const ownPorts = (): Set<number> => {
    const ports = new Set<number>([Number(process.env.PORT ?? 7777)]);
    const addr = app.server.address();
    if (addr && typeof addr === 'object') ports.add(addr.port);
    return ports;
  };

  app.post('/api/intercom/agents/spawn', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req); assertEnabled();
    const b = SpawnBody.parse(req.body);
    if (b.command !== undefined && b.mode !== 'shell') throw new AppError('VALIDATION', 'command is only for mode=shell; use prompt for an agent');
    if (b.prompt !== undefined && b.mode === 'shell') throw new AppError('VALIDATION', 'prompt is only for agent modes; use command for a shell');

    const guard = app.deps.spawnGuard;
    const { idempotencyKey: idemKey, ...request } = b;
    const replayed = await guard.begin<Record<string, unknown>>(ex.scopeId, ex.executionId, idemKey, bodyHash(request));
    if (replayed) { reply.code(200); return replayed.response; }
    try {
      const response = await spawnFor(ex, b);
      guard.complete(ex.scopeId, ex.executionId, idemKey, response);
      reply.code(201);
      return response;
    } catch (err) {
      guard.abandon(ex.scopeId, ex.executionId, idemKey);
      throw err;
    }
  });

  async function spawnFor(ex: Execution, b: z.infer<typeof SpawnBody>): Promise<Record<string, unknown>> {
    const worktreePath = b.worktreePath ?? callerPath(ex);
    assertOwnWorktree(ex, worktreePath, 'open tabs');
    if (b.worktreePath !== undefined) await assertWorktree(ex.scopeId, worktreePath);
    // Resolve the anchor before spawning: a bad anchor must not leave a stray tab.
    const placeInput = b.place === null ? null : Place.parse(b.place ?? {});
    if (placeInput) await placeArgs(ex, placeInput, worktreePath);
    const reservation = await app.deps.spawnGuard.admit(ex.scopeId, ex.executionId);

    let spawned;
    try {
      spawned = await spawnTab(ex.scopeId, b.mode, worktreePath);
    } catch (err) {
      reservation.release();
      throw err;
    }
    // Marked before anything else can fail: a tab that exists is a child,
    // whatever happens to the rest of this request.
    reservation.commit(spawned.execution.executionId);
    const child = await app.deps.agents.resolve(ex.scopeId, spawned.execution.agentId);
    const caller = await app.deps.agents.resolve(ex.scopeId, ex.agentId).catch(() => null);
    const callerName = caller?.alias ?? ex.agentId;

    const placement = placeInput ? await place(ex, refOfKey(spawned.key), placeInput) : { applied: false, reason: 'not_requested' };

    let command: CommandResult | undefined;
    if (b.command !== undefined) {
      await shellSettled(spawned.key);
      command = await runCommand(spawned.key, b.command);
    }
    if (b.prompt !== undefined) deliverPrompt(ex.scopeId, child.agentId, spawned.key, b.mode, promptLine(b.prompt, callerName));

    return {
      agent: { agentId: child.agentId, alias: child.alias, mode: child.mode, worktreePath: child.worktreePath },
      placement,
      ...(command ? { command } : {}),
      ...(b.prompt !== undefined ? { prompt: { status: 'queued' } } : {}),
    };
  }

  app.post('/api/intercom/ui/place', async (req) => {
    const ex = requireAgent(app, req); assertEnabled();
    const b = PlaceBody.parse(req.body);
    const target = await app.deps.agents.resolve(ex.scopeId, b.target);
    assertOwnWorktree(ex, target.worktreePath, 'place tabs');
    if (!target.live) throw new AppError('VALIDATION', 'target is not live');
    return place(ex, refOf(target), { split: b.split, anchor: b.anchor, focus: b.focus });
  });

  app.post('/api/intercom/ui/browser', async (req) => {
    const ex = requireAgent(app, req); assertEnabled();
    if (isSandboxed(ex)) throw new AppError('FORBIDDEN', 'Browser tabs are not available inside a sandbox');
    const b = BrowserBody.parse(req.body);
    const url = normaliseUrl(b.url, ownPorts());
    const worktreePath = b.worktreePath ?? callerPath(ex);
    if (b.worktreePath !== undefined) await assertWorktree(ex.scopeId, worktreePath);
    const p = b.place === null ? null : Place.parse(b.place ?? {});
    const placeArg = p ? await placeArgs(ex, p, worktreePath) : null;
    // Browser tabs exist only in the desktop app; a plain web browser window
    // answers applied:false reason 'no_browser'.
    const anchorKey = placeArg ? (placeArg.anchor ? refKey(placeArg.anchor) : null) : refKey(refOfKey(ex.key));
    const r = await app.deps.uiClients.dispatch(ex.scopeId, 'browser.open', { worktreePath, url, ...(placeArg ? { place: placeArg } : {}) }, anchorKey, worktreePath);
    const tabId = typeof r.result?.tabId === 'string' ? r.result.tabId : undefined;
    return { applied: r.applied, ...(r.reason ? { reason: r.reason } : {}), url, ...(tabId ? { tabId } : {}) };
  });

  app.get('/api/intercom/ui/state', async (req) => {
    const ex = requireAgent(app, req); assertEnabled();
    const agents = await app.deps.agents.list(ex.scopeId);
    const byKey = new Map(agents.map((a) => [refKey(refOf(a)), a] as const));
    const clients = app.deps.uiClients.list(ex.scopeId).filter((c) => !isSandboxed(ex) || c.worktreePath === callerPath(ex));
    const target = app.deps.uiClients.pick(ex.scopeId, refKey(refOfKey(ex.key)));
    return {
      target: target?.clientId ?? null,
      clients: clients.map((c) => ({
        clientId: c.clientId,
        focused: c.focused,
        remote: c.remote,
        worktreePath: c.worktreePath,
        visible: c.visibleKeys.map((k) => byKey.get(k)).filter((a): a is AgentSummary => a !== undefined)
          .map((a) => ({ agentId: a.agentId, alias: a.alias, mode: a.mode })),
        layout: c.layout,
      })),
    };
  });

  app.get<{ Params: { agent: string } }>('/api/intercom/agents/:agent/status', async (req) => {
    const ex = requireAgent(app, req); assertEnabled();
    const q = StatusQuery.parse(req.query ?? {});
    const a = await app.deps.agents.resolve(ex.scopeId, req.params.agent);
    // The last reply is the same read as the diary: same worktree boundary.
    assertOwnWorktree(ex, a.worktreePath, 'read agents');
    const [last] = app.deps.intercom.listTurns(ex.scopeId, a.agentId, { limit: 1 });
    let replied: string | null = null;
    if (q.request !== undefined) {
      try { replied = app.deps.intercom.receipt(ex.scopeId, ex.agentId, q.request).replyId; } catch { replied = null; }
    }
    return {
      agentId: a.agentId, alias: a.alias, mode: a.mode, live: a.live, lifecycle: a.lifecycle,
      lastTurn: last ? { turnIndex: last.turnIndex, endedAt: last.endedAt, reply: last.reply, replyTruncated: last.replyTruncated } : null,
      ...(q.request !== undefined ? { replyId: replied } : {}),
    };
  });

  // Close / interrupt. An agent may act freely on tabs it opened with
  // agent_spawn; anything else (the human's tabs, other agents') becomes an
  // escalation the human answers — the agent never closes it on its own.
  for (const verb of ['close', 'interrupt'] as const) {
    app.post<{ Params: { agent: string } }>(`/api/intercom/agents/:agent/${verb}`, async (req) => {
      const ex = requireAgent(app, req); assertEnabled();
      const target = await app.deps.agents.resolve(ex.scopeId, req.params.agent);
      assertOwnWorktree(ex, target.worktreePath, `${verb} tabs`);
      if (!target.live || !target.executionId) throw new AppError('VALIDATION', 'target is not live');
      if (target.executionId === ex.executionId) throw new AppError('VALIDATION', `an agent cannot ${verb} its own tab`);
      const key = keyOfRef(refOf(target));
      const name = target.alias ?? target.agentId;
      if (app.deps.spawnGuard.parentOf(target.executionId) === ex.executionId) {
        if (verb === 'close') tabOps.close(key); else tabOps.interrupt(key);
        return { status: 'done', target: { agentId: target.agentId, alias: target.alias } };
      }
      const caller = await app.deps.agents.resolve(ex.scopeId, ex.agentId).catch(() => null);
      const who = caller?.alias ?? ex.agentId;
      const what = verb === 'close' ? `close ${name}` : `press Ctrl-C in ${name}`;
      const escalation = app.deps.intercom.createEscalation({
        scopeId: ex.scopeId, from: { agentId: ex.agentId, executionId: ex.executionId }, to: HUMAN_AGENT_ID,
        title: `${who} wants to ${what}`,
        body: `${who} asked to ${what} (${target.mode} tab in ${target.worktreePath}; ${tabOps.busy(target) ? 'it is busy right now' : 'it looks idle'}). `
          + 'Agents may only do this to tabs they opened themselves. Do it yourself if you agree, then answer here.',
        context: [], taskId: null, timeoutMs: null,
      });
      return { status: 'needs_human', escalationId: escalation.id, target: { agentId: target.agentId, alias: target.alias } };
    });
  }

  // Window side. The event stream is the registration: open = connected,
  // close = gone. No token — the hub is the human, like every /events route.
  app.get('/events/ui', async (req, reply) => {
    assertHubRequest(req.headers);
    const q = EventsQuery.parse(req.query ?? {});
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.flushHeaders();
    const write = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const disconnect = app.deps.uiClients.connect({
      // Not the window's say: a hub reached over the network (relay, LAN) is
      // remote, and remote windows are not sent commands unless STRADO_UI_REMOTE=1.
      clientId: q.client, wsId: q.ws,
      remote: req.headers[VIA_RELAY_HEADER] !== undefined || !LOOPBACK_ADDRS.has(req.socket.remoteAddress ?? ''),
      send: (cmd) => { write('ui.command', cmd); },
    });
    write('ui.ready', { clientId: q.client });
    const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(beat); disconnect(); reply.raw.end(); });
    return reply;
  });
}

/** Window → server reports, under /api/w/:wsId like every hub route. */
export async function registerAppControlScopedRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { clientId: string } }>('/ui/clients/:clientId/state', { bodyLimit: 256 * 1024 }, async (req) => {
    assertHubRequest(req.headers);
    const b = ClientStateBody.parse(req.body);
    const state: UiClientState = { focused: b.focused, worktreePath: b.worktreePath, visibleKeys: b.visible.map(refKey), layout: b.layout ?? null };
    if (!app.deps.uiClients.report(req.workspace!.id, req.params.clientId, state)) {
      throw new AppError('NOT_FOUND', 'unknown ui client; reconnect /events/ui');
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/ui/commands/:id/ack', async (req) => {
    assertHubRequest(req.headers);
    const clientId = (req.headers['x-strado-ui-client'] ?? '') as string;
    const b = AckBody.parse(req.body);
    return { accepted: app.deps.uiClients.ack(req.workspace!.id, clientId, req.params.id, b) };
  });
}
