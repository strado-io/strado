import net from 'node:net';
import { WebSocket } from 'ws';
import {
  CLOSE_DRAIN,
  CLOSE_SILENCE,
  CONNECT_TIMEOUT_MS,
  INBOUND_SILENCE_TIMEOUT_MS,
  PROTO_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  WATCHDOG_INTERVAL_MS,
  type HttpRequestMsg,
  type RunnerToRelay,
  type TcpOpenMsg,
  type WsFrameMsg,
  type WsOpenMsg,
  decodeWsData,
  encodeWsData,
  parseMsg,
  redactSecrets,
} from './protocol.js';

export interface TunnelClientOptions {
  /** e.g. wss://r.strado.io or ws://127.0.0.1:8790 */
  relayUrl: string;
  runnerId: string;
  /** Shared runner registration secret (M1). */
  token: string;
  /** Client access key served to browsers via /__strado_connect. */
  accessKey: string;
  /** The local strado server this tunnel fronts. */
  localPort: number;
  localHost?: string;
  runnerVersion?: string;
  /**
   * Gate for tcp:open — which loopback ports this runner will let anyone reach.
   * Absent means refuse everything, so an older/unconfigured caller can't
   * accidentally expose the box.
   *
   * Not a privilege boundary: whoever can open a channel already has a shell
   * here. It's defense in depth against a bug or a stolen ticket turning into
   * "scan the runner's loopback", and it makes the log meaningful.
   */
  isPortAllowed?: (port: number) => boolean | Promise<boolean>;
  log?: (line: string) => void;
  onStatusChange?: (status: 'connected' | 'disconnected') => void;
}

/** Buffered client→local frames while the local WS is still CONNECTING. */
const MAX_PENDING_FRAMES = 256;

/**
 * Cap on bytes held while a TCP channel is still connecting (gate check +
 * connect). A frame count is the wrong unit here: one upload frame can be
 * megabytes, and the runner must not be OOM-able through the tunnel.
 */
const MAX_PENDING_TCP_BYTES = 1024 * 1024;

interface TcpChannel {
  socket: net.Socket | null;
  pending: Buffer[];
  pendingBytes: number;
  closed: boolean;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private readonly channels = new Map<string, { ws: WebSocket; pending: Array<string | Buffer> }>();
  private readonly tcpChannels = new Map<string, TcpChannel>();
  private readonly httpAborts = new Map<string, AbortController>();
  private readonly log: (line: string) => void;
  private readonly localBase: string;

