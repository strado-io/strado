import net from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { pidsOnPort } from '../../src/services/externalProcess.js';

describe('pidsOnPort', () => {
  it('finds the process listening on a port', async () => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const pids = await pidsOnPort(port);
      expect(pids).toContain(process.pid);
    } finally {
      srv.close();
    }
  });

  it('returns empty for a free port', async () => {
    // grab a port then release it so we know it is free
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as net.AddressInfo).port;
    srv.close();
    await once(srv, 'close');
    expect(await pidsOnPort(port)).toEqual([]);
  });
});
