// Tunnel wire protocol: JSON text frames over one runner-initiated WebSocket.
// A versioned hello lets either side reject an incompatible peer instead of
// misparsing frames, and HTTP responses stream (http:head/data/end) so SSE
// survives the tunnel.

export const PROTO_VERSION = 1;

// Timing constants — chosen to survive real proxies and idle-connection
// timeouts without flapping under normal network jitter.
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MISSED = 3;
export const HTTP_HEAD_TIMEOUT_MS = 30_000;
export const MAX_PENDING_REQUESTS = 1_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const INBOUND_SILENCE_TIMEOUT_MS = 75_000;
export const WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Reserved relay path that opens a raw TCP channel instead of proxying to the
 * runner's own strado server. Same `__strado_` prefix convention as
 * /__strado_connect, so it can never collide with an app route.
 */
export const TCP_FORWARD_PATH = '/__strado_tcp';
export const TCP_PORT_PARAM = 'port';

// App-defined WS close codes (4xxx). Runners reset reconnect backoff ONLY on
// CLOSE_DRAIN so a mass ping-timeout can't thundering-herd the relay.
export const CLOSE_DRAIN = 4001;
export const CLOSE_SILENCE = 4002;
export const CLOSE_BAD_VERSION = 4003;

// ── Runner → relay ──────────────────────────────────────────────────

export interface HelloMsg {
  type: 'hello';
  v: number;
  runnerVersion?: string;
  /** Per-runner client access key; the relay gates browser access on it. */
  accessKey: string;
}

export interface HttpHeadMsg {
  type: 'http:head';
  id: string;
  status: number;
  headers: Record<string, string>;
}

export interface HttpDataMsg {
  type: 'http:data';
  id: string;
  /** base64 chunk */
  data: string;
}

export interface HttpEndMsg {
  type: 'http:end';
  id: string;
}

export interface HttpErrorMsg {
  type: 'http:error';
  id: string;
  message: string;
}

export interface PongMsg {
  type: 'pong';
}

// ── Relay → runner ──────────────────────────────────────────────────

export interface HelloAckMsg {
  type: 'hello-ack';
  v: number;
}

export interface HttpRequestMsg {
  type: 'http';
  id: string;
  method: string;
  /** path + query string, e.g. /api/w/x/worktrees?y=1 */
  path: string;
  headers: Record<string, string>;
  /** base64 body (requests are small JSON; buffered is fine) */
  body?: string;
}

/** Client disappeared (closed tab, EventSource teardown) — abort the local fetch. */
export interface HttpAbortMsg {
  type: 'http:abort';
  id: string;
}

export interface WsOpenMsg {
  type: 'ws:open';
  id: string;
  path: string;
  query?: string;
}

/**
 * Open a raw TCP channel to 127.0.0.1:<port> on the runner (dev-server port
 * forwarding). Raw TCP rather than an HTTP-aware route because the far end is
 * not ours: it may speak HTTP/2, WebSockets, SSE, or not be HTTP at all.
 * Parsing it would only create ways to corrupt it.
 */
export interface TcpOpenMsg {
  type: 'tcp:open';
  id: string;
  port: number;
}

export interface PingMsg {
  type: 'ping';
}

export interface DrainMsg {
  type: 'drain';
  reason?: string;
}

// ── Both directions ─────────────────────────────────────────────────

export interface WsFrameMsg {
  type: 'ws:frame';
  id: string;
  data: string;
  /** set when data is base64-encoded binary; absent = UTF-8 text */
  b64?: boolean;
}

export interface WsCloseMsg {
  type: 'ws:close';
  id: string;
  code?: number;
}

/**
 * A chunk of a raw TCP stream. Always base64: unlike a WebSocket, TCP has no
 * text/binary distinction, and asset bytes are binary far more often than not.
 */
export interface TcpDataMsg {
  type: 'tcp:data';
  id: string;
  data: string;
}

export interface TcpCloseMsg {
  type: 'tcp:close';
  id: string;
  /** Set when the runner refused or could not reach the port. */
  message?: string;
}

export type RunnerToRelay =
  | HelloMsg
  | HttpHeadMsg
  | HttpDataMsg
  | HttpEndMsg
  | HttpErrorMsg
  | WsFrameMsg
  | WsCloseMsg
  | TcpDataMsg
  | TcpCloseMsg
  | PongMsg;

export type RelayToRunner =
  | HelloAckMsg
  | HttpRequestMsg
  | HttpAbortMsg
  | WsOpenMsg
  | WsFrameMsg
  | WsCloseMsg
  | TcpOpenMsg
  | TcpDataMsg
  | TcpCloseMsg
  | PingMsg
  | DrainMsg;

export function parseMsg(raw: unknown): { type: string; [k: string]: unknown } | null {
  try {
    const msg = JSON.parse(String(raw));
    if (msg && typeof msg.type === 'string') return msg;
    return null;
  } catch {
    return null;
  }
}

/** Mask secrets in URLs/log lines (tokens ride query params on WS upgrades). */
export function redactSecrets(line: string): string {
  return line.replace(/([?&])(token|key|accessKey|ticket)=[^&\s]+/g, '$1$2=REDACTED');
}

/**
 * WS frame → wire encoding. Text frames pass through; binary rides base64.
 * The strado terminal protocol is text-only today, but the tunnel must not
 * bake that assumption in — a future binary use should not require a wire
 * format change.
 */
export function encodeWsData(data: Buffer | ArrayBuffer | Buffer[] | string, isBinary: boolean): { data: string; b64?: boolean } {
  if (typeof data === 'string') return { data };
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  if (!isBinary) return { data: buf.toString('utf8') };
  return { data: buf.toString('base64'), b64: true };
}

export function decodeWsData(msg: WsFrameMsg): string | Buffer {
  return msg.b64 ? Buffer.from(msg.data, 'base64') : msg.data;
}
