// A minimal language-server client: JSON-RPC 2.0 over the child's stdio with
// Content-Length framing. Read-only by construction: it asks for definitions,
// references, hover and symbols, and refuses every edit or command a server
// asks it to carry out.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FILES_LIMITS } from '../files/types.js';

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;
/** A body over this is a broken or hostile server, not a real answer. */
const MAX_BODY = 64 * 1024 * 1024;
/** Documents kept open on the server; the least recently used is closed. */
const MAX_OPEN_DOCS = 50;
/** How much of the server's stderr is kept, to explain a failure. */
const STDERR_TAIL = 2048;

/** Server → client requests we answer; everything else (workspace/applyEdit,
 *  workspace/executeCommand, window/showDocument, …) is refused. */
const ANSWERED = new Set(['workspace/configuration', 'window/workDoneProgress/create', 'client/registerCapability', 'client/unregisterCapability']);

export class LspError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'exited' | 'rpc',
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type LspClientOptions = {
  /** argv[0] already resolved to a binary path. */
  argv: string[];
  /** The worktree's realpath: cwd and rootUri. */
  root: string;
  env?: NodeJS.ProcessEnv;
  onExit?: (code: number | null) => void;
};

export class LspClient {
  readonly root: string;
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf: Buffer = Buffer.alloc(0);
  private stderr = '';
  private exited = false;
  /** Work-done progress begun and not yet ended (a project load, indexing). */
  private progress = new Set<string | number>();
  private progressSeen = false;
  /** Set by the first didOpen: a load it starts may begin a moment later. */
  private awaitingFirstLoad = false;
  private progressWaiters: (() => void)[] = [];
  /** uri → { version, mtimeMs, size } of what the server was last told. */
  private docs = new Map<string, { version: number; mtimeMs: number; size: number }>();

