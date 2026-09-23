#!/usr/bin/env node
// `strado` — the shell → agent direction of the intercom (step 6). Runs inside a
// Strado tab: identity is the tab's execution token and the server is the
// sandbox socket or the loopback port, all from the environment the tab was
// spawned with. Six verbs: send/peers/inbox/task/escalate/ask.
import { requestJson, serverFromEnv } from './lib/transport.mjs';

export const USAGE = `usage:
  strado send <agent> <message...> [--request] [--reply-to <id>]
  strado peers
  strado inbox [--keep]
  strado task create <title...> [-m <body>] [--ticket <key>] [--after <id,id>]
  strado task list [--status <open|claimed|done|cancelled>] [--mine]
  strado task claim|done|release <id>
  strado escalate <title...> [-m <body>] [--task <id>]
  strado ask <agent> <message...> [--timeout <seconds>]
  strado fork <agent> | --new <claude|codex|opencode|pi> [-m <notes>] [--task <id>]
`;

const TIMEOUT_MS = 5000;
const PULL_LIMIT = 50;

class CliError extends Error {
  constructor(exitCode, message) { super(message); this.exitCode = exitCode; }
}

function parseSend(rest) {
  let request = false;
  let replyTo = null;
  let agent = null;
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--request') { request = true; continue; }
    if (a === '--reply-to') {
      replyTo = rest[i + 1];
      if (!replyTo) throw new CliError(2, `error: --reply-to needs a message id\n${USAGE}`);
      i += 1;
      continue;
    }
    if (agent === null) agent = a; else words.push(a);
  }
  if (request && replyTo) throw new CliError(2, `error: --request and --reply-to are exclusive\n${USAGE}`);
  if (!agent || words.length === 0) throw new CliError(2, USAGE);
  const kind = replyTo ? 'reply' : request ? 'request' : 'message';
  return { to: agent, kind, ...(replyTo ? { replyTo } : {}), body: words.join(' ') };
}

