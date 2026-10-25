// The Jarvis box's server side: resources the window can't create itself
// (tabs, shell runs, interrupts, closes, messages to agents), through the
// human-only /jarvis routes. jarvisFetch (hubToken.ts) adds the per-boot hub
// token and refreshes it once on a 401/403.
import { api, type JarvisRunResult, type JarvisScripts, type JarvisSpawnResult } from '../../api';
import type { JarvisServerPort } from './execute';
import { jarvisFetch } from './hubToken';
import type { ParseContext, TabRef } from './types';

/** A worktree's package.json scripts as parser context ("run dev" → `pnpm run dev`). */
export function scriptsContext(s: JarvisScripts | null): Pick<ParseContext, 'packageScripts' | 'packageManager' | 'runCommands'> {
  if (!s) return { packageScripts: {} };
  return {
    packageManager: s.packageManager,
    packageScripts: Object.fromEntries(s.scripts.map((n) => [n, `${s.packageManager} run ${n}`])),
    ...(s.runCommands ? { runCommands: s.runCommands } : {}),
  };
}

type JarvisServer = JarvisServerPort & {
  spawn: (...a: Parameters<JarvisServerPort['spawn']>) => Promise<{ tab: TabRef; agentId: string }>;
  recap: NonNullable<JarvisServerPort['recap']>;
  /** Fetch (once per worktree, unless `refresh`) the worktree's scripts; never throws. */
  loadScripts(worktreePath: string, opts?: { refresh?: boolean }): Promise<JarvisScripts>;
  /** What loadScripts last got, for the synchronous parse context. */
  cachedScripts(worktreePath: string): JarvisScripts | null;
};
type PtyRef = TabRef & { mode: Exclude<TabRef['mode'], 'browser'> };

export function createJarvisServerPort(wsId: string): JarvisServer {
  const base = `/api/w/${encodeURIComponent(wsId)}/jarvis`;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await jarvisFetch(`${base}${path}`, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string; details?: { reason?: string } } } | null;
    if (!res.ok) {
      // The tab's slot now holds a different session (closed and reopened).
      if (res.status === 409 && json?.error?.details?.reason === 'tab_replaced') throw new Error('That tab was closed and replaced');
      const reason = json?.error?.details?.reason;
      throw Object.assign(new Error(json?.error?.message ?? `request failed (${res.status})`), reason ? { reason } : {});
    }
    return json as T;
  };
  const pty = (tab: TabRef): PtyRef => {
    if (tab.mode === 'browser') throw new Error('Browser tabs have no terminal');
    return tab as PtyRef;
  };
  const scripts = new Map<string, Promise<JarvisScripts>>();
  const loaded = new Map<string, JarvisScripts>();

  return {
    loadScripts: (worktreePath, opts) => {
      let p = scripts.get(worktreePath);
      if (!p || opts?.refresh) {
        p = call<JarvisScripts>(`/scripts?worktreePath=${encodeURIComponent(worktreePath)}`)
          // No scripts is a fine answer; "run dev" just stays literal.
          .catch((): JarvisScripts => ({ packageManager: 'npm', scripts: [] }))
          .then((r) => { loaded.set(worktreePath, r); return r; });
        scripts.set(worktreePath, p);
      }
      return p;
    },
    cachedScripts: (worktreePath) => loaded.get(worktreePath) ?? null,
    // The box places the tab first, then runs the command (run below): the
    // spawn route's own command option only answers once the command settles.
    spawn: async ({ mode, worktreePath, prompt }) => {
      const r = await call<JarvisSpawnResult>('/spawn', { mode, worktreePath, ...(prompt ? { prompt } : {}) });
      const { agentId, mode: m, worktreePath: path, sessionId, executionId } = r.agent;
      return { tab: { worktreePath: path, mode: m, sessionId, ...(executionId ? { executionId } : {}) }, agentId };
    },
    run: async (tab, command) => {
      const r = await call<JarvisRunResult>('/run', { target: pty(tab), command });
      if ('error' in r) throw new Error(r.error);
      return r;
    },
    interrupt: (tab) => call('/interrupt', { target: pty(tab) }),
    close: (tab) => call('/close', { target: pty(tab) }),
    message: (agentId, text, opts) => call('/message', {
      to: agentId, body: text, ...(opts?.ask ? { ask: true } : {}), ...(opts?.context?.length ? { context: opts.context } : {}),
    }),
    recap: async (agents, question) => {
      try {
        return await call<{ text: string }>('/recap', { ...(agents === 'all' ? { all: true } : { agents }), ...(question ? { question } : {}) });
      } catch (err) {
        // The model's reasons in plain words, as for a plan; the code stays for a Settings link.
        const reason = (err as { reason?: string }).reason;
        const plain = reason ? RECAP_ERROR[reason] : undefined;
        throw plain ? Object.assign(new Error(plain), { reason }) : err;
      }
    },
    answerCall: (callId, text) => api.intercom.escalations.resolve(wsId, callId, text),
    dismissCall: (callId) => api.intercom.escalations.dismiss(wsId, callId),
    interruptAgent: (agentId) => api.intercom.interrupt(wsId, agentId),
    // The worktree's configured dev command; P0 has no per-call override.
    // The default run: no runId at all, exactly as before run commands.
    startServer: (worktreePath, _command, _script, run) => (run ? api.worktrees.start(wsId, worktreePath, run) : api.worktrees.start(wsId, worktreePath)),
    stopServer: (worktreePath, run) => (run ? api.worktrees.stop(wsId, worktreePath, run) : api.worktrees.stop(wsId, worktreePath)),
  };
}

const RECAP_ERROR: Record<string, string> = {
  local_only: 'Recaps use the model, and natural language is off (Local only)',
  no_key: 'Recaps need an Anthropic API key — Settings',
  bad_key: 'The Anthropic API key was rejected — Settings',
  timeout: 'The recap took too long — try again',
  model_unavailable: 'The model is unavailable right now',
  rate_limited: 'Too many requests — wait a moment',
};

// One port per workspace for the life of the page (its scripts cache).
const ports = new Map<string, JarvisServer>();
export function jarvisServerPort(wsId: string): JarvisServer {
  let port = ports.get(wsId);
  if (!port) { port = createJarvisServerPort(wsId); ports.set(wsId, port); }
  return port;
}
