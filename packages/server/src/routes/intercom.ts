import type { FastifyInstance } from 'fastify';
import { requireAgent } from '../hooks/requireAgent.js';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { formatInboxContext, selectUnderBudget } from '../services/intercomContext.js';
import type { ForkCreateInput } from '../services/forkService.js';
import {
  BODY_MAX, CONTEXT_MAX, ConfirmBody, DiaryQuery, EscalationCreateBody, EscalationListQuery, EscalationResolveBody,
  ESCALATION_BODY_MAX, ForkCreateBody, ForkListQuery, HOOK_PULL_LIMIT, HookBody, HUMAN_AGENT_ID, ListQuery, PullBody,
  READ_LINES_DEFAULT, READ_LINES_MAX, ReadQuery, RUN_TIMEOUT_MAX_MS, RUN_TIMEOUT_MIN_MS, RUN_TIMEOUT_MS, RunBody, SendBody, SHELL_RUN_ENV,
  STRADO_SENDER_ID, TaskAssignBody, TaskCreateBody, TaskListQuery, TASKS_ENV,
} from '../services/intercomSchema.js';
import { ShellRunError } from '../services/shellRunner.js';
import { parseSessionKey, sessionKeyFor } from '../services/terminalManager.js';
import { peekLines } from '../services/terminalText.js';
import type { AgentSummary, Execution } from '../services/agentRegistry.js';
import { HUMAN, type Message, type MessageWithAlias } from '../services/intercomStore.js';

const assertTasksEnabled = (): void => {
  if (process.env[TASKS_ENV] === '0') throw new AppError('UNAVAILABLE', 'tasks and escalations are disabled');
};
const actorOf = (ex: Execution) => ({ agentId: ex.agentId, executionId: ex.executionId });

export type { MessageWithAlias } from '../services/intercomStore.js';

/** Join each sender's current alias from the registry. Aliases are names, not identity: agentId stays canonical. */
export async function withAliases(app: FastifyInstance, scopeId: string, messages: Message[]): Promise<MessageWithAlias[]> {
  if (messages.length === 0) return [];
  const alias = new Map((await app.deps.agents.list(scopeId)).map((a) => [a.agentId, a.alias] as const));
  return messages.map((m) => ({ ...m, from: { ...m.from, alias: alias.get(m.from.agentId) ?? null } }));
}

/** A sandboxed tab may drive or read only tabs of its own worktree. The
 * workspace scope is not enough: sandboxing is per worktree, so a workspace
 * mixing sandboxed and unsandboxed worktrees would otherwise hand a
 * contained agent a shell on the host. */
function assertSandboxBoundary(app: FastifyInstance, ex: Execution, target: AgentSummary): void {
  const callerPath = parseSessionKey(ex.key).path;
  if (app.deps.sandboxSlugs.slugOf(callerPath) === null) return;
  if (target.worktreePath !== callerPath) {
    throw new AppError('FORBIDDEN', 'a sandboxed tab can only reach tabs of its own worktree');
  }
}

/** A sandboxed caller may only open a fork's `newTab` inside its own
 * worktree, whatever `source` the fork names — otherwise a sandboxed thread's
 * fork would be a way to spawn a tab elsewhere on the host. */
function assertForkSandboxBoundary(app: FastifyInstance, ex: Execution, worktreePath: string): void {
  const callerPath = parseSessionKey(ex.key).path;
  if (app.deps.sandboxSlugs.slugOf(callerPath) === null) return;
  if (worktreePath !== callerPath) {
    throw new AppError('FORBIDDEN', 'a sandboxed tab can only open a new tab in its own worktree');
  }
}

/** A `newTab.worktreePath` is a caller-supplied string (the schema allows any
 * 4096 characters) that becomes a spawned login shell's cwd and the directory
 * `<path>/.claude/settings.local.json` is written into. Hold it to the same
 * rule the terminal socket uses: a repo of this workspace must own it, either
 * as its own checkout or inside its canonical worktree root. */
