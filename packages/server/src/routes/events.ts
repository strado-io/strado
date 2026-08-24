import { FastifyInstance, FastifyReply } from 'fastify';
import { toResponse } from '../errors.js';

const HEARTBEAT_MS = 15_000;

function openStream(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function writeEvent(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function registerEventRoutes(app: FastifyInstance) {
  app.get('/events/worktrees', async (req, reply) => {
    openStream(reply);
    const unsubscribe = app.deps.bus.on('worktrees', (evt) => writeEvent(reply, evt.type, evt.data));
    const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(beat);
      unsubscribe();
      reply.raw.end();
    });
    return reply;
  });

  app.get('/events/workspaces', async (req, reply) => {
    openStream(reply);
    const unsubscribe = app.deps.bus.on('workspaces', (evt) => writeEvent(reply, evt.type, evt.data));
    const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => { clearInterval(beat); unsubscribe(); reply.raw.end(); });
    return reply;
  });

  // Output from an onboarding-driven prerequisite install. Same shape as the
  // channels above: whatever the installer emits, verbatim.
  app.get('/events/env-install', async (req, reply) => {
    openStream(reply);
    const unsubscribe = app.deps.bus.on('envInstall', (evt) => writeEvent(reply, evt.type, evt.data));
    const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => { clearInterval(beat); unsubscribe(); reply.raw.end(); });
    return reply;
  });

  app.get<{ Params: { encodedPath: string } }>(
    '/events/logs/:encodedPath',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      openStream(reply);
      const snapshot = app.deps.proc.snapshot(target, 200);
      for (const line of snapshot) writeEvent(reply, 'log', { stream: 'stdout', line });
      const unsubscribe = app.deps.bus.on(`logs:${target}`, (evt) => writeEvent(reply, evt.type, evt.data));
      const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
      req.raw.on('close', () => {
        clearInterval(beat);
        unsubscribe();
        reply.raw.end();
      });
      return reply;
    },
  );

  app.get<{ Params: { jobId: string } }>(
    '/events/jobs/:jobId',
    async (req, reply) => {
      const id = req.params.jobId;
      openStream(reply);
      const existing = app.deps.jobs.get(id);
      if (existing && (existing.status === 'done' || existing.status === 'error')) {
        // Match the live event shape: a raw Error serializes to {}, hiding the
        // reason — send the structured { code, message } instead so clients
        // that subscribe after a fast failure still see why it failed.
        const data =
          existing.status === 'done' ? existing.result : toResponse(existing.error).error;
        writeEvent(reply, existing.status, data);
        reply.raw.end();
        return reply;
      }
      const unsubscribe = app.deps.bus.on(`job:${id}`, (evt) => {
        writeEvent(reply, evt.type, evt.data);
        if (evt.type === 'done' || evt.type === 'error') reply.raw.end();
      });
      const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);
      req.raw.on('close', () => {
        clearInterval(beat);
        unsubscribe();
      });
      return reply;
    },
  );
}
