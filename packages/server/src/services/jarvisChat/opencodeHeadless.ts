// One Jarvis turn on OpenCode, headless (checked against OpenCode 2.0.32;
// fixture in test/fixtures/opencode-stream.jsonl).
//
// Two processes per turn:
// 1. `opencode serve --stdio`: a private server, configured for this turn
//    only by env. It prints {"url":…} and exits when its stdin closes, so it
//    cannot outlive Strado.
// 2. `opencode run --server <url> --format json`: the turn itself, prompt on
//    stdin (never argv), one JSON event per line.
// Why not `opencode run --standalone`: OpenCode starts MCP servers in the
// background and freezes the turn's tool list when the prompt arrives, so the
// first step never has the jarvis tools (the model answers "I have no such
// tool"). Here the turn starts only once /api/mcp says `strado` is connected.
//
// - Config: OPENCODE_CONFIG_CONTENT on the server's env (it carries the turn's
//   token in the MCP server's environment: env only, never argv or a file).
//   OPENCODE_CONFIG_DIR points at an empty folder in `cwd`, so the person's
//   global opencode.json (their MCP servers, plugins, agents) is not loaded;
//   project config and Claude Code's CLAUDE.md/skills are switched off too.
//   Login still comes from OpenCode's data dir (auth.json) or provider env.
// - Tools: permissions deny "*" and allow only strado_jarvis_*; OpenCode drops
//   a fully denied tool from the list, so no built-in tool (shell, read, edit,
//   write, webfetch, execute…) is offered at all. `codemode: false` exposes the
//   jarvis tools as plain tools rather than through `execute`.
// - System prompt: the `jarvis` agent's `system`, which replaces OpenCode's own.
// - Effort: OpenCode's model variants (low…max) where the model has one.
// - Errors are fixed strings: nothing OpenCode printed reaches the chat as an
//   error, so nothing in it can leak.
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HeadlessEvent, HeadlessOpts, HeadlessSpawn } from './claudeHeadless.js';

/** Provider logins OpenCode reads from the env (besides its own auth.json),
 *  for the runner's env scrub. AWS_REGION / AWS_PROFILE / XDG_* already pass it. */
export const OPENCODE_AUTH_ENV = /^(OPENCODE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|GOOGLE_(API_KEY|GENERATIVE_AI_API_KEY|APPLICATION_CREDENTIALS|VERTEX_PROJECT|VERTEX_LOCATION|CLOUD_PROJECT)|GROQ_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|MISTRAL_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|CEREBRAS_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY|ZHIPU_API_KEY|MINIMAX_API_KEY|PERPLEXITY_API_KEY|DEEPINFRA_API_KEY|NVIDIA_API_KEY|HF_TOKEN|AZURE_(API_KEY|RESOURCE_NAME)|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)|CLOUDFLARE_(ACCOUNT_ID|API_TOKEN|GATEWAY_ID))$/;

/** `provider/model` as `opencode models` lists them (2.0.32). null: OpenCode's default. */
export const OPENCODE_MODELS: { id: string | null; label: string }[] = [
  { id: null, label: 'OpenCode default' },
  { id: 'openrouter/anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 (OpenRouter)' },
  { id: 'openrouter/anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (OpenRouter)' },
  { id: 'openrouter/anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (OpenRouter)' },
  { id: 'openrouter/openai/gpt-6.1-sol', label: 'GPT-6.1 Sol (OpenRouter)' },
  { id: 'openrouter/google/gemini-3.8-flash', label: 'Gemini 3.8 Flash (OpenRouter)' },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Anthropic API)' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol (OpenAI)' },
  { id: 'opencode/big-pickle', label: 'Big Pickle (OpenCode Zen, free)' },
];

export const NOT_INSTALLED: HeadlessEvent = { type: 'error', message: 'OpenCode is not installed', fix: 'Install OpenCode, or pick another agent' };
export const TOO_OLD: HeadlessEvent = { type: 'error', message: 'Jarvis needs OpenCode 2 or newer', fix: 'Update OpenCode (brew upgrade opencode), or remove the old copy in ~/.opencode/bin' };
export const NOT_LOGGED_IN: HeadlessEvent = { type: 'error', message: 'OpenCode is not logged in to this model\'s provider', fix: 'Run opencode auth login, or pick another model' };
export const NO_TOOLS: HeadlessEvent = { type: 'error', message: 'OpenCode could not start Jarvis\'s tools', fix: 'Try again' };
export const BAD_MODEL: HeadlessEvent = { type: 'error', message: 'OpenCode cannot use that model', fix: 'Pick another model' };
const FAILED: HeadlessEvent = { type: 'error', message: 'OpenCode stopped with an error' };
const EXITED: HeadlessEvent = { type: 'error', message: 'OpenCode exited unexpectedly' };
const API_ERRORS: Record<string, HeadlessEvent> = {
  'provider.auth': NOT_LOGGED_IN,
  'provider.no-route': BAD_MODEL,
  'provider.quota': { type: 'error', message: 'OpenCode\'s provider has no usage left', fix: 'Check your plan, or pick another model' },
  'provider.rate-limit': { type: 'error', message: 'OpenCode hit its provider\'s rate limit', fix: 'Try again later, or pick another model' },
};

