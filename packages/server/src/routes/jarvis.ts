import { timingSafeEqual } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AgentMode } from '../services/handoffStore.js';
import { cutUtf8 } from '../services/intercomContext.js';
import { HUMAN } from '../services/intercomStore.js';
import { NUDGE } from '../services/intercomPush.js';
import { BODY_MAX, HUMAN_AGENT_ID, STRADO_SENDER_ID } from '../services/intercomSchema.js';
import { createTabOps, keyOfRef, type CommandResult } from '../services/tabOps.js';
import { assertHubRequest } from './appControl.js';
import { ACTIONS } from '../services/actions.js';
import type { RecapAgent } from '../services/jarvisModel.js';
import { readProfile } from '../services/profileStore.js';
import { sessionKeyFor } from '../services/terminalManager.js';
import { findOwningRepo } from '../services/worktreeRoot.js';
import { deriveRunCommands } from '../repoConfig.js';

// Jarvis: the hub's command box (⌘K). These routes act as the HUMAN — no
// spawn guard, no escalation — so they must only answer the hub itself:
// the loopback Origin/Host guard plus a per-boot token the hub fetched from
// GET /api/jarvis/session. Layout (split/focus/browser) never comes here; the
// window does it locally. Spec: docs/specs/2026-10-17-jarvis-command-box-design.md.

export const HUB_TOKEN_HEADER = 'x-strado-hub-token';

/** Model calls per minute the box may make. A human types far fewer; this
 * caps what a stuck client loop can spend on the user's key. */
export const PLAN_PER_MINUTE = 30;

// Same patterns as the box's looksSecret (web lib/jarvis/history.ts): the box
// refuses first, the server refuses again so nothing secret-looking reaches
// the model even from a buggy or old client.
const SECRET_PATTERNS: RegExp[] = [
  /(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\s*[=:]/i,
  /\bauthorization\s*:/i,
  /\bbearer\s+\S/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_/,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bxox[abpr]-/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /_authToken/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // a JWT
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/, // npm
];
export const SECRET_PATTERN_SOURCES = (): string[] => SECRET_PATTERNS.map((re) => `${re.source}/${re.flags}`);
export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((re) => re.test(text));

/** The thread must read user, assistant, user, … so the model sees real turns. */
const alternates = (thread: { role: string }[]) => thread.every((t, i) => t.role === (i % 2 === 0 ? 'user' : 'assistant'));
export const JARVIS_RUN_TIMEOUT_MS = 15_000;

const TabRefBody = z.object({
  worktreePath: z.string().min(1).max(4096),
  mode: z.enum(['claude', 'codex', 'opencode', 'pi', 'shell']),
  sessionId: z.string().min(1).max(64),
  /** The tab's identity when the box learned about it. Session numbers are
   * reused (close shell-3, open a new one: shell-3 again); with this set, a
   * different tab under the same ref is a 409, never acted on. */
  executionId: z.string().min(1).max(100).optional(),
}).strict();

const SpawnBody = z.object({
  mode: z.enum(['claude', 'codex', 'opencode', 'pi', 'shell']),
  worktreePath: z.string().min(1).max(4096),
  command: z.string().min(1).max(4096).refine((s) => !/[\r\n]/.test(s), { message: 'command must be a single line' }).optional(),
  prompt: z.string().min(1).max(8 * 1024).optional(),
}).strict();

const RunBody = z.object({
  target: TabRefBody,
  command: z.string().min(1).max(4096).refine((s) => !/[\r\n]/.test(s), { message: 'command must be a single line' }),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
}).strict();

const TargetBody = z.object({ target: TabRefBody }).strict();

const name = z.string().min(1).max(300);
const PlanBody = z.object({
  text: z.string().min(1).max(2000),
  context: z.object({
    worktree: z.object({ name }).strict().nullable(),
    focused: name.nullable(),
    tabs: z.array(z.object({ name, mode: z.string().max(20), label: z.string().max(300).optional(), busy: z.boolean(), worktree: name }).strict()).max(60),
    // repo: the owning repo's name ("in Strado Website" picks its worktree).
    worktrees: z.array(z.object({ name, branch: z.string().max(300).optional(), repo: name.optional() }).strict()).max(50),
    // The workspace this window is in, and every workspace by name.
    workspace: z.object({ name }).strict().nullable().default(null),
    workspaces: z.array(z.object({ name }).strict()).max(30).default([]),
    // The Focus open in this window, and each Focus's member worktrees.
    focus: z.object({ name }).strict().nullable().default(null),
    focuses: z.array(z.object({ name, worktrees: z.array(name).max(30).default([]) }).strict()).max(30),
    scripts: z.array(z.string().max(100)).max(50),
    packageManager: z.string().max(10),
    runCommands: z.array(z.object({ name }).strict()).max(30).default([]),
    agents: z.array(z.object({ name, mode: z.string().max(20), lifecycle: z.string().max(20) }).strict()).max(30),
    // Agents waiting on the user (dock calls), and the repos a new worktree can come from.
    calls: z.array(z.object({ from: name, title: z.string().max(300) }).strict()).max(20).default([]),
    // Never from the box: the route adds the board itself (contextWithBoard).
    tasks: z.array(z.never()).max(0).default([]),
    repos: z.array(z.object({ name }).strict()).max(50).default([]),
  }).strict(),
  thread: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(2000) }).strict()).max(6),
}).strict();

