import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

async function build() {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'req-log-')));
  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);
  return app;
}

afterEach(async () => {
  delete process.env.STRADO_LOG_REQUESTS;
  if (app) { await app.close(); app = undefined; }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('server request logging', () => {
  it('is off by default — a poll every few seconds must not grow the log file', async () => {
    const built = await build();
    expect(built.initialConfig.disableRequestLogging).toBe(true);
  });

  it('can be switched back on with STRADO_LOG_REQUESTS=1', async () => {
    process.env.STRADO_LOG_REQUESTS = '1';
    const built = await build();
    expect(built.initialConfig.disableRequestLogging).toBe(false);
  });
});
