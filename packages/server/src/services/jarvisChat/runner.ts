// The Focus Jarvis turn runner: one turn at a time per Focus, each a headless
// agent run (Claude Code first) resumed from the Focus's session, streaming
// its reply into the chat log. Later messages queue behind the running turn.
//
// A turn holds a random token (memory only, dropped when the turn ends) that
// its `strado` MCP server sends with every jarvis_* tool call; the gateway
// maps it back here with byToken(). The token reaches the MCP server through
// a 0600 mcp.json in the Focus's own working dir, never argv, and the file is
// removed when the turn ends.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../errors.js';
import type { WorkspaceStores } from '../../workspaceRegistry.js';
import { claudeMcpEntry } from '../claudeMcp.js';
import { createDetect } from '../lsp/detect.js';
import { envAllowed } from '../lsp/manager.js';
import type { HeadlessEvent, HeadlessOpts } from './claudeHeadless.js';
import { JARVIS_CHAT_SYSTEM, turnPrompt, type TurnInput } from './prompt.js';
import { JARVIS_LIMITS, JARVIS_TOKEN_ENV, type ChatEntry, type JarvisContext, type JarvisUiActionResult } from './types.js';

export type TurnRef = { ws: string; focusId: string; turnId: string; windowId: string; wake: boolean };

/** Runs an approved action (the tool gateway's executor): one line for the log and the next turn. */
export type ApprovedRun = (call: TurnRef & { action: string; args: Record<string, unknown> }) => Promise<JarvisUiActionResult>;

export type JarvisRunner = {
  send(ws: string, focusId: string, input: { text: string; windowId: string; context: JarvisContext }): Promise<ChatEntry>;
  approve(ws: string, focusId: string, entryId: string, input: { approve: boolean; windowId: string; context: JarvisContext }): Promise<void>;
  /** Queues a wake turn (wakes.ts batches and rate-limits); events queued together run as one turn. */
  wake(ws: string, focusId: string, eventText: string): void;
  stop(ws: string, focusId: string): Promise<void>;
  /** The Focus is being deleted: stop its turn, drop what is queued, wait for the turn to end, remove its working dir. */
  forget(ws: string, focusId: string): Promise<void>;
  /** Gateway lookup: token → the turn it belongs to. */
  byToken(token: string): TurnRef | null;
};

export type JarvisRunnerDeps = {
  /** Sync or async (app.deps.registry.get is async). */
  stores: (ws: string) => WorkspaceStores | Promise<WorkspaceStores>;
  spawnHeadless: (o: HeadlessOpts) => AsyncIterable<HeadlessEvent>;
  now?: () => Date;
  /** Strado's home (STRADO_HOME or ~/.strado); Jarvis works in <home>/jarvis/<focusId>. */
  home?: string;
  /** The agent's env: the person's, minus Strado's identity and anything credential-shaped. */
  env?: () => Promise<Record<string, string>>;
  /** How the MCP server reaches this server (what tabs get). */
  serverEnv?: () => Record<string, string>;
  /** Runs an approved action; wired to the tool gateway by app.ts. */
  runApproved?: ApprovedRun;
  turnMs?: number;
};

type Job = { input: TurnInput; windowId: string; wake: boolean };
type FocusState = { queue: Job[]; draining: Promise<void> | null; running: { abort: AbortController; why: 'stop' | 'cap' | null } | null; lastContext: JarvisContext | null };

const TURN_CAP = 'Jarvis took longer than 5 minutes and was stopped';

/** How the person's claude tabs log in, which Jarvis must too: an API key or
 *  token (or `claude setup-token`'s), a gateway, a model, or Bedrock / Vertex with their cloud credentials. */
const CLAUDE_AUTH = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL)|CLAUDE_CODE_(USE_BEDROCK|USE_VERTEX|OAUTH_TOKEN)|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|CLOUD_ML_[A-Z0-9_]+)$/;

/** The LSP scrub (no Strado identity, nothing credential-shaped), except Claude's own login. */
export function jarvisEnvAllowed(name: string, value = ''): boolean {
  return CLAUDE_AUTH.test(name) || envAllowed(name, value);
}

function defaultEnv(): () => Promise<Record<string, string>> {
  const detect = createDetect();
  return async () => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && jarvisEnvAllowed(k, v)) out[k] = v;
    out.PATH = (await detect.dirs()).join(':');
    return out;
  };
}

