import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAgent } from '../hooks/requireAgent.js';
import { describeTool } from '../services/agentControl.js';
import { hideSecrets } from './jarvis.js';
import { assertHubRequest } from './appControl.js';
import { AppError } from '../errors.js';
import { formatInboxContext, selectUnderBudget } from '../services/intercomContext.js';
import {
  BODY_MAX, CONTEXT_MAX, ConfirmBody, DiaryQuery, EscalationCreateBody, EscalationResolveBody,
  ESCALATION_BODY_MAX, HOOK_PULL_LIMIT, HookBody, HUMAN_AGENT_ID, ListQuery, PullBody,
  READ_LINES_DEFAULT, READ_LINES_MAX, ReadQuery, RUN_TIMEOUT_MAX_MS, RUN_TIMEOUT_MIN_MS, RUN_TIMEOUT_MS, RunBody, SendBody, SHELL_RUN_ENV,
  TaskCreateBody, TaskListQuery, TASKS_ENV, UI_LIST_MAX,
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

/** The task half of the boundary: a sandboxed tab may create or claim only
 * tasks that name no worktree or its own. A null path is everyone's. */
function assertTaskSandboxBoundary(app: FastifyInstance, ex: Execution, worktreePath: string | null): void {
  const callerPath = parseSessionKey(ex.key).path;
  if (app.deps.sandboxSlugs.slugOf(callerPath) === null || worktreePath === null) return;
  if (worktreePath !== callerPath) {
    throw new AppError('FORBIDDEN', 'a sandboxed tab can only take tasks of its own worktree');
  }
}

/** Resolve `agent` (exact id or unique alias, never a guess) and list its turns newest first. */
async function diaryFor(app: FastifyInstance, scopeId: string, query: unknown, caller?: Execution) {
  const q = DiaryQuery.parse(query ?? {});
  const agent = await app.deps.agents.resolve(scopeId, q.agent);
  // A peer's diary is its conversation: reading one across the boundary is
  // the same leak read_tab is guarded against.
  if (caller) assertSandboxBoundary(app, caller, agent);
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
    // The human is reached by escalation, except to answer a question the
    // human asked this agent (the store checks replyTo names one).
    if (toRef === HUMAN_AGENT_ID && body.kind !== 'reply') throw new AppError('VALIDATION', 'use intercom_escalate to reach the human (or kind=reply to answer a question the human asked you)');
    let toAgentId = HUMAN_AGENT_ID;
    if (toRef !== HUMAN_AGENT_ID) {
      // Alias or exact id; throws NOT_FOUND (unknown) or CONFLICT (ambiguous).
      const target = await app.deps.agents.resolve(ex.scopeId, body.to);
      assertSandboxBoundary(app, ex, target);
      toAgentId = target.agentId;
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
    return diaryFor(app, ex.scopeId, req.query, ex);
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
    // A tab opened by agent_spawn types only into nothing it did not open:
    // typing `claude` or a curl into the human's shell would run with that
    // shell's (unmarked) identity and slip the spawn-depth limit.
    if (app.deps.spawnGuard.isSpawned(ex.executionId)) {
      throw new AppError('FORBIDDEN', 'a tab opened by agent_spawn cannot type into other shells', { reason: 'spawn_depth' });
    }
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
    assertTaskSandboxBoundary(app, ex, b.worktreePath ?? null);
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
      if (verb === 'claim') assertTaskSandboxBoundary(app, ex, app.deps.intercom.getTask(ex.scopeId, req.params.id).worktreePath);
      return { task: fn(ex.scopeId, req.params.id, ex) };
    });
  }
  app.post('/api/intercom/escalations', { bodyLimit: ESCALATION_BODY_MAX + CONTEXT_MAX + 16 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req); assertTasksEnabled();
    const b = EscalationCreateBody.parse(req.body);
    let to = HUMAN_AGENT_ID;
    if (b.to !== undefined) {
      const target = await app.deps.agents.resolve(ex.scopeId, b.to);
      assertSandboxBoundary(app, ex, target);
      to = target.agentId;
    }
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
    return { escalation: app.deps.intercom.pollEscalation(ex.scopeId, req.params.id, ex.agentId) };
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

  // Mission control. A Claude PermissionRequest hook holds this request open
  // while the TUI shows its own dialog: the box's Approve/Deny answers it here,
  // or the tab answers first and Claude cancels the hook, which closes the
  // request (the approval is then gone). Null decision: the dialog decides.
  app.post('/api/intercom/hook/permission', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const ex = requireAgent(app, req);
    const b = PermissionHookBody.parse(req.body);
    const ask = describeTool(b.tool_name, b.tool_input, worktreeOf(ex.key), hideSecrets);
    // The hook went away before we answered: Claude cancelled it (the tab's
    // dialog was answered) or it timed out. The request body's own 'close'
    // fires once it is read, so watch the response instead.
    const closed = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) closed.abort(); });
    const decision = await app.deps.agentControl.request(ex.scopeId, ex.agentId, { kind: ask.kind, title: ask.title, detail: ask.detail }, closed.signal);
    return { decision };
  });

  // The agent's live line: a tool started, or the turn ended with its final words.
  app.post('/api/intercom/hook/activity', { bodyLimit: 256 * 1024 }, async (req) => {
    const ex = requireAgent(app, req);
    const b = ActivityHookBody.parse(req.body);
    if (b.phase === 'tool') {
      const { line } = describeTool(b.tool_name ?? 'tool', b.tool_input, worktreeOf(ex.key), hideSecrets);
      app.deps.agentControl.toolStarted(ex.scopeId, ex.agentId, line);
    } else {
      const text = b.message?.trim() ? hideSecrets(b.message.trim()).slice(0, LAST_RESULT_MAX) : null;
      app.deps.agentControl.turnEnded(ex.scopeId, ex.agentId, text);
    }
    return { ok: true };
  });
}