  constructor(private readonly o: LspClientOptions) {
    this.root = o.root;
    this.child = spawn(o.argv[0]!, o.argv.slice(1), {
      cwd: o.root,
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a stop also reaches what a wrapper script
      // started (jdtls' and OmniSharp's JVM / mono).
      detached: true,
    });
    this.child.stdout!.on('data', (b: Buffer) => this.onData(b));
    // Kept only to explain a failure (never sent to a client unredacted).
    this.child.stderr!.on('data', (b: Buffer) => {
      this.stderr = (this.stderr + b.toString('utf8')).slice(-STDERR_TAIL);
    });
    this.child.stdin!.on('error', () => {});
    this.child.on('error', () => this.onExit(null));
    this.child.on('exit', (code) => this.onExit(code));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** The last STDERR_TAIL characters the server wrote to stderr. */
  get stderrTail(): string {
    return this.stderr;
  }

  /** initialize + initialized. Rejects if the server is not up within `timeoutMs`. */
  async initialize(timeoutMs: number, initializationOptions?: unknown): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'strado' },
        rootUri,
        rootPath: this.root,
        ...(initializationOptions === undefined ? {} : { initializationOptions }),
        workspaceFolders: [{ uri: rootUri, name: this.root.split('/').pop() || this.root }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          window: { workDoneProgress: true },
        },
      },
      timeoutMs,
    );
    this.notify('initialized', {});
  }

  /** Tells the server about the file (didOpen), or that it changed on disk
   *  since (didChange, full text). Unchanged since last time: nothing sent. */
  async sync(abs: string, languageId: string): Promise<string> {
    const uri = pathToFileURL(abs).href;
    const st = await fs.stat(abs);
    // The Files tab never shows a file this big; it is not worth a server's memory.
    if (st.size > FILES_LIMITS.readBytes) throw new LspError('file too large', 'rpc');
    const known = this.docs.get(uri);
    // Re-inserted on every use: the Map's order is least recently used first.
    this.docs.delete(uri);
    if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) {
      this.docs.set(uri, known);
      return uri;
    }
    const text = await fs.readFile(abs, 'utf8');
    if (!known) {
      if (!this.docs.size && !this.progressSeen) this.awaitingFirstLoad = true;
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
      this.docs.set(uri, { version: 1, mtimeMs: st.mtimeMs, size: st.size });
    } else {
      const version = known.version + 1;
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
      this.docs.set(uri, { version, mtimeMs: st.mtimeMs, size: st.size });
    }
    while (this.docs.size > MAX_OPEN_DOCS) {
      const oldest = this.docs.keys().next().value!;
      this.docs.delete(oldest);
      this.notify('textDocument/didClose', { textDocument: { uri: oldest } });
    }
    return uri;
  }

  /** Resolves once no progress is running (a server answers from a half-loaded
   *  project otherwise: tsserver gives the import line, not the definition),
   *  or at `maxMs`. After the first open, waits up to `graceMs` for a load to
   *  begin, since servers start it just after the open, not with it. */
  async settle(maxMs: number, graceMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    const waitFor = (done: () => boolean, until: number) =>
      new Promise<void>((resolve) => {
        if (done() || this.exited) return resolve();
        const timer = setTimeout(finish, Math.max(0, until - Date.now()));
        const check = () => {
          if (done() || this.exited) finish();
          else this.progressWaiters.push(check);
        };
        function finish() {
          clearTimeout(timer);
          resolve();
        }
        this.progressWaiters.push(check);
      });
    if (this.awaitingFirstLoad) {
      this.awaitingFirstLoad = false;
      await waitFor(() => this.progressSeen, Math.min(deadline, Date.now() + graceMs));
    }
    await waitFor(() => this.progress.size === 0, deadline);
  }

  private onProgress(params: unknown): void {
    const p = params as { token?: string | number; value?: { kind?: string } } | undefined;
    if (p?.token === undefined || !p.value) return;
    if (p.value.kind === 'begin') {
      this.progress.add(p.token);
      this.progressSeen = true;
    } else if (p.value.kind === 'end') {
      this.progress.delete(p.token);
    } else {
      return;
    }
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const w of waiters) w();
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.exited) return Promise.reject(new LspError('language server exited', 'exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop working on it; the answer is no longer wanted.
        this.notify('$/cancelRequest', { id });
        reject(new LspError(`${method} timed out`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.write({ jsonrpc: '2.0', method, params });
  }

  /** shutdown + exit, then a kill if it is still there. */
  async stop(graceMs = 2000): Promise<void> {
    if (this.exited) return;
    const gone = new Promise<void>((r) => this.child.once('exit', () => r()));
    try {
      await this.request('shutdown', null, graceMs);
      this.notify('exit', null);
    } catch {
      // Not answering: the kill below.
    }
    const timer = setTimeout(() => this.kill(), graceMs);
    await gone;
    clearTimeout(timer);
    // The server left on its own; whatever it started may not have.
    this.killGroup();
  }

  kill(): void {
    this.killGroup();
    if (!this.exited) this.child.kill('SIGKILL');
  }

  private killGroup(): void {
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private write(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new LspError('language server exited', 'exited'));
    }
    this.pending.clear();
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const w of waiters) w();
    this.o.onExit?.(code);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.subarray(0, sep).toString('ascii');
      const m = /^content-length:\s*(\d+)\s*$/im.exec(header);
      const len = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(len) || len > MAX_BODY) {
        // Unframeable: nothing after this can be trusted.
        this.kill();
        return;
      }
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }): void {
    if (msg.method !== undefined) {
      // A notification from the server: progress is tracked, the rest
      // (diagnostics, logs) ignored.
      if (msg.id === undefined) {
        if (msg.method === '$/progress') this.onProgress(msg.params);
        return;
      }
      if (!ANSWERED.has(msg.method)) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: `${msg.method} is not supported` } });
        return;
      }
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params as { items?: unknown[] } | undefined)?.items;
        result = Array.isArray(items) ? items.map(() => null) : [];
      }
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new LspError(msg.error.message ?? 'language server error', 'rpc'));
    else p.resolve(msg.result ?? null);
  }
}
