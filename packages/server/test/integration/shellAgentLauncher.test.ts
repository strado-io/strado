import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hooks');
let server: http.Server | undefined;
let tmp: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function listen(hits: any[]): Promise<number> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ url: req.url, body: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function run(agent: 'claude' | 'codex' | 'opencode') {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-agent-'));
  const fakeBin = path.join(tmp, 'bin');
  const capture = path.join(tmp, 'capture.json');
  await fs.mkdir(fakeBin);
  const fake = path.join(fakeBin, agent);
  await fs.writeFile(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));\n`);
  await fs.chmod(fake, 0o755);

  const hits: any[] = [];
  const port = await listen(hits);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [path.join(HOOKS, 'bin', agent), '--flag', 'value'], {
      env: {
        ...process.env,
        PATH: [path.join(HOOKS, 'bin'), fakeBin, process.env.PATH ?? ''].join(path.delimiter),
        CAPTURE: capture,
        STRADO_WORKTREE: '/tmp/wt-a',
        STRADO_SESSION_ID: '2',
        STRADO_SESSION_MODE: 'shell',
        STRADO_STATUS_PORT: String(port),
      },
      stdio: 'ignore',
    });
    child.on('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  return { code, hits, capture: JSON.parse(await fs.readFile(capture, 'utf8')) };
}

describe('Shell agent launchers', () => {
  it.each(['claude', 'opencode'] as const)('registers, invokes, and clears %s', async (agent) => {
    const result = await run(agent);
    expect(result.code).toBe(0);
    expect(result.hits).toEqual([
      { url: `/api/${agent}/status`, body: { cwd: '/tmp/wt-a', status: 'waiting', sessionId: 'shell:2' } },
      { url: `/api/${agent}/status`, body: { cwd: '/tmp/wt-a', status: 'closed', sessionId: 'shell:2' } },
    ]);
    expect(result.capture.argv).toEqual(['--flag', 'value']);
    expect(result.capture.path.split(path.delimiter)).not.toContain(path.join(HOOKS, 'bin'));
  });

  it('injects the completion hook when Codex is launched from Shell', async () => {
    const result = await run('codex');
    expect(result.code).toBe(0);
    expect(result.hits.map((h: any) => h.body.status)).toEqual(['waiting', 'closed']);
    expect(result.capture.argv[0]).toBe('-c');
    expect(result.capture.argv[1]).toContain('codex-notify-hook.mjs');
    expect(result.capture.argv.slice(2)).toEqual(['--flag', 'value']);
  });
});
