// Focus Jarvis routes (JARVIS_ROUTES): read a Focus's chat log, post a
// message or an approval, stop the running turn, switch the agent, and an SSE
// stream of new entries. The runner does the work; these routes only check
// the Focus exists and the request came from a window on this machine (every
// POST/PUT: assertLocalHub, so a relayed window cannot drive Jarvis).
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { JarvisChatChange } from '../services/jarvisChat/store.js';
import { JARVIS_AGENTS, JARVIS_LIMITS, type ChatEntry, type JarvisAgent, type JarvisContext, type JarvisMeta } from '../services/jarvisChat/types.js';
import { JarvisContextBody } from './jarvis.js';
import { assertLocalHub } from './profile.js';

/** What the routes need of the turn runner (jarvisChat/runner.ts). */
export type FocusJarvisRunner = {
  /** Appends the person's entry and starts (or queues) a turn. */
  send(ws: string, focusId: string, input: { text: string; windowId: string; context: JarvisContext }): Promise<ChatEntry>;
  approve(ws: string, focusId: string, entryId: string, input: { approve: boolean; windowId: string; context: JarvisContext }): Promise<void>;
  stop(ws: string, focusId: string): Promise<void>;
  /** The Focus is gone: stop, drop its queue, wait for the turn's last
   *  writes, remove its working dir. Without it, delete falls back to stop. */
  forget?(ws: string, focusId: string): Promise<void>;
};

const HEARTBEAT_MS = 15_000;

const WindowId = z.string().min(1).max(100);
const LogQuery = z.object({
  before: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(JARVIS_LIMITS.pageMax).optional(),
});
const SendBody = z.object({
  text: z.string().min(1).max(JARVIS_LIMITS.messageMax),
  windowId: WindowId,
  context: JarvisContextBody,
}).strict();
const ApproveBody = z.object({ approve: z.boolean(), windowId: WindowId, context: JarvisContextBody }).strict();
const AgentBody = z.object({ agent: z.enum(JARVIS_AGENTS as [JarvisAgent, ...JarvisAgent[]]) }).strict();

type Params = { id: string };

async function focusOf(req: FastifyRequest<{ Params: Params }>): Promise<string> {
  const id = req.params.id;
  const focuses = await req.workspace!.stores.focuses.list();
  if (!focuses.some((f) => f.id === id)) throw new AppError('NOT_FOUND', `focus ${id} not found`);
  return id;
}

function needRunner(runner: FocusJarvisRunner | null): FocusJarvisRunner {
  if (!runner) throw new AppError('UNAVAILABLE', 'Jarvis is not available on this server');
  return runner;
}

function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function registerFocusJarvisRoutes(app: FastifyInstance, runner: FocusJarvisRunner | null) {
  app.get<{ Params: Params }>('/focuses/:id/jarvis', async (req) => {
    const id = await focusOf(req);
    const q = LogQuery.parse(req.query ?? {});
    const { jarvis } = req.workspace!.stores;
    return { entries: await jarvis.page(id, q), meta: await jarvis.meta(id) };
  });

  app.post<{ Params: Params }>('/focuses/:id/jarvis/messages', async (req, reply) => {
    assertLocalHub(req.headers);
    const id = await focusOf(req);
    const body = SendBody.parse(req.body);
    const entry = await needRunner(runner).send(req.workspace!.id, id, body as typeof body & { context: JarvisContext });
    return reply.code(202).send({ entry });
  });

  app.post<{ Params: Params }>('/focuses/:id/jarvis/stop', async (req, reply) => {
    assertLocalHub(req.headers);
    const id = await focusOf(req);
    await needRunner(runner).stop(req.workspace!.id, id);
    return reply.code(204).send();
  });

  app.post<{ Params: Params & { entryId: string } }>('/focuses/:id/jarvis/approvals/:entryId', async (req, reply) => {
    assertLocalHub(req.headers);
    const id = await focusOf(req);
    const body = ApproveBody.parse(req.body);
    const entry = await req.workspace!.stores.jarvis.find(id, req.params.entryId);
    if (!entry || entry.type !== 'approval') throw new AppError('NOT_FOUND', 'approval not found');
    if (entry.state !== 'pending') throw new AppError('CONFLICT', `approval is already ${entry.state}`);
    await needRunner(runner).approve(req.workspace!.id, id, entry.id, body as typeof body & { context: JarvisContext });
    return reply.code(202).send({});
  });

  // A different agent is a fresh session: the running turn stops, the old
  // session id is dropped, and the log gets a "Now on …" divider.
  app.put<{ Params: Params }>('/focuses/:id/jarvis/agent', async (req) => {
    assertLocalHub(req.headers);
    const id = await focusOf(req);
    const { agent } = AgentBody.parse(req.body);
    const { jarvis } = req.workspace!.stores;
    if ((await jarvis.meta(id)).agent === agent) return jarvis.meta(id);
    await needRunner(runner).stop(req.workspace!.id, id);
    await jarvis.setMeta(id, { agent, sessionId: null });
    await jarvis.append(id, { type: 'agent', agent });
    return jarvis.meta(id);
  });

  // `meta` first, then `entry` (upsert by id) and `meta` as they change, and
  // `heartbeat` every 15 s. The stream ends when the Focus is deleted.
  app.get<{ Params: Params }>('/focuses/:id/jarvis/events', async (req, reply) => {
    const { jarvis } = req.workspace!.stores;
    // Subscribe before checking the Focus, so a delete in between is seen:
    // changes are held until the stream is open, and a removal means 404.
    let gone = false;
    let held: JarvisChatChange[] | null = [];
    let send = (_c: JarvisChatChange): void => undefined;
    const off = jarvis.onChange((focusId, change) => {
      if (focusId !== req.params.id) return;
      if (change.removed) gone = true;
      if (held) held.push(change);
      else send(change);
    });
    let id: string;
    let meta: JarvisMeta;
    try {
      id = await focusOf(req);
      meta = await jarvis.meta(id);
      if (gone) throw new AppError('NOT_FOUND', 'focus not found');
    } catch (err) {
      off();
      throw err;
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.flushHeaders();
    writeEvent(reply, 'meta', meta);
    // A named event, not an SSE comment: EventSource never surfaces comments,
    // and the window reopens a stream that has gone quiet past two beats.
    const heartbeat = () => writeEvent(reply, 'heartbeat', {});
    heartbeat();
    const beat = setInterval(heartbeat, HEARTBEAT_MS);
    function close(): void {
      clearInterval(beat);
      off();
      reply.raw.end();
    }
    send = (change) => {
      if (change.removed) return close();
      if (change.entry) writeEvent(reply, 'entry', change.entry);
      if (change.meta) writeEvent(reply, 'meta', change.meta);
    };
    const early = held;
    held = null;
    for (const c of early) send(c);
    req.raw.on('close', close);
    return reply;
  });
}

/** Focus deleted: forget its Jarvis (its last writes land first), then
 *  delete its chat. Never fails the delete. */
export async function dropFocusJarvis(
  req: FastifyRequest,
  runner: FocusJarvisRunner | null,
  focusId: string,
): Promise<void> {
  const ws = req.workspace!.id;
  await (runner?.forget ? runner.forget(ws, focusId) : runner?.stop(ws, focusId))?.catch((err) => req.log.warn({ err }, 'jarvis forget on focus delete failed'));
  await req.workspace!.stores.jarvis.remove(focusId).catch((err) => req.log.warn({ err }, 'jarvis chat remove failed'));
}