const CALL_BODY_MAX = 500;
const TASKS_MAX = 20;

const ScriptsQuery = z.object({ worktreePath: z.string().min(1).max(4096) });

const LOCKFILES: [string, 'pnpm' | 'yarn' | 'bun' | 'npm'][] = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'],
];

/** Script names of the worktree's package.json and its package manager (by lockfile; npm when unknown). */
export async function readScripts(worktreePath: string): Promise<{ packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'; scripts: string[] }> {
  let scripts: string[] = [];
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(worktreePath, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    if (pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null) scripts = Object.keys(pkg.scripts).slice(0, 200);
  } catch { /* no or unreadable package.json: no scripts */ }
  let packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm';
  for (const [file, pm] of LOCKFILES) {
    if (await fsp.access(path.join(worktreePath, file)).then(() => true, () => false)) { packageManager = pm; break; }
  }
  return { packageManager, scripts };
}

const MessageBody = z.object({
  to: z.string().min(1).max(200),
  body: z.string().min(1).max(BODY_MAX),
  // A question: the agent answers through the intercom, and the box shows it.
  ask: z.literal(true).optional(),
}).strict();

const RecapBody = z.object({
  agents: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  all: z.literal(true).optional(),
  // The user's words, so the answer fits what they asked.
  question: z.string().min(1).max(2000).optional(),
}).strict().refine((b) => (b.agents === undefined) !== (b.all === undefined), { message: 'give agents or all, not both' });

/** Turns per agent the recap reads, and how much of each side. */
const RECAP_TURNS = 8;
const RECAP_ASKED_MAX = 600;
const RECAP_ANSWERED_MAX = 900;
/** A refresh reads the transcript; never hold the answer up for long. */
const RECAP_REFRESH_MS = 1500;

/** Turn text goes to the model: lines that look like a secret never do. */
export const hideSecrets = (text: string): string =>
  text.split('\n').map((l) => (looksSecret(l) ? '[hidden: looked like a secret]' : l)).join('\n');

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The loopback hub, holding this boot's token. */
function requireHub(app: FastifyInstance, req: FastifyRequest): void {
  assertHubRequest(req.headers);
  const t = req.headers[HUB_TOKEN_HEADER];
  if (typeof t !== 'string' || !sameSecret(t, app.deps.hubToken)) throw new AppError('UNAUTHENTICATED', 'missing or invalid hub token');
}

export async function registerJarvisRoutes(app: FastifyInstance): Promise<void> {
  // Same-origin fetch from the hub. A cross-site page can send this request
  // but not read the answer (no CORS headers), and DNS rebinding fails the
  // Host check. It is not a secret from the user's own processes: anything
  // running as the user on this machine can fetch it (and do far more).
  app.get('/api/jarvis/session', async (req, reply) => {
    assertHubRequest(req.headers);
    reply.header('cache-control', 'no-store');
    return { token: app.deps.hubToken };
  });

  // The action registry, for the box's parser and any future surface.
  app.get('/api/jarvis/actions', async (req) => {
    assertHubRequest(req.headers);
    return { actions: ACTIONS };
  });
}

