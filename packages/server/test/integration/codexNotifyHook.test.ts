import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hooks/codex-notify-hook.mjs',
);

let server: http.Server | undefined;
afterEach(() => server?.close());

function listen(received: any[]): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.statusCode = 200;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as any).port));
  });
}

function runHook(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end();
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

describe('codex-notify-hook', () => {
  it('POSTs waiting on agent-turn-complete', async () => {
    const received: any[] = [];
    const port = await listen(received);
    const code = await runHook(
      [String(port), '/tmp/wt-a', JSON.stringify({ type: 'agent-turn-complete' })],
      {},
    );
    expect(code).toBe(0);
    expect(received).toEqual([{ cwd: '/tmp/wt-a', status: 'waiting' }]);
  });

  it('forwards STRADO_SESSION_ID so multi-session status lands on the right tab', async () => {
    const received: any[] = [];
    const port = await listen(received);
    const code = await runHook(
      [String(port), '/tmp/wt-a', JSON.stringify({ type: 'agent-turn-complete' })],
      { STRADO_SESSION_ID: '2' },
    );
    expect(code).toBe(0);
    expect(received).toEqual([{ cwd: '/tmp/wt-a', status: 'waiting', sessionId: '2' }]);
  });

  it('namespaces completion from Codex launched inside Shell', async () => {
    const received: any[] = [];
    const port = await listen(received);
    await runHook(
      [String(port), '/tmp/wt-a', JSON.stringify({ type: 'agent-turn-complete' })],
      { STRADO_SESSION_ID: '3', STRADO_SESSION_MODE: 'shell' },
    );
    expect(received).toEqual([{ cwd: '/tmp/wt-a', status: 'waiting', sessionId: 'shell:3' }]);
  });
});
