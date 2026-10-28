import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { claudeArgv, createStreamParser, runClaudeHeadless, type HeadlessEvent, type HeadlessSpawn } from './claudeHeadless.js';
import { jarvisAllowedTools } from './types.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../test/fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[]) => {
  const p = createStreamParser();
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

const base = { cwd: '/j/f1', resume: null, systemPrompt: 'You are Jarvis.', mcpConfigPath: '/j/f1/mcp.json', env: { PATH: '/bin' } };

async function collect(it: AsyncIterable<HeadlessEvent>) {
  const out: HeadlessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('claude stream-json parsing (recorded from Claude Code 2.1.310)', () => {
  it('a turn with tool calls: the session, the reply text, then done', () => {
    expect(parseAll(fixture('claude-stream.jsonl'))).toEqual([
      { type: 'session', sessionId: '9cb41d87-9d3f-43d8-905a-4998c3f4da87' },
      { type: 'text', delta: 'Opened shell-1 in demo; `ls` is waiting for your approval (a1).' },
      { type: 'done' },
    ]);
  });

  it('not logged in: a fixed error with the fix, and Claude\'s own words never become a reply', () => {
    const events = parseAll(fixture('claude-stream-noauth.jsonl'));
    expect(events).toEqual([
      { type: 'session', sessionId: 'edda28f5-2a19-4139-bab0-c334a42444f5' },
      { type: 'error', message: 'Claude Code is not logged in', fix: 'Run claude and log in' },
    ]);
  });

  it('text from a later message starts a new paragraph; junk lines are skipped', () => {
    const msg = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    expect(parseAll([msg('One.'), 'not json', msg('Two.'), JSON.stringify({ type: 'result', is_error: true })])).toEqual([
      { type: 'text', delta: 'One.' },
      { type: 'text', delta: '\n\nTwo.' },
      { type: 'error', message: 'Claude Code stopped with an error' },
    ]);
  });
});

describe('runClaudeHeadless', () => {
  it('argv: no built-in tools, only the jarvis tools, no settings, nothing asked, resume when known; the prompt is not in it', () => {
    const argv = claudeArgv({ ...base, resume: 'sid-1' });
    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after('--tools')).toBe('');
    expect(after('--setting-sources')).toBe('');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--mcp-config')).toBe('/j/f1/mcp.json');
    expect(argv).toContain('--strict-mcp-config');
    expect(after('--resume')).toBe('sid-1');
    const i = argv.indexOf('--allowedTools');
    expect(argv.slice(i + 1, i + 1 + jarvisAllowedTools().length)).toEqual(jarvisAllowedTools());
    expect(jarvisAllowedTools().every((t) => t.startsWith('mcp__strado__jarvis_'))).toBe(true);
    expect(claudeArgv(base)).not.toContain('--resume');
  });

  it('argv: the Focus\'s model and effort when set; none of either at the default', () => {
    const argv = claudeArgv({ ...base, model: 'opus', effort: 'high' });
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    const plain = claudeArgv({ ...base, model: null, effort: null });
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--effort');
  });

  it('streams the recorded turn and sends the prompt on stdin', async () => {
    const fake = fakeChild(fixture('claude-stream.jsonl'));
    let seen: { cmd: string; args: string[]; cwd: string } | null = null;
    const spawn: HeadlessSpawn = (cmd, args, o) => { seen = { cmd, args, cwd: o.cwd }; return fake.child; };
    const events = await collect(runClaudeHeadless({ ...base, prompt: 'open a shell', signal: new AbortController().signal }, spawn));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(seen!.cmd).toBe('claude');
    expect(seen!.cwd).toBe('/j/f1');
    expect(seen!.args).not.toContain('open a shell');
    expect(fake.input()).toBe('open a shell');
  });

  it('claude missing: Claude Code is not installed, with the fix', async () => {
    const spawn: HeadlessSpawn = () => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      Object.assign(child, { stdout: new PassThrough(), stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    expect(await collect(runClaudeHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, spawn))).toEqual([
      { type: 'error', message: 'Claude Code is not installed', fix: 'Install Claude Code, or pick another agent' },
    ]);
  });

  it('exits without a result: a fixed error, not its output', async () => {
    const fake = fakeChild(['{"type":"system","subtype":"init","session_id":"s"}', 'Error: token=abc123 leaked'], 1);
    const events = await collect(runClaudeHeadless({ ...base, prompt: 'x', signal: new AbortController().signal }, () => fake.child));
    expect(events).toEqual([{ type: 'session', sessionId: 's' }, { type: 'error', message: 'Claude Code exited unexpectedly' }]);
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
      const run = collect(runClaudeHeadless({ ...base, prompt: 'x', signal: ac.signal }, () => child)).then((e) => { ended = true; return e; });
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
    const run = collect(runClaudeHeadless({ ...base, prompt: 'x', signal: ac.signal }, () => fake.child));
    setImmediate(() => ac.abort());
    expect(await run).toEqual([]);
    expect(fake.killed()).toBe(true);
  });
});
