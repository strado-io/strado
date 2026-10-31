import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessEvent, HeadlessOpts, HeadlessSpawn } from './claudeHeadless.js';
import { createPiStreamParser, PI_AUTH_ENV, PI_MODELS, piArgv, piMcpConfig, piMcpConfigPath, runPiHeadless } from './piHeadless.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[]) => {
  const p = createPiStreamParser();
  return [...lines.flatMap((l) => p.line(l)), ...p.close()];
};

/** A child that, once its stdin ends, prints `lines` (and `err` on stderr) and exits `code`, recording stdin. */
function fakeChild(lines: string[], code = 0, opts: { hold?: boolean; err?: string } = {}) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let input = '';
  stdin.on('data', (c) => (input += String(c)));
  let killed = false;
  Object.assign(child, {
    stdout, stderr, stdin, pid: 42, exitCode: null, signalCode: null,
    kill: () => { killed = true; (child as any).signalCode = 'SIGTERM'; stdout.end(); setImmediate(() => child.emit('close', null)); return true; },
  });
  // Starts once the prompt is in (the run writes its config file before spawning).
  if (!opts.hold) {
    stdin.on('finish', () => {
      for (const l of lines) stdout.write(l + '\n');
      if (opts.err) stderr.write(opts.err);
      stdout.end();
      stderr.end();
      (child as any).exitCode = code;
      setImmediate(() => child.emit('close', code));
    });
  }
  return { child, input: () => input, killed: () => killed };
}

let dir: string;
let home: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-headless-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const TOKEN = 'abc123token';
const opts = (extra: Partial<HeadlessOpts> = {}): HeadlessOpts => ({
  agent: 'pi' as unknown as HeadlessOpts['agent'],
  cwd: dir, prompt: 'x', resume: null, systemPrompt: 'You are Jarvis.', mcpConfigPath: '',
  mcp: { command: 'node', args: ['/h/strado-mcp.mjs'], env: { STRADO_STATUS_PORT: '7777', STRADO_JARVIS_TOKEN: TOKEN } },
  env: { PATH: '/bin', HOME: home }, signal: new AbortController().signal,
  ...extra,
});

async function collect(it: AsyncIterable<HeadlessEvent>) {
  const out: HeadlessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const assistantEnd = (stopReason: string, errorMessage?: string) =>
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) } });
const delta = (d: string) => JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: d } });
const textStart = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
const settled = JSON.stringify({ type: 'agent_settled', aborted: false });

describe('pi --mode json parsing (recorded from Pi 1.4.0)', () => {
  it('a turn with a jarvis tool call: the session, the streamed reply, then done', () => {
    const events = parseAll(fixture('pi-stream.jsonl'));
    expect(events[0]).toEqual({ type: 'session', sessionId: '01a1847a-b953-73e8-9fe6-7750d128bfac' });
    expect(events.at(-1)).toEqual({ type: 'done' });
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('You have two open tabs: **claude-1** (demo) and **shell-1** (demo).');
    // Thinking and tool-call deltas never become reply text.
    expect(events.every((e) => e.type !== 'error')).toBe(true);
  });

  it('a later text block starts a new paragraph; junk lines are skipped', () => {
    expect(parseAll([textStart, delta('One.'), 'not json', textStart, delta('Two.'), assistantEnd('stop'), settled])).toEqual([
      { type: 'text', delta: 'One.' },
      { type: 'text', delta: '\n\nTwo.' },
      { type: 'done' },
    ]);
  });

  it('a provider error is a fixed string, never Pi\'s own words', () => {
    const run = (msg: string) => parseAll([assistantEnd('error', msg), settled]);
    expect(run('401: {"error":"invalid key sk-or-secret"}')).toEqual([{ type: 'error', message: 'Pi is not logged in', fix: 'Run pi and log in to a provider' }]);
    expect(run('402: Insufficient credits')).toEqual([{ type: 'error', message: 'Pi\'s provider has no credit left', fix: 'Check your provider account, or pick another agent' }]);
    expect(run('429: slow down')).toEqual([{ type: 'error', message: 'Pi hit its provider\'s rate limit', fix: 'Try again later, or pick another agent' }]);
    expect(run('400: {"message":"nonexistent/foo is not a valid model ID"}')).toEqual([{ type: 'error', message: 'Pi could not use that model', fix: 'Pick another model' }]);
    expect(run('500: token=abc123 leaked')).toEqual([{ type: 'error', message: 'Pi stopped with an error' }]);
  });

  it('a failed attempt that a retry fixes ends done', () => {
    expect(parseAll([assistantEnd('error', '529 overloaded'), JSON.stringify({ type: 'agent_end', willRetry: true }), textStart, delta('ok'), assistantEnd('stop'), settled])).toEqual([
      { type: 'text', delta: 'ok' },
      { type: 'done' },
    ]);
  });

  it('exit after agent_end without agent_settled still finishes', () => {
    expect(parseAll([textStart, delta('hi'), assistantEnd('stop'), JSON.stringify({ type: 'agent_end', willRetry: false })])).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'done' },
    ]);
  });
});

