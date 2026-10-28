// One Jarvis turn on the Pi coding agent, headless: `pi -p --mode json`,
// resumed by session id, with no built-in tools and only the `strado` MCP
// server's jarvis_* tools (checked against Pi 1.4.0; fixture in
// test/fixtures/pi-stream.jsonl).
//
// - The prompt goes on stdin, never argv: it carries the person's words (Pi
//   reads piped stdin as the prompt).
// - Pi speaks MCP itself. The `strado` server reaches it through a 0600
//   `.pi/mcp.json` in the Focus's own dir (a project entry replaces the
//   person's user-level `strado`); `--approve` trusts that dir for this run.
//   The file holds the turn's token, so it is never argv, and it is removed
//   when the turn ends. The person's other user-level servers are switched off
//   in the same file, so none of them start.
// - `--tools mcp__strado__jarvis_*` is an allowlist: Pi's own tools (read,
//   bash, edit, write, grep, find, ls), codemode and tool_search are all off;
//   `exposure: direct` declares the jarvis tools to the model as they are.
// - `-ne -e builtin:mcp`: none of the person's extensions (their hooks would
//   talk to Jarvis), only Pi's MCP support. `-nc -ns -np --no-themes`: no
//   AGENTS.md/CLAUDE.md, skills, prompt templates or themes. Login still comes
//   from Pi's own auth file (~/.pi/agent/auth.json) or a provider env var.
// - Sessions live in `<cwd>/pi-sessions`; the first line of the stream is the
//   session header, whose id `--session-id` resumes.
// - Errors are fixed strings: nothing Pi printed reaches the chat as an error.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HeadlessEvent, HeadlessOpts, HeadlessSpawn } from './claudeHeadless.js';

/** The provider credentials (and Pi's config dir) a headless Pi needs from the
 *  server's env; everything else Pi reads from ~/.pi/agent/auth.json. */
export const PI_AUTH_ENV =
  /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)|OPENAI_API_KEY|AZURE_OPENAI_(?:API_KEY|BASE_URL|RESOURCE_NAME|API_VERSION|DEPLOYMENT_NAME_MAP)|(?:ANT_LING|DEEPSEEK|NVIDIA|GEMINI|GROQ|CEREBRAS|XAI|FIREWORKS|TOGETHER|BASETEN|OPENROUTER|AI_GATEWAY|ZAI|ZAI_CODING_CN|MISTRAL|MINIMAX|MOONSHOT|OPENCODE|KIMI|META|CLOUDFLARE)_API_KEY|CLOUDFLARE_(?:ACCOUNT|GATEWAY)_ID|QWEN_TOKEN_PLAN(?:_CN)?_API_KEY|XIAOMI_(?:API_KEY|TOKEN_PLAN_(?:CN|AMS|SGP)_API_KEY)|AWS_(?:PROFILE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK|REGION)|PI_CODING_AGENT_DIR)$/;

/** Models for the picker, as `provider/id` (Pi's --model takes that form).
 *  These are OpenRouter's, the provider Pi is logged in to here. */
