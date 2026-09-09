import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import { serve, text } from '../../hooks/mcp/rpc.mjs';

type Msg = Record<string, unknown>;

function harness(tools: unknown[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const out: Msg[] = [];
  let errText = '';
  output.on('data', (c) => { for (const line of String(c).split('\n')) if (line.trim()) out.push(JSON.parse(line)); });
  stderr.on('data', (c) => { errText += String(c); });
  const done = serve({ name: 'strado', version: '0.2.0', tools, input, output, stderr });
  const send = (m: Msg) => { input.write(JSON.stringify(m) + '\n'); };
  const flush = () => new Promise((r) => setImmediate(r));
  return { input, out, send, flush, done, err: () => errText };
}

const echoTool = {
  name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { s: { type: 'string' } } },
  run: async ({ s }: { s: string }) => text(`echo:${s}`),
};
const boomTool = { name: 'boom', description: 'throws', inputSchema: { type: 'object' }, run: async () => { throw new Error('kaboom'); } };

describe('mcp rpc', () => {
  it('initialize echoes the protocol version and names the server', async () => {
    const h = harness([echoTool]);
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    await h.flush();
    expect(h.out).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'strado', version: '0.2.0' } } }]);
  });

  it('defaults the protocol version when the client sends none', async () => {
    const h = harness([]);
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await h.flush();
    expect((h.out[0]!.result as Msg).protocolVersion).toBe('2025-06-18');
  });

  it('tools/list returns name, description and schema only', async () => {
    const h = harness([echoTool, boomTool]);
    h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await h.flush();
    expect(h.out[0]!.result).toEqual({ tools: [
      { name: 'echo', description: 'echoes', inputSchema: echoTool.inputSchema },
      { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
    ] });
  });

  it('tools/call runs the tool; a thrown error becomes an isError text result', async () => {
    const h = harness([echoTool, boomTool]);
    h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { s: 'hi' } } });
    h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    await h.flush(); await h.flush();
    expect(h.out).toContainEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'echo:hi' }] } });
    expect(h.out).toContainEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'Error: kaboom' }], isError: true } });
  });

  it('unknown tool → -32602; unknown method with id → -32601; ping → {}', async () => {
    const h = harness([echoTool]);
    h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
    h.send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    h.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await h.flush();
    expect(h.out).toContainEqual({ jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'unknown tool nope' } });
    expect(h.out).toContainEqual({ jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'method not found: resources/list' } });
    expect(h.out).toContainEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('notifications get no reply; a malformed line is logged and skipped; split and joined lines both parse', async () => {
    const h = harness([echoTool]);
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    h.input.write('{not json}\n');
    const a = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' });
    const b = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' });
    h.input.write(a.slice(0, 10)); h.input.write(a.slice(10) + '\n' + b + '\n');
    await h.flush();
    expect(h.out.map((m) => m.id)).toEqual([8, 9]);
    expect(h.err()).toContain('strado: bad message');
  });

  it('resolves when input ends', async () => {
    const h = harness([]);
    h.input.end();
    await expect(h.done).resolves.toBeUndefined();
  });

  it('a known-method notification (no id) gets no reply', async () => {
    const h = harness([echoTool]);
    h.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n');
    await h.flush();
    expect(h.out).toEqual([]);
  });

  it('a JSON-RPC line split inside a multi-byte UTF-8 character still parses intact', async () => {
    const captured: string[] = [];
    const argTool = {
      name: 'arg', description: 'captures its argument', inputSchema: { type: 'object' },
      run: async ({ s }: { s: string }) => { captured.push(s); return text('ok'); },
    };
    const h = harness([argTool]);
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'arg', arguments: { s: 'héllo — wörld 日本' } } }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    // Split inside the multi-byte em dash (—, e2 80 94) so neither half is a
    // valid UTF-8 sequence on its own.
    const splitAt = buf.indexOf(Buffer.from('—', 'utf8')) + 1;
    h.input.write(buf.subarray(0, splitAt));
    h.input.write(buf.subarray(splitAt));
    await h.flush();
    expect(captured).toEqual(['héllo — wörld 日本']);
  });
});