describe('piArgv', () => {
  it('json print mode, only the jarvis tools, no extensions but MCP, no context files, trusted dir, own session dir; the prompt is not in it', () => {
    const argv = piArgv({ ...opts(), resume: '01a1847a-b953-73e8-9fe6-7750d128bfac' });
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
    expect(after('--tools')).toBe('mcp__strado__jarvis_*');
    expect(argv).toContain('-ne');
    expect(after('-e')).toBe('builtin:mcp');
    expect(argv).toEqual(expect.arrayContaining(['-nc', '-ns', '-np', '--approve', '--offline']));
    expect(after('--session-dir')).toBe(path.join(dir, 'pi-sessions'));
    expect(after('--session-id')).toBe('01a1847a-b953-73e8-9fe6-7750d128bfac');
    expect(after('--system-prompt')).toBe('You are Jarvis.');
    expect(argv).not.toContain('x');
    expect(argv.join(' ')).not.toContain(TOKEN);
    expect(piArgv(opts())).not.toContain('--session-id');
  });

  it('the Focus\'s model and effort when set; none at the default; nothing flag-shaped passes', () => {
    const argv = piArgv(opts({ model: 'openrouter/anthropic/claude-sonnet-5.5', effort: 'xhigh' }));
    expect(argv[argv.indexOf('--model') + 1]).toBe('openrouter/anthropic/claude-sonnet-5.5');
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('xhigh');
    const plain = piArgv(opts({ model: null, effort: null }));
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--thinking');
    const odd = piArgv(opts({ model: '--api-key', effort: 'turbo', resume: '--fork' }));
    expect(odd).not.toContain('--model');
    expect(odd).not.toContain('--thinking');
    expect(odd).not.toContain('--session-id');
  });
});

describe('piMcpConfig', () => {
  it('strado direct with the turn env; the person\'s other servers off; expandable values by reference', () => {
    const { config, passEnv } = piMcpConfig({ command: 'node', args: ['/h/m.mjs'], env: { A: 'plain', B: '${HOME}', C: '!rm -rf' } }, ['strado', 'figma', 'bad name']);
    expect(config.mcpServers.strado).toEqual({ command: 'node', args: ['/h/m.mjs'], env: { A: 'plain', B: '${B}', C: '${C}' }, exposure: 'direct', timeout: 120 });
    expect(config.mcpServers.figma).toEqual({ enabled: false });
    expect(config.mcpServers).not.toHaveProperty('bad name');
    expect(config.autoEnableCodemode).toBe(false);
    expect(passEnv).toEqual({ B: '${HOME}', C: '!rm -rf' });
  });
});

