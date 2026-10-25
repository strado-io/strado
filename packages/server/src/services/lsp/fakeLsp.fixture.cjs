// A tiny language server for tests: Content-Length framed JSON-RPC on stdio.
// FAKE_LSP_LOG: append every message it receives (one JSON per line).
// FAKE_LSP_MODE: 'normal' | 'slow-init' | 'crash-on-request' | 'hang' | 'exit-at-start' | 'grandchild'
//   | 'progress' (the first didOpen starts a project load that ends 1.5s later; until then
//     definition answers with the import line, as tsserver does) | 'progress-stuck' (never ends)
//   | 'needs-tsserver' (initialize fails unless initializationOptions.tsserver.path is a file,
//     as typescript-language-server does) | 'stderr-exit' (writes to stderr, exits 3).
// FAKE_LSP_PIDFILE: 'grandchild' writes the pid of a child it leaves running.
const fs = require('fs');

const mode = process.env.FAKE_LSP_MODE || 'normal';
const log = (m) => process.env.FAKE_LSP_LOG && fs.appendFileSync(process.env.FAKE_LSP_LOG, JSON.stringify(m) + '\n');
if (mode === 'exit-at-start') process.exit(3);
if (mode === 'stderr-exit') {
  process.stderr.write('boom: cannot start, token=sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA\n');
  setTimeout(() => process.exit(3), 50);
}
if (mode === 'grandchild') {
  // Like a wrapper script's JVM: a process of its own that outlives a kill of this one.
  const kid = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_LSP_PIDFILE, String(kid.pid));
}

let root = '';
let nextId = 1000;
let loading = false;
let opened = false;
const send = (m) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const uri = (rel) => `file://${root}/${rel}`;

function onMessage(m) {
  log(m);
  if (m.method === undefined) return; // a reply to one of our requests
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      root = decodeURIComponent(new URL(m.params.rootUri).pathname);
      log({ env: Object.keys(process.env).filter((k) => !k.startsWith('FAKE_LSP_')).sort() });
      if (mode === 'needs-tsserver') {
        const p = m.params.initializationOptions && m.params.initializationOptions.tsserver && m.params.initializationOptions.tsserver.path;
        if (!p || !fs.existsSync(p)) {
          return send({ id: m.id, error: { code: -32603, message: 'Could not find a valid TypeScript installation. Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified.' } });
        }
      }
      if (mode === 'slow-init') return setTimeout(() => reply({ capabilities: {} }), 10000);
      return reply({ capabilities: { definitionProvider: true }, serverInfo: { name: 'fake' } });
    case 'initialized':
      // Ask the client for things it must answer, and things it must refuse.
      for (const method of ['workspace/configuration', 'client/registerCapability', 'window/workDoneProgress/create', 'workspace/applyEdit', 'workspace/executeCommand', 'foo/bar']) {
        send({ id: nextId++, method, params: method === 'workspace/configuration' ? { items: [{}, {}] } : {} });
      }
      return;
    case 'shutdown':
      return reply(null);
    case 'exit':
      return process.exit(0);
  }
  if (m.method === 'textDocument/didOpen' && !opened && mode.startsWith('progress')) {
    opened = true;
    loading = true;
    // Like tsserver: the load starts a moment after the open, not with it.
    setTimeout(() => {
      send({ id: nextId++, method: 'window/workDoneProgress/create', params: { token: 'load' } });
      send({ method: '$/progress', params: { token: 'load', value: { kind: 'begin', title: 'Loading' } } });
      send({ method: '$/progress', params: { token: 'load', value: { kind: 'report', message: 'half' } } });
      if (mode === 'progress') {
        setTimeout(() => {
          loading = false;
          send({ method: '$/progress', params: { token: 'load', value: { kind: 'end' } } });
        }, 1500);
      }
    }, 100);
  }
  if (m.id === undefined) return; // other notifications (didOpen, didChange)
  if (mode === 'crash-on-request') process.exit(7);
  if (mode === 'hang') return;
  switch (m.method) {
    case 'textDocument/definition':
      if (loading) {
        return reply([{ uri: uri('src/use.ts'), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } }]);
      }
      if (process.env.FAKE_LSP_ESCAPE) {
        return reply([{ uri: uri('link/secret.ts'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
      }
      return reply([
        { uri: uri('src/def.ts'), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 16 } } },
        { uri: 'file:///definitely/outside/x.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ]);
    case 'textDocument/references':
      return reply([
        { targetUri: uri('src/use.ts'), targetSelectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 30 } } },
        { uri: uri('src/def.ts'), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 16 } } },
        { uri: uri('src/def.ts'), range: { start: { line: 1, character: 20 }, end: { line: 1, character: 21 } } },
      ]);
    case 'textDocument/hover':
      return reply({ contents: { kind: 'markdown', value: '```ts\nconst foo: number\n```' } });
    case 'textDocument/documentSymbol':
      return reply([
        { name: 'Box', kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          children: [{ name: 'open', kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } } }] },
        { name: 'foo', kind: 14, location: { uri: uri('src/def.ts'), range: { start: { line: 5, character: 13 }, end: { line: 5, character: 16 } } } },
      ]);
    default:
      return send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.subarray(sep + 4 + len);
    onMessage(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
