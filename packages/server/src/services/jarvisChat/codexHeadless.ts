// One Jarvis turn on Codex, headless: `codex exec --json`, resumed by thread id
// (`codex exec resume <id>`), with only the `strado` MCP server's jarvis_* tools
// (checked against codex-cli 0.164.0; fixture in test/fixtures/codex-stream.jsonl).
//
// - The prompt goes on stdin (`-`), never argv: it carries the person's words.
// - `--ignore-user-config`: ~/.codex/config.toml is not read, so none of the
//   person's MCP servers, notify hooks, profiles or model settings load (and its
//   own `[mcp_servers.strado]` can't merge into ours). Login still comes from
//   CODEX_HOME (auth.json) or the env. `--ignore-rules`: no execpolicy files.
// - The `strado` server is set with `-c mcp_servers.strado.*`: command and args
//   in argv, the env only by name (`env_vars`). Codex starts MCP servers with a
//   small default env plus those names, read from Codex's own env, so the token
//   rides in the child's env and never in argv or on disk. `enabled_tools`
//   limits it to the jarvis_* tools; `default_tools_approval_mode="approve"`
//   runs them without asking (there is no one to ask in exec); `required`
//   fails the turn if the server can't start instead of running toolless.
// - Codex's own tools, as far as the CLI lets them go: the shell (`shell_tool`,
//   `unified_exec`), web search, images, browser / computer use, plugins, apps,
//   skills, hooks, memories, goals and v1 sub-agents are off; the sandbox is
//   read-only and approvals are `never`. What stays (no flag removes it):
//   `exec`/`wait`, the code-mode JS runner every listed model calls tools through
//   (a V8 isolate with no fs, network or env; turning it off makes MCP tools
//   unreachable); nested in it `apply_patch` (refused: read-only sandbox, no
//   approvals), MCP resource listing/reading (the strado server only) and a
//   clock; `request_user_input` (no one answers in exec); and the multi-agent
//   v2 `collaboration.*` tools, which the model catalog turns on per model
//   (sub-agents inherit this same locked-down config).
// - The system prompt is `developer_instructions` (a developer message after
//   Codex's base instructions). The project's AGENTS.md is skipped
//   (`project_doc_max_bytes=0`).
// - Errors are fixed strings: nothing Codex printed reaches the chat as an
//   error, so nothing in it can leak.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { JARVIS_TOOLS } from './types.js';
import type { HeadlessEvent, HeadlessOpts, HeadlessSpawn } from './claudeHeadless.js';

export const NOT_INSTALLED: HeadlessEvent = { type: 'error', message: 'Codex is not installed', fix: 'Install Codex, or pick another agent' };
export const NOT_LOGGED_IN: HeadlessEvent = { type: 'error', message: 'Codex is not logged in', fix: 'Run codex login' };
export const USAGE_LIMIT: HeadlessEvent = { type: 'error', message: 'Codex hit its usage limit', fix: 'Try again later, or pick another agent' };
const FAILED: HeadlessEvent = { type: 'error', message: 'Codex stopped with an error' };
const EXITED: HeadlessEvent = { type: 'error', message: 'Codex exited unexpectedly' };
const KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;

/** How Codex logs in: an API key (CODEX_API_KEY is exec's own, OPENAI_API_KEY
 *  the provider's), an access token, a gateway / org / project, or CODEX_HOME,
 *  where `codex login` keeps auth.json (default ~/.codex, found through HOME). */
export const CODEX_AUTH_ENV = /^(OPENAI_(API_KEY|BASE_URL|ORGANIZATION|PROJECT)|CODEX_(API_KEY|ACCESS_TOKEN|HOME))$/;

/** The models `codex debug models` lists (visibility "list") in 0.164.0. */
export const CODEX_MODELS: { id: string | null; label: string }[] = [
  { id: null, label: 'Codex default' },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
];

/** Jarvis effort → Codex `model_reasoning_effort`. Codex 0.164.0 takes
 *  none|minimal|low|medium|high|xhigh|max|ultra, and the listed models all
 *  support low…max, so every Jarvis level maps to itself. */
const EFFORTS: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** Codex features turned off for Jarvis (see the header). */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'computer_use', 'browser_use', 'in_app_browser',
  'plugins', 'apps', 'tool_suggest', 'recommended_plugins', 'skill_search', 'multi_agent', 'goals', 'sleep_tool',
  'hooks', 'memories', 'workspace_dependencies',
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A TOML value for `-c key=value`: JSON strings and arrays of them are valid TOML. */
const toml = (v: string | string[]) => JSON.stringify(v);

export function codexArgv(o: Pick<HeadlessOpts, 'resume' | 'systemPrompt' | 'mcp' | 'model' | 'effort'>): string[] {
  const c = (kv: string) => ['-c', kv];
  const effort = o.effort ? EFFORTS[o.effort] : undefined;
  return [
    'exec', ...(o.resume ? ['resume'] : []),
    '--json',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    ...c('sandbox_mode="read-only"'),
    ...c('approval_policy="never"'),
    ...c('web_search="disabled"'),
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    ...c('skills.include_instructions=false'),
    ...c('skills.bundled.enabled=false'),
    ...c('project_doc_max_bytes=0'),
    ...c(`developer_instructions=${toml(o.systemPrompt)}`),
    ...c(`mcp_servers.strado.command=${toml(o.mcp.command)}`),
    ...c(`mcp_servers.strado.args=${toml(o.mcp.args)}`),
    ...c(`mcp_servers.strado.env_vars=${toml(Object.keys(o.mcp.env).filter((k) => ENV_NAME.test(k)))}`),
    ...c(`mcp_servers.strado.enabled_tools=${toml(Object.keys(JARVIS_TOOLS))}`),
    ...c('mcp_servers.strado.default_tools_approval_mode="approve"'),
    ...c('mcp_servers.strado.required=true'),
    ...(o.model ? ['-m', o.model] : []),
    ...(effort ? c(`model_reasoning_effort=${toml(effort)}`) : []),
    ...(o.resume ? [o.resume] : []),
    '-',
  ];
}

