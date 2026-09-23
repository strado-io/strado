// Shared HTTP transport for the Strado hook script and the `strado` CLI: one
// JSON request to the local server. Inside a sandbox there is no route to the
// host's loopback; the server is reachable over a bind-mounted unix socket
// whose path the container wrapper exports as STRADO_SERVER_SOCKET, and only
// allowlisted routes are forwarded on the other end (services/sandbox/hookSocket.ts).
import { request } from 'node:http';

/** Where the server is, from a tab's environment. null when this is not a Strado tab. */
export function serverFromEnv(env = process.env) {
  if (env.STRADO_SERVER_SOCKET) return { socketPath: env.STRADO_SERVER_SOCKET, port: null };
  if (env.STRADO_STATUS_PORT) return { socketPath: null, port: Number(env.STRADO_STATUS_PORT) };
  return null;
}

/** Resolves { status, json } for ANY HTTP response (json is null for an empty or
 * non-JSON body). Rejects only when no response arrived: connection error,
 * timeout, or the socket closed first. Callers decide what a non-2xx means. */
export function requestJson({ socketPath, port, method = 'POST', urlPath, body, token, timeoutMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const opts = {
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
      ...(socketPath ? { socketPath } : { host: '127.0.0.1', port: Number(port) }),
    };
    let settled = false;
    const once = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    const ok = once(resolve);
    const fail = once(reject);
    const req = request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        ok({ status: res.statusCode ?? 0, json });
      });
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`request to ${urlPath} timed out after ${timeoutMs}ms`)));
    req.on('error', fail);
    req.on('close', () => fail(new Error(`connection closed before a response to ${urlPath}`))); // backstop
    req.end(body === undefined ? undefined : body);
  });
}
