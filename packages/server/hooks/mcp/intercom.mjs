// intercom_* tools plus run_in_shell / read_tab: the agent → agent and
// agent → shell directions of Strado's Intercom, over the step 3–6 routes.
// Identity is the TAB's execution token; the server is reached over the
// sandbox socket when present, else loopback — the same transport the
// status hook and the `strado` CLI use, so this works inside a sandbox.
import { requestJson, serverFromEnv } from '../lib/transport.mjs';
import { text } from './rpc.mjs';

const NOT_A_TAB = 'this is not a Strado tab; open it from Strado to talk to peers';
const TIMEOUT_MS = 5000;
const RUN_DEFAULT_TIMEOUT_MS = 15000;
const PULL_LIMIT = 50;

// Mirrors of the server's ask-timeout constants (src/services/intercomSchema.ts):
// hooks are plain .mjs and cannot import TS, so these are kept in sync by hand.
export const ASK_POLL_MS = 2000;
export const ASK_DEFAULT_TIMEOUT_MS = 120000;

// Mirror of STRADO_SENDER_ID (src/services/intercomSchema.ts): the synthetic
// sender behind a fork's summary ask, package and acceptance notice.
const STRADO_SENDER_ID = 'strado';
const FORK_HAND_OVER_PREFIX = 'FORK HAND-OVER';
const forkReplyHint = (id) => `[reply with intercom_send to=strado kind=reply replyTo=${id} when you have taken over]`;

class NoTab extends Error {}