export const PI_MODELS: { id: string | null; label: string }[] = [
  { id: null, label: 'Pi default' },
  { id: 'openrouter/anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
  { id: 'openrouter/anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
  { id: 'openrouter/anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
  { id: 'openrouter/openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openrouter/google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'openrouter/z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
  { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3' },
  { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

export const PI_NOT_INSTALLED: HeadlessEvent = { type: 'error', message: 'Pi is not installed', fix: 'Install Pi, or pick another agent' };
export const PI_NOT_LOGGED_IN: HeadlessEvent = { type: 'error', message: 'Pi is not logged in', fix: 'Run pi and log in to a provider' };
const KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
const STDERR_MAX = 8_192;
const FAILED: HeadlessEvent = { type: 'error', message: 'Pi stopped with an error' };
const EXITED: HeadlessEvent = { type: 'error', message: 'Pi exited unexpectedly' };
const NO_CREDIT: HeadlessEvent = { type: 'error', message: 'Pi\'s provider has no credit left', fix: 'Check your provider account, or pick another agent' };
const RATE_LIMIT: HeadlessEvent = { type: 'error', message: 'Pi hit its provider\'s rate limit', fix: 'Try again later, or pick another agent' };
const BAD_MODEL: HeadlessEvent = { type: 'error', message: 'Pi could not use that model', fix: 'Pick another model' };
/** Pi's levels are the Focus's efforts by name. */
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** The server's tools only: `mcp__<server>__<tool>`. */
const PI_TOOLS = 'mcp__strado__jarvis_*';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** Where Pi keeps a Focus's sessions. */
export const piSessionDir = (cwd: string) => path.join(cwd, 'pi-sessions');
/** The project MCP config Pi reads from the Focus's dir once it is trusted. */
export const piMcpConfigPath = (cwd: string) => path.join(cwd, '.pi', 'mcp.json');

export function piArgv(o: Pick<HeadlessOpts, 'cwd' | 'resume' | 'systemPrompt' | 'model' | 'effort'>): string[] {
  const flagSafe = (v: string | null | undefined): v is string => !!v && !v.startsWith('-');
  return [
    '-p', '--mode', 'json',
    '--offline',
    '-ne', '-e', 'builtin:mcp',
    '-nc', '-ns', '-np', '--no-themes',
    '--approve',
    '--tools', PI_TOOLS,
    '--session-dir', piSessionDir(o.cwd),
    '--system-prompt', o.systemPrompt,
    ...(o.resume && SESSION_ID.test(o.resume) ? ['--session-id', o.resume] : []),
    ...(flagSafe(o.model) ? ['--model', o.model] : []),
    ...(o.effort && THINKING.has(o.effort) ? ['--thinking', o.effort] : []),
  ];
}

type McpEntry = { command: string; args: string[]; env: Record<string, string>; exposure: 'direct'; timeout: number };

/** `.pi/mcp.json`: `strado` with the turn's env, every other user-level server
 *  off. A value Pi would expand (`${…}`, a leading `!`) goes by reference
 *  instead, through `passEnv` into Pi's own env. */
export function piMcpConfig(mcp: HeadlessOpts['mcp'], userServers: string[]): { config: { mcpServers: Record<string, McpEntry | { enabled: false }>; autoEnableCodemode: false }; passEnv: Record<string, string> } {
  const env: Record<string, string> = {};
  const passEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(mcp.env)) {
    if (v.includes('${') || v.startsWith('!')) { env[k] = `\${${k}}`; passEnv[k] = v; } else env[k] = v;
  }
  const mcpServers: Record<string, McpEntry | { enabled: false }> = {};
  const norm = (n: string) => n.replace(/-/g, '_').toLowerCase();
  for (const name of userServers) if (norm(name) !== 'strado' && /^[A-Za-z0-9_-]+$/.test(name)) mcpServers[name] = { enabled: false };
  // Over the jarvis tool call's own 90 s wait (an approval can take a while).
  mcpServers.strado = { command: mcp.command, args: mcp.args, env, exposure: 'direct', timeout: 120 };
  return { config: { mcpServers, autoEnableCodemode: false }, passEnv };
}

async function userServerNames(env: Record<string, string>): Promise<string[]> {
  const dir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), '.pi', 'agent');
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'mcp.json'), 'utf8')) as { mcpServers?: unknown };
    return raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? Object.keys(raw.mcpServers) : [];
  } catch {
    return [];
  }
}

