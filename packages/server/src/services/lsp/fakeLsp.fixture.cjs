// A tiny language server for tests: Content-Length framed JSON-RPC on stdio.
// FAKE_LSP_LOG: append every message it receives (one JSON per line).
// FAKE_LSP_MODE: 'normal' | 'slow-init' | 'crash-on-request' | 'hang' | 'exit-at-start'.
const fs = require('fs');

const mode = process.env.FAKE_LSP_MODE || 'normal';
const log = (m) => process.env.FAKE_LSP_LOG && fs.appendFileSync(process.env.FAKE_LSP_LOG, JSON.stringify(m) + '\n');
if (mode === 'exit-at-start') process.exit(3);

let root = '';
let nextId = 1000;
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
      if (mode === 'slow-init') return setTimeout(() => reply({ capabilities: {} }), 3000);
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
  if (m.id === undefined) return; // other notifications (didOpen, didChange)
  if (mode === 'crash-on-request') process.exit(7);
  if (mode === 'hang') return;
  switch (m.method) {
    case 'textDocument/definition':
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