function makeCall(env) {
  return async function call(method, urlPath, body, timeoutMs = TIMEOUT_MS) {
    const token = env.STRADO_AGENT_TOKEN;
    const server = serverFromEnv(env);
    if (!token || !server) throw new NoTab();
    const res = await requestJson({ ...server, method, urlPath, token, timeoutMs, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status < 200 || res.status >= 300) {
      const msg = res.json && res.json.error && typeof res.json.error.message === 'string' ? res.json.error.message : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return res.json;
  };
}

// A tool body that throws NoTab renders the friendly sentence as a normal
// result; everything else propagates and rpc.mjs turns it into isError.
const guarded = (fn) => async (args) => {
  try { return await fn(args ?? {}); } catch (err) { if (err instanceof NoTab) return text(NOT_A_TAB); throw err; }
};

const required = (args, ...names) => {
  for (const n of names) if (args[n] === undefined || args[n] === null || args[n] === '') throw new Error(`${n} is required`);
};

const iso = (ms) => new Date(ms).toISOString();

/** Render a pulled batch, then acknowledge it. A tool returns ONE result, so an
 * ack that rejects halfway must not throw away the text: everything is rendered
 * first, `ack` is injected (null for keep=true), and a failure becomes a warning
 * line at the end rather than an error. Whatever was acknowledged is always
 * visible to the caller — otherwise those messages are gone for good. */
export async function renderInbox(messages, ack) {
  const out = messages.map((m) => {
    const from = (m.from && (m.from.alias || m.from.agentId)) || 'unknown';
    const when = iso(m.createdAt);
    if (m.forkId && m.from && m.from.agentId === STRADO_SENDER_ID) {
      if (m.kind === 'request' && typeof m.body === 'string' && m.body.startsWith(FORK_HAND_OVER_PREFIX)) {
        return `── strado · fork · ${m.id} · ${when}\n${m.body}\n${forkReplyHint(m.id)}\n`;
      }
      if (m.kind === 'request') {
        // No hint appended: SUMMARY_PROMPT already ends with its own reply
        // instruction, and a second one just contradicts it.
        return `── strado · fork-summary · ${m.id} · ${when}\n${m.body}\n`;
      }
      return `── strado · fork · ${m.id} · ${when} · accepted\n${m.body}\n`;
    }
    if (m.kind === 'request' && m.escalationId) {
      return `── ${from} · ask · ${m.id} · ${when}\n${m.body}\n[reply with intercom_send kind=reply replyTo=${m.id}]\n`;
    }
    if (m.from && m.from.agentId === 'human' && m.escalationId) {
      return `── human · resolution · ${m.id} · ${when} · re: escalation ${m.escalationId}\n${m.body}\n`;
    }
    return `── ${from} · ${m.kind} · ${m.id} · ${when}\n${m.body}\n`;
  });
  const warnings = [];
  if (ack) {
    for (const m of messages) {
      try {
        await ack(m.id);
      } catch (err) {
        warnings.push(`[warning: could not acknowledge ${m.id}: ${err instanceof Error ? err.message : err}]`);
      }
    }
  }
  if (warnings.length > 0) out.push(`${warnings.join('\n')}\n`);
  return out.join('\n');
}

export function intercomTools(env = process.env) {
  const call = makeCall(env);
  return [
    {
      name: 'intercom_send',
      description: 'Send a message to a peer agent in this workspace by id or alias. kind=request expects a reply; kind=reply with replyTo answers one. Claude peers receive messages automatically at their next prompt or are nudged when idle; other peers read them with intercom_inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'peer agent id or alias (see intercom_peers)' },
          body: { type: 'string' },
          kind: { type: 'string', enum: ['message', 'request', 'reply'], default: 'message' },
          replyTo: { type: 'string', description: 'id of the request being answered; required for kind=reply' },
          context: { type: 'array', description: 'up to 32 typed references ({kind: text|file|url|reference, value, label?})', items: { type: 'object' } },
        },
        required: ['to', 'body'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'to', 'body');
        const kind = a.kind ?? 'message';
        if (kind === 'reply' && !a.replyTo) throw new Error('replyTo is required for kind=reply');
        if (kind !== 'reply' && a.replyTo) throw new Error('replyTo is only allowed with kind=reply');
        const receipt = await call('POST', '/api/intercom/messages', { to: a.to, body: a.body, kind, ...(a.replyTo ? { replyTo: a.replyTo } : {}), ...(a.context ? { context: a.context } : {}) });
        return text(`sent ${receipt.id} to ${a.to} (${kind})`);
      }),
    },
    {
      name: 'intercom_peers',
      description: 'Agents in this workspace with mode and lifecycle; the caller is marked (you).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: guarded(async () => {
        const { peers } = await call('GET', '/api/intercom/peers');
        if (peers.length === 0) return text('no peers in this workspace');
        const rows = peers.map((p) => [p.alias || p.agentId, p.mode, p.lifecycle, p.agentId === env.STRADO_AGENT_ID ? '  (you)' : '']);
        const w0 = Math.max(...rows.map((r) => r[0].length)); const w1 = Math.max(...rows.map((r) => r[1].length));
        return text(rows.map(([n, m, l, y]) => `${n.padEnd(w0)}  ${m.padEnd(w1)}  ${l}${y}`).join('\n'));
      }),
    },
    {
      name: 'intercom_inbox',
      description: 'Read and acknowledge messages queued for this tab. Claude tabs receive messages automatically; use this mid-turn to check for new ones or from harnesses without hook delivery. keep=true leaves them unacknowledged. Messages are always returned even if acknowledging one fails.',
      inputSchema: { type: 'object', properties: { keep: { type: 'boolean', default: false } }, additionalProperties: false },
      run: guarded(async (a) => {
        const { messages } = await call('POST', '/api/intercom/pull', { limit: PULL_LIMIT });
        if (messages.length === 0) return text('no messages');
        const ack = a.keep ? null : (id) => call('POST', `/api/intercom/messages/${id}/ack`, {});
        return text(await renderInbox(messages, ack));
      }),
    },
    {
      name: 'intercom_diary',
      description: 'What a peer tab was asked and answered recently, newest first.',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string', description: 'peer agent id or alias' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        required: ['agent'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'agent');
        const q = new URLSearchParams({ agent: a.agent, limit: String(a.limit ?? 10) });
        const { turns } = await call('GET', `/api/intercom/diary?${q}`);
        if (turns.length === 0) return text('no turns recorded');
        const render = (t) => {
          const prompt = t.prompt.split('\n').map((l) => `> ${l}`).join('\n') + (t.promptTruncated ? '\n> [truncated]' : '');
          const reply = t.reply + (t.replyTruncated ? '\n[truncated]' : '');
          return `── ${iso(t.endedAt)} (turn ${t.turnIndex})\n${prompt}\n${reply}`;
        };
        return text(turns.map(render).join('\n\n'));
      }),
    },
    {
      name: 'run_in_shell',
      description: 'Type one command into a peer SHELL tab (never an agent tab) of this workspace and return its output. settled=true means the shell reached the end of the command; false means it was still running at the cap — use read_tab to check on it. Do not run interactive programs. Refused while the user is typing in that tab (retry) or another run is in flight.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'shell tab agent id or alias (see intercom_peers, mode shell)' },
          command: { type: 'string', description: 'one line' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, description: 'cap; default 15000' },
        },
        required: ['target', 'command'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'target', 'command');
        const cap = a.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS;
        const r = await call('POST', '/api/intercom/shell/run', { target: a.target, command: a.command, ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}) }, cap + TIMEOUT_MS);
        const trailer = r.settled ? `[settled in ${r.durationMs} ms]` : `[still running after ${r.durationMs} ms — use read_tab to check on it]`;
        const body = r.output.endsWith('\n') || r.output === '' ? r.output : `${r.output}\n`;
        return text(`${body}${trailer}`);
      }),
    },
    {
      name: 'read_tab',
      description: "Last N cleaned lines of any live peer tab's screen.",
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 400, description: 'default 40' } },
        required: ['agent'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'agent');
        const q = a.lines ? `?lines=${a.lines}` : '';
        // Not percent-encoded on purpose: agent ids are `name@repo` slugs, `@` is
        // legal in a path, and the sandbox hook socket refuses any `%` in a PATH.
        if (/[\s/%?#]/.test(a.agent)) throw new Error('agent must be an agent id or alias without spaces or slashes');
        const r = await call('GET', `/api/intercom/tabs/${a.agent}/read${q}`);
        return text(`${r.lines.join('\n')}\n[${r.status}]`);
      }),
    },
    {
      name: 'task_create',
      description: 'Create a shared task in this workspace that any agent can claim. Optional ticketKey links it to a Jira/Linear ticket for display; dependsOn lists task ids that must be done first.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, ticketKey: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['title'], additionalProperties: false },
      run: guarded(async (a) => {
        required(a, 'title');
        const { task } = await call('POST', '/api/intercom/tasks', { title: a.title, ...(a.body ? { body: a.body } : {}), ...(a.ticketKey ? { ticketKey: a.ticketKey } : {}), ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}) });
        return text(`created ${task.id}: ${task.title}`);
      }),
    },
    {
      name: 'task_list',
      description: 'Shared tasks in this workspace: open first, then claimed, then closed. status filters; mine=true shows only tasks you claimed.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'claimed', 'done', 'cancelled'] }, mine: { type: 'boolean' } }, additionalProperties: false },
      run: guarded(async (a) => {
        const q = new URLSearchParams();
        if (a.status) q.set('status', a.status);
        if (a.mine) q.set('mine', '1');
        const { tasks } = await call('GET', `/api/intercom/tasks${q.size ? `?${q}` : ''}`);
        if (tasks.length === 0) return text('no tasks');
        return text(tasks.map((t) => [t.id, t.status, t.title, t.claimedBy ? t.claimedBy.agentId : null, t.ticketKey].filter((x) => x !== null && x !== undefined).join(' · ')).join('\n'));
      }),
    },
    ...['claim', 'done', 'release'].map((verb) => ({
      name: `task_${verb}`,
      description: verb === 'claim' ? 'Claim an open shared task for this tab. Fails if it is already claimed, cancelled, or has open dependencies.'
        : verb === 'done' ? 'Mark a task you claimed as done.' : 'Give up a task you claimed so another agent can take it.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: guarded(async (a) => {
        required(a, 'id');
        if (/[\s/%?#]/.test(a.id)) throw new Error('id must be a task id');
        const { task } = await call('POST', `/api/intercom/tasks/${a.id}/${verb}`, {});
        const past = verb === 'claim' ? 'claimed' : verb === 'done' ? 'done' : 'released';
        return text(`${past} ${task.id}: ${task.title}`);
      }),
    })),
    {
      name: 'intercom_escalate',
      description: 'Ask the human for a decision. Returns immediately; the answer arrives in your inbox as a message from "human" (Claude tabs are nudged when idle). Use for anything only the human can decide; do not block on it.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'one line, ≤ 200 chars' }, body: { type: 'string' }, context: { type: 'array', items: { type: 'object' } }, taskId: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false },
      run: guarded(async (a) => {
        required(a, 'title', 'body');
        const { escalation } = await call('POST', '/api/intercom/escalations', { title: a.title, body: a.body, ...(a.context ? { context: a.context } : {}), ...(a.taskId ? { taskId: a.taskId } : {}) });
        return text(`escalated ${escalation.id}; the human will reply to your inbox`);
      }),
    },
    {
      name: 'intercom_ask',
      description: 'Ask a peer agent and wait for its reply (default 120 s, max 600 s). The peer sees an ask in its inbox and answers with intercom_send kind=reply. If it does not answer in time the question is handed to the human and the answer will arrive in your inbox later. Strado sets the client tool timeout to cover the maximum wait.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 5000, maximum: 600000 } }, required: ['to', 'body'], additionalProperties: false },
      run: guarded(async (a) => {
        required(a, 'to', 'body');
        const timeoutMs = Math.min(600000, Math.max(5000, a.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS));
        const title = String(a.body).split('\n')[0].slice(0, 200) || 'question';
        const { escalation } = await call('POST', '/api/intercom/escalations', { title, body: a.body, to: a.to, timeoutMs });
        if (/[\s/%?#]/.test(escalation.id)) throw new Error('bad escalation id');
        const deadline = Date.now() + timeoutMs + ASK_POLL_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, ASK_POLL_MS));
          const { escalation: e } = await call('GET', `/api/intercom/escalations/${escalation.id}`);
          if (e.status === 'resolved') return text(e.resolution);
          if (e.status === 'dismissed') return text('[the question was dismissed]');
          if (e.to === 'human') return text(`[no reply after ${Math.round(timeoutMs / 1000)} s — retargeted to the human; the answer will arrive in your inbox]`);
        }
        return text(`[no reply after ${Math.round(timeoutMs / 1000)} s — retargeted to the human; the answer will arrive in your inbox]`);
      }),
    },
    {
      name: 'intercom_fork',
      description: 'Hand this thread\'s working context to a peer agent or a brand-new tab. A bounded package (a summary of this thread, its last turns, a repository snapshot, and references) is delivered to the target; if you are live, you are asked to summarise first. Non-blocking — delivery and acceptance happen off this call; check intercom_inbox or intercom_diary for what happens next.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'peer agent id or alias to fork to (see intercom_peers); exactly one of to / newTab is required' },
          newTab: { type: 'string', enum: ['claude', 'codex', 'opencode', 'pi'], description: 'spawn a brand-new tab of this harness in this worktree instead of forking to a peer' },
          notes: { type: 'string', description: 'what the target should know; its first line becomes the fork\'s label' },
          taskId: { type: 'string', description: 'a shared task (see task_create) the target should claim' },
        },
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        if ((a.to === undefined) === (a.newTab === undefined)) throw new Error('exactly one of to or newTab is required');
        if (a.to !== undefined && /[\s/%?#]/.test(a.to)) throw new Error('to must be an agent id or alias without spaces or slashes');
        const target = a.to !== undefined ? { to: a.to } : { newTab: { mode: a.newTab } };
        const { fork } = await call('POST', '/api/intercom/forks', {
          ...target,
          ...(a.notes !== undefined ? { notes: a.notes } : {}),
          ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
        });
        const targetLabel = fork.target.kind === 'peer' ? fork.target.agentId : (fork.target.agentId ?? fork.target.mode);
        if (fork.status === 'summarising') return text(`fork ${fork.id} queued → ${targetLabel}; summary requested from you — reply to it in your inbox`);
        if (fork.status === 'delivered') return text(`fork ${fork.id} delivered to ${targetLabel}`);
        return text(`fork ${fork.id} queued → ${targetLabel}`);
      }),
    },
  ];
}