/** Codex's own error text → a fixed event (the text itself is never shown). */
function classify(message: unknown): HeadlessEvent {
  const m = typeof message === 'string' ? message : '';
  if (/\b401\b|unauthori[sz]ed|not logged in|authenticat|api key/i.test(m)) return NOT_LOGGED_IN;
  if (/usage limit|\b429\b|rate.?limit|quota|too many requests/i.test(m)) return USAGE_LIMIT;
  return FAILED;
}

type Line = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
};

/** Reads `codex exec --json` lines into events. Stateful: each agent message
 *  after the first starts a new paragraph; one terminal event at most. Codex's
 *  top-level `error` lines are retries ("Reconnecting... 2/5"); the last one
 *  decides the error if the process ends without a `turn.failed`. */
export function createCodexParser() {
  let session = false;
  let wrote = false;
  let ended = false;
  let lastError: HeadlessEvent | null = null;
  return {
    get ended() { return ended; },
    /** The error to report when the process ends with no terminal line. */
    get lastError() { return lastError; },
    line(raw: string): HeadlessEvent[] {
      if (ended || !raw.trim()) return [];
      let m: Line;
      try { m = JSON.parse(raw) as Line; } catch { return []; }
      if (!m || typeof m !== 'object') return [];
      switch (m.type) {
        case 'thread.started':
          if (session || typeof m.thread_id !== 'string' || !m.thread_id) return [];
          session = true;
          return [{ type: 'session', sessionId: m.thread_id }];
        case 'item.completed': {
          // agent_message is the reply; `error` items are warnings (a model
          // switch, a transport fallback), and tool calls show as their own items.
          if (m.item?.type !== 'agent_message' || !m.item.text) return [];
          const delta = (wrote ? '\n\n' : '') + m.item.text;
          wrote = true;
          return [{ type: 'text', delta }];
        }
        case 'error':
          lastError = classify(m.message);
          return [];
        case 'turn.completed':
          ended = true;
          return [{ type: 'done' }];
        case 'turn.failed':
          ended = true;
          return [classify(m.error?.message)];
        default:
          return [];
      }
    },
  };
}

/** Runs one turn. Ends after its terminal event (done or error), or quietly
 *  when `signal` aborts (the caller knows it stopped the turn). */
export async function* runCodexHeadless(o: HeadlessOpts, spawn: HeadlessSpawn = (c, a, s) => nodeSpawn(c, a, { ...s, stdio: ['pipe', 'pipe', 'ignore'] })): AsyncIterable<HeadlessEvent> {
  if (o.signal.aborted) return;
  // The MCP server's env (its token) goes in Codex's env, named by env_vars.
  const child = spawn('codex', codexArgv(o), { cwd: o.cwd, env: { ...o.env, ...o.mcp.env } });
  const queue: (HeadlessEvent | 'eof')[] = [];
  let wake: (() => void) | null = null;
  const push = (e: HeadlessEvent | 'eof') => { queue.push(e); wake?.(); wake = null; };
  const parser = createCodexParser();
  let pending = '';
  let spawnError: HeadlessEvent | null = null;

  const alive = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((r) => child.once('close', () => r()));
  // SIGTERM, then SIGKILL if it lingers: a resumed turn must never overlap it.
  let terminated = false;
  const kill = () => {
    if (!alive() || terminated) return;
    terminated = true;
    child.kill('SIGTERM');
    const hard = setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, KILL_GRACE_MS);
    hard.unref?.();
  };
  const onAbort = () => { kill(); push('eof'); };
  o.signal.addEventListener('abort', onAbort, { once: true });

  child.on('error', (err: NodeJS.ErrnoException) => {
    spawnError = err.code === 'ENOENT' ? NOT_INSTALLED : EXITED;
    if (child.pid === undefined) { push(spawnError); push('eof'); }
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      for (const e of parser.line(pending.slice(0, nl))) push(e);
      pending = pending.slice(nl + 1);
    }
  });
  child.on('close', () => {
    for (const e of parser.line(pending)) push(e);
    pending = '';
    if (!parser.ended && !o.signal.aborted) push(spawnError ?? parser.lastError ?? EXITED);
    push('eof');
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(o.prompt);

  let finished = false;
  try {
    for (;;) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      const e = queue.shift()!;
      if (e === 'eof' || o.signal.aborted) return;
      if (e.type === 'done' || e.type === 'error') finished = true;
      yield e;
      if (finished) return;
    }
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    // A finished turn exits on its own (and saves its thread); anything else is
    // stopped. Either way the turn is over only once the process is gone.
    if (!finished) kill();
    if (child.pid !== undefined) await Promise.race([exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS).unref?.())]);
    if (alive()) child.kill('SIGKILL');
  }
}
