import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installOpencodePlugin } from '../../src/services/claudeHooks';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('installOpencodePlugin', () => {
  it('writes the plugin into <worktree>/.opencode/plugin', async () => {
    await installOpencodePlugin(dir);
    const p = path.join(dir, '.opencode', 'plugin', 'strado-opencode-status.js');
    expect(fs.existsSync(p)).toBe(true);
    const body = await fsp.readFile(p, 'utf8');
    expect(body).toContain('/api/opencode/status');
  });
});