async function writeMcpConfig(cwd: string, config: unknown): Promise<string> {
  const file = piMcpConfigPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

/** A failed assistant message's provider error, as a fixed event. Pi's text is
 *  only matched, never shown. */
function providerError(msg: string): HeadlessEvent {
  if (/^(?:401|403)\b|unauthori[sz]ed|invalid api key|no api key|authentication/i.test(msg)) return PI_NOT_LOGGED_IN;
  if (/^402\b|insufficient (?:credits|funds|balance)|billing|quota/i.test(msg)) return NO_CREDIT;
  if (/^429\b|rate.?limit/i.test(msg)) return RATE_LIMIT;
  if (/not a valid model|model[^.]*not found|unknown model|no such model/i.test(msg)) return BAD_MODEL;
  return FAILED;
}

type Line = {
  type?: string;
  id?: string;
  aborted?: boolean;
  willRetry?: boolean;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
  assistantMessageEvent?: { type?: string; delta?: string };
};

/** Reads `--mode json` lines into events. Stateful: a later text block starts
 *  on a new paragraph; a failed message counts only if no retry succeeds; one
 *  terminal event at most (on `agent_settled`). */
export function createPiStreamParser() {
  let session = false;
  let wrote = false;
  let sep = false;
  let ended = false;
  let runEnded = false;
  let lastError: HeadlessEvent | null = null;
  const end = (): HeadlessEvent[] => { ended = true; return [lastError ?? { type: 'done' }]; };
  return {
    get ended() { return ended; },
    line(raw: string): HeadlessEvent[] {
      if (ended || !raw.trim()) return [];
      let m: Line;
      try { m = JSON.parse(raw) as Line; } catch { return []; }
      if (!m || typeof m !== 'object') return [];
      switch (m.type) {
        case 'session':
          if (session || typeof m.id !== 'string' || !m.id) return [];
          session = true;
          return [{ type: 'session', sessionId: m.id }];
        case 'message_update': {
          const e = m.assistantMessageEvent;
          if (e?.type === 'text_start') sep = wrote;
          if (e?.type !== 'text_delta' || !e.delta) return [];
          const delta = (sep ? '\n\n' : '') + e.delta;
          sep = false;
          wrote = true;
          return [{ type: 'text', delta }];
        }
        case 'message_end':
          if (m.message?.role !== 'assistant') return [];
          lastError = m.message.stopReason === 'error' ? providerError(m.message.errorMessage ?? '') : null;
          return [];
        case 'agent_start':
          runEnded = false;
          return [];
        case 'agent_end':
          runEnded = !m.willRetry;
          return [];
        case 'agent_settled':
          if (m.aborted) { ended = true; return [FAILED]; }
          return end();
        default:
          return [];
      }
    },
    /** At exit without `agent_settled`: a finished run still counts. */
    close(): HeadlessEvent[] {
      return !ended && runEnded ? end() : [];
    },
  };
}

/** Runs one turn. Ends after its terminal event (done or error), or quietly
 *  when `signal` aborts (the caller knows it stopped the turn). */
export async function* runPiHeadless(o: HeadlessOpts, spawn: HeadlessSpawn = (c, a, s) => nodeSpawn(c, a, { ...s, stdio: ['pipe', 'pipe', 'pipe'] })): AsyncIterable<HeadlessEvent> {
  if (o.signal.aborted) return;
  let mcpFile: string | null = null;
  let child: ChildProcess;
  try {
    const { config, passEnv } = piMcpConfig(o.mcp, await userServerNames(o.env));
    mcpFile = await writeMcpConfig(o.cwd, config);
    if (o.signal.aborted) { await fs.rm(mcpFile, { force: true }).catch(() => undefined); return; }
    child = spawn('pi', piArgv(o), { cwd: o.cwd, env: { ...o.env, ...passEnv } });
  } catch {
    if (mcpFile) await fs.rm(mcpFile, { force: true }).catch(() => undefined);
    yield EXITED;
    return;
  }
  const queue: (HeadlessEvent | 'eof')[] = [];
  let wake: (() => void) | null = null;
  const push = (e: HeadlessEvent | 'eof') => { queue.push(e); wake?.(); wake = null; };
  const parser = createPiStreamParser();
  let pending = '';
  let stderr = '';
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
    spawnError = err.code === 'ENOENT' ? PI_NOT_INSTALLED : EXITED;
    if (child.pid === undefined) { push(spawnError); push('eof'); }
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      for (const e of parser.line(pending.slice(0, nl).replace(/\r$/, ''))) push(e);
      pending = pending.slice(nl + 1);
    }
  });
  // Kept only to tell "not logged in" apart; never shown.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < STDERR_MAX) stderr += chunk.slice(0, STDERR_MAX - stderr.length); });
  child.on('close', () => {
    for (const e of [...parser.line(pending), ...parser.close()]) push(e);
    pending = '';
    if (!parser.ended && !o.signal.aborted) push(spawnError ?? (/no api key found|not logged in|\/login/i.test(stderr) ? PI_NOT_LOGGED_IN : EXITED));
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
    // A finished turn exits on its own (and saves its session); anything else is
    // stopped. Either way the turn is over only once the process is gone.
    if (!finished) kill();
    if (child.pid !== undefined) await Promise.race([exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS).unref?.())]);
    if (alive()) child.kill('SIGKILL');
    await fs.rm(mcpFile, { force: true }).catch(() => undefined);
  }
}
