#!/usr/bin/env node
// strado-preview: per-worktree browser context for agents.
//
// A stdio MCP server that exposes ONLY the Browser-preview page belonging to
// the worktree it runs in — the agent cannot see or touch other worktrees'
// tabs, the Strado dashboard, or anything else on the CDP endpoint.
//
// Scoping: Strado's PTY sessions export STRADO_WORKTREE (fallback: cwd).
// The desktop shell registers each preview's CDP target id with the Strado
// server (PUT /api/preview-targets); this process looks its worktree up
// there and talks straight to that one target over the CDP websocket.
//
// No dependencies: uses Node's global fetch + WebSocket (Node >= 22).

const SERVER = process.env.STRADO_SERVER || 'http://127.0.0.1:7777';
const WORKTREE = process.env.STRADO_WORKTREE || process.cwd();

// ---------- CDP ----------

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const WS = globalThis.WebSocket ?? require('ws').WebSocket;
      this.ws = new WS(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`cannot reach CDP target at ${this.url}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method) {
          for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
        }
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    const list = this.listeners.get(method) ?? [];
    list.push(cb);
    this.listeners.set(method, list);
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// All Browser tabs open for THIS worktree, sorted by tab id ('1' first).
async function resolveTargets() {
  let res;
  try {
    res = await fetch(`${SERVER}/api/preview-targets`);
  } catch {
    throw new Error(`Strado server not reachable at ${SERVER} — is the app running?`);
  }
  if (!res.ok) throw new Error(`Strado server error (${res.status}) — update + restart the server`);
  const { targets } = await res.json();
  const mine = targets
    .filter((x) => x.path === WORKTREE || WORKTREE.startsWith(x.path + '/'))
    .map((x) => ({ ...x, tabId: x.tabId ?? '1' }))
    .sort((a, b) => Number(a.tabId) - Number(b.tabId));
  if (mine.length === 0) {
    const open = [...new Set(targets.map((x) => x.path))].join(', ') || 'none';
    throw new Error(
      `No Browser preview is open for this worktree (${WORKTREE}). ` +
        `Open a Browser tab for it in the Strado hub, then retry. Previews open elsewhere: ${open}`,
    );
  }
  return mine;
}

async function resolveTarget(tab) {
  const mine = await resolveTargets();
  const t = tab !== undefined && tab !== null && tab !== ''
    ? mine.find((x) => x.tabId === String(tab))
    : mine.find((x) => x.tabId === '1') ?? mine[0];
  if (!t) {
    throw new Error(
      `No Browser tab '${tab}' in this worktree. Open tabs: ${mine.map((x) => x.tabId).join(', ')} — see preview_tabs.`,
    );
  }
  if (!t.cdpPort) {
    throw new Error('CDP is disabled for this instance. Relaunch with `npm run desktop` (not desktop:nocdp) to enable it.');
  }
  return t;
}

async function withPage(fn, tab) {
  const t = await resolveTarget(tab);
  const cdp = new Cdp(`ws://127.0.0.1:${t.cdpPort}/devtools/page/${t.targetId}`);
  try {
    await cdp.connect();
  } catch {
    throw new Error(
      'Preview target is stale (page was closed or the shell restarted). Reopen the Browser tab and retry.',
    );
  }
  try {
    return await fn(cdp, t);
  } finally {
    cdp.close();
  }
}

async function evalIn(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = (p, ms, message) =>
  Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(message);
    }),
  ]);

function fmtRemote(o) {
  if (o.value !== undefined) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  return o.description ?? o.type;
}

// ---------- tools ----------

const text = (s) => ({ content: [{ type: 'text', text: s }] });

const TAB_PROP = {
  tab: {
    type: 'string',
    description: "Which Browser tab of this worktree to target, by tab id (see preview_tabs). Default: tab '1'.",
  },
};