// Peer-supplied text goes to the user's real terminal: drop escape sequences and
// control bytes (keep \n and \t) so a message cannot move the cursor or retitle the tab.
function sanitize(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function pad(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

const ASK_POLL_MS = 2000;
const ASK_DEFAULT_S = 120;

// Mirror of STRADO_SENDER_ID (src/services/intercomSchema.ts): the synthetic
// sender behind a fork's summary ask, package and acceptance notice.
const STRADO_SENDER_ID = 'strado';
const FORK_HAND_OVER_PREFIX = 'FORK HAND-OVER';
const FORK_MODES = ['claude', 'codex', 'opencode', 'pi'];

function takeFlag(rest, name) {           // removes `--name value` from rest, returns value or null
  const i = rest.indexOf(name);
  if (i === -1) return null;
  const v = rest[i + 1];
  if (v === undefined) throw new CliError(2, `error: ${name} needs a value\n${USAGE}`);
  rest.splice(i, 2);
  return v;
}
function takeBool(rest, name) { const i = rest.indexOf(name); if (i === -1) return false; rest.splice(i, 1); return true; }
const okId = (id) => { if (!id || /[\s/%?#]/.test(id)) throw new CliError(2, `error: expected an id\n${USAGE}`); return id; };

export async function main(argv, env = process.env, io = { out: process.stdout, err: process.stderr }) {
  const out = (s) => new Promise((resolve) => io.out.write(s, () => resolve()));
  const errLine = (s) => new Promise((resolve) => io.err.write(s.endsWith('\n') ? s : `${s}\n`, () => resolve()));

  const [verb, ...rest] = argv;
  if (!verb || verb === '-h' || verb === '--help') { await errLine(USAGE); return 2; }
  if (verb !== 'send' && verb !== 'peers' && verb !== 'inbox' && verb !== 'task' && verb !== 'escalate' && verb !== 'ask' && verb !== 'fork') { await errLine(`error: unknown command '${verb}'\n${USAGE}`); return 2; }
  const token = env.STRADO_AGENT_TOKEN;
  if (!token) { await errLine('error: STRADO_AGENT_TOKEN is not set (run this inside a Strado tab)'); return 2; }
  const server = serverFromEnv(env);
  if (!server) { await errLine('error: no Strado server in environment (STRADO_SERVER_SOCKET or STRADO_STATUS_PORT)'); return 2; }

  const call = async (method, urlPath, body) => {
    let res;
    try {
      res = await requestJson({ ...server, method, urlPath, token, timeoutMs: TIMEOUT_MS, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new CliError(1, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = res.json && res.json.error && typeof res.json.error.message === 'string' ? res.json.error.message : `HTTP ${res.status}`;
      throw new CliError(1, `error: ${msg}`);
    }
    return res.json;
  };

  try {
    if (verb === 'send') {
      const parsed = parseSend(rest);
      const receipt = await call('POST', '/api/intercom/messages', parsed);
      // The receipt carries the message id, not the recipient: print what we
      // sent (the agent argument), not a field the receipt doesn't have.
      await out(`sent ${receipt.id} → ${parsed.to}\n`);
      return 0;
    }
    if (verb === 'peers') {
      const { peers } = await call('GET', '/api/intercom/peers');
      const rows = peers.map((p) => [sanitize(p.alias || p.agentId), p.mode, p.lifecycle, p.agentId === env.STRADO_AGENT_ID ? '(you)' : '']);
      const w0 = Math.max(...rows.map((r) => r[0].length), 0);
      const w1 = Math.max(...rows.map((r) => r[1].length), 0);
      for (const [name, mode, lifecycle, you] of rows) {
        await out(`${pad(name, w0)}  ${pad(mode, w1)}  ${lifecycle}${you ? `  ${you}` : ''}\n`);
      }
      return 0;
    }
    if (verb === 'inbox') {
      const keep = rest.includes('--keep');
      const { messages } = await call('POST', '/api/intercom/pull', { limit: PULL_LIMIT });
      if (messages.length === 0) { await out('no messages\n'); return 0; }
      for (const m of messages) {
        const from = sanitize((m.from && (m.from.alias || m.from.agentId)) || 'unknown');
        const when = new Date(m.createdAt).toISOString();
        if (m.forkId && m.from && m.from.agentId === STRADO_SENDER_ID) {
          const bodySan = sanitize(m.body);
          const hint = `[reply with: strado send strado <message> --reply-to ${m.id}]`;
          if (m.kind === 'request' && typeof m.body === 'string' && m.body.startsWith(FORK_HAND_OVER_PREFIX)) {
            await out(`── strado · fork · ${m.id} · ${when}\n${bodySan}\n${hint}\n\n`);
          } else if (m.kind === 'request') {
            // The summary ask's own body already says how to reply; `hint` is
            // for the hand-over, which does not.
            await out(`── strado · fork-summary · ${m.id} · ${when}\n${bodySan}\n\n`);
          } else {
            await out(`── strado · fork · ${m.id} · ${when} · accepted\n${bodySan}\n\n`);
          }
        } else if (m.kind === 'request' && m.escalationId) {
          const fromAgentId = sanitize(m.from.agentId);
          await out(`── ${from} · ask · ${m.id} · ${when}\n${sanitize(m.body)}\n[reply with: strado send ${fromAgentId} <answer> --reply-to ${m.id}]\n\n`);
        } else if (m.from && m.from.agentId === 'human' && m.escalationId) {
          await out(`── human · resolution · ${m.id} · ${when} · re: escalation ${m.escalationId}\n${sanitize(m.body)}\n\n`);
        } else {
          await out(`── ${from} · ${sanitize(m.kind)} · ${m.id} · ${when}\n${sanitize(m.body)}\n\n`);
        }
        // {} rather than no body at all: an empty POST body with a JSON
        // content-type is a 400 from Fastify's parser, which this app's
        // error handler maps to a bare 500 for anything that isn't an AppError.
        if (!keep) await call('POST', `/api/intercom/messages/${m.id}/ack`, {});
      }
      return 0;
    }
    if (verb === 'task') {
      const [sub, ...args] = rest;
      if (sub === 'create') {
        const body = takeFlag(args, '-m'); const ticket = takeFlag(args, '--ticket'); const after = takeFlag(args, '--after');
        if (args.length === 0) throw new CliError(2, USAGE);
        const { task } = await call('POST', '/api/intercom/tasks', { title: args.join(' '), ...(body ? { body } : {}), ...(ticket ? { ticketKey: ticket } : {}), ...(after ? { dependsOn: after.split(',') } : {}) });
        await out(`created ${task.id}: ${sanitize(task.title)}\n`);
        return 0;
      }
      if (sub === 'list') {
        const status = takeFlag(args, '--status'); const mine = takeBool(args, '--mine');
        const q = new URLSearchParams(); if (status) q.set('status', status); if (mine) q.set('mine', '1');
        const { tasks } = await call('GET', `/api/intercom/tasks${q.size ? `?${q}` : ''}`);
        if (tasks.length === 0) { await out('no tasks\n'); return 0; }
        const w = Math.max(...tasks.map((t) => t.status.length));
        for (const t of tasks) {
          const tail = [t.claimedBy ? sanitize(t.claimedBy.agentId) : null, t.ticketKey ? sanitize(t.ticketKey) : null].filter(Boolean).join('  ');
          await out(`${t.id}  ${pad(t.status, w)}  ${sanitize(t.title)}${tail ? `  ${tail}` : ''}\n`);
        }
        return 0;
      }
      if (sub === 'claim' || sub === 'done' || sub === 'release') {
        const id = okId(args[0]);
        const { task } = await call('POST', `/api/intercom/tasks/${id}/${sub}`, {});
        await out(`${sub === 'claim' ? 'claimed' : sub === 'done' ? 'done' : 'released'} ${task.id}: ${sanitize(task.title)}\n`);
        return 0;
      }
      throw new CliError(2, USAGE);
    }
    if (verb === 'escalate') {
      const args = [...rest];
      const body = takeFlag(args, '-m'); const taskId = takeFlag(args, '--task');
      if (args.length === 0) throw new CliError(2, USAGE);
      const title = args.join(' ');
      const { escalation } = await call('POST', '/api/intercom/escalations', { title, body: body ?? title, ...(taskId ? { taskId } : {}) });
      await out(`escalated ${escalation.id}; the human will reply to your inbox\n`);
      return 0;
    }
    if (verb === 'ask') {
      const args = [...rest];
      const timeoutS = Number(takeFlag(args, '--timeout') ?? ASK_DEFAULT_S);
      const [agent, ...words] = args;
      if (!agent || words.length === 0 || !Number.isFinite(timeoutS)) throw new CliError(2, USAGE);
      const timeoutMs = Math.min(600000, Math.max(5000, Math.round(timeoutS * 1000)));
      const body = words.join(' ');
      const { escalation } = await call('POST', '/api/intercom/escalations', { title: body.split('\n')[0].slice(0, 200), body, to: agent, timeoutMs });
      const deadline = Date.now() + timeoutMs + ASK_POLL_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, ASK_POLL_MS));
        const { escalation: e } = await call('GET', `/api/intercom/escalations/${okId(escalation.id)}`);
        if (e.status === 'resolved') { await out(`${sanitize(e.resolution)}\n`); return 0; }
        if (e.status === 'dismissed') throw new CliError(3, 'error: the question was dismissed');
        if (e.to === 'human') break;
      }
      throw new CliError(3, `error: no reply after ${Math.round(timeoutMs / 1000)} s — retargeted to the human; the answer will arrive in your inbox`);
    }
    // fork
    {
      const args = [...rest];
      const notes = takeFlag(args, '-m');
      const taskId = takeFlag(args, '--task');
      const newTabMode = takeFlag(args, '--new');
      let body;
      if (newTabMode !== null) {
        if (args.length > 0 || !FORK_MODES.includes(newTabMode)) throw new CliError(2, USAGE);
        body = { newTab: { mode: newTabMode } };
      } else {
        if (args.length !== 1) throw new CliError(2, USAGE);
        body = { to: okId(args[0]) };
      }
      const { fork } = await call('POST', '/api/intercom/forks', { ...body, ...(notes !== null ? { notes } : {}), ...(taskId !== null ? { taskId } : {}) });
      const target = fork.target.kind === 'peer' ? fork.target.agentId : (fork.target.agentId ?? fork.target.mode);
      if (fork.status === 'summarising') { await out(`fork ${fork.id} queued → ${target}; summary requested from you — reply to it in your inbox\n`); return 0; }
      if (fork.status === 'delivered') { await out(`fork ${fork.id} delivered to ${target}\n`); return 0; }
      await out(`fork ${fork.id} queued → ${target}\n`);
      return 0;
    }
  } catch (err) {
    if (err instanceof CliError) { await errLine(err.message); return err.exitCode; }
    await errLine(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
