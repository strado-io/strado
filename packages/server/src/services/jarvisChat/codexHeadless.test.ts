import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { HeadlessEvent, HeadlessOpts, HeadlessSpawn } from './claudeHeadless.js';
import { CODEX_AUTH_ENV, CODEX_MODELS, codexArgv, createCodexParser, runCodexHeadless } from './codexHeadless.js';
import { JARVIS_TOOLS } from './types.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[]) => {
  const p = createCodexParser();
  return lines.flatMap((l) => p.line(l));
};

/** A child that prints `lines` and exits `code`, recording what came on stdin. */
function fakeChild(lines: string[], code = 0, opts: { hold?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let input = '';
  stdin.on('data', (c) => (input += String(c)));
  let killed = false;
  Object.assign(child, {
    stdout, stdin, pid: 42, exitCode: null, signalCode: null,
    kill: () => { killed = true; (child as any).signalCode = 'SIGTERM'; stdout.end(); setImmediate(() => child.emit('close', null)); return true; },
  });
  if (!opts.hold) {
    setImmediate(() => {
      for (const l of lines) stdout.write(l + '\n');
      stdout.end();
      (child as any).exitCode = code;
      setImmediate(() => child.emit('close', code));
    });
  }
  return { child, input: () => input, killed: () => killed };
}

const TOKEN = 'tok-very-secret';
const base = {
  agent: 'codex' as unknown as HeadlessOpts['agent'],
  mcp: { command: 'node', args: ['/h/strado-mcp.mjs'], env: { STRADO_STATUS_PORT: '7777', STRADO_JARVIS_TOKEN: TOKEN } },
  cwd: '/j/f1', resume: null, systemPrompt: 'You are Jarvis.\nBe "brief".', mcpConfigPath: '/j/f1/mcp.json', env: { PATH: '/bin' },
};

async function collect(it: AsyncIterable<HeadlessEvent>) {
  const out: HeadlessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const NO_AUTH = [
  '{"type":"thread.started","thread_id":"01a18479-4b02-76d2-b862-24e9a4b77347"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized"}}',
  '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}',
];

describe('codex exec --json parsing (recorded from codex-cli 0.164.0)', () => {
  it('a turn with an MCP tool call: the thread, each agent message, then done', () => {
    expect(parseAll(fixture('codex-stream.jsonl'))).toEqual([
      { type: 'session', sessionId: '01a18478-db8d-7013-94e9-39628e6edbe1' },
      { type: 'text', delta: 'I’ll locate the `jarvis_ping` tool and check the registered tool list, then call `jarvis_ping` once.' },
      { type: 'text', delta: '\n\n`jarvis_ping` returned `pong (token present)`. There is no tool named `other_tool` in `ALL_TOOLS`.' },
      { type: 'done' },
    ]);
  });

  it('not logged in (recorded): a fixed error with the fix; Codex\'s words never reach the chat', () => {
    const events = parseAll(NO_AUTH);
    expect(events).toEqual([
      { type: 'session', sessionId: '01a18479-4b02-76d2-b862-24e9a4b77347' },
      { type: 'error', message: 'Codex is not logged in', fix: 'Run codex login' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Unauthorized');
  });

  it('usage limit and other failures map to fixed errors; warnings and junk are skipped', () => {
    const failed = (message: string) => JSON.stringify({ type: 'turn.failed', error: { message } });
    expect(parseAll([failed("You've hit your usage limit. Try again in 3 hours.")])).toEqual([
      { type: 'error', message: 'Codex hit its usage limit', fix: 'Try again later, or pick another agent' },
    ]);
    expect(parseAll([
      'not json',
      '{"type":"item.completed","item":{"type":"error","message":"model switch warning"}}',
      '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"strado","tool":"jarvis_recap"}}',
      failed('stream disconnected: token=abc123'),
    ])).toEqual([{ type: 'error', message: 'Codex stopped with an error' }]);
  });

  it('one terminal event at most', () => {
    expect(parseAll(['{"type":"turn.completed"}', '{"type":"turn.failed","error":{"message":"x"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"late"}}'])).toEqual([{ type: 'done' }]);
  });
});

describe('runCodexHeadless', () => {
  const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
  const configs = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []));

  it('argv: exec --json, no user config, read-only, never asks, built-ins off, the prompt on stdin', () => {
    const argv = codexArgv(base);
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argv).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']));
    expect(configs(argv)).toEqual(expect.arrayContaining([
      'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"', 'project_doc_max_bytes=0',
      'skills.include_instructions=false', 'skills.bundled.enabled=false',
    ]));
    const disabled = argv.flatMap((a, i) => (argv[i - 1] === '--disable' ? [a] : []));
    expect(disabled).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'plugins', 'apps', 'hooks', 'computer_use', 'browser_use']));
    expect(argv.at(-1)).toBe('-');
    expect(argv).not.toContain('resume');
  });

  it('argv: the system prompt as developer_instructions, TOML-quoted', () => {
    expect(configs(codexArgv(base))).toContain('developer_instructions="You are Jarvis.\\nBe \\"brief\\"."');
  });

  it('argv: the strado server with only the jarvis tools; env by name, never its values', () => {
    const argv = codexArgv(base);
    const c = configs(argv);
    expect(c).toContain('mcp_servers.strado.command="node"');
    expect(c).toContain('mcp_servers.strado.args=["/h/strado-mcp.mjs"]');
    expect(c).toContain('mcp_servers.strado.env_vars=["STRADO_STATUS_PORT","STRADO_JARVIS_TOKEN"]');
    expect(c).toContain('mcp_servers.strado.default_tools_approval_mode="approve"');
    expect(c).toContain('mcp_servers.strado.required=true');
    const tools = JSON.parse(c.find((x) => x.startsWith('mcp_servers.strado.enabled_tools='))!.split('=')[1]!) as string[];
    expect(tools).toEqual(Object.keys(JARVIS_TOOLS));
    expect(tools.every((t) => t.startsWith('jarvis_'))).toBe(true);
    expect(argv.join(' ')).not.toContain(TOKEN);
    expect(argv.join(' ')).not.toContain('7777');
  });

  it('argv: resume is `exec resume … <id> -`', () => {
    const argv = codexArgv({ ...base, resume: 'th-1' });
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(argv.slice(-2)).toEqual(['th-1', '-']);
  });

  it('argv: the Focus\'s model and effort when set; none of either at the default', () => {
    const argv = codexArgv({ ...base, model: 'gpt-5.6-terra', effort: 'xhigh' });
    expect(after(argv, '-m')).toBe('gpt-5.6-terra');
    expect(configs(argv)).toContain('model_reasoning_effort="xhigh"');
    for (const e of ['low', 'medium', 'high', 'max']) expect(configs(codexArgv({ ...base, effort: e }))).toContain(`model_reasoning_effort="${e}"`);
    const plain = codexArgv({ ...base, model: null, effort: null });
    expect(plain).not.toContain('-m');
    expect(configs(plain).some((c) => c.startsWith('model_reasoning_effort'))).toBe(false);
    expect(configs(codexArgv({ ...base, effort: 'bogus' })).some((c) => c.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('auth env and models', () => {
    for (const n of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) expect(CODEX_AUTH_ENV.test(n)).toBe(true);
    for (const n of ['STRADO_JARVIS_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY_X', 'GITHUB_TOKEN']) expect(CODEX_AUTH_ENV.test(n)).toBe(false);
    expect(CODEX_MODELS[0]).toEqual({ id: null, label: 'Codex default' });
    expect(CODEX_MODELS.slice(1).map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  });

  it('streams the recorded turn, sends the prompt on stdin and the token in the env', async () => {
    const fake = fakeChild(fixture('codex-stream.jsonl'));
    let seen: { cmd: string; args: string[]; cwd: string; env: Record<string, string> } | null = null;
    const spawn: HeadlessSpawn = (cmd, args, o) => { seen = { cmd, args, cwd: o.cwd, env: o.env }; return fake.child; };
    const events = await collect(runCodexHeadless({ ...base, prompt: 'open a shell', signal: new AbortController().signal }, spawn));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'text', 'done']);
    expect(seen!.cmd).toBe('codex');
    expect(seen!.cwd).toBe('/j/f1');
    expect(seen!.args).not.toContain('open a shell');
    expect(seen!.env).toEqual({ PATH: '/bin', STRADO_STATUS_PORT: '7777', STRADO_JARVIS_TOKEN: TOKEN });
    expect(fake.input()).toBe('open a shell');
  });

  it('codex missing: Codex is not installed, with the fix', async () => {
    const spawn: HeadlessSpawn = () => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      Object.assign(child, { stdout: new PassThrough(), stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    expect(await collect(runCodexHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, spawn))).toEqual([
      { type: 'error', message: 'Codex is not installed', fix: 'Install Codex, or pick another agent' },
    ]);
  });

  it('exits without a result: a fixed error, not its output', async () => {
    const fake = fakeChild(['{"type":"thread.started","thread_id":"t"}', 'Error: token=abc123 leaked'], 1);
    const events = await collect(runCodexHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, () => fake.child));
    expect(events).toEqual([{ type: 'session', sessionId: 't' }, { type: 'error', message: 'Codex exited unexpectedly' }]);
  });

  it('exits after retrying a 401 with no turn.failed: not logged in', async () => {
    const fake = fakeChild(NO_AUTH.slice(0, 3), 1);
    const events = await collect(runCodexHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, () => fake.child));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Codex is not logged in', fix: 'Run codex login' });
  });

  it('a process that ignores SIGTERM gets SIGKILL, and the turn ends only once it is gone', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const signals: string[] = [];
      Object.assign(child, {
        stdout: new PassThrough(), stdin: new PassThrough(), pid: 7, exitCode: null, signalCode: null,
        kill: (sig: string) => { signals.push(sig); if (sig === 'SIGKILL') { (child as any).signalCode = 'SIGKILL'; setTimeout(() => child.emit('close', null), 0); } return true; },
      });
      const ac = new AbortController();
      let ended = false;
      const run = collect(runCodexHeadless({ ...base, prompt: 'x', signal: ac.signal }, () => child)).then((e) => { ended = true; return e; });
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(signals).toEqual(['SIGTERM']);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      await vi.advanceTimersByTimeAsync(10);
      expect(await run).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort kills the process and ends quietly', async () => {
    const fake = fakeChild([], 0, { hold: true });
    const ac = new AbortController();
    const run = collect(runCodexHeadless({ ...base, prompt: 'x', signal: ac.signal }, () => fake.child));
    setImmediate(() => ac.abort());
    expect(await run).toEqual([]);
    expect(fake.killed()).toBe(true);
  });
});