const LAST_RESULT_MAX = 300;
const PermissionHookBody = z.object({ tool_name: z.string().min(1).max(200), tool_input: z.unknown().optional() });
const ActivityHookBody = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('tool'), tool_name: z.string().min(1).max(200), tool_input: z.unknown().optional() }),
  z.object({ phase: z.literal('stop'), message: z.string().max(64 * 1024).nullable().optional() }),
]);
/** The worktree a session key belongs to (paths in the box are shown relative to it). */
const worktreeOf = (key: string): string | null => {
  try { return parseSessionKey(key)?.path ?? null; } catch { return null; }
};

/** Workspace-scoped, read-only UI view. No token, like every other /api/w route. */
export async function registerIntercomScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/intercom/messages', async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const scopeId = req.workspace!.id;
    // `agent`: one station's line (the dock card's "Recent"), sent or received.
    const raw = (req.query as { agent?: unknown } | undefined)?.agent;
    const agent = typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null;
    // Filtered in the query: a quiet station in a busy workspace still has its line.
    const rows = app.deps.intercom.listScope(scopeId, agent === null ? q : { ...q, agent });
    return { messages: await withAliases(app, scopeId, rows) };
  });

  app.get('/intercom/diary', async (req) => diaryFor(app, req.workspace!.id, req.query));

  app.get('/intercom/peers', async (req) => ({ peers: await app.deps.agents.list(req.workspace!.id) }));

  // The dock's station lights (spec: 2026-10-17-strado-dock-intercom-design.md):
  // every tab in the workspace, with the calls waiting on the human, in one
  // read. A Claude at a permission prompt is calling too: it is blocked on
  // the human exactly like an open escalation.
  app.get('/intercom/stations', async (req) => {
    const scopeId = req.workspace!.id;
    const agents = await app.deps.agents.list(scopeId);
    const open = process.env[TASKS_ENV] === '0' ? [] : app.deps.intercom.listEscalations(scopeId, { status: 'open', limit: 200 });
    const now = Date.now();
    const stations = agents.map((a) => {
      const calls = open
        .filter((e) => e.to === HUMAN_AGENT_ID && e.from.agentId === a.agentId)
        .map((e) => ({ id: e.id, title: e.title, body: e.body, createdAt: e.createdAt }));
      const approvals = app.deps.agentControl.approvals(scopeId, a.agentId);
      const q = app.deps.ptyActivity.quiet(sessionKeyFor(a.mode, a.worktreePath, a.sessionId));
      const idleFor = Math.min(q.input, q.output);
      return {
        agentId: a.agentId,
        alias: a.alias,
        name: a.alias ?? a.agentId.split('@')[0]!,
        mode: a.mode,
        worktreePath: a.worktreePath,
        worktreeName: path.basename(a.worktreePath),
        sessionId: a.sessionId,
        lifecycle: a.lifecycle,
        live: a.live,
        needsYou: calls.length > 0 || a.lifecycle === 'needs_input' || approvals.length > 0,
        calls,
        ...app.deps.agentControl.activityOf(scopeId, a.agentId),
        approvals,
        lastActivityAt: Number.isFinite(idleFor) ? now - idleFor : null,
      };
    });
    // A call whose asker has no tab any more (it exited; a retargeted ask)
    // still waits on the human: listed apart so it can be answered or dismissed.
    const seen = new Set(agents.map((a) => a.agentId));
    const orphanCalls = open
      .filter((e) => e.to === HUMAN_AGENT_ID && !seen.has(e.from.agentId))
      .map((e) => ({ id: e.id, from: e.from.agentId, name: e.from.agentId.split('@')[0]!, title: e.title, body: e.body, createdAt: e.createdAt }));
    return { stations, orphanCalls };
  });

  // The human's side of an escalation (step 8): no token — the caller is the
  // human, identified by the `HUMAN` actor constant, never a bearer token.
  // Answering and dismissing are all the human does here (the command box and
  // Mission Control); the task board is the agents' own (their task_* tools).
  app.post<{ Params: { id: string } }>('/intercom/escalations/:id/resolve', { bodyLimit: ESCALATION_BODY_MAX + 16 * 1024 }, async (req) => {
    assertTasksEnabled();
    const b = EscalationResolveBody.parse(req.body);
    return { escalation: app.deps.intercom.resolveEscalation(req.workspace!.id, req.params.id, HUMAN, b.resolution) };
  });
  app.post<{ Params: { id: string } }>('/intercom/escalations/:id/dismiss', async (req) => { assertTasksEnabled(); return { escalation: app.deps.intercom.dismissEscalation(req.workspace!.id, req.params.id) }; });

  // Mission control, the human's side: answer an agent's permission request
  // from the box (a click — never the model), or stop an agent mid-turn.
  app.post<{ Params: { id: string } }>('/intercom/approvals/:id', async (req) => {
    assertHubRequest(req.headers);
    const { decision } = ApprovalBody.parse(req.body);
    if (app.deps.agentControl.decide(req.workspace!.id, req.params.id, decision) === 'gone') {
      throw new AppError('CONFLICT', 'already answered in the tab, or no longer waiting', { reason: 'gone' });
    }
    return { ok: true };
  });
  app.post<{ Params: { agentId: string } }>('/intercom/agents/:agentId/interrupt', async (req) => {
    assertHubRequest(req.headers);
    const agents = await app.deps.agents.list(req.workspace!.id);
    const a = agents.find((x) => x.agentId === req.params.agentId);
    if (!a || !a.live) throw new AppError('NOT_FOUND', 'no such agent running');
    // Esc is every harness's own "stop this turn" key: the TUI does what it always does.
    app.deps.terminal.write(sessionKeyFor(a.mode, a.worktreePath, a.sessionId), '\x1b');
    return { ok: true };
  });
}

const ApprovalBody = z.object({ decision: z.enum(['allow', 'deny']) });
