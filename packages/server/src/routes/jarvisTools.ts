// The Focus Jarvis tool gateway: the `strado` MCP server of a Jarvis turn
// calls here with the turn's token (never a tab's identity). The token names
// the turn; the tool names one action. Approval is decided HERE: exec and
// destructive actions (and the few spawn cases the rule names) become a
// pending approval card and end the turn; everything else runs now, in the
// turn's window, through the same name-resolving executor as the ⌘K box.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { WorkspaceStores } from '../workspaceRegistry.js';
import { exec } from '../shell.js';
import { trustClaudeFolder } from '../services/claudeMcp.js';
import { trustAttention } from '../services/claudeTrust.js';
import type { UiClients } from '../services/uiClients.js';
import type { JarvisRunner, TurnRef } from '../services/jarvisChat/runner.js';
import { approvalFor, checkArgs, jarvisToolSpecs, summarize } from '../services/jarvisChat/tools.js';
import {
  JARVIS_ROUTES, JARVIS_TOKEN_HEADER, JARVIS_TOOLS, JARVIS_UI_OP, WORKTREE_CREATE,
  type JarvisUiActionResult, type TabCardRef,
} from '../services/jarvisChat/types.js';

export type JarvisCall = TurnRef & { action: string; args: Record<string, unknown> };
export type JarvisExecutor = (call: JarvisCall) => Promise<JarvisUiActionResult>;

/** A window needs this long to open an agent and type its first prompt. */
export const JARVIS_ACTION_TIMEOUT_MS = 60_000;
const TEXT_MAX = 4000;

const WINDOW_REASONS: Record<string, string> = {
  no_window: 'No Strado window is open',
  window_closed: 'The Strado window that sent this has closed',
  timeout: 'The Strado window did not finish in time',
};
const CARD_KINDS = new Set(['claude', 'codex', 'opencode', 'pi', 'shell', 'run', 'browser']);

/** The window's ack, kept to its declared shape: an odd field is dropped, not trusted. */
function resultOf(raw: unknown): JarvisUiActionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== 'boolean' || typeof r.text !== 'string') return null;
  const c = r.card as Record<string, unknown> | undefined;
  const str = (v: unknown, max = 300) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const card: TabCardRef | null = c && typeof c === 'object' && typeof c.kind === 'string' && CARD_KINDS.has(c.kind) && str(c.worktree) && str(c.tab)
    ? {
        kind: c.kind as TabCardRef['kind'], worktree: str(c.worktree)!, tab: str(c.tab)!,
        ...(str(c.label) ? { label: str(c.label)! } : {}), ...(str(c.url, 2048) ? { url: str(c.url, 2048)! } : {}),
        // The exact worktree (absolute path): wakes match cards on it.
        ...(str(c.worktreePath, 4096)?.startsWith('/') ? { worktreePath: str(c.worktreePath, 4096)! } : {}),
      }
    : null;
  const askId = str(r.askId, 100);
  return { ok: r.ok, text: r.text.slice(0, TEXT_MAX), ...(card ? { card } : {}), ...(askId ? { askId } : {}) };
}

/** Runs an action in a window: the turn's own (or, for a wake, the most
 *  recently focused one). A new worktree is the server's own job. */
export function createJarvisExecutor(deps: { uiClients: UiClients; createWorktree: JarvisExecutor; timeoutMs?: number }): JarvisExecutor {
  return async (call) => {
    if (call.action === WORKTREE_CREATE) return deps.createWorktree(call);
    const r = await deps.uiClients.dispatch(call.ws, JARVIS_UI_OP, { action: call.action, args: call.args }, null, null, {
      ...(call.windowId ? { clientId: call.windowId } : {}),
      timeoutMs: deps.timeoutMs ?? JARVIS_ACTION_TIMEOUT_MS,
    });
    if (!r.applied) return { ok: false, text: WINDOW_REASONS[r.reason ?? ''] ?? 'The Strado window could not do it' };
    return resultOf(r.result) ?? { ok: false, text: 'The Strado window could not do it' };
  };
}

/** An agent.ask that went out: its answer (a reply to that message) belongs
 *  in the turn's Focus chat. Wraps the executor for both the gateway and Approve. */
export function trackAsks(execute: JarvisExecutor, asked: (ws: string, focusId: string, askId: string) => void): JarvisExecutor {
  return async (call) => {
    const r = await execute(call);
    if (call.action === 'agent.ask' && r.ok && r.askId) asked(call.ws, call.focusId, r.askId);
    return r;
  };
}

/** After an agent tab opens: is it on Claude's folder-trust question? Polls
 *  the hub's view of that tab (found by the card) until it starts, the
 *  question shows, or `timeoutMs` passes. */
export function trustWatcher(app: FastifyInstance, o: { timeoutMs?: number; pollMs?: number } = {}) {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const pollMs = o.pollMs ?? 500;
  return async (ws: string, card: TabCardRef & { worktreePath?: string }): Promise<boolean> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const tab = (await app.deps.agents.list(ws)).find((a) =>
        (card.worktreePath ? a.worktreePath === card.worktreePath : a.worktreePath.split('/').pop() === card.worktree)
        && (a.alias === card.tab || `${a.mode}-${a.sessionId}` === card.tab));
      if (tab && tab.lifecycle !== 'starting') return false;
      if (tab && trustAttention(tab, (k) => app.deps.terminal.snapshot(k))) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
}

