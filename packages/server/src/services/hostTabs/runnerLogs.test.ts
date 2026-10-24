import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFn } from '../sandbox/runtime.js';
import { readRunnerLogs, type LogDeps } from './runnerLogs.js';

const us = (ms: number) => String(ms * 1000);
const entry = (ms: number, msg: string | number[], prio = '6', id = 'strado-runner') =>
  JSON.stringify({ __REALTIME_TIMESTAMP: us(ms), MESSAGE: msg, PRIORITY: prio, SYSLOG_IDENTIFIER: id });

function journal(lines: string[], code = 0) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_f, args) => {
    calls.push(args);
    return { code, stdout: lines.join('\n') + '\n', stderr: '' };
  };
  return { calls, exec };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-logs-'));
});
const deps = (exec: ExecFn, over: Partial<LogDeps> = {}): LogDeps => ({
  exec,
  underSystemd: true,
  logFile: path.join(dir, 'server.log'),
  ...over,
});

describe('journal', () => {
  it('reads only the runner and systemd lines of its unit, oldest first, with levels', async () => {
    const { calls, exec } = journal([
      entry(1000, '[runner] strado 0.1.32 listening on http://127.0.0.1:7777'),
      entry(2000, 'Started strado-runner.service - Strado runner.', '6', 'systemd'),
      entry(3000, '{"level":40,"time":3001,"msg":"slow request"}'),
      entry(4000, 'agent-login sync failed: store'),
      entry(5000, 'boom', '3'),
      entry(6000, '{"level":20,"time":6001,"msg":"debug detail"}'),
    ]);
    const page = await readRunnerLogs({}, deps(exec));
    expect(calls[0]).toEqual([
      '--user', '-u', 'strado-runner', '-t', 'strado-runner', '-t', 'systemd',
      '-o', 'json', '--no-pager', '-n', '300',
    ]);
    expect(page.source).toBe('journal');
    expect(page.lines.map((l) => [l.ts, l.level, l.text])).toEqual([
      [1000, 'info', '[runner] strado 0.1.32 listening on http://127.0.0.1:7777'],
      [2000, 'info', 'Started strado-runner.service - Strado runner.'],
      [3001, 'warn', 'slow request'],
      [4000, 'error', 'agent-login sync failed: store'],
      [5000, 'error', 'boom'],
      [6001, 'debug', 'debug detail'],
    ]);
    expect(page.nextSince).toBe(6001);
  });

  it('redacts every line on the runner', async () => {
    const { exec } = journal([entry(1, 'token=sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA'), entry(2, [104, 105])]);
    const page = await readRunnerLogs({}, deps(exec));
    expect(page.lines.map((l) => l.text)).toEqual(['token=[redacted]', 'hi']);
  });

  it('redacts before cutting a long line, so no head of a secret survives the cut', async () => {
    const { exec } = journal([entry(1, `${'x'.repeat(3990)} sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA`)]);
    const text = (await readRunnerLogs({}, deps(exec))).lines[0]!.text;
    expect(text).not.toContain('sk-ant');
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('a PEM block logged line by line is redacted whole', async () => {
    const { exec } = journal([
      entry(1, '-----BEG' + 'IN PRIVATE KEY-----'),
      entry(2, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'),
      entry(3, '-----END PRIVATE KEY-----'),
      entry(4, 'ok'),
    ]);
    expect((await readRunnerLogs({}, deps(exec))).lines.map((l) => l.text)).toEqual(['[redacted]', '[redacted]', '[redacted]', 'ok']);
  });

  it('lines is clamped to 1..1000', async () => {
    const a = journal([]);
    await readRunnerLogs({ lines: 5000 }, deps(a.exec));
    expect(a.calls[0]!.at(-1)).toBe('1000');
    const b = journal([]);
    await readRunnerLogs({ lines: 0 }, deps(b.exec));
    expect(b.calls[0]!.at(-1)).toBe('1');
  });

  it('grep filters case-insensitively after redaction, so it cannot probe a secret', async () => {
    const { calls, exec } = journal([
      entry(1, 'Tunnel connected'),
      entry(2, 'key=sk-proj-SECRETSECRETSECRETSECRET'),
      entry(3, 'tunnel dropped'),
    ]);
    const page = await readRunnerLogs({ grep: 'TUNNEL', lines: 10 }, deps(exec));
    expect(page.lines.map((l) => l.text)).toEqual(['Tunnel connected', 'tunnel dropped']);
    // Reads further back so a filter still finds `lines` matches.
    expect(calls[0]!.at(-1)).toBe('200');
    expect((await readRunnerLogs({ grep: 'sk-proj' }, deps(exec))).lines).toEqual([]);
  });

  it('since: only newer lines, asked of journalctl in whole seconds', async () => {
    const { calls, exec } = journal([entry(4_999, 'old'), entry(5_000, 'same'), entry(5_001, 'new')]);
    const page = await readRunnerLogs({ since: 5_000 }, deps(exec));
    expect(calls[0]).toContain('--since');
    expect(calls[0]![calls[0]!.indexOf('--since') + 1]).toBe('@5');
    expect(page.lines.map((l) => l.text)).toEqual(['new']);
    expect(page.nextSince).toBe(5_001);
  });

  it('no new lines keeps the cursor', async () => {
    const { exec } = journal([]);
    expect((await readRunnerLogs({ since: 7 }, deps(exec))).nextSince).toBe(7);
  });

  it('a failing journalctl falls back to the file', async () => {
    fs.writeFileSync(path.join(dir, 'server.log'), 'from file\n');
    const { exec } = journal([], 1);
    const page = await readRunnerLogs({}, deps(exec));
    expect(page.source).toBe('file');
    expect(page.lines.map((l) => l.text)).toEqual(['from file']);
  });
});

describe('file (not under systemd)', () => {
  it('last N lines of server.log, redacted; pino lines carry their time', async () => {
    fs.writeFileSync(
      path.join(dir, 'server.log'),
      ['one', 'two', '{"level":50,"time":1234,"msg":"bad gh' + 'p_0123456789abcdefABCDEF0123456789abcd"}', 'four', ''].join('\n'),
    );
    const { calls, exec } = journal([]);
    const page = await readRunnerLogs({ lines: 3 }, deps(exec, { underSystemd: false }));
    expect(calls).toHaveLength(0);
    expect(page.source).toBe('file');
    expect(page.lines.map((l) => [l.level, l.text])).toEqual([
      ['info', 'two'],
      ['error', 'bad [redacted]'],
      ['info', 'four'],
    ]);
    expect(page.lines[1]!.ts).toBe(1234);
    expect(page.lines[2]!.ts).toBe(1234);
    // No reliable cursor in a plain file: follow is journal-only.
    expect(page.nextSince).toBeNull();
  });

  it('no file is source none', async () => {
    const { exec } = journal([]);
    expect(await readRunnerLogs({}, deps(exec, { underSystemd: false }))).toEqual({ lines: [], source: 'none', nextSince: null });
  });

  it('since on a file returns nothing new', async () => {
    fs.writeFileSync(path.join(dir, 'server.log'), 'x\n');
    const { exec } = journal([]);
    expect((await readRunnerLogs({ since: 1 }, deps(exec, { underSystemd: false }))).lines).toEqual([]);
  });
});