const KILL_GRACE_MS = 3_000;
const EXIT_WAIT_MS = 5_000;
const AGENT = 'jarvis';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** provider/model[#variant]: nothing that could read as a flag. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]-]*\/[A-Za-z0-9._:@\/\[\]-]{1,160}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export type OpencodeDeps = {
  fetch?: typeof fetch;
  /** How long the private server may take to come up with the tools connected. */
  readyMs?: number;
  pollMs?: number;
  password?: () => string;
  /** Which `opencode` to run (default: the first 2.x on the turn's PATH). */
  bin?: () => Promise<string | null>;
};

// An old 1.x install (~/.opencode/bin) often sits earlier on PATH than a
// current one (Homebrew), and 1.x has no `serve --stdio`: take the first
// opencode on PATH that is 2 or newer. Versions are read once per file.
const versions = new Map<string, Promise<number | null>>();
const majorOf = (file: string) => {
  let v = versions.get(file);
  if (!v) {
    v = new Promise((r) => execFile(file, ['--version'], { timeout: 5_000 }, (err, out) => {
      const m = /(\d+)\.\d+/.exec(String(out));
      r(err || !m ? null : Number(m[1]));
    }));
    versions.set(file, v);
  }
  return v;
};
/** The opencode to run: a 2.x path; `null` when only older ones exist; 'opencode' when none is found (spawn says not installed). */
export async function findOpencode(pathVar = ''): Promise<string | null> {
  let sawOld = false;
  for (const dir of pathVar.split(':').filter(Boolean)) {
    const file = path.join(dir, 'opencode');
    try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; }
    const major = await majorOf(file);
    if (major !== null && major >= 2) return file;
    sawOld = true;
  }
  return sawOld ? null : 'opencode';
}

/** Deny everything, then allow the jarvis tools (last match wins). */
export const JARVIS_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'strado_jarvis_*', resource: '*', effect: 'allow' },
] as const;

/** The turn's whole OpenCode config (canonical 2.x shape). */
export function opencodeConfig(o: Pick<HeadlessOpts, 'mcp' | 'systemPrompt'>) {
  return {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    share: 'disabled',
    snapshots: false,
    lsp: false,
    formatter: false,
    mcp: {
      servers: {
        strado: { type: 'local', command: [o.mcp.command, ...o.mcp.args], environment: o.mcp.env, codemode: false },
      },
    },
    permissions: JARVIS_PERMISSIONS,
    agents: { [AGENT]: { mode: 'primary', system: o.systemPrompt, permissions: JARVIS_PERMISSIONS } },
    default_agent: AGENT,
  };
}

/** The server's env and the run client's. Inherited OPENCODE_* settings are
 *  dropped (a Strado tab's OPENCODE_CONFIG_CONTENT must not leak in), except
 *  the OpenCode Zen key. Only the server gets the config (and so the token). */
export function opencodeEnv(o: Pick<HeadlessOpts, 'env' | 'cwd' | 'mcp' | 'systemPrompt'>, configDir: string, password: string): { server: Record<string, string>; client: Record<string, string> } {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (!k.startsWith('OPENCODE_') || k === 'OPENCODE_API_KEY') base[k] = v;
  const common = { ...base, PWD: o.cwd, OPENCODE_CONFIG_DIR: configDir, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: '1' };
  return {
    server: {
      ...common,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(o)),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
    },
    client: common,
  };
}

export const SERVE_ARGV = ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'];

export function opencodeRunArgv(o: { url: string; resume: string | null; model: string | null }): string[] {
  return [
    'run', '--server', o.url, '--format', 'json', '--agent', AGENT,
    ...(o.resume ? ['--session', o.resume] : ['--title', 'Jarvis']),
    ...(o.model ? ['--model', o.model] : []),
  ];
}

/** The model's variant for this effort, or the nearest lower one it has. */
export function pickVariant(effort: string | null | undefined, variants: string[]): string | null {
  const at = EFFORTS.indexOf(effort ?? '');
  for (const e of EFFORTS.slice(0, at + 1).reverse()) if (variants.includes(e)) return e;
  return null;
}

type Line = {
  type?: string;
  sessionID?: string;
  part?: { id?: string; messageID?: string; text?: string };
  error?: { type?: string };
};