export function createJarvisRunner(deps: JarvisRunnerDeps): JarvisRunner {
  const now = deps.now ?? (() => new Date());
  const home = deps.home ?? (process.env.STRADO_HOME || path.join(os.homedir(), '.strado'));
  const env = deps.env ?? defaultEnv();
  const serverEnv = deps.serverEnv ?? (() => ({ STRADO_STATUS_PORT: String(process.env.PORT ?? 7777) }));
  const turnMs = deps.turnMs ?? JARVIS_LIMITS.turnMs;
  const focuses = new Map<string, FocusState>();
  const tokens = new Map<string, TurnRef>();
  const deciding = new Set<string>();

  const key = (ws: string, focusId: string) => `${ws}\0${focusId}`;
  const state = (ws: string, focusId: string): FocusState => {
    const k = key(ws, focusId);
    let s = focuses.get(k);
    if (!s) focuses.set(k, (s = { queue: [], draining: null, running: null, lastContext: null }));
    return s;
  };
  const store = async (ws: string) => (await deps.stores(ws)).jarvis;

  /** Pending approvals in this Focus's log, oldest first. */
  async function pendingApprovals(ws: string, focusId: string): Promise<Extract<ChatEntry, { type: 'approval' }>[]> {
    const st = await store(ws);
    if (!(await st.meta(focusId)).pendingApprovals) return [];
    const out: Extract<ChatEntry, { type: 'approval' }>[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await st.page(focusId, { before, limit: JARVIS_LIMITS.pageMax });
      for (const e of page) if (e.type === 'approval' && e.state === 'pending') out.push(e);
      if (page.length < JARVIS_LIMITS.pageMax) return out;
      before = page[0]!.id;
    }
  }

  async function workDir(focusId: string): Promise<string> {
    const dir = path.join(home, 'jarvis', focusId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return dir;
  }

  async function writeMcpConfig(dir: string, token: string): Promise<string> {
    const file = path.join(dir, 'mcp.json');
    const config = { mcpServers: { strado: { ...claudeMcpEntry(), env: { ...serverEnv(), [JARVIS_TOKEN_ENV]: token } } } };
    await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    return file;
  }

  async function runTurn(ws: string, focusId: string, s: FocusState, job: Job): Promise<void> {
    const st = await store(ws);
    const turnId = randomUUID();
    const turnEntryId = `turn-${turnId}`;
    const replyId = `reply-${turnId}`;
    const token = randomBytes(32).toString('hex');
    const abort = new AbortController();
    s.running = { abort, why: null };
    const at = () => now().toISOString();
    const turn = (state: 'running' | 'done' | 'failed' | 'stopped', extra: { error?: string; fix?: string } = {}) =>
      st.upsert(focusId, { id: turnEntryId, at: at(), type: 'turn', turnId, state, ...(job.wake ? { wake: true } : {}), ...extra });
    let reply = '';
    const writeReply = (done: boolean) => (reply ? st.upsert(focusId, { id: replyId, at: at(), type: 'jarvis', turnId, text: reply, done }) : undefined);

    await turn('running');
    const cap = setTimeout(() => { s.running!.why = 'cap'; abort.abort(); }, turnMs);
    let mcpFile: string | null = null;
    let outcome: { state: 'done' | 'failed' | 'stopped'; error?: string; fix?: string } = { state: 'failed', error: 'Jarvis stopped without an answer' };
    try {
      const cwd = await workDir(focusId);
      mcpFile = await writeMcpConfig(cwd, token);
      tokens.set(token, { ws, focusId, turnId, windowId: job.windowId, wake: job.wake });
      const meta = await st.meta(focusId);
      for await (const e of deps.spawnHeadless({
        cwd, prompt: turnPrompt(job.input), resume: meta.sessionId, systemPrompt: JARVIS_CHAT_SYSTEM,
        mcpConfigPath: mcpFile, env: await env(), signal: abort.signal,
      })) {
        if (e.type === 'session' && e.sessionId !== meta.sessionId) await st.setMeta(focusId, { sessionId: e.sessionId });
        else if (e.type === 'text') { reply += e.delta; await writeReply(false); }
        else if (e.type === 'done') outcome = { state: 'done' };
        else if (e.type === 'error') outcome = { state: 'failed', error: e.message, ...(e.fix ? { fix: e.fix } : {}) };
      }
    } catch {
      outcome = { state: 'failed', error: 'Jarvis could not start' };
    } finally {
      clearTimeout(cap);
      tokens.delete(token);
      if (mcpFile) await fs.rm(mcpFile, { force: true }).catch(() => undefined);
    }
    if (s.running.why === 'stop') outcome = { state: 'stopped' };
    else if (s.running.why === 'cap') outcome = { state: 'failed', error: TURN_CAP };
    s.running = null;
    await writeReply(true);
    await turn(outcome.state, { ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.fix ? { fix: outcome.fix } : {}) });
    await st.setMeta(focusId, { lastActiveAt: at() });
  }

  /** Runs queued jobs one at a time; a no-op while already draining (that loop picks new jobs up). */
  function drain(ws: string, focusId: string): Promise<void> {
    const s = state(ws, focusId);
    s.draining ??= (async () => {
      try {
        // A write refused because the Focus was deleted ends the turn quietly.
        for (let job = s.queue.shift(); job; job = s.queue.shift()) {
          await runTurn(ws, focusId, s, job).catch(() => { s.running = null; });
        }
      } finally {
        s.draining = null;
      }
    })();
    return s.draining;
  }
  const enqueue = (ws: string, focusId: string, job: Job) => {
    state(ws, focusId).queue.push(job);
    void drain(ws, focusId);
  };

  return {
    async send(ws, focusId, input) {
      const s = state(ws, focusId);
      s.lastContext = input.context;
      const st = await store(ws);
      for (const a of await pendingApprovals(ws, focusId)) await st.upsert(focusId, { ...a, state: 'superseded' });
      const entry = await st.append(focusId, { type: 'user', text: input.text, windowId: input.windowId });
      enqueue(ws, focusId, { input: { kind: 'message', text: input.text, context: input.context }, windowId: input.windowId, wake: false });
      return entry;
    },

    async approve(ws, focusId, entryId, input) {
      const st = await store(ws);
      // One decision per approval, even from two windows at once: the second gets 409.
      const claim = key(ws, focusId) + '\0' + entryId;
      if (deciding.has(claim)) throw new AppError('CONFLICT', 'that approval is no longer pending');
      deciding.add(claim);
      let result: string | undefined;
      let entry: Extract<ChatEntry, { type: 'approval' }>;
      try {
        const found = await st.find(focusId, entryId);
        if (!found || found.type !== 'approval') throw new AppError('NOT_FOUND', 'no such approval');
        if (found.state !== 'pending') throw new AppError('CONFLICT', 'that approval is no longer pending');
        entry = found;
        if (input.approve && !deps.runApproved) throw new AppError('UNAVAILABLE', 'Jarvis cannot run actions yet');
        await st.upsert(focusId, { ...entry, state: input.approve ? 'approved' : 'declined' });
      } finally {
        deciding.delete(claim);
      }
      state(ws, focusId).lastContext = input.context;
      if (input.approve) {
        let r: JarvisUiActionResult;
        try {
          r = await deps.runApproved!({ ws, focusId, turnId: entry.turnId, windowId: input.windowId, wake: false, action: entry.action, args: entry.args });
        } catch {
          r = { ok: false, text: 'It failed' };
        }
        result = r.ok ? r.text : `It failed: ${r.text}`;
        // What it did, with its card, under the approval.
        await st.append(focusId, {
          type: 'action', turnId: entry.turnId, action: entry.action, summary: entry.summary, ok: r.ok,
          ...(r.ok ? {} : { error: r.text }), ...(r.card ? { card: r.card } : {}),
        });
        await st.upsert(focusId, { ...entry, state: 'approved', result });
      }
      enqueue(ws, focusId, {
        input: { kind: 'approval', approvalId: entry.id, approved: input.approve, ...(result ? { result } : {}), context: input.context },
        windowId: input.windowId,
        wake: false,
      });
    },

    wake(ws, focusId, eventText) {
      const s = state(ws, focusId);
      const queued = s.queue.find((j) => j.input.kind === 'wake');
      if (queued && queued.input.kind === 'wake') { queued.input.events.push(eventText); return; }
      enqueue(ws, focusId, { input: { kind: 'wake', events: [eventText], ...(s.lastContext ? { context: s.lastContext } : {}) }, windowId: '', wake: true });
    },

    async stop(ws, focusId) {
      const s = focuses.get(key(ws, focusId));
      if (!s?.running) return;
      s.running.why = 'stop';
      s.running.abort.abort();
    },

    async forget(ws, focusId) {
      const s = focuses.get(key(ws, focusId));
      if (s) {
        s.queue.length = 0;
        if (s.running) { s.running.why = 'stop'; s.running.abort.abort(); }
        await s.draining;
        focuses.delete(key(ws, focusId));
      }
      if (/^[A-Za-z0-9_-]{1,64}$/.test(focusId)) await fs.rm(path.join(home, 'jarvis', focusId), { recursive: true, force: true });
    },

    byToken(token) {
      return tokens.get(token) ?? null;
    },
  };
}