const TOOLS = [
  {
    name: 'preview_tabs',
    description:
      "List this worktree's open Browser tabs (tab id, url, title). A worktree can have several tabs; every other preview_* tool takes a `tab` argument to pick one and defaults to tab '1'.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const mine = await resolveTargets();
      const lines = [];
      for (const t of mine) {
        if (!t.cdpPort) { lines.push(`tab ${t.tabId}: (CDP disabled)`); continue; }
        const cdp = new Cdp(`ws://127.0.0.1:${t.cdpPort}/devtools/page/${t.targetId}`);
        try {
          await cdp.connect();
          const r = await evalIn(cdp, '({ url: location.href, title: document.title })');
          lines.push(`tab ${t.tabId}: ${r.value.url} — ${r.value.title || '(untitled)'}`);
        } catch {
          lines.push(`tab ${t.tabId}: (stale — reopen this Browser tab)`);
        } finally {
          cdp.close();
        }
      }
      return text(`${lines.length} Browser tab${lines.length === 1 ? '' : 's'} open in this worktree:\n${lines.join('\n')}`);
    },
  },
  {
    name: 'preview_status',
    description:
      "This worktree's live browser preview: current URL and title of one tab. The worktree can have several Browser tabs — list them with preview_tabs and pass `tab` to target one (default '1').",
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
    run: ({ tab } = {}) =>
      withPage(async (cdp, t) => {
        const r = await evalIn(cdp, '({ url: location.href, title: document.title })');
        return text(`worktree: ${WORKTREE}\ntab: ${t.tabId}\nurl: ${r.value.url}\ntitle: ${r.value.title}`);
      }, tab),
  },
  {
    name: 'preview_screenshot',
    description: "Screenshot of this worktree's preview page as the user sees it.",
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
    run: ({ tab } = {}) =>
      withPage(async (cdp, t) => {
        // A hidden preview (its Browser tab not on screen) produces no
        // compositor frames, so the capture times out. Do NOT fall back to
        // fromSurface:false — that grabs the WINDOW surface at the view's
        // spot, i.e. whatever hub pane is actually on screen (verified live:
        // an agent got a screenshot of its own terminal). An honest error
        // beats misleading pixels.
        const shot = await withTimeout(
          cdp.send('Page.captureScreenshot', { format: 'png' }),
          4000,
          `Screenshot unavailable — Browser tab ${t.tabId} renders no frames while it isn't the visible hub tab. ` +
            'Ask the user to switch the hub to that Browser tab, or use preview_eval / preview_console instead.',
        );
        return { content: [{ type: 'image', data: shot.data, mimeType: 'image/png' }] };
      }, tab),
  },
  {
    name: 'preview_eval',
    description:
      "Evaluate JavaScript in this worktree's preview page and return the JSON result. Use for reading state or React-safe interactions.",
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript expression (promises awaited)' }, ...TAB_PROP },
      required: ['expression'],
      additionalProperties: false,
    },
    run: ({ expression, tab }) =>
      withPage(async (cdp) => {
        const r = await evalIn(cdp, expression);
        return text(fmtRemote(r));
      }, tab),
  },
  {
    name: 'preview_console',
    description: "Recent console messages from this worktree's preview page (replayed from the page's buffer).",
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
    run: ({ tab } = {}) =>
      withPage(async (cdp) => {
        const lines = [];
        cdp.on('Runtime.consoleAPICalled', (p) => {
          lines.push(`[${p.type}] ${p.args.map(fmtRemote).join(' ')}`);
        });
        cdp.on('Runtime.exceptionThrown', (p) => {
          lines.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
        });
        cdp.on('Log.entryAdded', (p) => {
          lines.push(`[${p.entry.level}] ${p.entry.text} (${p.entry.source})`);
        });
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await sleep(900); // buffered history replays right after enable
        return text(lines.length ? lines.slice(-200).join('\n') : '(no console messages)');
      }, tab),
  },
  {
    name: 'preview_network',
    description:
      "Observe network requests in this worktree's preview. Reloads the page by default so the full page-load traffic is captured.",
    inputSchema: {
      type: 'object',
      properties: {
        reload: { type: 'boolean', description: 'reload the page first (default true)' },
        seconds: { type: 'number', description: 'how long to record (default 6, max 30)' },
        ...TAB_PROP,
      },
      additionalProperties: false,
    },
    run: ({ reload = true, seconds = 6, tab }) =>
      withPage(async (cdp) => {
        const reqs = new Map();
        cdp.on('Network.requestWillBeSent', (p) => {
          reqs.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type, status: '…' });
        });
        cdp.on('Network.responseReceived', (p) => {
          const r = reqs.get(p.requestId);
          if (r) r.status = String(p.response.status);
        });
        cdp.on('Network.loadingFailed', (p) => {
          const r = reqs.get(p.requestId);
          if (r) r.status = `FAILED ${p.errorText}`;
        });
        await cdp.send('Network.enable');
        if (reload) await cdp.send('Page.reload');
        await sleep(Math.min(Math.max(seconds, 1), 30) * 1000);
        const lines = [...reqs.values()].map((r) => `${r.status} ${r.method} ${r.url} (${r.type ?? '?'})`);
        return text(lines.length ? lines.join('\n') : '(no requests recorded)');
      }, tab),
  },
  {
    name: 'preview_click',
    description: "Click an element (CSS selector) in this worktree's preview with a real mouse event.",
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, ...TAB_PROP },
      required: ['selector'],
      additionalProperties: false,
    },
    run: ({ selector, tab }) =>
      withPage(async (cdp) => {
        const r = await evalIn(
          cdp,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const b = el.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          })()`,
        );
        if (!r.value) throw new Error(`selector not found: ${selector}`);
        const { x, y } = r.value;
        const base = { x, y, button: 'left', clickCount: 1 };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        return text(`clicked ${selector} at (${Math.round(x)}, ${Math.round(y)})`);
      }, tab),
  },
  {
    name: 'preview_fill',
    description:
      "Type into an input/textarea (CSS selector) in this worktree's preview using real text input. Replaces the current value.",
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' }, ...TAB_PROP },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
    run: ({ selector, text: value, tab }) =>
      withPage(async (cdp) => {
        const r = await evalIn(
          cdp,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.focus();
            if (typeof el.select === 'function') el.select();
            return true;
          })()`,
        );
        if (!r.value) throw new Error(`selector not found: ${selector}`);
        await cdp.send('Input.insertText', { text: value });
        return text(`filled ${selector}`);
      }, tab),
  },
  {
    name: 'preview_navigate',
    description: "Navigate this worktree's preview to a URL.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, ...TAB_PROP },
      required: ['url'],
      additionalProperties: false,
    },
    run: ({ url, tab }) =>
      withPage(async (cdp) => {
        await cdp.send('Page.navigate', { url: /^https?:\/\//.test(url) ? url : `http://${url}` });
        return text(`navigating to ${url}`);
      }, tab),
  },
  {
    name: 'preview_reload',
    description: "Reload this worktree's preview page.",
    inputSchema: { type: 'object', properties: { ...TAB_PROP }, additionalProperties: false },
    run: ({ tab } = {}) =>
      withPage(async (cdp) => {
        await cdp.send('Page.reload');
        return text('reloading');
      }, tab),
  },
];

// ---------- MCP stdio plumbing ----------

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'strado-preview', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      return;
    }
    try {
      const result = await tool.run(params?.arguments ?? {});
      write({ jsonrpc: '2.0', id, result });
    } catch (err) {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true },
      });
    }
    return;
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  // notifications (initialized, cancelled, ...) need no reply
  if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`strado-preview: bad message: ${err}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