/** Reads `opencode run --format json` lines into events. There is no closing
 *  event: a clean exit (code 0) is done. Text parts arrive whole; a later part
 *  starts a new paragraph, except OpenCode's catch-up of a part it streamed
 *  only in part (id `…_text-N`, same message), which continues it. */
export function createOpencodeParser() {
  let session = false;
  let wrote = false;
  let ended = false;
  const messages = new Set<string>();
  return {
    get ended() { return ended; },
    line(raw: string): HeadlessEvent[] {
      if (ended || !raw.trim()) return [];
      let m: Line;
      try { m = JSON.parse(raw) as Line; } catch { return []; }
      if (!m || typeof m !== 'object') return [];
      const out: HeadlessEvent[] = [];
      if (!session && typeof m.sessionID === 'string' && m.sessionID) {
        session = true;
        out.push({ type: 'session', sessionId: m.sessionID });
      }
      if (m.type === 'text' && typeof m.part?.text === 'string' && m.part.text) {
        const msg = m.part.messageID ?? '';
        const catchUp = /_text-\d+$/.test(m.part.id ?? '') && messages.has(msg);
        out.push({ type: 'text', delta: (wrote && !catchUp ? '\n\n' : '') + m.part.text });
        messages.add(msg);
        wrote = true;
      }
      if (m.type === 'error') {
        ended = true;
        out.push(API_ERRORS[m.error?.type ?? ''] ?? FAILED);
      }
      return out;
    },
    /** The run exited: done if it was clean, else a fixed error. */
    exit(code: number | null): HeadlessEvent[] {
      if (ended) return [];
      ended = true;
      return [code === 0 ? { type: 'done' } : EXITED];
    },
  };
}

class Stop extends Error {
  constructor(readonly event: HeadlessEvent | null) { super('stop'); }
}

function realDir(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return dir; }
}

/** Runs one turn. Ends after its terminal event (done or error), or quietly
 *  when `signal` aborts (the caller knows it stopped the turn). */
