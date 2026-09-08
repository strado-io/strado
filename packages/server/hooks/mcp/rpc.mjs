// Newline-delimited JSON-RPC over stdio for an MCP server: initialize,
// tools/list, tools/call, ping. Lifted from the original strado-preview server
// so every Strado tool family shares one loop. A tool is
// { name, description, inputSchema, run(args) } where run resolves to an MCP
// result ({ content: [{ type: 'text', text }] }). Swapping this file for the
// official SDK later leaves the tool modules untouched.

export const text = (s) => ({ content: [{ type: 'text', text: s }] });

export function serve({ name, version, tools, input = process.stdin, output = process.stdout, stderr = process.stderr }) {
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');

  async function handle(msg) {
    const { id, method, params } = msg;
    // notifications (initialized, cancelled, ...) never get a reply, no matter the method
    if (id === undefined) return;
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) } });
      return;
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) {
        write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
        return;
      }
      try {
        const result = await tool.run(params?.arguments ?? {});
        write({ jsonrpc: '2.0', id, result });
      } catch (err) {
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true } });
      }
      return;
    }
    if (method === 'ping') {
      write({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }

  return new Promise((resolve) => {
    let buf = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (err) { stderr.write(`${name}: bad message: ${err}\n`); continue; }
        void handle(msg);
      }
    });
    input.on('end', () => resolve());
  });
}
