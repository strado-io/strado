// Mission control's server state for agents running in their own UI: what
// each one is doing right now (its live tool line and last answer, from its
// hooks), and the permission requests it is holding open for the human.
//
// A Claude Code PermissionRequest hook runs alongside the TUI's own dialog
// (verified against a real session): the box and the tab can both answer,
// the first decision wins, and when the tab answers first Claude cancels the
// hook — its request closes, and the approval here is `gone`.

export type ApprovalKind = 'command' | 'file-change' | 'file-read' | 'web' | 'tool';
export type Approval = { id: string; kind: ApprovalKind; title: string; detail: string; createdAt: number };
export type Decision = 'allow' | 'deny';
export type Line = { text: string; at: number };
export type AgentActivity = { activity: Line | null; lastResult: Line | null };

/** How long a request waits for the box before the tab's own dialog is the only way (Claude's hook default is 600s). */
export const APPROVAL_WAIT_MS = 590_000;
/** An answered or abandoned request is remembered this long, so a late click gets `gone`, not "unknown". */
const GONE_FOR_MS = 120_000;

type Pending = Approval & { scopeId: string; agentId: string; settle: (d: Decision | null) => void };

export function createAgentControl(opts: {
  /** Something about this agent changed: the hub refetches its stations. */
  onChange: (scopeId: string, agentId: string) => void;
  now?: () => number;
  waitMs?: number;
}) {
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? APPROVAL_WAIT_MS;
  const pending = new Map<string, Pending>();
  const gone = new Map<string, number>(); // id → when it closed
  const activity = new Map<string, AgentActivity>(); // scopeId\0agentId
  let seq = 0;
  const key = (scopeId: string, agentId: string) => `${scopeId}\0${agentId}`;
  const forget = () => {
    const cutoff = now() - GONE_FOR_MS;
    for (const [id, at] of gone) if (at < cutoff) gone.delete(id);
  };

  return {
    /**
     * An agent asks for permission. Resolves with the human's decision, or
     * null when nobody answered here: the tab's own dialog answered (the hook
     * was cancelled → `signal` aborts), the wait ran out, or the agent left.
     */
    request(scopeId: string, agentId: string, ask: { kind: ApprovalKind; title: string; detail: string }, signal?: AbortSignal): Promise<Decision | null> {
      const id = `ap_${now().toString(36)}_${(++seq).toString(36)}`;
      return new Promise<Decision | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (d: Decision | null) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          gone.set(id, now());
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          opts.onChange(scopeId, agentId);
          resolve(d);
        };
        const onAbort = () => settle(null);
        pending.set(id, { id, scopeId, agentId, createdAt: now(), ...ask, settle });
        if (signal?.aborted) { settle(null); return; }
        signal?.addEventListener('abort', onAbort);
        timer = setTimeout(() => settle(null), waitMs);
        timer.unref?.();
        opts.onChange(scopeId, agentId);
      });
    },

    /** The human's click. `gone`: already answered in the tab, expired, or never existed. */
    decide(scopeId: string, id: string, decision: Decision): 'ok' | 'gone' {
      forget();
      const p = pending.get(id);
      if (!p || p.scopeId !== scopeId) return 'gone';
      p.settle(decision);
      return 'ok';
    },

    /** Open requests of one agent, oldest first. */
    approvals(scopeId: string, agentId: string): Approval[] {
      return [...pending.values()]
        .filter((p) => p.scopeId === scopeId && p.agentId === agentId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ id, kind, title, detail, createdAt }) => ({ id, kind, title, detail, createdAt }));
    },

    /** A tool started: it is what the agent is doing now. */
    toolStarted(scopeId: string, agentId: string, text: string): void {
      const k = key(scopeId, agentId);
      activity.set(k, { activity: { text, at: now() }, lastResult: activity.get(k)?.lastResult ?? null });
      opts.onChange(scopeId, agentId);
    },

    /** The turn ended: nothing running; its final words are the last result. */
    turnEnded(scopeId: string, agentId: string, result: string | null): void {
      const k = key(scopeId, agentId);
      const prev = activity.get(k);
      activity.set(k, { activity: null, lastResult: result ? { text: result, at: now() } : prev?.lastResult ?? null });
      opts.onChange(scopeId, agentId);
    },

    activityOf(scopeId: string, agentId: string): AgentActivity {
      return activity.get(key(scopeId, agentId)) ?? { activity: null, lastResult: null };
    },
  };
}

export type AgentControl = ReturnType<typeof createAgentControl>;

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** A path as the person reads it: relative to the worktree when inside it. */
const shown = (p: string, cwd: string | null) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

/**
 * What a tool call is, in the box's words: the approval's kind, title and
 * detail, and the one-line activity ("Bash: npm test"). `hide` scrubs any line
 * that looks like a secret before it leaves the server.
 */
export function describeTool(tool: string, input: unknown, cwd: string | null, hide: (s: string) => string): { kind: ApprovalKind; title: string; detail: string; line: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const file = shown(str(i.file_path) || str(i.notebook_path) || str(i.path), cwd);
  let kind: ApprovalKind = 'tool';
  let title = `use ${tool}`;
  let detail = '';
  let what = '';
  switch (tool) {
    case 'Bash':
      kind = 'command'; title = 'run a command'; detail = str(i.command); what = firstLine(str(i.command));
      break;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      kind = 'file-change'; title = `${tool === 'Write' ? 'write' : 'edit'} ${file || 'a file'}`; detail = file; what = file;
      break;
    case 'Read': case 'Glob': case 'Grep':
      kind = 'file-read'; title = `read ${file || str(i.pattern) || 'files'}`; detail = file || str(i.pattern); what = file || str(i.pattern);
      break;
    case 'WebFetch': case 'WebSearch':
      kind = 'web'; title = tool === 'WebFetch' ? 'fetch a URL' : 'search the web'; detail = str(i.url) || str(i.query); what = detail;
      break;
    default:
      detail = cut(JSON.stringify(i), 400); what = '';
  }
  detail = hide(detail.split('\n').slice(0, 8).join('\n'));
  return { kind, title: hide(title), detail: cut(detail, 600), line: cut(hide(what ? `${tool}: ${what}` : tool), 120) };
}