export async function registerJarvisScopedRoutes(app: FastifyInstance): Promise<void> {
  const ops = createTabOps(app);
  const planCalls: number[] = []; // start times within the last minute

  app.post('/jarvis/spawn', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    requireHub(app, req);
    const b = SpawnBody.parse(req.body);
    if (b.command !== undefined && b.mode !== 'shell') throw new AppError('VALIDATION', 'command is only for a shell');
    if (b.prompt !== undefined && b.mode === 'shell') throw new AppError('VALIDATION', 'prompt is only for an agent');
    const scopeId = req.workspace!.id;
    await ops.assertWorktree(scopeId, b.worktreePath);
    const spawned = await ops.spawnTab(scopeId, b.mode, b.worktreePath);
    const agent = await app.deps.agents.resolve(scopeId, spawned.execution.agentId);
    let command: CommandResult | undefined;
    if (b.command !== undefined) {
      await ops.shellSettled(spawned.key);
      command = await ops.runCommand(spawned.key, b.command);
    }
    // The first prompt is the human's message too: it waits in the new agent's
    // inbox, and only the notice is typed once the harness is ready.
    if (b.prompt !== undefined) {
      app.deps.intercom.send({ scopeId, fromAgentId: HUMAN.agentId, fromExecutionId: HUMAN.executionId, toAgentId: agent.agentId, kind: 'message', replyTo: null, body: b.prompt, context: [], idempotencyKey: null, expiresInMs: null });
      ops.deliverPrompt(scopeId, agent.agentId, spawned.key, b.mode, NUDGE(1));
    }
    reply.code(201);
    return {
      agent: { agentId: agent.agentId, alias: agent.alias, mode: agent.mode, worktreePath: agent.worktreePath, sessionId: agent.sessionId, executionId: spawned.execution.executionId },
      ...(command ? { command } : {}),
      ...(b.prompt !== undefined ? { prompt: { status: 'queued' } } : {}),
    };
  });

  app.post('/jarvis/run', async (req) => {
    requireHub(app, req);
    const b = RunBody.parse(req.body);
    const tab = await ops.liveTab(req.workspace!.id, b.target);
    if (tab.mode !== 'shell') throw new AppError('VALIDATION', 'target is not a shell tab');
    await ops.settleIfFresh(keyOfRef(b.target));
    return ops.runCommand(keyOfRef(b.target), b.command, b.timeoutMs ?? JARVIS_RUN_TIMEOUT_MS);
  });

  app.post('/jarvis/interrupt', async (req) => {
    requireHub(app, req);
    const b = TargetBody.parse(req.body);
    await ops.liveTab(req.workspace!.id, b.target);
    ops.interrupt(keyOfRef(b.target));
    return { ok: true };
  });

  app.post('/jarvis/close', async (req) => {
    requireHub(app, req);
    const b = TargetBody.parse(req.body);
    await ops.liveTab(req.workspace!.id, b.target);
    ops.close(keyOfRef(b.target));
    return { ok: true };
  });

  // Natural language: free text → a proposed plan (or a short answer). The
  // box previews it and runs nothing until ⏎. A `$` line is a literal shell
  // command and never leaves the machine.
  /** What the box cannot know but the model needs to answer "what does X want"
   * and "what tasks are open": each call's question, and the task board. */
  const contextWithBoard = (scopeId: string, context: z.infer<typeof PlanBody>['context']) => {
    const list = <T>(read: () => T[]): T[] => { try { return read(); } catch { return []; } }; // the board is off
    const open = list(() => app.deps.intercom.listEscalations(scopeId, { status: 'open', limit: 200 })).filter((e) => e.to === HUMAN_AGENT_ID);
    const calls = context.calls.map((c) => {
      const e = open.find((x) => x.title === c.title);
      return e ? { ...c, body: cutUtf8(e.body, CALL_BODY_MAX) } : c;
    });
    const short = (agentId: string) => agentId.split('@')[0]!;
    const tasks = (['open', 'claimed'] as const).flatMap((status) => list(() => app.deps.intercom.listTasks(scopeId, { status, limit: TASKS_MAX })))
      .slice(0, TASKS_MAX)
      .map((t) => ({ title: cutUtf8(t.title, 200), status: t.status as 'open' | 'claimed', ...(t.claimedBy ? { by: short(t.claimedBy.agentId) } : {}) }));
    return { ...context, calls, tasks };
  };

  app.post('/jarvis/plan', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    requireHub(app, req);
    const b = PlanBody.parse(req.body);
    if (b.text.trimStart().startsWith('$')) throw new AppError('VALIDATION', 'shell commands are never sent to the model', { reason: 'shell_text' });
    if (looksSecret(b.text) || b.thread.some((t) => looksSecret(t.text))) throw new AppError('VALIDATION', 'that looks like a secret; it is never sent to the model', { reason: 'secret' });
    if (!alternates(b.thread)) throw new AppError('VALIDATION', 'thread must alternate user/assistant, starting with user', { reason: 'thread' });
    const now = Date.now();
    while (planCalls.length && now - planCalls[0]! > 60_000) planCalls.shift();
    if (planCalls.length >= PLAN_PER_MINUTE) throw new AppError('UNAVAILABLE', 'too many model requests; wait a moment', { reason: 'rate_limited' });
    planCalls.push(now);
    if ((await readProfile()).jarvisLocalOnly) throw new AppError('FORBIDDEN', 'local only is on: nothing is sent to a model', { reason: 'local_only' });
    const ac = new AbortController();
    // The box aborts its fetch when the user keeps typing: stop paying for an
    // answer nobody will read. (The response side closes early only then.)
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) ac.abort(); });
    // Jev and the model start together: a confident single choice-only Jev
    // decision wins and cancels the model; otherwise the model's answer is
    // already on its way, so a Jev "no" costs no extra time (live: Jev took
    // 0.6–0.9 s, which run in series added to every Haiku answer).
    const input = { text: b.text, context: contextWithBoard(req.workspace!.id, b.context), thread: b.thread };
    const modelAc = new AbortController();
    ac.signal.addEventListener('abort', () => modelAc.abort());
    const slow = app.deps.jarvisModel.plan(input, modelAc.signal);
    slow.catch(() => {}); // observed below, or abandoned when Jev wins
    const fast = await app.deps.jevRouter.route(input, ac.signal);
    if (fast) { modelAc.abort(); return fast; }
    return slow;
  });

  // What agents are doing and have done, from their saved turns: nothing is
  // sent to the agents. Their turns go to the model, so local only refuses.
  app.post('/jarvis/recap', { bodyLimit: 16 * 1024 }, async (req) => {
    requireHub(app, req);
    const b = RecapBody.parse(req.body);
    const scopeId = req.workspace!.id;
    const agents = b.all
      ? (await app.deps.agents.list(scopeId)).filter((a) => a.mode !== 'shell' && a.live)
      : await Promise.all(b.agents!.map(async (ref) => {
        const a = await app.deps.agents.resolve(scopeId, ref);
        if (a.mode === 'shell') throw new AppError('VALIDATION', `${a.alias ?? a.agentId} is a shell: it has no turns`, { reason: 'shell_target' });
        return a;
      }));
    // Bring the diary up to date (a working agent's latest turn), bounded.
    await Promise.race([
      Promise.all(agents.map((a) => app.deps.turnDiary.refresh(a.mode as AgentMode, a.worktreePath, a.sessionId, 'working'))),
      new Promise((r) => setTimeout(r, RECAP_REFRESH_MS).unref()),
    ]);
    const lifecycles = new Map((await app.deps.agents.list(scopeId)).map((a) => [a.agentId, a.lifecycle] as const));
    const data: RecapAgent[] = agents.map((a) => ({
      name: a.alias ?? a.agentId,
      mode: a.mode,
      state: lifecycles.get(a.agentId) ?? 'unknown',
      turns: app.deps.intercom.listTurns(scopeId, a.agentId, { limit: RECAP_TURNS }).reverse().map((t) => ({
        at: new Date(t.endedAt).toISOString(),
        asked: hideSecrets(cutUtf8(t.prompt, RECAP_ASKED_MAX)),
        answered: hideSecrets(cutUtf8(t.reply, RECAP_ANSWERED_MAX)),
      })),
    }));
    const out = { agents: agents.map((a) => ({ agentId: a.agentId, alias: a.alias, lifecycle: lifecycles.get(a.agentId) ?? null })) };
    // Nothing to read: say so without a model call.
    if (data.every((a) => a.turns.length === 0)) {
      const names = data.map((a) => a.name);
      const text = names.length === 0 ? 'No agents are running.'
        : `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no finished turns yet${data.some((a) => a.state === 'working') ? ' (working on the first one now)' : ''}.`;
      return { text, ...out };
    }
    if ((await readProfile()).jarvisLocalOnly) throw new AppError('FORBIDDEN', 'local only is on: nothing is sent to a model', { reason: 'local_only' });
    const now = Date.now();
    while (planCalls.length && now - planCalls[0]! > 60_000) planCalls.shift();
    if (planCalls.length >= PLAN_PER_MINUTE) throw new AppError('UNAVAILABLE', 'too many model requests; wait a moment', { reason: 'rate_limited' });
    planCalls.push(now);
    const question = b.question && !looksSecret(b.question) ? b.question : `What ${data.length === 1 ? `is ${data[0]!.name}` : 'are these agents'} doing, and what has been done?`;
    const { text } = await app.deps.jarvisModel.recap({ question, agents: data });
    return { text, ...out };
  });

  // package.json scripts of a worktree, so "run dev" resolves in the box.
  app.get('/jarvis/scripts', async (req) => {
    requireHub(app, req);
    const { worktreePath } = ScriptsQuery.parse(req.query ?? {});
    await ops.assertWorktree(req.workspace!.id, worktreePath);
    // And the repo's run commands, so "run api" / "stop web" resolve in the box.
    const repo = findOwningRepo(await req.workspace!.stores.repos.list(), worktreePath, app.deps.homeStateDir, { includeRepoRoot: true });
    const runCommands = repo ? deriveRunCommands(repo).map((c) => ({ id: c.id, name: c.name })) : [];
    return { ...(await readScripts(worktreePath)), runCommands };
  });

  // A message from the human to an agent, through the intercom inbox (so a
  // busy agent reads it at its next prompt; an idle one is nudged).
  /** The agent's oldest open call to the human, or null (none, or the board is off). */
  const oldestCallFrom = (scopeId: string, agentId: string) => {
    let open: ReturnType<typeof app.deps.intercom.listEscalations> = [];
    try { open = app.deps.intercom.listEscalations(scopeId, { status: 'open', limit: 200 }); } catch { return null; }
    // Newest first, ties in insertion order (ids are random within a millisecond).
    return open.filter((e) => e.to === HUMAN_AGENT_ID && e.from.agentId === agentId).at(-1) ?? null;
  };

  app.post('/jarvis/message', { bodyLimit: BODY_MAX + 16 * 1024 }, async (req, reply) => {
    requireHub(app, req);
    const b = MessageBody.parse(req.body);
    const scopeId = req.workspace!.id;
    if (b.to.trim().toLowerCase() === STRADO_SENDER_ID) throw new AppError('VALIDATION', '"strado" is not an agent');
    const to = await app.deps.agents.resolve(scopeId, b.to);
    // A shell has no prompt and no inbox reader: a message would sit queued
    // forever behind a "queued" toast. Commands for a shell go through run.
    if (to.mode === 'shell') throw new AppError('VALIDATION', `${to.alias ?? to.agentId} is a shell: run a command in it instead`, { reason: 'shell_target' });
    // An agent calling the human (an escalation, or an ask that reached the
    // human) is waiting on an answer: the box's message IS that answer, to the
    // oldest open call, which then closes. An ask is a new question instead.
    const call = b.ask ? null : oldestCallFrom(scopeId, to.agentId);
    // Always through the intercom: the agent reads the human's words from its
    // inbox (the hook's strada-intercom block / intercom_inbox), never as text
    // typed into its prompt. An agent at rest is told it has mail at once: the
    // inbox push does that on arrival, except for a Claude with no status
    // since a restart ('starting'), which the push never reaches, so the
    // route sends it the same notice. Only that notice crosses the PTY.
    const id = call
      ? app.deps.intercom.resolveEscalation(scopeId, call.id, HUMAN, b.body).replyMessageId ?? call.id
      : app.deps.intercom.send({
        scopeId, fromAgentId: HUMAN.agentId, fromExecutionId: HUMAN.executionId, toAgentId: to.agentId,
        kind: b.ask ? 'request' : 'message', replyTo: null, body: b.body, context: [], idempotencyKey: null, expiresInMs: null,
      }).receipt.id;
    const me = (await app.deps.agents.list(scopeId)).find((a) => a.agentId === to.agentId);
    const atRest = !!me && me.live && me.lifecycle !== 'working' && me.lifecycle !== 'needs_input';
    if (atRest && me.mode === 'claude' && me.lifecycle === 'starting') {
      const queued = app.deps.intercom.peek(scopeId, to.agentId, 50).length || 1;
      void app.deps.intercomPush.nudge(sessionKeyFor(me.mode, me.worktreePath, me.sessionId), NUDGE(queued));
    }
    reply.code(201);
    return {
      delivered: atRest ? 'sent' : 'queued', id, to: { agentId: to.agentId, alias: to.alias },
      ...(b.ask ? { ask: true } : {}),
      ...(call ? { answered: { callId: call.id, title: call.title } } : {}),
    };
  });
}
