import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app.js';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-license-')));
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.STRADO_HOME;
});

// PUT /api/license used to be the invite-code exchange's write path: hand it a
// `code`-shaped body and it would persist a license without ever going through
// the device-code sign-in flow. That flow (POST /api/auth/poll) is now the
// only way a license.json gets created — nothing in packages/web calls this
// route anymore, so it is gone rather than left as a dead write path that
// would otherwise still let a client mint itself a license out of thin air.
describe('PUT /api/license', () => {
  it('no longer exists', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/license',
      payload: { token: 'a'.repeat(64), name: 'K', deviceId: 'device-abcdefgh', email: 'a@b.com' },
    });
    expect(res.statusCode).toBe(404);
    await expect(fs.access(path.join(process.env.STRADO_HOME!, 'license.json'))).rejects.toThrow();
  });
});
