import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevProxy, worktreeHostname, type DevProxy } from '../../src/services/devProxy.js';

async function freePort(): Promise<number> {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  await once(srv, 'close');
  return port;
}

// A dev server that echoes who it is and the Host it was asked for, and
// answers a WebSocket-style upgrade by echoing raw bytes back.
async function upstream(name: string): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    res.setHeader('set-cookie', ['a=1', 'b=2']);
    res.end(JSON.stringify({ name, host: req.headers.host, fwd: req.headers['x-forwarded-host'] }));
  });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as net.AddressInfo).port, server };
}

function get(port: number, host: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

describe('worktreeHostname', () => {
  it('keeps the bare host for the main checkout', () => {
    expect(worktreeHostname('dev.fleetx.io', '/repos/app', '/repos/app')).toBe('dev.fleetx.io');
  });

  it('turns the worktree directory into a DNS-safe label', () => {
    expect(worktreeHostname('dev.fleetx.io', '/wt/app/FX_1234__New Login', '/repos/app')).toBe(
      'fx-1234-new-login.dev.fleetx.io',
    );
  });

  it('caps the label at 63 characters', () => {
    const host = worktreeHostname('dev.x.io', `/wt/${'a'.repeat(100)}`, '/repos/app');
    expect(host.split('.')[0]).toHaveLength(63);
  });
});

describe('dev proxy', () => {
  let proxy: DevProxy | null = null;
  const servers: http.Server[] = [];

  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    for (const s of servers.splice(0)) s.close();
  });

  it('routes two worktrees on one port by Host, and rewrites Host to the base host', async () => {
    const a = await upstream('main');
    const b = await upstream('feature');
    servers.push(a.server, b.server);
    const port = await freePort();
    const config = { host: 'dev.example.test', port };
    proxy = createDevProxy();

    const main = await proxy.register({ key: '/repo', hostname: 'dev.example.test', config, resolvePort: () => a.port });
    await proxy.register({ key: '/wt/feature', hostname: 'feature.dev.example.test', config, resolvePort: () => b.port });
    expect(main.url).toBe(`http://dev.example.test:${port}`);

    const r1 = await get(port, `dev.example.test:${port}`);
    expect(JSON.parse(r1.body).name).toBe('main');

    const r2 = await get(port, `feature.dev.example.test:${port}`);
    expect(JSON.parse(r2.body)).toEqual({
      name: 'feature',
      host: 'dev.example.test',
      fwd: `feature.dev.example.test:${port}`,
    });
    expect(r2.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(proxy.listenPorts()).toEqual(new Set([port]));
  });

  it('answers 502 when the worktree is not running and 404 for an unknown host', async () => {
    const port = await freePort();
    proxy = createDevProxy();
    await proxy.register({ key: '/wt/x', hostname: 'x.dev.example.test', config: { host: 'dev.example.test', port }, resolvePort: () => null });

    expect((await get(port, 'x.dev.example.test')).status).toBe(502);
    const unknown = await get(port, 'nope.dev.example.test');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain('x.dev.example.test');
  });

  it('refuses to route one hostname to two worktrees', async () => {
    const port = await freePort();
    proxy = createDevProxy();
    const config = { host: 'dev.example.test', port };
    await proxy.register({ key: '/wt/a', hostname: 'same.dev.example.test', config, resolvePort: () => null });
    await expect(
      proxy.register({ key: '/wt/b', hostname: 'same.dev.example.test', config, resolvePort: () => null }),
    ).rejects.toThrow(/already routed/);
  });

  it('relays WebSocket upgrades (HMR) to the right worktree', async () => {
    const b = await upstream('feature');
    servers.push(b.server);
    const port = await freePort();
    proxy = createDevProxy();
    await proxy.register({
      key: '/wt/feature',
      hostname: 'feature.dev.example.test',
      config: { host: 'dev.example.test', port },
      resolvePort: () => b.port,
    });

    const sock = net.connect(port, '127.0.0.1');
    await once(sock, 'connect');
    sock.write(
      'GET /ws HTTP/1.1\r\nHost: feature.dev.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    let received = '';
    sock.on('data', (d) => (received += d.toString()));
    const deadline = Date.now() + 5_000;
    while (!received.includes('101') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    sock.write('ping');
    while (!received.endsWith('ping') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    expect(received).toContain('101 Switching Protocols');
    expect(received.endsWith('ping')).toBe(true);
  });

  it('reports a clear error when the port is already taken', async () => {
    const squatter = net.createServer();
    squatter.listen(0, '127.0.0.1');
    await once(squatter, 'listening');
    const port = (squatter.address() as net.AddressInfo).port;
    proxy = createDevProxy();
    await expect(
      proxy.register({ key: '/wt/a', hostname: 'a.dev.example.test', config: { host: 'dev.example.test', port }, resolvePort: () => null }),
    ).rejects.toThrow(/could not listen/);
    squatter.close();
  });

  it('terminates TLS with a wildcard cert and serves every worktree subdomain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devproxy-tls-'));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=dev.example.test',
      '-addext', 'subjectAltName=DNS:dev.example.test,DNS:*.dev.example.test',
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore' });

    const b = await upstream('feature');
    servers.push(b.server);
    const port = await freePort();
    proxy = createDevProxy();
    const { url } = await proxy.register({
      key: '/wt/feature',
      hostname: 'feature.dev.example.test',
      config: { host: 'dev.example.test', port, certFile, keyFile },
      resolvePort: () => b.port,
    });
    expect(url).toBe(`https://feature.dev.example.test:${port}`);

    const body = await new Promise<string>((resolve, reject) => {
      https
        .get(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            servername: 'feature.dev.example.test',
            headers: { host: 'feature.dev.example.test' },
            ca: fs.readFileSync(certFile),
            checkServerIdentity: (_h, cert) => tlsCheck(cert),
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
          },
        )
        .on('error', reject);
    });
    expect(JSON.parse(body).name).toBe('feature');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Verifies the served cert covers the worktree subdomain via its wildcard SAN.
function tlsCheck(cert: { subjectaltname?: string }): Error | undefined {
  return cert.subjectaltname?.includes('DNS:*.dev.example.test') ? undefined : new Error('wrong cert');
}
