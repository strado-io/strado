import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hooks/claude-status-hook.mjs',
);

let server: http.Server | undefined;
afterEach(() => server?.close());

function runHook(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(); // no stdin payload; rely on CLAUDE_PROJECT_DIR
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

describe('claude-status-hook', () => {
  it('POSTs {cwd,status} to the status endpoint and exits 0', async () => {
    const received: any[] = [];
    const port: number = await new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ url: req.url, body: JSON.parse(body) });
          res.statusCode = 200;
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as any).port));
    });

    const code = await runHook(['working', String(port)], {
      CLAUDE_PROJECT_DIR: '/tmp/wt-a',
    });

    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/api/claude/status');
    expect(received[0].body).toEqual({ cwd: '/tmp/wt-a', status: 'working' });
  });

  it('forwards STRADO_SESSION_ID so multi-session status lands on the right tab', async () => {
    const received: any[] = [];
    const port: number = await new Promise((resolve) => {
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

    const code = await runHook(['working', String(port)], {
      CLAUDE_PROJECT_DIR: '/tmp/wt-a',
      STRADO_SESSION_ID: '2',
    });

    expect(code).toBe(0);
    expect(received[0]).toEqual({ cwd: '/tmp/wt-a', status: 'working', sessionId: '2' });
  });

  it('exits 0 even when no server is listening', async () => {
    // Port 1 is privileged/closed; connection refused → must still exit 0.
    const code = await runHook(['idle', '1'], { CLAUDE_PROJECT_DIR: '/tmp/wt-b' });
    expect(code).toBe(0);
  });
});
