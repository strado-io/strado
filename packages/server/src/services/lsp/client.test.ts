import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LspClient } from './client.js';

const FAKE = fileURLToPath(new URL('./fakeLsp.fixture.cjs', import.meta.url));

let tmp: string;
let client: LspClient | null;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-client-')));
  await fs.writeFile(path.join(tmp, 'a.ts'), 'x\n');
  client = null;
});
afterEach(async () => {
  await client?.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('LspClient.settle', () => {
  it('a wait that times out leaves nothing behind (a stuck load must not pile up waiters)', async () => {
    client = new LspClient({ argv: [process.execPath, FAKE], root: tmp, env: { ...process.env, FAKE_LSP_MODE: 'progress-stuck' } });
    await client.initialize(10_000);
    await client.sync(path.join(tmp, 'a.ts'), 'typescript');
    await client.settle(400, 300); // the load begins, never ends
    for (let i = 0; i < 5; i++) await client.settle(50, 300);
    expect((client as unknown as { progressWaiters: unknown[] }).progressWaiters).toHaveLength(0);
  });
});
