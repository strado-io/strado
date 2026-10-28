// One Jarvis turn on Claude Code, headless: `claude -p` with stream-json out,
// resumed by session id, with no built-in tools and only the `strado` MCP
// server's jarvis_* tools (checked against Claude Code 2.1.310; fixture in
// test/fixtures/claude-stream.jsonl).
//
// - The prompt goes on stdin, never argv: it carries the person's words.
// - `--tools ""` removes Claude's own tools (Read, Bash, Edit…); `--allowedTools`
//   pre-approves the Strado ones; `dontAsk` denies anything else instead of
//   asking; `--strict-mcp-config` ignores every other MCP server.
// - `--setting-sources ""`: none of the person's settings, hooks or plugins
//   (their SessionStart hooks would talk to Jarvis). Login still comes from
//   Claude's own credential store.
// - Errors are fixed strings: nothing Claude printed reaches the chat as an
//   error, so nothing in it can leak.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { jarvisAllowedTools } from './types.js';

export type HeadlessEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string; fix?: string };

export type HeadlessOpts = {
  cwd: string;
  prompt: string;
  resume: string | null;
  systemPrompt: string;
  mcpConfigPath: string;
  /** Null (or absent): Claude Code's own default. */
  model?: string | null;
  effort?: string | null;
  env: Record<string, string>;
  signal: AbortSignal;
};

export type HeadlessSpawn = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildProcess;

export const NOT_INSTALLED: HeadlessEvent = { type: 'error', message: 'Claude Code is not installed', fix: 'Install Claude Code, or pick another agent' };
export const NOT_LOGGED_IN: HeadlessEvent = { type: 'error', message: 'Claude Code is not logged in', fix: 'Run claude and log in' };
const KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
const FAILED: HeadlessEvent = { type: 'error', message: 'Claude Code stopped with an error' };
const EXITED: HeadlessEvent = { type: 'error', message: 'Claude Code exited unexpectedly' };
const API_ERRORS: Record<string, HeadlessEvent> = {
  authentication_failed: NOT_LOGGED_IN,
  billing_error: { type: 'error', message: 'Claude Code has no usage left', fix: 'Check your Claude plan, or pick another agent' },
  rate_limit: { type: 'error', message: 'Claude Code hit its usage limit', fix: 'Try again later, or pick another agent' },
};

export function claudeArgv(o: Pick<HeadlessOpts, 'resume' | 'systemPrompt' | 'mcpConfigPath' | 'model' | 'effort'>): string[] {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', o.mcpConfigPath,
    '--tools', '',
    '--allowedTools', ...jarvisAllowedTools(),
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', o.systemPrompt,
    ...(o.resume ? ['--resume', o.resume] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
  ];
}

type Line = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string;
  is_api_error_message?: boolean;
  message?: { content?: { type?: string; text?: string }[] };
};

/** Reads stream-json lines into events. Stateful: text from later messages
 *  of the same turn starts on a new paragraph; one terminal event at most. */
export function createStreamParser() {
  let session = false;
  let wrote = false;
  let ended = false;
  return {
    get ended() { return ended; },
    line(raw: string): HeadlessEvent[] {
      if (ended || !raw.trim()) return [];
      let m: Line;
      try { m = JSON.parse(raw) as Line; } catch { return []; }
      const out: HeadlessEvent[] = [];
      if (!session && typeof m.session_id === 'string' && m.session_id && m.type === 'system' && m.subtype === 'init') {
        session = true;
        out.push({ type: 'session', sessionId: m.session_id });
      }
      if (m.type === 'assistant') {
        if (m.error || m.is_api_error_message) {
          ended = true;
          out.push(API_ERRORS[m.error ?? ''] ?? FAILED);
          return out;
        }
        for (const block of m.message?.content ?? []) {
          if (block.type !== 'text' || !block.text) continue;
          out.push({ type: 'text', delta: (wrote ? '\n\n' : '') + block.text });
          wrote = true;
        }
      }
      if (m.type === 'result') {
        ended = true;
        out.push(m.is_error ? FAILED : { type: 'done' });
      }
      return out;
    },
  };
}

/** Runs one turn. Ends after its terminal event (done or error), or quietly
 *  when `signal` aborts (the caller knows it stopped the turn). */
export async function* runClaudeHeadless(o: HeadlessOpts, spawn: HeadlessSpawn = (c, a, s) => nodeSpawn(c, a, { ...s, stdio: ['pipe', 'pipe', 'ignore'] })): AsyncIterable<HeadlessEvent> {
  if (o.signal.aborted) return;
  const child = spawn('claude', claudeArgv(o), { cwd: o.cwd, env: o.env });
  const queue: (HeadlessEvent | 'eof')[] = [];
  let wake: (() => void) | null = null;
  const push = (e: HeadlessEvent | 'eof') => { queue.push(e); wake?.(); wake = null; };
  const parser = createStreamParser();
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
    if (!parser.ended && !o.signal.aborted) push(spawnError ?? EXITED);
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
  }
}
