import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { HeadlessEvent, HeadlessSpawn } from './claudeHeadless.js';
import {
  BAD_MODEL, NO_TOOLS, NOT_INSTALLED, NOT_LOGGED_IN, OPENCODE_AUTH_ENV, OPENCODE_MODELS, SERVE_ARGV,
  createOpencodeParser, opencodeConfig, opencodeEnv, opencodeRunArgv, pickVariant, runOpencodeHeadless, type OpencodeDeps,
} from './opencodeHeadless.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[], code: number | null = 0) => {
  const p = createOpencodeParser();
  return [...lines.flatMap((l) => p.line(l)), ...p.exit(code)];
};

const SID = 'ses_e7b7a96c6ffeBaBjNJkgXU8x1u';
const URL = 'http://127.0.0.1:41234';
const base = {
  agent: 'claude' as const, cwd: '/j/f1', resume: null, systemPrompt: 'You are Jarvis.', mcpConfigPath: '/j/f1/mcp.json',
  mcp: { command: 'node', args: ['/h/strado-mcp.mjs'], env: { STRADO_JARVIS_TOKEN: 'secret-tok' } },
  env: { PATH: '/bin', HOME: '/home/me', OPENCODE_CONFIG_CONTENT: '{"mcp":{}}', OPENCODE_API_KEY: 'zen' },
};