async function assertForkWorktreePath(app: FastifyInstance, scopeId: string, worktreePath: string): Promise<void> {
  const invalid = (): AppError => new AppError('VALIDATION', 'invalid worktreePath');
  const stores = await app.deps.registry.get(scopeId);
  const repos = await stores.repos.list();
  const repo = findOwningRepo(repos, worktreePath, app.deps.homeStateDir, { includeRepoRoot: true });
  if (!repo) throw invalid();
  try {
    assertPathUnder(worktreePath, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
  } catch {
    // PATH_FORBIDDEN would be a 403 naming host paths; this is a bad field.
    throw invalid();
  }
}

/** Exactly one of `to` / `newTab` is guaranteed by the schema; this turns
 * whichever arrived into a `ForkCreateInput['target']`, resolving a peer
 * reference (404 unknown) and refusing a fork whose target is its own source. */
async function resolveForkTarget(
  app: FastifyInstance, scopeId: string, source: AgentSummary, b: ForkCreateBody,
): Promise<ForkCreateInput['target']> {
  if (b.to !== undefined) {
    const to = await app.deps.agents.resolve(scopeId, b.to);
    if (to.agentId === source.agentId) {
      throw new AppError('CONFLICT', 'fork source and target are the same agent', { reason: 'source_is_target' });
    }
    return { kind: 'peer', agentId: to.agentId };
  }
  return { kind: 'new', mode: b.newTab!.mode, worktreePath: b.newTab!.worktreePath ?? source.worktreePath };
}

/** Resolve `agent` (exact id or unique alias, never a guess) and list its turns newest first. */
async function diaryFor(app: FastifyInstance, scopeId: string, query: unknown) {
  const q = DiaryQuery.parse(query ?? {});
  const agent = await app.deps.agents.resolve(scopeId, q.agent);
  const turns = app.deps.intercom.listTurns(scopeId, agent.agentId, { limit: q.limit, before: q.before });
  return { agent: { agentId: agent.agentId, alias: agent.alias }, turns };
}

/** Token-authenticated intercom routes. Sender and scope come from the execution token; a body naming a sender is ignored. */
export async function registerIntercomRoutes(app: FastifyInstance): Promise<void> {
  // Explicit bodyLimit: Fastify's default 1 MiB is smaller than body + context
  // alone can legally be; the extra 16 KiB covers JSON framing (quoting,
  // escaping) and the request's other small scalar fields (to, kind, etc).
  app.post('/api/intercom/messages', { bodyLimit: BODY_MAX + CONTEXT_MAX + 16 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req);
    const body = SendBody.parse(req.body);
    const toRef = body.to.trim().toLowerCase();
    if (toRef === HUMAN_AGENT_ID) throw new AppError('VALIDATION', 'use intercom_escalate to reach the human');
    // `strado` is the synthetic sender behind a fork's summary ask and
    // hand-over: it is reachable only by replying to a request it sent, never
    // by name, and never through the registry (it is not a registered agent).
    let toAgentId: string;
    if (toRef === STRADO_SENDER_ID) {
      if (body.kind !== 'reply') throw new AppError('VALIDATION', '"strado" only receives replies to its own requests');
      toAgentId = STRADO_SENDER_ID;
    } else {
      // Alias or exact id; throws NOT_FOUND (unknown) or CONFLICT (ambiguous).
      toAgentId = (await app.deps.agents.resolve(ex.scopeId, body.to)).agentId;
    }
    const { receipt, replayed } = app.deps.intercom.send({
      scopeId: ex.scopeId,
      fromAgentId: ex.agentId,
      fromExecutionId: ex.executionId,
      toAgentId,
      kind: body.kind,
      replyTo: body.replyTo ?? null,
      body: body.body,
      context: body.context,
      idempotencyKey: body.idempotencyKey ?? null,
      expiresInMs: body.expiresInMs ?? null,
    });
    reply.code(replayed ? 200 : 201);
    return receipt;
  });

  app.post('/api/intercom/pull', async (req) => {
    const ex = requireAgent(app, req);
    const { limit } = PullBody.parse(req.body ?? undefined);
    const { batchId, messages } = app.deps.intercom.pull(ex.scopeId, ex.agentId, ex.executionId, limit);
    return { batchId, messages: await withAliases(app, ex.scopeId, messages) };
  });

  app.post<{ Params: { id: string } }>('/api/intercom/messages/:id/ack', async (req) => {
    const ex = requireAgent(app, req);
    return app.deps.intercom.ack(ex.scopeId, ex.agentId, req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/intercom/messages/:id', async (req) => {
    const ex = requireAgent(app, req);
    return app.deps.intercom.receipt(ex.scopeId, ex.agentId, req.params.id);
  });

  app.get('/api/intercom/peers', async (req) => {
    const ex = requireAgent(app, req);
    return { peers: await app.deps.agents.list(ex.scopeId) };
  });

  // Turn diary (step 4b): what a peer tab was asked and answered, newest first.
  app.get('/api/intercom/diary', async (req) => {
    const ex = requireAgent(app, req);
    return diaryFor(app, ex.scopeId, req.query);
  });

  // Shell adapters (step 6). `run`: type a command into a peer SHELL tab of the
  // caller's workspace and return what the PTY printed until it went quiet.
  // Agent tabs are never a target — step 5's nudge is the only server-side
  // typing into those. `read`: the last lines of any live peer tab's screen.
  app.post('/api/intercom/shell/run', async (req) => {
    // 401 first: an unauthenticated caller learns nothing about this server's config.
    const ex = requireAgent(app, req);
    if (process.env[SHELL_RUN_ENV] === '0') throw new AppError('UNAVAILABLE', 'shell run disabled');
    const body = RunBody.parse(req.body);
    const target = await app.deps.agents.resolve(ex.scopeId, body.target);
    assertSandboxBoundary(app, ex, target);
    if (target.mode !== 'shell') throw new AppError('VALIDATION', 'target is not a shell tab');
    if (!target.live) throw new AppError('VALIDATION', 'target is not live');
    const key = sessionKeyFor(target.mode, target.worktreePath, target.sessionId);
    const timeoutMs = Math.min(RUN_TIMEOUT_MAX_MS, Math.max(RUN_TIMEOUT_MIN_MS, body.timeoutMs ?? RUN_TIMEOUT_MS));
    try {
      const result = await app.deps.shellRunner.run(key, body.command, { timeoutMs });
      return { target: { agentId: target.agentId, alias: target.alias }, ...result };
    } catch (err) {
      if (!(err instanceof ShellRunError)) throw err;
      if (err.code === 'NOT_RUNNING') throw new AppError('UNAVAILABLE', 'target tab is not running');
      throw new AppError(
        'CONFLICT',
        err.code === 'BUSY' ? 'a run is already in progress on that tab' : 'the user is typing in that tab',
        { reason: err.code },
      );
    }
  });

  app.get<{ Params: { agent: string } }>('/api/intercom/tabs/:agent/read', async (req) => {
    const ex = requireAgent(app, req);
    const q = ReadQuery.parse(req.query ?? {});
    const target = await app.deps.agents.resolve(ex.scopeId, req.params.agent);
    assertSandboxBoundary(app, ex, target);
    if (!target.live) throw new AppError('VALIDATION', 'target is not live');
    const key = sessionKeyFor(target.mode, target.worktreePath, target.sessionId);
    const lines = Math.min(READ_LINES_MAX, q.lines ?? READ_LINES_DEFAULT);
    return {
      target: { agentId: target.agentId, alias: target.alias },
      lines: peekLines(app.deps.terminal.snapshot(key), lines),
      status: app.deps.terminal.status(key).status,
    };
  });

  // Shared tasks + escalation (step 8): an agent creates, lists, claims,
  // releases, or completes a task, and opens or resolves an escalation to a
  // peer or to the human. The kill switch and 401 apply to every route below.
  app.post('/api/intercom/tasks', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const b = TaskCreateBody.parse(req.body);
    reply.code(201);
    return { task: app.deps.intercom.createTask({ scopeId: ex.scopeId, by: actorOf(ex), title: b.title, body: b.body, ticketKey: b.ticketKey ?? null, dependsOn: b.dependsOn, worktreePath: b.worktreePath ?? null }) };
  });
  app.get('/api/intercom/tasks', async (req) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const q = TaskListQuery.parse(req.query ?? {});
    return { tasks: app.deps.intercom.listTasks(ex.scopeId, { status: q.status, claimedBy: q.mine === '1' ? ex.agentId : undefined, limit: q.limit }) };
  });
  for (const [verb, fn] of [
    ['claim', (s: string, id: string, ex: Execution) => app.deps.intercom.claimTask(s, id, actorOf(ex))],
    ['release', (s: string, id: string, ex: Execution) => app.deps.intercom.releaseTask(s, id, actorOf(ex))],
    ['done', (s: string, id: string, ex: Execution) => app.deps.intercom.doneTask(s, id, actorOf(ex))],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/intercom/tasks/:id/${verb}`, async (req) => {
      const ex = requireAgent(app, req); assertTasksEnabled();
      return { task: fn(ex.scopeId, req.params.id, ex) };
    });
  }
  app.post('/api/intercom/escalations', { bodyLimit: ESCALATION_BODY_MAX + CONTEXT_MAX + 16 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const b = EscalationCreateBody.parse(req.body);
    const to = b.to === undefined ? HUMAN_AGENT_ID : (await app.deps.agents.resolve(ex.scopeId, b.to)).agentId;
    if (to === ex.agentId) throw new AppError('VALIDATION', 'cannot ask yourself');
    reply.code(201);
    return { escalation: app.deps.intercom.createEscalation({ scopeId: ex.scopeId, from: actorOf(ex), to, title: b.title, body: b.body, context: b.context, taskId: b.taskId ?? null, timeoutMs: b.timeoutMs ?? null }) };
  });
  app.get<{ Params: { id: string } }>('/api/intercom/escalations/:id', async (req) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const e = app.deps.intercom.getEscalation(ex.scopeId, req.params.id);
    if (e.from.agentId !== ex.agentId && e.to !== ex.agentId) throw new AppError('NOT_FOUND', `no escalation "${req.params.id}"`);
    // An asker polling its own question must see the timeout without waiting
    // for the hourly sweep: pollEscalation retargets an overdue peer ask on
    // read, comparing the deadline against the store's own clock.
    return { escalation: app.deps.intercom.pollEscalation(ex.scopeId, req.params.id) };
  });
  app.post<{ Params: { id: string } }>('/api/intercom/escalations/:id/resolve', { bodyLimit: ESCALATION_BODY_MAX + 16 * 1024 }, async (req) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const b = EscalationResolveBody.parse(req.body);
    // The store's resolve is idempotent for an already-resolved row (any
    // caller may read back a settled fact) and answers a plain CONFLICT for a
    // dismissed one regardless of caller — either way a stranger must never
    // be the one to discover that a settled row exists by calling resolve.
    // Gate on identity here before it can reach either path. An open
    // escalation is left to the store's own target-only check below, which
    // answers FORBIDDEN for a wrong agent rather than NOT_FOUND.
    const e = app.deps.intercom.getEscalation(ex.scopeId, req.params.id);
    if (e.status !== 'open' && e.from.agentId !== ex.agentId && e.to !== ex.agentId) {
      throw new AppError('NOT_FOUND', `no escalation "${req.params.id}"`);
    }
    return { escalation: app.deps.intercom.resolveEscalation(ex.scopeId, req.params.id, actorOf(ex), b.resolution) };
  });

  // Claude hook entry point (step 4). SessionStart/UserPromptSubmit: peek →
  // choose what fits the budget → claim exactly that as one batch → render.
  // Stop: acknowledge only batches this execution confirmed after printing.
  app.post('/api/intercom/hook', async (req) => {
    const ex = requireAgent(app, req);
    const { event, transport } = HookBody.parse(req.body);
    if (event === 'Stop') {
      const acknowledged = app.deps.intercom.ackAll(ex.scopeId, ex.agentId, ex.executionId);
      return { additionalContext: null, batchId: null, delivered: 0, acknowledged };
    }
    const candidates = await withAliases(app, ex.scopeId, app.deps.intercom.peek(ex.scopeId, ex.agentId, HOOK_PULL_LIMIT));
    const chosen = selectUnderBudget(candidates, { transport });
    const claimed = app.deps.intercom.claim(ex.scopeId, ex.agentId, ex.executionId, chosen.map((m) => m.id));
    // Render from what was actually claimed: a subset of `chosen`, so still under budget.
    const messages = await withAliases(app, ex.scopeId, claimed.messages);
    return {
      additionalContext: formatInboxContext(messages, { transport }),
      batchId: claimed.batchId,
      delivered: messages.length,
      acknowledged: 0,
    };
  });

  // The hook calls this only after its stdout write succeeded. A stale or
  // foreign batch id is not an error — the hook fires and forgets.
  app.post('/api/intercom/hook/confirm', async (req) => {
    const ex = requireAgent(app, req);
    const { batchId } = ConfirmBody.parse(req.body);
    return { confirmed: app.deps.intercom.confirm(ex.scopeId, ex.agentId, ex.executionId, batchId) };
  });

  // Cross-agent fork (step 9a): hand a live thread's working context to a
  // peer or a freshly spawned tab. Delivery (the summary ask, the package,
  // the nudge) happens off the bus through ForkService; this route only opens
  // the row and hands back where it stands.
  app.post('/api/intercom/forks', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const b = ForkCreateBody.parse(req.body);
    const source = await app.deps.agents.resolve(ex.scopeId, b.source ?? ex.agentId);
    // A fork hands the source's summary, repository snapshot and notes to the
    // target's inbox, so naming a foreign source is a read of that worktree.
    assertSandboxBoundary(app, ex, source);
    const target = await resolveForkTarget(app, ex.scopeId, source, b);
    if (target.kind === 'new') {
      assertForkSandboxBoundary(app, ex, target.worktreePath);
      await assertForkWorktreePath(app, ex.scopeId, target.worktreePath);
    }
    const fork = await app.deps.forks.create({
      scopeId: ex.scopeId, from: actorOf(ex), source: { agentId: source.agentId },
      target, notes: b.notes, taskId: b.taskId ?? null,
    });
    reply.code(201);
    return { fork };
  });

  app.get<{ Params: { id: string } }>('/api/intercom/forks/:id', async (req) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    // Visibility first, on the row as it stands — a stranger must not be the
    // one whose read advances a summarising fork past its deadline. Only once
    // the caller is confirmed does poll() run (never store.getFork() for the
    // actual response: a `summarising` row past its deadline advances to the
    // diary fallback on read, same as an escalation retarget).
    const raw = app.deps.intercom.getFork(ex.scopeId, req.params.id);
    if (raw.from.agentId !== ex.agentId && raw.source.agentId !== ex.agentId && raw.target.agentId !== ex.agentId) {
      throw new AppError('NOT_FOUND', `no fork "${req.params.id}"`);
    }
    return { fork: app.deps.forks.poll(ex.scopeId, req.params.id) };
  });
}

/** Workspace-scoped, read-only UI view. No token, like every other /api/w route. */
export async function registerIntercomScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/intercom/messages', async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const scopeId = req.workspace!.id;
    return { messages: await withAliases(app, scopeId, app.deps.intercom.listScope(scopeId, q)) };
  });

  app.get('/intercom/diary', async (req) => diaryFor(app, req.workspace!.id, req.query));

  app.get('/intercom/peers', async (req) => ({ peers: await app.deps.agents.list(req.workspace!.id) }));

  // Human-facing tasks + escalation (step 8): no token — the caller is the
  // human, identified by the `HUMAN` actor constant, never a bearer token.
  app.get('/intercom/tasks', async (req) => {
    assertTasksEnabled();
    const q = TaskListQuery.parse(req.query ?? {});
    return { tasks: app.deps.intercom.listTasks(req.workspace!.id, { status: q.status, limit: q.limit }) };
  });
  app.post('/intercom/tasks', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    assertTasksEnabled();
    const b = TaskCreateBody.parse(req.body);
    reply.code(201);
    return { task: app.deps.intercom.createTask({ scopeId: req.workspace!.id, by: HUMAN, title: b.title, body: b.body, ticketKey: b.ticketKey ?? null, dependsOn: b.dependsOn, worktreePath: b.worktreePath ?? null }) };
  });
  app.post<{ Params: { id: string } }>('/intercom/tasks/:id/assign', async (req) => {
    assertTasksEnabled();
    const { agent } = TaskAssignBody.parse(req.body);
    const scopeId = req.workspace!.id;
    const target = await app.deps.agents.resolve(scopeId, agent);
    if (!target.live || !target.executionId) throw new AppError('CONFLICT', `${target.agentId} has no live tab`, { reason: 'agent_offline' });
    return { task: app.deps.intercom.assignTask(scopeId, req.params.id, { agentId: target.agentId, executionId: target.executionId }) };
  });
  app.post<{ Params: { id: string } }>('/intercom/tasks/:id/release', async (req) => { assertTasksEnabled(); return { task: app.deps.intercom.releaseTask(req.workspace!.id, req.params.id, HUMAN) }; });
  app.post<{ Params: { id: string } }>('/intercom/tasks/:id/done', async (req) => { assertTasksEnabled(); return { task: app.deps.intercom.doneTask(req.workspace!.id, req.params.id, HUMAN) }; });
  app.post<{ Params: { id: string } }>('/intercom/tasks/:id/cancel', async (req) => { assertTasksEnabled(); return { task: app.deps.intercom.cancelTask(req.workspace!.id, req.params.id) }; });
  app.get('/intercom/escalations', async (req) => {
    assertTasksEnabled();
    const q = EscalationListQuery.parse(req.query ?? {});
    return { escalations: app.deps.intercom.listEscalations(req.workspace!.id, { status: q.status, limit: q.limit }) };
  });
  app.post<{ Params: { id: string } }>('/intercom/escalations/:id/resolve', { bodyLimit: ESCALATION_BODY_MAX + 16 * 1024 }, async (req) => {
    assertTasksEnabled();
    const b = EscalationResolveBody.parse(req.body);
    return { escalation: app.deps.intercom.resolveEscalation(req.workspace!.id, req.params.id, HUMAN, b.resolution) };
  });
  app.post<{ Params: { id: string } }>('/intercom/escalations/:id/dismiss', async (req) => { assertTasksEnabled(); return { escalation: app.deps.intercom.dismissEscalation(req.workspace!.id, req.params.id) }; });

  // Human-facing fork (step 9a): no token, no sandbox boundary — the caller
  // is the browser, not a sandboxed tab. `source` is required: unlike an
  // agent's own call, there is no caller identity to default it from.
  app.post('/intercom/forks', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    assertTasksEnabled();
    const b = ForkCreateBody.parse(req.body);
    if (b.source === undefined) throw new AppError('VALIDATION', 'source is required');
    const scopeId = req.workspace!.id;
    const source = await app.deps.agents.resolve(scopeId, b.source);
    const target = await resolveForkTarget(app, scopeId, source, b);
    if (target.kind === 'new') await assertForkWorktreePath(app, scopeId, target.worktreePath);
    const fork = await app.deps.forks.create({
      scopeId, from: HUMAN, source: { agentId: source.agentId }, target, notes: b.notes, taskId: b.taskId ?? null,
    });
    reply.code(201);
    return { fork };
  });
  app.get('/intercom/forks', async (req) => {
    assertTasksEnabled();
    const q = ForkListQuery.parse(req.query ?? {});
    return { forks: app.deps.intercom.listForks(req.workspace!.id, { status: q.status, limit: q.limit }) };
  });
  app.post<{ Params: { id: string } }>('/intercom/forks/:id/cancel', async (req) => {
    assertTasksEnabled();
    return { fork: app.deps.intercom.cancelFork(req.workspace!.id, req.params.id) };
  });
}