  constructor(private readonly opts: TunnelClientOptions) {
    this.log = opts.log ?? ((line) => console.log(`[tunnel] ${redactSecrets(line)}`));
    this.localBase = `${opts.localHost ?? '127.0.0.1'}:${opts.localPort}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown('client stopped');
    this.ws?.close(1000, 'Client stopped');
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL('/tunnel', this.opts.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    url.searchParams.set('runner', this.opts.runnerId);
    url.searchParams.set('token', this.opts.token);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    let opened = false;

    const connectDeadline = setTimeout(() => {
      if (!opened) ws.close(CLOSE_DRAIN, 'Connect timeout');
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      opened = true;
      clearTimeout(connectDeadline);
      this.lastInboundAt = Date.now();
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: PROTO_VERSION,
          runnerVersion: this.opts.runnerVersion,
          accessKey: this.opts.accessKey,
        }),
      );
    });

    ws.on('message', (raw) => {
      this.lastInboundAt = Date.now();
      const msg = parseMsg(raw);
      if (!msg) return;
      if (msg.type === 'hello-ack') {
        this.attempts = 0;
        this.log(`connected to relay as ${this.opts.runnerId}`);
        this.opts.onStatusChange?.('connected');
        this.startWatchdog();
      } else if (msg.type === 'ping') {
        this.send({ type: 'pong' });
      } else if (msg.type === 'drain') {
        // Relay is deploying: reconnect immediately, don't wait for the
        // close frame (it may never arrive within the kill window).
        this.log('relay draining — reconnecting');
        this.attempts = 0;
        ws.close(1000, 'Drain acknowledged');
      } else if (msg.type === 'http') {
        void this.handleHttp(msg as unknown as HttpRequestMsg);
      } else if (msg.type === 'http:abort') {
        this.httpAborts.get(msg.id as string)?.abort();
      } else if (msg.type === 'ws:open') {
        this.handleWsOpen(msg as unknown as WsOpenMsg);
      } else if (msg.type === 'ws:frame') {
        const channel = this.channels.get(msg.id as string);
        if (!channel) return;
        const data = decodeWsData(msg as unknown as WsFrameMsg);
        if (channel.ws.readyState === WebSocket.OPEN) channel.ws.send(data);
        else if (channel.ws.readyState === WebSocket.CONNECTING && channel.pending.length < MAX_PENDING_FRAMES)
          channel.pending.push(data);
      } else if (msg.type === 'ws:close') {
        const channel = this.channels.get(msg.id as string);
        if (channel) {
          this.channels.delete(msg.id as string);
          try {
            channel.ws.close(1000);
          } catch {
            /* already closed */
          }
        }
      } else if (msg.type === 'tcp:open') {
        void this.handleTcpOpen(msg as unknown as TcpOpenMsg);
      } else if (msg.type === 'tcp:data') {
        this.writeTcp(msg.id as string, Buffer.from(String(msg.data), 'base64'));
      } else if (msg.type === 'tcp:close') {
        this.closeTcp(msg.id as string);
      }
    });

    const onGone = (code?: number) => {
      clearTimeout(connectDeadline);
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopWatchdog();
      this.teardown('tunnel disconnected');
      this.opts.onStatusChange?.('disconnected');
      if (this.stopped) return;
      // Backoff resets ONLY on the relay's drain code so a mass disconnect
      // doesn't thundering-herd it.
      if (code === CLOSE_DRAIN) this.attempts = 0;
      this.scheduleReconnect();
    };
    ws.on('close', (code) => onGone(code));
    ws.on('error', (err) => {
      this.log(`socket error: ${(err as Error).message}`);
      // 'close' follows 'error' for opened sockets; for pre-open failures it
      // does too in ws, so reconnect is scheduled exactly once via onGone.
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    // The relay pings every 30s; 75s of inbound silence means the link is
    // dead even though TCP still says ESTABLISHED (sleep/wake, NAT rebind).
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastInboundAt > INBOUND_SILENCE_TIMEOUT_MS) {
        this.log('inbound silence timeout — recycling connection');
        this.ws?.close(CLOSE_SILENCE, 'Inbound silence timeout');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private teardown(reason: string): void {
    for (const [, channel] of this.channels) {
      try {
        channel.ws.close(1000, reason);
      } catch {
        /* already closed */
      }
    }
    this.channels.clear();
    // Forwarded sockets belong to the tunnel: with no control socket there is
    // no way to report their bytes, so leaving them open leaks a connection to
    // the dev server on every reconnect.
    for (const [, channel] of this.tcpChannels) {
      channel.closed = true;
      channel.socket?.destroy();
    }
    this.tcpChannels.clear();
    for (const [, controller] of this.httpAborts) controller.abort();
    this.httpAborts.clear();
  }

  private send(message: RunnerToRelay): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private async handleHttp(req: HttpRequestMsg): Promise<void> {
    const controller = new AbortController();
    this.httpAborts.set(req.id, controller);
    try {
      const headers: Record<string, string> = { ...req.headers };
      delete headers['host'];
      delete headers['content-length'];
      const res = await fetch(`http://${this.localBase}${req.path}`, {
        method: req.method,
        headers,
        body: req.body ? Buffer.from(req.body, 'base64') : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      this.send({ type: 'http:head', id: req.id, status: res.status, headers: outHeaders });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) {
            this.send({ type: 'http:data', id: req.id, data: Buffer.from(value).toString('base64') });
          }
        }
      }
      this.send({ type: 'http:end', id: req.id });
    } catch (err) {
      if (!controller.signal.aborted) {
        this.send({ type: 'http:error', id: req.id, message: (err as Error).message });
      }
    } finally {
      this.httpAborts.delete(req.id);
    }
  }

  /**
   * Raw TCP to a loopback port on this box — how a dev server running here
   * becomes reachable on the user's desktop.
   */
  private async handleTcpOpen(msg: TcpOpenMsg): Promise<void> {
    const id = msg.id;
    const port = Number(msg.port);
    const refuse = (why: string) => {
      this.log(`tcp:open refused for port ${msg.port}: ${why}`);
      this.tcpChannels.delete(id);
      this.send({ type: 'tcp:close', id, message: why });
    };
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      refuse('not a valid port');
      return;
    }
    // Registered before the await: tcp:data can arrive while the gate check is
    // still in flight, and dropping it would eat the request line.
    const channel: TcpChannel = { socket: null, pending: [], pendingBytes: 0, closed: false };
    this.tcpChannels.set(id, channel);

    let allowed = false;
    try {
      allowed = (await this.opts.isPortAllowed?.(port)) ?? false;
    } catch (err) {
      this.log(`port gate errored for ${port}: ${(err as Error).message}`);
      allowed = false;
    }
    if (channel.closed) return;
    if (!allowed) {
      refuse(`port ${port} is not forwardable on this runner`);
      return;
    }

    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    channel.socket = socket;

    socket.on('connect', () => {
      this.log(`tcp forward connected: 127.0.0.1:${port}`);
      for (const chunk of channel.pending) socket.write(chunk);
      channel.pending.length = 0;
      channel.pendingBytes = 0;
    });
    socket.on('data', (chunk: Buffer) => {
      this.send({ type: 'tcp:data', id, data: chunk.toString('base64') });
    });
    // 'end' is the peer's FIN; 'close' always follows, so only 'close' reports.
    socket.on('close', () => {
      if (this.tcpChannels.delete(id)) this.send({ type: 'tcp:close', id });
    });
    socket.on('error', (err) => {
      // Nothing listening is the common case (the dev server isn't up yet), and
      // it must read as a refusal rather than a silent empty response.
      if (this.tcpChannels.delete(id)) {
        this.send({ type: 'tcp:close', id, message: `cannot reach 127.0.0.1:${port}: ${err.message}` });
      }
    });
  }

  private writeTcp(id: string, chunk: Buffer): void {
    const channel = this.tcpChannels.get(id);
    if (!channel) return;
    const socket = channel.socket;
    if (socket && !socket.connecting && socket.writable) {
      socket.write(chunk);
      return;
    }
    if (channel.pendingBytes + chunk.length > MAX_PENDING_TCP_BYTES) {
      this.log(`tcp channel ${id} exceeded ${MAX_PENDING_TCP_BYTES} pending bytes — dropping`);
      this.closeTcp(id);
      this.send({ type: 'tcp:close', id, message: 'too much unsent data while connecting' });
      return;
    }
    channel.pending.push(chunk);
    channel.pendingBytes += chunk.length;
  }

  private closeTcp(id: string): void {
    const channel = this.tcpChannels.get(id);
    if (!channel) return;
    this.tcpChannels.delete(id);
    channel.closed = true;
    channel.socket?.destroy();
  }

  private handleWsOpen(msg: WsOpenMsg): void {
    const url = new URL(msg.path, `ws://${this.localBase}`);
    if (msg.query) url.search = msg.query;
    const local = new WebSocket(url.toString());
    const channel = { ws: local, pending: [] as Array<string | Buffer> };
    this.channels.set(msg.id, channel);
    local.on('open', () => {
      for (const frame of channel.pending) local.send(frame);
      channel.pending.length = 0;
    });
    local.on('message', (data, isBinary) => {
      this.send({ type: 'ws:frame', id: msg.id, ...encodeWsData(data as Buffer, isBinary) });
    });
    local.on('close', (code) => {
      if (this.channels.delete(msg.id)) this.send({ type: 'ws:close', id: msg.id, code });
    });
    local.on('error', () => {
      if (this.channels.delete(msg.id)) this.send({ type: 'ws:close', id: msg.id, code: 1011 });
    });
  }
}