describe('runPiHeadless', () => {
  it('streams the recorded turn, sends the prompt on stdin, hands the token over in a 0600 file it then removes', async () => {
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { strado: { command: 'x' }, other: { command: 'y' } } }));
    const fake = fakeChild(fixture('pi-stream.jsonl'));
    let seen: { cmd: string; args: string[]; cwd: string; env: Record<string, string>; file: string; mode: number } | null = null;
    const spawn: HeadlessSpawn = (cmd, args, o) => {
      const f = piMcpConfigPath(o.cwd);
      seen = { cmd, args, cwd: o.cwd, env: o.env, file: fs.readFileSync(f, 'utf8'), mode: fs.statSync(f).mode & 0o777 };
      return fake.child;
    };
    const events = await collect(runPiHeadless(opts({ prompt: 'list my tabs' }), spawn));
    expect(events[0]!.type).toBe('session');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(seen!.cmd).toBe('pi');
    expect(seen!.cwd).toBe(dir);
    expect(seen!.args).not.toContain('list my tabs');
    expect(seen!.args.join(' ')).not.toContain(TOKEN);
    expect(seen!.env).toEqual({ PATH: '/bin', HOME: home });
    expect(seen!.mode).toBe(0o600);
    const cfg = JSON.parse(seen!.file);
    expect(cfg.mcpServers.strado.env.STRADO_JARVIS_TOKEN).toBe(TOKEN);
    expect(cfg.mcpServers.other).toEqual({ enabled: false });
    expect(fake.input()).toBe('list my tabs');
    expect(fs.existsSync(piMcpConfigPath(dir))).toBe(false);
  });

  it('pi missing: Pi is not installed, with the fix', async () => {
    const spawn: HeadlessSpawn = () => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      Object.assign(child, { stdout: new PassThrough(), stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    expect(await collect(runPiHeadless(opts(), spawn))).toEqual([
      { type: 'error', message: 'Pi is not installed', fix: 'Install Pi, or pick another agent' },
    ]);
    expect(fs.existsSync(piMcpConfigPath(dir))).toBe(false);
  });

  it('no login: Pi prints the session header then exits 1 with a note on stderr (recorded) — a fixed error', async () => {
    const header = '{"type":"session","version":3,"id":"01a18477-d28a-736b-ac41-446163dcaeeb","timestamp":"2026-10-28T21:43:27.626Z","cwd":"/home/me/.strado/jarvis/f1"}';
    const fake = fakeChild([header], 1, { err: 'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.\n' });
    expect(await collect(runPiHeadless(opts(), () => fake.child))).toEqual([
      { type: 'session', sessionId: '01a18477-d28a-736b-ac41-446163dcaeeb' },
      { type: 'error', message: 'Pi is not logged in', fix: 'Run pi and log in to a provider' },
    ]);
  });

  it('exits without finishing: a fixed error, not its output', async () => {
    const fake = fakeChild(['{"type":"session","id":"s"}', 'Error: token=abc123 leaked'], 1, { err: 'boom token=abc123' });
    expect(await collect(runPiHeadless(opts(), () => fake.child))).toEqual([
      { type: 'session', sessionId: 's' },
      { type: 'error', message: 'Pi exited unexpectedly' },
    ]);
  });

  it('a process that ignores SIGTERM gets SIGKILL, and the turn ends only once it is gone', async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const signals: string[] = [];
    Object.assign(child, {
      stdout: new PassThrough(), stdin: new PassThrough(), pid: 7, exitCode: null, signalCode: null,
      kill: (sig: string) => { signals.push(sig); if (sig === 'SIGKILL') { (child as any).signalCode = 'SIGKILL'; setTimeout(() => child.emit('close', null), 0); } return true; },
    });
    const ac = new AbortController();
    let spawned!: () => void;
    const started = new Promise<void>((r) => { spawned = r; });
    let ended = false;
    const run = collect(runPiHeadless(opts({ signal: ac.signal }), () => { spawned(); return child; })).then((e) => { ended = true; return e; });
    await started; // the config file is written with real I/O before the spawn
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(signals).toEqual(['SIGTERM']);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
    expect(await run).toEqual([]);
    expect(fs.existsSync(piMcpConfigPath(dir))).toBe(false);
  });

  it('abort kills the process and ends quietly', async () => {
    const fake = fakeChild([], 0, { hold: true });
    const ac = new AbortController();
    const run = collect(runPiHeadless(opts({ signal: ac.signal }), () => { setImmediate(() => ac.abort()); return fake.child; }));
    expect(await run).toEqual([]);
    expect(fake.killed()).toBe(true);
  });

  it('aborted before it starts: no process, no file', async () => {
    const ac = new AbortController();
    ac.abort();
    const spawn = vi.fn();
    expect(await collect(runPiHeadless(opts({ signal: ac.signal }), spawn as unknown as HeadlessSpawn))).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(piMcpConfigPath(dir))).toBe(false);
  });
});

describe('PI_AUTH_ENV and PI_MODELS', () => {
  it('matches the provider keys Pi reads, and nothing else', () => {
    for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AWS_PROFILE', 'PI_CODING_AGENT_DIR', 'CLOUDFLARE_ACCOUNT_ID'])
      expect(PI_AUTH_ENV.test(k)).toBe(true);
    for (const k of ['STRADO_JARVIS_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY_X', 'MY_OPENAI_API_KEY', 'PATH'])
      expect(PI_AUTH_ENV.test(k)).toBe(false);
  });

  it('a default first, then provider/id models, no duplicates', () => {
    expect(PI_MODELS[0]).toEqual({ id: null, label: 'Pi default' });
    const ids = PI_MODELS.slice(1).map((m) => m.id);
    expect(ids.every((id) => typeof id === 'string' && /^[a-z0-9-]+\/.+/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PI_MODELS.length).toBeGreaterThanOrEqual(6);
    expect(PI_MODELS.length).toBeLessThanOrEqual(10);
  });
});