async function collect(it: AsyncIterable<HeadlessEvent>) {
  const out: HeadlessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

type Fake = ChildProcess & EventEmitter;
function bare(pid: number | undefined) {
  const child = new EventEmitter() as Fake;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let input = '';
  stdin.on('data', (c) => (input += String(c)));
  const signals: string[] = [];
  const exit = (code: number | null, sig: string | null = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    Object.assign(child, { exitCode: code, signalCode: sig });
    stdout.end();
    setImmediate(() => child.emit('close', code));
  };
  Object.assign(child, {
    stdout, stdin, pid, exitCode: null, signalCode: null,
    kill: (sig: string) => { signals.push(sig); exit(null, sig); return true; },
  });
  return { child, stdout, stdin, input: () => input, signals, exit };
}

/** `opencode serve --stdio`: prints its url, exits when stdin closes. */
function fakeServer(url = URL) {
  const f = bare(7);
  setImmediate(() => f.stdout.write(JSON.stringify({ url }) + '\n'));
  f.stdin.on('finish', () => f.exit(0));
  return f;
}

/** `opencode run`: once the prompt is in, prints `lines` and exits `code` (or holds until killed). */
function fakeRun(lines: string[], code = 0, hold = false) {
  const f = bare(8);
  if (!hold) f.stdin.on('finish', () => setImmediate(() => { for (const l of lines) f.stdout.write(l + '\n'); f.exit(code); }));
  return f;
}

/** The private server's API: MCP status per poll, models. */
function fakeApi(statuses: string[], models: Record<string, unknown> = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetch = (async (u: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: u, headers: init?.headers ?? {} });
    const p = u.slice(URL.length);
    const data = p === '/api/mcp'
      ? [{ name: 'figma', status: { status: 'connected' } }, { name: 'strado', status: { status: statuses[Math.min(i++, statuses.length - 1)] } }]
      : models[p];
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

function harness(run: ReturnType<typeof bare>, opts: { statuses?: string[]; models?: Record<string, unknown> } = {}) {
  const server = fakeServer();
  const api = fakeApi(opts.statuses ?? ['connected'], opts.models);
  const calls: { cmd: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const spawn: HeadlessSpawn = (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return args[0] === 'serve' ? server.child : run.child;
  };
  const deps: OpencodeDeps = { fetch: api.fetch, pollMs: 1, readyMs: 2_000, password: () => 'pw-1' };
  return { server, api, calls, spawn, deps };
}

describe('opencode run --format json parsing (recorded from OpenCode 2.0.32)', () => {
  it('a turn with a jarvis tool call: the session, the reply text, then done on a clean exit', () => {
    expect(parseAll(fixture('opencode-stream.jsonl'))).toEqual([
      { type: 'session', sessionId: SID },
      { type: 'text', delta: 'Strado responded with "pong" and confirmed the token successfully reached the server.' },
      { type: 'done' },
    ]);
  });

  it('a provider error: a fixed error with the fix, and OpenCode\'s own words never become a reply', () => {
    // As OpenCode 2.0.32 printed it for a bad Anthropic key.
    const line = JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_x', error: { type: 'provider.auth', message: 'invalid x-api-key sk-leak', status: 401 } });
    const events = parseAll([line], 1);
    expect(events).toEqual([{ type: 'session', sessionId: 'ses_x' }, NOT_LOGGED_IN]);
    expect(JSON.stringify(events)).not.toContain('sk-leak');
    const other = JSON.stringify({ type: 'error', sessionID: 'ses_x', error: { type: 'provider.invalid-request', message: 'boom' } });
    expect(parseAll([other], 1)[1]).toEqual({ type: 'error', message: 'OpenCode stopped with an error' });
  });

  it('a later part starts a new paragraph, a catch-up of the same message continues it; junk is skipped', () => {
    const text = (id: string, messageID: string, t: string) => JSON.stringify({ type: 'text', sessionID: 's', part: { id, messageID, type: 'text', text: t } });
    expect(parseAll([text('prt_a', 'msg_1', 'One.'), 'not json', 'null', text('prt_1_text-0', 'msg_1', ' more'), text('prt_b', 'msg_2', 'Two.')])).toEqual([
      { type: 'session', sessionId: 's' },
      { type: 'text', delta: 'One.' },
      { type: 'text', delta: ' more' },
      { type: 'text', delta: '\n\nTwo.' },
      { type: 'done' },
    ]);
  });

  it('an exit that is not clean, with no error line, is a fixed error', () => {
    expect(parseAll(['Error: token=abc123 leaked'], 1)).toEqual([{ type: 'error', message: 'OpenCode exited unexpectedly' }]);
  });
});

describe('opencode config and argv', () => {
  it('only the strado server, as direct tools; everything denied but strado_jarvis_*; the system prompt as the agent\'s', () => {
    const c = opencodeConfig(base);
    expect(c.mcp.servers).toEqual({ strado: { type: 'local', command: ['node', '/h/strado-mcp.mjs'], environment: { STRADO_JARVIS_TOKEN: 'secret-tok' }, codemode: false } });
    const rules = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'strado_jarvis_*', resource: '*', effect: 'allow' }];
    expect(c.permissions).toEqual(rules);
    expect(c.agents.jarvis).toEqual({ mode: 'primary', system: 'You are Jarvis.', permissions: rules });
    expect(c.default_agent).toBe('jarvis');
  });

  it('env: the config (and so the token) only on the server; the person\'s OpenCode settings dropped, their Zen key kept', () => {
    const { server, client } = opencodeEnv(base, '/j/f1/.opencode-config', 'pw-1');
    expect(JSON.parse(server.OPENCODE_CONFIG_CONTENT!).mcp.servers.strado.environment.STRADO_JARVIS_TOKEN).toBe('secret-tok');
    expect(server.OPENCODE_CONFIG_DIR).toBe('/j/f1/.opencode-config');
    expect(server.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(server.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    expect(server.PWD).toBe('/j/f1');
    expect(client.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(JSON.stringify(client)).not.toContain('secret-tok');
    expect(client.OPENCODE_SERVER_PASSWORD).toBe('pw-1');
    expect(client.OPENCODE_API_KEY).toBe('zen');
    expect(client.HOME).toBe('/home/me');
  });

  it('run argv: resume when known, a title when new, the model when set', () => {
    const argv = opencodeRunArgv({ url: URL, resume: 'ses_1', model: 'openrouter/anthropic/claude-haiku-4.5#high' });
    expect(argv.slice(0, 7)).toEqual(['run', '--server', URL, '--format', 'json', '--agent', 'jarvis']);
    expect(argv[argv.indexOf('--session') + 1]).toBe('ses_1');
    expect(argv[argv.indexOf('--model') + 1]).toBe('openrouter/anthropic/claude-haiku-4.5#high');
    expect(argv).not.toContain('--title');
    const fresh = opencodeRunArgv({ url: URL, resume: null, model: null });
    expect(fresh).not.toContain('--session');
    expect(fresh).not.toContain('--model');
    expect(fresh[fresh.indexOf('--title') + 1]).toBe('Jarvis');
    expect(SERVE_ARGV).toEqual(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0']);
  });

  it('effort: the model\'s own variant, else the nearest lower one, else none', () => {
    expect(pickVariant('high', ['none', 'low', 'medium', 'high', 'xhigh'])).toBe('high');
    expect(pickVariant('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    expect(pickVariant('medium', ['none', 'thinking'])).toBeNull();
    expect(pickVariant(null, ['high'])).toBeNull();
  });

  it('auth env: provider logins pass, Strado\'s own secrets do not', () => {
    for (const n of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'GEMINI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK']) expect(OPENCODE_AUTH_ENV.test(n)).toBe(true);
    for (const n of ['STRADO_JARVIS_TOKEN', 'GITHUB_TOKEN', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'ANTHROPIC_API_KEY_X']) expect(OPENCODE_AUTH_ENV.test(n)).toBe(false);
  });

  it('models: a short list, OpenCode\'s default first, the rest provider/model ids', () => {
    expect(OPENCODE_MODELS.length).toBeGreaterThanOrEqual(6);
    expect(OPENCODE_MODELS.length).toBeLessThanOrEqual(10);
    expect(OPENCODE_MODELS[0]).toEqual({ id: null, label: 'OpenCode default' });
    for (const m of OPENCODE_MODELS.slice(1)) expect(m.id).toMatch(/^[a-z-]+\/[A-Za-z0-9._\/-]+$/);
  });
});

describe('runOpencodeHeadless', () => {
  it('starts a private server, waits for the jarvis tools, then streams the recorded turn with the prompt on stdin', async () => {
    const run = fakeRun(fixture('opencode-stream.jsonl'));
    const h = harness(run, { statuses: ['pending', 'pending', 'connected'] });
    const events = await collect(runOpencodeHeadless({ ...base, prompt: 'ping strado', signal: new AbortController().signal }, h.spawn, h.deps));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(h.calls.map((c) => [c.cmd, c.args[0]])).toEqual([['opencode', 'serve'], ['opencode', 'run']]);
    expect(h.calls[1]!.args.slice(0, 3)).toEqual(['run', '--server', URL]);
    expect(h.calls.every((c) => c.cwd === '/j/f1')).toBe(true);
    // Polled until strado was connected, as the turn's directory, with the password.
    expect(h.api.seen.filter((s) => s.url === URL + '/api/mcp')).toHaveLength(3);
    expect(h.api.seen[0]!.headers['x-opencode-directory']).toBe(encodeURIComponent('/j/f1'));
    expect(h.api.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('opencode:pw-1').toString('base64')}`);
    // Never in argv: the prompt, the token, the password.
    const argv = h.calls.flatMap((c) => c.args).join(' ');
    for (const s of ['ping strado', 'secret-tok', 'pw-1']) expect(argv).not.toContain(s);
    expect(run.input()).toBe('ping strado');
    expect(h.server.child.exitCode).toBe(0); // its stdin was closed
  });

  it('effort: asks the server for the model\'s variants and passes model#variant', async () => {
    const run = fakeRun(fixture('opencode-stream.jsonl'));
    const h = harness(run, { models: { '/api/model': [
      { providerID: 'openrouter', id: 'openai/gpt-5.4-mini', variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] },
    ] } });
    await collect(runOpencodeHeadless({ ...base, prompt: 'x', model: 'openrouter/openai/gpt-5.4-mini', effort: 'max', signal: new AbortController().signal }, h.spawn, h.deps));
    const argv = h.calls[1]!.args;
    expect(argv[argv.indexOf('--model') + 1]).toBe('openrouter/openai/gpt-5.4-mini#xhigh');
  });

  it('effort at OpenCode\'s default model: pins the default with its variant', async () => {
    const run = fakeRun(fixture('opencode-stream.jsonl'));
    const h = harness(run, { models: { '/api/model/default': { providerID: 'anthropic', id: 'claude-sonnet-5-5', variants: [{ id: 'low' }, { id: 'high' }] } } });
    await collect(runOpencodeHeadless({ ...base, prompt: 'x', effort: 'medium', signal: new AbortController().signal }, h.spawn, h.deps));
    const argv = h.calls[1]!.args;
    expect(argv[argv.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-5-5#low');
  });

  it('the strado MCP server fails to start: a fixed error, no turn, the server stopped', async () => {
    const run = fakeRun([]);
    const h = harness(run, { statuses: ['pending', 'failed'] });
    expect(await collect(runOpencodeHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, h.spawn, h.deps))).toEqual([NO_TOOLS]);
    expect(h.calls.map((c) => c.args[0])).toEqual(['serve']);
    expect(h.server.child.exitCode).toBe(0);
  });

  it('a model name that could be a flag never reaches argv', async () => {
    const run = fakeRun([]);
    const h = harness(run);
    expect(await collect(runOpencodeHeadless({ ...base, prompt: 'x', model: '--help', signal: new AbortController().signal }, h.spawn, h.deps))).toEqual([BAD_MODEL]);
    expect(h.calls).toEqual([]);
  });

  it('opencode missing: OpenCode is not installed, with the fix', async () => {
    const spawn: HeadlessSpawn = () => {
      const f = bare(undefined);
      setImmediate(() => f.child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })));
      return f.child;
    };
    expect(await collect(runOpencodeHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, spawn, { fetch: fakeApi(['connected']).fetch }))).toEqual([NOT_INSTALLED]);
  });

  it('the run exits without finishing: a fixed error, not its output', async () => {
    const run = fakeRun([JSON.stringify({ type: 'step_start', sessionID: 's' }), 'Error: token=abc123 leaked'], 1);
    const h = harness(run);
    expect(await collect(runOpencodeHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, h.spawn, h.deps))).toEqual([
      { type: 'session', sessionId: 's' }, { type: 'error', message: 'OpenCode exited unexpectedly' },
    ]);
  });

  it('abort kills the run and the server and ends quietly', async () => {
    const run = fakeRun([], 0, true);
    const h = harness(run);
    const ac = new AbortController();
    const going = collect(runOpencodeHeadless({ ...base, prompt: 'x', signal: ac.signal }, h.spawn, h.deps));
    while (h.calls.length < 2) await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await going).toEqual([]);
    expect(run.signals).toContain('SIGTERM');
    expect(h.server.child.exitCode !== null || h.server.child.signalCode !== null).toBe(true);
  });

  it('abort while waiting for the tools: no turn starts', async () => {
    const run = fakeRun([]);
    const h = harness(run, { statuses: ['pending'] });
    const ac = new AbortController();
    const going = collect(runOpencodeHeadless({ ...base, prompt: 'x', signal: ac.signal }, h.spawn, h.deps));
    while (h.api.seen.length < 2) await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await going).toEqual([]);
    expect(h.calls.map((c) => c.args[0])).toEqual(['serve']);
  });
});

describe('findOpencode', () => {
  it('takes the first opencode on PATH that is 2 or newer, past an old 1.x; null when only old ones; "opencode" when none', async () => {
    const { findOpencode } = await import('./opencodeHeadless.js');
    const os = await import('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bin-'));
    const make = (dir: string, version: string) => {
      fs.mkdirSync(path.join(root, dir));
      const f = path.join(root, dir, 'opencode');
      fs.writeFileSync(f, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return path.join(root, dir);
    };
    try {
      const old = make('old', '1.19.4');
      const cur = make('cur', '2.0.32');
      expect(await findOpencode(`${old}:${cur}`)).toBe(path.join(cur, 'opencode'));
      expect(await findOpencode(old)).toBeNull();
      expect(await findOpencode(path.join(root, 'none'))).toBe('opencode');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