export async function* runOpencodeHeadless(
  o: HeadlessOpts,
  spawn: HeadlessSpawn = (c, a, s) => nodeSpawn(c, a, { ...s, stdio: ['pipe', 'pipe', 'ignore'] }),
  deps: OpencodeDeps = {},
): AsyncIterable<HeadlessEvent> {
  if (o.signal.aborted) return;
  if (o.model && !MODEL_RE.test(o.model)) { yield BAD_MODEL; return; }
  const doFetch = deps.fetch ?? fetch;
  const readyMs = deps.readyMs ?? 30_000;
  const pollMs = deps.pollMs ?? 150;
  const password = deps.password?.() ?? randomBytes(24).toString('base64url');
  const configDir = path.join(o.cwd, '.opencode-config');
  // Empty on purpose: it stands in for ~/.config/opencode. Only inside an existing cwd.
  try { fs.mkdirSync(configDir, { mode: 0o700 }); } catch { /* exists, or no cwd: OpenCode copes with a missing dir */ }
  const env = opencodeEnv(o, configDir, password);
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'x-opencode-directory': encodeURIComponent(realDir(o.cwd)) };

  const children: ChildProcess[] = [];
  const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
  const exits = new Map<ChildProcess, Promise<void>>();
  const track = (c: ChildProcess) => { children.push(c); exits.set(c, new Promise<void>((r) => c.once('close', () => r()))); };
  const terminated = new Set<ChildProcess>();
  const kill = (c: ChildProcess) => {
    if (!alive(c) || terminated.has(c)) return;
    terminated.add(c);
    c.kill('SIGTERM');
    const hard = setTimeout(() => { if (alive(c)) c.kill('SIGKILL'); }, KILL_GRACE_MS);
    hard.unref?.();
  };

  // One queue for both phases; abort wakes whoever waits.
  const queue: (HeadlessEvent | 'eof')[] = [];
  let wake: (() => void) | null = null;
  const push = (e: HeadlessEvent | 'eof') => { queue.push(e); wake?.(); wake = null; };
  const onAbort = () => { for (const c of children) kill(c); push('eof'); };
  o.signal.addEventListener('abort', onAbort, { once: true });
  const aborted = () => o.signal.aborted;
  const sleep = (ms: number) => new Promise<void>((r) => {
    const done = () => { clearTimeout(t); o.signal.removeEventListener('abort', done); r(); };
    const t = setTimeout(done, ms);
    o.signal.addEventListener('abort', done, { once: true });
  });

  let finished = false;
  try {
    const bin = deps.bin ? await deps.bin() : await findOpencode(o.env.PATH);
    if (!bin) { yield TOO_OLD; finished = true; return; }
    // 1. The private server.
    const server = spawn(bin, SERVE_ARGV, { cwd: o.cwd, env: env.server });
    track(server);
    const url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      let done = false;
      const onStop = () => settle(() => reject(new Stop(null)));
      const settle = (f: () => void) => { if (!done) { done = true; clearTimeout(timer); o.signal.removeEventListener('abort', onStop); f(); } };
      const timer = setTimeout(() => settle(() => reject(new Stop(EXITED))), readyMs);
      timer.unref?.();
      o.signal.addEventListener('abort', onStop, { once: true });
      server.on('error', (err: NodeJS.ErrnoException) => settle(() => reject(new Stop(err.code === 'ENOENT' ? NOT_INSTALLED : EXITED))));
      server.once('close', () => settle(() => reject(new Stop(aborted() ? null : EXITED))));
      server.stdout?.setEncoding('utf8');
      // Keep draining stdout for the server's whole life.
      server.stdout?.on('data', (chunk: string) => {
        if (done) return;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const u = (JSON.parse(line) as { url?: unknown }).url;
            if (typeof u === 'string' && URL_RE.test(u)) { settle(() => resolve(u)); return; }
          } catch { /* not the url line */ }
        }
      });
      server.stdin?.on('error', () => undefined);
    });

    // 2. Wait for the strado MCP server (this request also starts it).
    const deadline = Date.now() + readyMs;
    const get = async (p: string): Promise<unknown> => {
      const res = await doFetch(url + p, { headers: auth, signal: AbortSignal.any([o.signal, AbortSignal.timeout(5_000)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { data?: unknown }).data;
    };
    for (;;) {
      if (aborted()) throw new Stop(null);
      if (!alive(server)) throw new Stop(EXITED);
      const servers = await get('/api/mcp').catch(() => null);
      const status = Array.isArray(servers) ? (servers.find((s) => s?.name === 'strado') as { status?: { status?: string } } | undefined)?.status?.status : undefined;
      if (status === 'connected') break;
      if (status && status !== 'pending') throw new Stop(NO_TOOLS);
      if (Date.now() > deadline) throw new Stop(NO_TOOLS);
      await sleep(pollMs);
    }

    // 3. Effort: the model's variant, when it has one.
    let model = o.model ?? null;
    if (o.effort && EFFORTS.includes(o.effort)) {
      type M = { id?: string; providerID?: string; variants?: { id?: string }[] };
      const id = (m: M) => `${m.providerID}/${m.id}`;
      const found = await (o.model
        ? get('/api/model').then((all) => (Array.isArray(all) ? (all as M[]).find((m) => id(m) === o.model) : undefined))
        : get('/api/model/default').then((m) => (m && typeof m === 'object' ? (m as M) : undefined))
      ).catch(() => undefined);
      const variant = found ? pickVariant(o.effort, (found.variants ?? []).map((v) => v.id ?? '')) : null;
      if (found && variant && MODEL_RE.test(id(found))) model = `${id(found)}#${variant}`;
    }
    if (aborted()) throw new Stop(null);

    // 4. The turn.
    const resume = o.resume && SESSION_RE.test(o.resume) ? o.resume : null;
    const child = spawn(bin, opencodeRunArgv({ url, resume, model }), { cwd: o.cwd, env: env.client });
    track(child);
    const parser = createOpencodeParser();
    let pending = '';
    let spawnError: HeadlessEvent | null = null;
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
    child.on('close', (code: number | null) => {
      for (const e of parser.line(pending)) push(e);
      pending = '';
      if (!aborted()) for (const e of spawnError && !parser.ended ? [spawnError] : parser.exit(code)) push(e);
      push('eof');
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(o.prompt);

    for (;;) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      const e = queue.shift()!;
      if (e === 'eof' || aborted()) return;
      if (e.type === 'done' || e.type === 'error') finished = true;
      yield e;
      if (finished) return;
    }
  } catch (err) {
    if (err instanceof Stop) { if (err.event && !aborted()) { finished = true; yield err.event; } return; }
    throw err;
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    // The run exits on its own once it finished (its session is saved); the
    // server goes when its stdin closes. Anything still running is stopped, and
    // the turn is over only once both are gone.
    const [server, run] = children;
    server?.stdin?.end();
    if (run && !finished) kill(run);
    const gone = () => Promise.all(children.filter((c) => c.pid !== undefined).map((c) => exits.get(c)));
    const timeout = () => new Promise((r) => setTimeout(r, EXIT_WAIT_MS).unref?.());
    if (run && run.pid !== undefined) await Promise.race([exits.get(run), timeout()]);
    if (server && server.pid !== undefined && alive(server)) {
      await Promise.race([exits.get(server), new Promise((r) => setTimeout(r, 1_000).unref?.())]);
      kill(server);
    }
    await Promise.race([gone(), timeout()]);
    for (const c of children) if (alive(c)) c.kill('SIGKILL');
  }
}