/** An agent tab that sits on Claude's trust question is the person's to
 *  answer: Jarvis is told so plainly instead of a prompt that never lands. */
export function watchTrust(execute: JarvisExecutor, onTrust: (ws: string, card: TabCardRef) => Promise<boolean>): JarvisExecutor {
  return async (call) => {
    const r = await execute(call);
    // Only Claude asks it (others would just wait out the poll).
    if (call.action !== 'tab.open' || call.args.mode !== 'claude' || !r.ok || !r.card) return r;
    return (await onTrust(call.ws, r.card).catch(() => false))
      ? { ...r, text: `${r.card.tab} is waiting for you to trust the folder; open the tab to answer` }
      : r;
  };
}

/** worktree.create: the same job the New worktree dialog starts (from the
 *  repo's current branch), then the new worktree is trusted in Claude Code and
 *  joins the turn's Focus. */
export function createJarvisWorktree(
  app: FastifyInstance,
  stores: (ws: string) => Promise<WorkspaceStores>,
  trust: (folder: string) => Promise<unknown> = trustClaudeFolder,
): JarvisExecutor {
  return async ({ ws, focusId, args }) => {
    const repoName = String(args.repo ?? '');
    const branch = String(args.branch ?? '');
    const { repos, focuses } = await stores(ws);
    const repo = (await repos.list()).find((r) => r.name.toLowerCase() === repoName.toLowerCase());
    if (!repo) return { ok: false, text: `No repo named ${repoName}` };
    const head = await exec('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim(), () => '');
    const res = await app.inject({
      method: 'POST',
      url: `/api/w/${encodeURIComponent(ws)}/worktrees`,
      payload: { repoId: repo.id, ticketId: '', title: branch, sourceBranch: head && head !== 'HEAD' ? head : 'main', sourceWorktree: repo.path },
    });
    const jobId = res.statusCode === 202 ? (res.json() as { jobId?: string }).jobId : undefined;
    if (!jobId) return { ok: false, text: 'Could not start the new worktree' };
    const job = await app.deps.jobs.wait<{ path?: string }>(jobId);
    const wtPath = job.status === 'done' ? job.result?.path : undefined;
    if (!wtPath) return { ok: false, text: 'Creating the worktree failed' };
    // The person approved this exact folder from their own repo: a Claude tab
    // Jarvis opens there must not sit on Claude's trust question off screen.
    await trust(wtPath).catch(() => undefined);
    await focuses.update(focusId, { addMembers: [`local:${wtPath}`] });
    return { ok: true, text: `Created the worktree ${wtPath.split('/').pop()} from ${repo.name} and added it to this Focus` };
  };
}

const waitText = (id: string) => `Waiting for the person's approval (approval ${id}). End your turn now.`;

export async function registerJarvisToolRoutes(app: FastifyInstance, deps: {
  runner: Pick<JarvisRunner, 'byToken'>;
  stores: (ws: string) => Promise<WorkspaceStores>;
  execute: JarvisExecutor;
}): Promise<void> {
  /** Turns that asked for approval: they may not act again (approvals end the
   *  turn). Kept past any turn's 5-minute cap, then forgotten. */
  const waiting = new Map<string, number>();
  const WAITING_MS = 10 * 60_000;

  const turnOf = (req: FastifyRequest): TurnRef => {
    const t = req.headers[JARVIS_TOKEN_HEADER];
    const ref = typeof t === 'string' && t.length === 64 ? deps.runner.byToken(t) : null;
    if (!ref) throw new AppError('UNAUTHENTICATED', 'unknown jarvis token');
    return ref;
  };

  app.get(JARVIS_ROUTES.tools, async (req) => {
    turnOf(req);
    return jarvisToolSpecs();
  });

  app.post<{ Params: { tool: string } }>(JARVIS_ROUTES.tool, { bodyLimit: 64 * 1024 }, async (req) => {
    const ref = turnOf(req);
    const action = Object.prototype.hasOwnProperty.call(JARVIS_TOOLS, req.params.tool) ? JARVIS_TOOLS[req.params.tool]! : null;
    if (!action) throw new AppError('NOT_FOUND', 'no such jarvis tool');
    let args: Record<string, unknown>;
    try {
      args = checkArgs(action, req.body ?? {});
    } catch (err) {
      throw new AppError('VALIDATION', (err as Error).message);
    }
    const t = Date.now();
    for (const [id, at] of waiting) if (t - at > WAITING_MS) waiting.delete(id);
    if (waiting.has(ref.turnId)) return { text: 'An approval is already waiting. End your turn now.' };
    const log = (await deps.stores(ref.ws)).jarvis;
    const summary = summarize(action, args);
    const gate = approvalFor(action, args, { wake: ref.wake });
    if (gate) {
      waiting.set(ref.turnId, t);
      const entry = await log.append(ref.focusId, { type: 'approval', turnId: ref.turnId, action, args, summary, ...gate, state: 'pending' });
      return { text: waitText(entry.id) };
    }
    const r = await deps.execute({ ...ref, action, args });
    await log.append(ref.focusId, {
      type: 'action', turnId: ref.turnId, action, summary, ok: r.ok,
      ...(r.ok ? {} : { error: r.text }), ...(r.card ? { card: r.card } : {}),
    });
    return { text: r.ok ? r.text || `Done: ${summary}` : `Failed: ${r.text}` };
  });
}
