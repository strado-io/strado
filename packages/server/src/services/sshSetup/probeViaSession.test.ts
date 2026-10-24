// The real probe, through session.run's exact quoting and stdin convention,
// executed by a local `sh` in place of the remote one: proves the api base
// reaches the script (so releaseReachable is real) with no ssh involved.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProbe, PROBE_SCRIPT } from './probe.js';
import { openSession, realExec, type ExecFn } from './session.js';

let server: http.Server;
let api: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/v1/release' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** ssh stand-in: run the remote command string with the local sh, same stdin. */
const localSsh: ExecFn = async (file, args, opts) => {
  if (args.includes('-G') || args.includes('-O')) return { code: 0, stdout: '', stderr: '' };
  return realExec('sh', ['-c', args.at(-1)!], opts);
};

describe('probe through session.run', () => {
  it('the api base on stdin reaches the script: releaseReachable reflects the feed', async () => {
    const s = await openSession({ target: 'local', port: null }, { exec: localSsh });
    try {
      const up = await s.run(PROBE_SCRIPT, `${api}\n`, undefined, 30_000);
      expect(up.code).toBe(0);
      expect(parseProbe(up.stdout).releaseReachable).toBe(true);
      const down = await s.run(PROBE_SCRIPT, 'http://127.0.0.1:9\n', undefined, 30_000);
      expect(parseProbe(down.stdout).releaseReachable).toBe(false);
    } finally {
      await s.close();
    }
  }, 60_000);
});
